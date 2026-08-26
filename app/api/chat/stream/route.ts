import { NextResponse } from 'next/server';
import { prisma } from '../../../../lib/prisma';
import { askGeminiStream, GeminiMessage } from '../../../../services/geminiService';
import {
  getConversationHistoryForAI,
  validateConversationOwnership,
  createConversationWithInitialMessage,
  deleteConversation,
  addMessageToConversation,
  setConversationTitleIfMissing,
  updateConversationSummary,
} from '../../../../lib/conversationDb';
import {
  AIRequestGatewayError,
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  executeAIRequest,
  getClientIp,
  buildAIRequestId,
} from '../../../../lib/aiSecurityGateway';
import { validateImageBuffer } from '../../../../lib/imageValidator';
import logger from '../../../../lib/logger';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import { createSafeStreamWriter } from '../../../lib/streamUtils';
import { observeMonitoringLatency } from '../../../../lib/monitoring';
import { createHash } from 'node:crypto';
import { takeChatImage } from '../../../../lib/chatImageUpload';

const CORS_METHODS = 'POST, OPTIONS';

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS },
  });
}

export async function POST(req: Request) {
  const requestStartedAt = Date.now();
  try {
    logger.info('Chat stream auth attempt', {
      origin: req.headers.get('origin') ?? null,
      host: req.headers.get('host') ?? null,
      method: req.method,
      url: req.url,
    });

    const authStartedAt = Date.now();
    const user = await authenticateAIRequest(req);
    observeMonitoringLatency('api', Date.now() - authStartedAt, { route: 'chat-stream', operation: 'auth' });
    const userId = user.id;
    logger.info('Authenticated chat stream user', { userId });

    const clientIp = getClientIp(req);
    const rateLimitStartedAt = Date.now();
    await enforceAIGatewayRateLimit(userId, clientIp);
    observeMonitoringLatency('api', Date.now() - rateLimitStartedAt, { route: 'chat-stream', operation: 'rate-limit' });

    let body: { message?: unknown; image?: unknown; conversationId?: unknown; requestId?: unknown; answerMode?: unknown } | null = null;
    try {
      body = (await req.json()) as { message?: unknown; image?: unknown; conversationId?: unknown; requestId?: unknown; answerMode?: unknown };
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    logger.info('Chat stream request payload received', { body: body ? { messageLength: String(body?.message || '').length, hasImage: Boolean(body?.image), conversationId: body?.conversationId ?? null } : null });

    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    const image = body?.image;
    const requestId = typeof body?.requestId === 'string' && body.requestId.trim()
      ? body.requestId.trim()
      : buildAIRequestId('chat-stream');
    const answerMode = body?.answerMode === 'short' ? 'short' : 'detailed';

    if (!message && !image) {
      return NextResponse.json({ error: 'Invalid input: message or image is required' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }
    if (image !== undefined && image !== null && typeof image !== 'object') {
      return NextResponse.json({ error: 'Invalid input: image payload is malformed' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const imagePayload = image && typeof image === 'object'
      ? image as { data?: unknown; mimeType?: unknown; uri?: unknown }
      : null;

    let conversationId = typeof body?.conversationId === 'string' ? body.conversationId : undefined;
    let createdForRequest = false;
    if (conversationId && !(await validateConversationOwnership(conversationId, userId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }
    const userText = message || (imagePayload ? 'Please analyze the attached image and explain it clearly as a tutor.' : '');

    // Validate image if provided
    let validatedImage: { data: string; mimeType: string; uri?: string | null } | null = null;
    if (imagePayload) {
      let imageData = imagePayload.data;
      let imageMimeType = imagePayload.mimeType;
      if (typeof imageData !== 'string' && typeof imagePayload.uri === 'string') {
        const uploadId = imagePayload.uri.split('/').pop() || '';
        const uploaded = takeChatImage(uploadId);
        imageData = uploaded?.data;
        imageMimeType = uploaded?.mimeType;
      }
      if (typeof imageData !== 'string' || typeof imageMimeType !== 'string') {
        return NextResponse.json({ error: 'Invalid image: upload has expired or is malformed' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
      }
      try {
        const imageBuffer = Buffer.from(imageData, 'base64');
        const validated = validateImageBuffer(imageBuffer, imageMimeType);
        validatedImage = {
          data: imageData,
          mimeType: validated.mimeType,
          uri: typeof imagePayload.uri === 'string' ? imagePayload.uri : undefined,
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : 'Image validation failed';
        return NextResponse.json({ error: `Invalid image: ${errMsg}` }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
      }
    }

    const savedUserText = message || (validatedImage ? 'Image attached' : '');
    if (!conversationId) {
      const conv = await createConversationWithInitialMessage(userId, savedUserText, { requestId });
      conversationId = conv.id;
      createdForRequest = true;
    }
    logger.info('Chat stream conversation selected', { userId, conversationId });

    const historyStartedAt = Date.now();
    const historyForAI = await getConversationHistoryForAI(conversationId);
    observeMonitoringLatency('database', Date.now() - historyStartedAt, { route: 'chat-stream', operation: 'history' });

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const { enqueue, close, isStreamClosed } = createSafeStreamWriter(controller, req.signal);
        let assistantMessageId: string | null = null;
        let assistantText = '';
        let promptHash = '';

        try {
          promptHash = createHash('sha256').update(savedUserText.trim().toLowerCase()).digest('hex');
          const repeatedPrompt = !createdForRequest && Boolean(savedUserText.trim()) && Boolean(await prisma.conversationMessage.findFirst({
            where: { conversationId, role: 'user', content: savedUserText, status: { not: 'failed' } },
            select: { id: true },
          }));
          if (message) {
            await setConversationTitleIfMissing(conversationId, message);
          }
          if (!createdForRequest) {
            await addMessageToConversation(conversationId, 'user', savedUserText, userId, { requestId });
          }
          if (repeatedPrompt) {
            await prisma.chatAnalyticsEvent.create({
              data: { userId, conversationId, eventType: 'repeated_prompt', promptHash, metadata: { requestId } },
            });
          }

          const assistantPlaceholder = await addMessageToConversation(conversationId, 'assistant', '', userId, { requestId, status: 'streaming' });
          if (assistantPlaceholder?.id) {
            assistantMessageId = assistantPlaceholder.id;
          }
          enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'conversation', conversationId })}\n\n`));
        } catch (dbErr) {
          logger.error('Failed to save initial conversation state before streaming', { error: String(dbErr) });
          if (createdForRequest) await deleteConversation(conversationId).catch(() => undefined);
          if (!isStreamClosed()) {
            enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: 'Unable to start the response. Please try again.' })}\n\n`));
          }
          close();
          return;
        }

        try {
          const { result: aiResponse } = await executeAIRequest({
            user,
            clientIp,
            feature: validatedImage ? 'image' : 'chat',
            provider: 'Gemini',
            amount: 1,
            requestId,
            metadata: { conversationId },
            pending: true,
            securityInput: userText,
            securityContext: { conversationId, hasImage: Boolean(validatedImage) },
            callback: async ({ billingDecision, sanitizedInput }) => {
              const sanitizedText = sanitizedInput ?? userText;
              const modeInstruction = answerMode === 'short'
                ? '\nAnswer in 1-3 concise sentences. Prioritize the direct answer and omit optional background.'
                : '\nGive a thorough, structured explanation with useful context and examples where appropriate.';
              const userEntry: GeminiMessage = {
                role: 'user',
                parts: [
                  { text: `${sanitizedText}${modeInstruction}` },
                  ...(validatedImage ? [{ inlineData: { mimeType: validatedImage.mimeType, data: validatedImage.data } }] : []),
                ],
              };
              const priorHistory = createdForRequest ? historyForAI.slice(0, -1) : historyForAI;
              const contents: GeminiMessage[] = [...priorHistory, userEntry];

              const modelToUse = billingDecision.modelUsed ?? undefined;
              assistantText = '';
              await askGeminiStream(contents, async (token: string) => {
                if (isStreamClosed()) {
                  return;
                }
                assistantText += token;
                const payload = JSON.stringify({ type: 'token', token });
                enqueue(encoder.encode(`data: ${payload}\n\n`));

              }, modelToUse, req.signal);

              return assistantText;
            },
          });

          try {
            const finalAssistantText = typeof aiResponse === 'string' ? aiResponse : String(aiResponse ?? '');
            if (assistantMessageId) {
              await prisma.conversationMessage.update({
                where: { id: assistantMessageId },
                data: {
                  content: finalAssistantText,
                  text: finalAssistantText,
                    status: 'completed',
                },
              });
            }
            await updateConversationSummary(conversationId);
            if (!finalAssistantText.trim()) {
              await prisma.chatAnalyticsEvent.create({
                data: { userId, conversationId, messageId: assistantMessageId, eventType: 'unanswered_question', promptHash, metadata: { requestId, reason: 'empty_response' } },
              });
            }
          } catch (dbErr) {
            logger.error('Failed to finalize assistant message after streaming', { error: String(dbErr), assistantMessageId });
          }

          if (!isStreamClosed()) {
            enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`));
          }
          observeMonitoringLatency('api', Date.now() - requestStartedAt, { route: 'chat-stream', operation: 'total' });
          close();
        } catch (err: unknown) {
          const appError = (() => {
            const status = typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status?: unknown }).status === 'number' ? (err as { status?: number }).status : undefined;
            return {
              message: 'We couldn’t finish that reply right now. Please try again shortly.',
              status,
            };
          })();
          logger.error('Chat stream error', { error: { message: appError.message, status: appError.status } });
          if (assistantMessageId) {
            await prisma.conversationMessage.update({
              where: { id: assistantMessageId },
              data: { status: 'failed' },
            }).catch((dbErr) => {
              logger.error('Failed to mark assistant message as failed', { error: String(dbErr), assistantMessageId });
            });
          }
          await updateConversationSummary(conversationId).catch(() => undefined);
          await prisma.chatAnalyticsEvent.create({
            data: { userId, conversationId, messageId: assistantMessageId, eventType: 'unanswered_question', metadata: { requestId, reason: 'generation_failed' } },
          }).catch(() => undefined);
          if (!isStreamClosed()) {
            const errPayload = JSON.stringify({ type: 'error', message: appError.message });
            enqueue(encoder.encode(`data: ${errPayload}\n\n`));
          }
          close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        ...buildCorsHeaders(req.headers.get('origin')),
        'Access-Control-Allow-Methods': CORS_METHODS,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (err: unknown) {
    if (err instanceof AIRequestGatewayError) {
      return NextResponse.json(err.body, { status: err.status, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const message = err instanceof Error ? err.message : 'Streaming is temporarily unavailable. Please try again shortly.';
    const status = typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status?: unknown }).status === 'number' ? (err as { status?: number }).status : 503;
    logger.error('Chat stream route error', { error: { message, status } });
    return NextResponse.json({ error: message, code: 'stream_unavailable' }, { status, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
