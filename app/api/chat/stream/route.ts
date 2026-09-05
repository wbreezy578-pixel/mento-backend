import { NextResponse } from 'next/server';
import { prisma } from '../../../../lib/prisma';
import { askGeminiStream, GeminiMessage } from '../../../../services/geminiService';
import {
  getConversationHistoryForAI,
  validateConversationOwnership,
  initializeStreamingTurn,
  updateConversationSummary,
} from '../../../../lib/conversationDb';
import {
  AIRequestGatewayError,
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  executeAIRequest,
  getClientIp,
  requireClientAIRequestId,
  assertAIRequestNotProcessed,
  secureAITextInput,
  AIGenerationCancelledError,
} from '../../../../lib/aiSecurityGateway';
import { MAX_IMAGE_BYTES, validateImageBuffer } from '../../../../lib/imageValidator';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../lib/requestBody';
import logger from '../../../../lib/logger';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import { createSafeStreamWriter } from '../../../lib/streamUtils';
import { observeMonitoringLatency } from '../../../../lib/monitoring';
import { createHash } from 'node:crypto';
import { acquireAIGenerationLock, releaseAIGenerationLock, startAIGenerationLockHeartbeat } from '../../../../lib/aiGenerationLock';
import { buildTutorLanguageInstruction, getTutorLanguage } from '../../../../lib/userSettings';
import { ChatOperationConflictError, claimInitialChatOperation, completeInitialChatOperation, failInitialChatOperation } from '../../../../services/chatOperationService';

