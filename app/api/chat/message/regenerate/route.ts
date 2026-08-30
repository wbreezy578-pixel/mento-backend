import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import { askGeminiStream, GeminiMessage } from '../../../../../services/geminiService';
import {
  AIRequestGatewayError,
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  executeAIRequest,
  getClientIp,
  buildAIRequestId,
  assertAIRequestNotProcessed,
} from '../../../../../lib/aiSecurityGateway';
import { buildCorsHeaders } from '../../../../../lib/securityHeaders';
import logger from '../../../../../lib/logger';
import { createSafeStreamWriter } from '../../../../lib/streamUtils';
import { acquireAIGenerationLock, releaseAIGenerationLock } from '../../../../../lib/aiGenerationLock';
import { buildTutorLanguageInstruction, getTutorLanguage } from '../../../../../lib/userSettings';
import { createHash } from 'node:crypto';

const CORS_METHODS = 'POST, OPTIONS';

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS },
  });
}

function toGeminiMessages(messages: Array<{ role: string; content?: string | null; text?: string | null }>): GeminiMessage[] {
  return messages.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content ?? message.text ?? '' }],
  }));
}

export async function POST(req: Request) {
  try {
    const user = await authenticateAIRequest(req);
    const clientIp = getClientIp(req);
    await enforceAIGatewayRateLimit(user.id, clientIp);

    let body: { messageId?: unknown; answerMode?: unknown; requestId?: unknown } | null = null;
    try {
      body = (await req.json()) as { messageId?: unknown; answerMode?: unknown; requestId?: unknown };
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const messageId = typeof body?.messageId === 'string' ? body.messageId.trim() : '';
    const answerMode = body?.answerMode === 'short' ? 'short' : 'detailed';
    const requestId = typeof body?.requestId === 'string' && body.requestId.trim()
      ? body.requestId.trim()
      : buildAIRequestId('chat-regenerate');
    if (!messageId) {
      return NextResponse.json({ error: 'Invalid input: messageId is required' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const targetMessage = await prisma.conversationMessage.findUnique({
      where: { id: messageId },
      include: { conversation: { select: { id: true, userId: true } } },
    });

    if (!targetMessage) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    if (targetMessage.conversation.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    if (targetMessage.role !== 'assistant') {
      return NextResponse.json({ error: 'Only assistant messages can be regenerated' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const conversationId = targetMessage.conversation.id;
    const priorMessages = await prisma.conversationMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, text: true },
    });

    const targetIndex = priorMessages.findIndex((message) => message.id === messageId);
    if (targetIndex < 0) {
      return NextResponse.json({ error: 'Message not found in conversation' }, { status: 404, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const messagesBeforeTarget = priorMessages.slice(0, targetIndex);
    const lastUserMessage = [...messagesBeforeTarget].reverse().find((message) => message.role === 'user');
    const regeneratePrompt = lastUserMessage?.content ?? lastUserMessage?.text ?? '';

    if (!regeneratePrompt.trim()) {
      return NextResponse.json({ error: 'No preceding user prompt found to regenerate from' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const contextMessages = lastUserMessage
      ? messagesBeforeTarget.filter((message) => message.id !== lastUserMessage.id)
      : messagesBeforeTarget;

    const historyForAI = toGeminiMessages(contextMessages);
    const modeInstruction = answerMode === 'short'
      ? '\nAnswer in 1-3 concise sentences. Prioritize the direct answer and omit optional background.'
      : '\nGive a thorough, structured explanation with useful context and examples where appropriate.';
    const userEntry: GeminiMessage = { role: 'user', parts: [{ text: `${regeneratePrompt.trim()}${modeInstruction}` }] };
    const tutorLanguage = await getTutorLanguage(user.id);
    const contents: GeminiMessage[] = [
      { role: 'system', parts: [{ text: buildTutorLanguageInstruction(tutorLanguage) }] },
      ...historyForAI,
      userEntry,
    ];
    const operationPayloadHash = createHash('sha256')
      .update(messageId)
      .update('\0')
      .update(regeneratePrompt.trim())
      .update('\0')
      .update(answerMode)
      .digest('hex');
    const generationOwnerId = `${user.id}:${requestId}`;
    const generationLockAcquired = await acquireAIGenerationLock(conversationId, generationOwnerId);
    if (!generationLockAcquired) {
      return NextResponse.json(
        { error: 'A response is already being generated for this conversation.', code: 'generation_in_progress' },
        { status: 409, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } },
      );
    }
    try {
      await assertAIRequestNotProcessed({
        userId: user.id,
        feature: 'chat',
        provider: 'Gemini',
        clientRequestId: requestId,
        metadata: { conversationId, operationType: 'chat.regenerate', payloadHash: operationPayloadHash, targetMessageId: messageId },
      });
    } catch (error) {
      await releaseAIGenerationLock(conversationId, generationOwnerId).catch(() => undefined);
      throw error;
    }

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const { enqueue, close, isStreamClosed } = createSafeStreamWriter(controller, req.signal);
        let finalText = '';

        try {
          const { result: aiResponse } = await executeAIRequest({
            user,
            clientIp,
            feature: 'chat',
            provider: 'Gemini',
            amount: 1,
            requestId,
            metadata: { conversationId, operationType: 'chat.regenerate', payloadHash: operationPayloadHash, targetMessageId: messageId },
            pending: true,
            securityInput: regeneratePrompt.trim(),
            securityContext: { conversationId },
            callback: async ({ billingDecision }) => {
              const modelToUse = billingDecision.modelUsed ?? undefined;
              await askGeminiStream(contents, async (token: string) => {
                if (isStreamClosed()) {
                  return;
                }
                finalText += token;
                const payload = JSON.stringify({ type: 'token', token });
                enqueue(encoder.encode(`data: ${payload}\n\n`));
              }, modelToUse, req.signal, regeneratePrompt.trim());
              return finalText;
            },
          });

          await prisma.conversationMessage.update({
            where: { id: messageId },
            data: {
              content: aiResponse,
              text: aiResponse,
              status: 'completed',
            },
          });

          await prisma.conversation.update({
            where: { id: conversationId },
            data: { updatedAt: new Date() },
          });

          if (!isStreamClosed()) {
            enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`));
          }
          close();
        } catch (_err: unknown) {
          const message = 'We couldn’t regenerate that reply right now. Please try again shortly.';
          // Keep the last completed answer intact. The client may show streamed
          // draft text, but failed regeneration must never destroy durable content.
          if (!isStreamClosed()) {
            const errorPayload = JSON.stringify({ type: 'error', message });
            enqueue(encoder.encode(`data: ${errorPayload}\n\n`));
          }
          close();
        } finally {
          await releaseAIGenerationLock(conversationId, generationOwnerId).catch((lockError) => {
            logger.error('Failed to release regenerate lock', { conversationId, error: String(lockError) });
          });
        }
      },
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
      return NextResponse.json(err.body, { status: err.status });
    }
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    logger.error('Regenerate route failed', { error: err });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