const CORS_METHODS = 'POST, OPTIONS';
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_CHAT_JSON_BYTES = MAX_IMAGE_BASE64_CHARS + 128 * 1024;

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
      body = await readJsonBodyWithLimit<{ message?: unknown; image?: unknown; conversationId?: unknown; requestId?: unknown; answerMode?: unknown }>(req, MAX_CHAT_JSON_BYTES);
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
      return NextResponse.json({ error: bodyError.message, code: bodyError.code }, { status: bodyError.status, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    logger.info('Chat stream request payload received', { body: body ? { messageLength: String(body?.message || '').length, hasImage: Boolean(body?.image), conversationId: body?.conversationId ?? null } : null });

    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    const image = body?.image;
    const requestId = requireClientAIRequestId(req, body?.requestId);
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
    let userMessageId: string | null = null;
    if (conversationId && !(await validateConversationOwnership(conversationId, userId, 'chat'))) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }
    const userText = message || (imagePayload ? 'Please analyze the attached image and explain it clearly as a tutor.' : '');

    // Validate image if provided
    let validatedImage: { data: string; mimeType: string } | null = null;
    if (imagePayload) {
      const imageData = imagePayload.data;
      const imageMimeType = imagePayload.mimeType;
      if (typeof imageData !== 'string' || typeof imageMimeType !== 'string') {
        return NextResponse.json({ error: 'Invalid image: inline image data is required' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
      }
      if (imageData.length > MAX_IMAGE_BASE64_CHARS) {
        return NextResponse.json({ error: 'Invalid image: image is too large' }, { status: 413, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
      }
      try {
        const imageBuffer = Buffer.from(imageData, 'base64');
        const validated = validateImageBuffer(imageBuffer, imageMimeType);
        validatedImage = {
          data: imageData,
          mimeType: validated.mimeType,
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : 'Image validation failed';
        return NextResponse.json({ error: `Invalid image: ${errMsg}` }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
      }
    }

    const securedInput = await secureAITextInput({
      userId,
      requestId,
      ip: clientIp,
      input: userText,
      conversationId,
      hasImage: Boolean(validatedImage),
    });
    const securedUserText = securedInput.sanitizedInput ?? userText;
    const savedUserText = message ? securedUserText : (validatedImage ? 'Image attached' : '');
    const operationPayloadHash = createHash('sha256')
      .update(savedUserText)
      .update('\0')
      .update(answerMode)
      .update('\0')
      .update(validatedImage ? createHash('sha256').update(validatedImage.data).digest('hex') : 'no-image')
      .digest('hex');
    let initialOperationId: string | null = null;
    if (!conversationId) {
      let claim;
      try {
        claim = await claimInitialChatOperation({ userId, clientRequestId: requestId, payloadHash: operationPayloadHash, initialMessage: savedUserText });
      } catch (error) {
        if (error instanceof ChatOperationConflictError) {
          return NextResponse.json({ error: error.message, code: error.code }, { status: 409, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
        }
        throw error;
      }
      conversationId = claim.conversationId;
      initialOperationId = claim.operationId;
      userMessageId = claim.userMessageId;
      if (claim.kind === 'completed' && claim.responseText) {
        const replayBody = `data: ${JSON.stringify({ type: 'conversation', conversationId, replayed: true })}\n\ndata: ${JSON.stringify({ type: 'token', token: claim.responseText })}\n\ndata: ${JSON.stringify({ type: 'done', replayed: true })}\n\n`;
        return new Response(replayBody, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, private' } });
      }
      if (claim.kind !== 'claimed') {
        return NextResponse.json({ error: claim.kind === 'in_progress' ? 'This message is already being processed.' : 'The previous attempt did not complete. Send it again as a new message.', code: claim.kind === 'in_progress' ? 'operation_in_progress' : claim.errorCode ?? 'operation_failed', conversationId }, { status: 409, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
      }
      createdForRequest = true;
    }
    const operationMetadata = { conversationId, operationType: 'chat.send', payloadHash: operationPayloadHash, ...(createdForRequest ? { idempotencyScope: 'initial-chat' } : {}) };
    try {
      await assertAIRequestNotProcessed({ userId, feature: validatedImage ? 'image' : 'chat', provider: 'Gemini', clientRequestId: requestId, metadata: operationMetadata });
    } catch (error) {
      if (initialOperationId) await failInitialChatOperation({ operationId: initialOperationId, userId, conversationId, errorCode: 'idempotency_check_failed' }).catch(() => undefined);
      throw error;
    }
    logger.info('Chat stream conversation selected', { userId, conversationId });

    const generationOwnerId = `${userId}:${requestId}`;
    const generationLockAcquired = await acquireAIGenerationLock(conversationId, generationOwnerId);
    if (!generationLockAcquired) {
      if (initialOperationId) await failInitialChatOperation({ operationId: initialOperationId, userId, conversationId, errorCode: 'generation_lock_unavailable' }).catch(() => undefined);
      return NextResponse.json(
        { error: 'A response is already being generated for this conversation.', code: 'generation_in_progress' },
        { status: 409, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } },
      );
    }
    const generationLease = startAIGenerationLockHeartbeat(conversationId, generationOwnerId);
    const generationSignal = AbortSignal.any([req.signal, generationLease.signal]);

    try {
    } catch (error) {
      generationLease.stop();
      await releaseAIGenerationLock(conversationId, generationOwnerId).catch(() => undefined);
      if (initialOperationId) await failInitialChatOperation({ operationId: initialOperationId, userId, conversationId, errorCode: 'operation_conflict' }).catch(() => undefined);
      throw error;
    }

    let historyForAI: GeminiMessage[];
    try {
      const historyStartedAt = Date.now();
      historyForAI = await getConversationHistoryForAI(conversationId);
      observeMonitoringLatency('database', Date.now() - historyStartedAt, { route: 'chat-stream', operation: 'history' });
    } catch (error) {
      generationLease.stop();
      await releaseAIGenerationLock(conversationId, generationOwnerId).catch(() => undefined);
      throw error;
    }

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const { enqueue, close, isStreamClosed } = createSafeStreamWriter(controller, generationSignal);
        let assistantMessageId: string | null = null;
        let assistantText = '';
        let promptHash = '';

        if (generationSignal.aborted) {
          if (initialOperationId) {
            await failInitialChatOperation({
              operationId: initialOperationId,
              userId,
              conversationId,
              errorCode: 'cancelled_before_start',
            }).catch(() => undefined);
          }
          generationLease.stop();
          await releaseAIGenerationLock(conversationId, generationOwnerId).catch(() => undefined);
          close();
          return;
        }

        try {
          promptHash = createHash('sha256').update(savedUserText.trim().toLowerCase()).digest('hex');
          const initializedTurn = await initializeStreamingTurn({
            conversationId,
            userId,
            requestId,
            userText: savedUserText,
            titleText: message || null,
            userMessageAlreadySaved: createdForRequest,
            repeatedPromptHash: promptHash,
          });
          userMessageId = initializedTurn.userMessageId;
          assistantMessageId = initializedTurn.assistantMessageId;
          if (userMessageId) {
            enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'user_message', messageId: userMessageId })}\n\n`));
          }
          if (assistantMessageId) {
            enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'assistant_message', messageId: assistantMessageId })}\n\n`));
          }
          enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'conversation', conversationId })}\n\n`));
          if (validatedImage) {
            enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'image', accepted: true, mimeType: validatedImage.mimeType })}\n\n`));
          }
        } catch (dbErr) {
          logger.error('Failed to save initial conversation state before streaming', {
            errorName: dbErr instanceof Error ? dbErr.name : 'UnknownError',
          });
          if (initialOperationId) await failInitialChatOperation({ operationId: initialOperationId, userId, conversationId, errorCode: 'persistence_start_failed' }).catch(() => undefined);
          generationLease.stop();
          await releaseAIGenerationLock(conversationId, generationOwnerId).catch(() => undefined);
          if (!isStreamClosed()) {
            enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: 'Unable to start the response. Please try again.' })}\n\n`));
          }
          close();
          return;
        }

        try {
          await executeAIRequest({
            user,
            clientIp,
            feature: validatedImage ? 'image' : 'chat',
            provider: 'Gemini',
            amount: 1,
            requestId,
            metadata: operationMetadata,
            pending: true,
            securityInput: securedUserText,
            securityDecision: securedInput,
            securityContext: { conversationId, hasImage: Boolean(validatedImage) },
            callback: async ({ billingDecision, sanitizedInput, reportUsage, reportProviderAttempt }) => {
              await generationLease.assertOwned();
              const sanitizedText = sanitizedInput ?? securedUserText;
              const imageInstruction = validatedImage
                ? '\nAn image is attached and available to you. Base the answer on visible details in that image, explicitly identify the relevant visual evidence, and say when any detail is uncertain. Do not give a generic answer that ignores the image.'
                : '';
              const modeInstruction = answerMode === 'short'
                ? '\nAnswer in 1-3 concise sentences. Prioritize the direct answer and omit optional background.'
                : '\nGive a thorough, structured explanation with useful context and examples where appropriate.';
              const userEntry: GeminiMessage = {
                role: 'user',
                parts: [
                  { text: `${sanitizedText}${imageInstruction}${modeInstruction}` },
                  ...(validatedImage ? [{ inlineData: { mimeType: validatedImage.mimeType, data: validatedImage.data } }] : []),
                ],
              };
              const priorHistory = createdForRequest ? historyForAI.slice(0, -1) : historyForAI;
              const tutorLanguage = await getTutorLanguage(userId);
              const contents: GeminiMessage[] = [
                { role: 'system', parts: [{ text: buildTutorLanguageInstruction(tutorLanguage) }] },
                ...priorHistory,
                userEntry,
              ];

              const modelToUse = billingDecision.modelUsed ?? undefined;
              assistantText = '';
              const generation = await askGeminiStream(contents, async (token: string) => {
                if (isStreamClosed()) {
                  return;
                }
                assistantText += token;
                const payload = JSON.stringify({ type: 'token', token });
                enqueue(encoder.encode(`data: ${payload}\n\n`));

              }, modelToUse, generationSignal, sanitizedText, reportUsage, async (model) => {
                await generationLease.assertOwned();
                return reportProviderAttempt(model);
              });

              if (generationLease.signal.aborted) {
                throw generationLease.signal.reason;
              }
              if (generation.outcome === 'cancelled' || req.signal.aborted || isStreamClosed()) {
                throw new AIGenerationCancelledError();
              }

              return generation.text;
            },
            beforeFinalize: async (aiResponse) => {
              await generationLease.assertOwned();
              const finalAssistantText = typeof aiResponse === 'string' ? aiResponse : String(aiResponse ?? '');
              if (assistantMessageId) {
                await prisma.conversationMessage.update({
                  where: { id: assistantMessageId },
                  data: { content: finalAssistantText, text: finalAssistantText, status: 'completed' },
                });
              }
              await updateConversationSummary(conversationId).catch((summaryError) => {
                logger.warn('Deferred conversation summary refresh', {
                  conversationId,
                  errorName: summaryError instanceof Error ? summaryError.name : 'UnknownError',
                });
              });
            },
          });

          if (initialOperationId) {
            await completeInitialChatOperation({ operationId: initialOperationId, userId, conversationId, responseText: assistantText });
          }

          if (!isStreamClosed()) {
            enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`));
          }
          observeMonitoringLatency('api', Date.now() - requestStartedAt, { route: 'chat-stream', operation: 'total' });
          close();
        } catch (err: unknown) {
          if (err instanceof AIGenerationCancelledError) {
            if (initialOperationId) await failInitialChatOperation({ operationId: initialOperationId, userId, conversationId, errorCode: 'generation_cancelled' }).catch(() => undefined);
            if (assistantMessageId) {
              await prisma.conversationMessage.deleteMany({
                where: { id: assistantMessageId, userId, status: 'streaming' },
              }).catch((dbErr) => {
                logger.error('Failed to discard cancelled assistant message', { error: String(dbErr), assistantMessageId });
              });
            }
            await updateConversationSummary(conversationId).catch(() => undefined);
            await prisma.chatAnalyticsEvent.create({
              data: { userId, conversationId, eventType: 'generation_cancelled', metadata: { requestId } },
            }).catch(() => undefined);
            if (!isStreamClosed()) {
              enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'cancelled' })}\n\n`));
            }
            close();
            return;
          }
          const appError = (() => {
            const status = typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status?: unknown }).status === 'number' ? (err as { status?: number }).status : undefined;
            return {
              message: 'We couldn’t finish that reply right now. Please try again shortly.',
              status,
            };
          })();
          logger.error('Chat stream error', { error: { message: appError.message, status: appError.status } });
          if (initialOperationId) await failInitialChatOperation({ operationId: initialOperationId, userId, conversationId, errorCode: 'generation_failed' }).catch(() => undefined);
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
        } finally {
          generationLease.stop();
          await releaseAIGenerationLock(conversationId, generationOwnerId).catch((lockError) => {
            logger.error('Failed to release chat generation lock', { conversationId, error: String(lockError) });
          });
        }
      }
    });

    return new Response(stream, {
      headers: {
        ...buildCorsHeaders(req.headers.get('origin')),
        'Access-Control-Allow-Methods': CORS_METHODS,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store, private',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      },
    });
  } catch (err: unknown) {
    if (err instanceof AIRequestGatewayError) {
      return NextResponse.json(err.body, { status: err.status, headers: { ...buildCorsHeaders(req.headers.get('origin')), ...err.headers, 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const message = err instanceof Error ? err.message : 'Streaming is temporarily unavailable. Please try again shortly.';
    const status = typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status?: unknown }).status === 'number' ? (err as { status?: number }).status : 503;
    logger.error('Chat stream route error', { error: { message, status } });
    return NextResponse.json({ error: message, code: 'stream_unavailable' }, { status, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
