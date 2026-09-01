import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import { askGeminiStream, GeminiMessage } from '../../../../../services/geminiService';
import {
  AIRequestGatewayError,
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  executeAIRequest,
  getClientIp,
  requireClientAIRequestId,
  assertAIRequestNotProcessed,
  AIGenerationCancelledError,
} from '../../../../../lib/aiSecurityGateway';
import { buildCorsHeaders } from '../../../../../lib/securityHeaders';
import logger from '../../../../../lib/logger';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../../lib/requestBody';
import { createSafeStreamWriter } from '../../../../lib/streamUtils';
import { acquireAIGenerationLock, releaseAIGenerationLock, startAIGenerationLockHeartbeat } from '../../../../../lib/aiGenerationLock';
import { buildTutorLanguageInstruction, getTutorLanguage } from '../../../../../lib/userSettings';
import { buildConversationSummaryReset, getRegenerationContextForAI } from '../../../../../lib/conversationDb';
import { createHash } from 'node:crypto';

const CORS_METHODS = 'POST, OPTIONS';

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS },
  });
}

export async function POST(req: Request) {
  try {
    const user = await authenticateAIRequest(req);
    const clientIp = getClientIp(req);
    await enforceAIGatewayRateLimit(user.id, clientIp);

    let body: { messageId?: unknown; answerMode?: unknown; requestId?: unknown } | null = null;
    try {
      body = await readJsonBodyWithLimit<{ messageId?: unknown; answerMode?: unknown; requestId?: unknown }>(req, 8 * 1024);
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
      return NextResponse.json({ error: bodyError.message, code: bodyError.code }, { status: bodyError.status, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const messageId = typeof body?.messageId === 'string' ? body.messageId.trim() : '';
    const answerMode = body?.answerMode === 'short' ? 'short' : 'detailed';
    const requestId = requireClientAIRequestId(req, body?.requestId);
    if (!messageId) {
      return NextResponse.json({ error: 'Invalid input: messageId is required' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const targetMessage = await prisma.conversationMessage.findUnique({
      where: { id: messageId },
      include: { conversation: { select: { id: true, userId: true, source: true } } },
    });

    if (!targetMessage) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    if (targetMessage.conversation.userId !== user.id || targetMessage.conversation.source !== 'chat') {
      return NextResponse.json({ error: 'Message not found' }, { status: 404, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    if (targetMessage.role !== 'assistant') {
      return NextResponse.json({ error: 'Only assistant messages can be regenerated' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }
    if (targetMessage.status !== 'completed') {
      return NextResponse.json(
        { error: 'Only completed assistant messages can be regenerated', code: 'message_not_regenerable' },
        { status: 409, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } },
      );
    }

    const conversationId = targetMessage.conversation.id;
    let regenerationContext: Awaited<ReturnType<typeof getRegenerationContextForAI>>;
    try {
      regenerationContext = await getRegenerationContextForAI(conversationId, messageId);
    } catch (error) {
      logger.warn('Regeneration context unavailable', {
        conversationId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return NextResponse.json(
        { error: 'This reply cannot be regenerated from its saved conversation context.', code: 'regeneration_context_unavailable' },
        { status: 409, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } },
      );
    }
    const { history: historyForAI, prompt: regeneratePrompt } = regenerationContext;
    const tutorLanguage = await getTutorLanguage(user.id);
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
    const generationLease = startAIGenerationLockHeartbeat(conversationId, generationOwnerId);
    const generationSignal = AbortSignal.any([req.signal, generationLease.signal]);
    try {
      await assertAIRequestNotProcessed({
        userId: user.id,
        feature: 'chat',
        provider: 'Gemini',
        clientRequestId: requestId,
        metadata: { conversationId, operationType: 'chat.regenerate', payloadHash: operationPayloadHash, targetMessageId: messageId },
      });
    } catch (error) {
      generationLease.stop();
      await releaseAIGenerationLock(conversationId, generationOwnerId).catch(() => undefined);
      throw error;
    }

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const { enqueue, close, isStreamClosed } = createSafeStreamWriter(controller, generationSignal);
        let finalText = '';
        let deletedMessageIds: string[] = [];

        try {
          await executeAIRequest({
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
            callback: async ({ billingDecision, sanitizedInput, reportUsage, reportProviderAttempt }) => {
              await generationLease.assertOwned();
              const safePrompt = sanitizedInput ?? regeneratePrompt.trim();
              const modeInstruction = answerMode === 'short'
                ? '\nAnswer in 1-3 concise sentences. Prioritize the direct answer and omit optional background.'
                : '\nGive a thorough, structured explanation with useful context and examples where appropriate.';
              const contents: GeminiMessage[] = [
                { role: 'system', parts: [{ text: buildTutorLanguageInstruction(tutorLanguage) }] },
                ...historyForAI,
                { role: 'user', parts: [{ text: `${safePrompt}${modeInstruction}` }] },
              ];
              const modelToUse = billingDecision.modelUsed ?? undefined;
              const generation = await askGeminiStream(contents, async (token: string) => {
                if (isStreamClosed()) {
                  return;
                }
                finalText += token;
                const payload = JSON.stringify({ type: 'token', token });
                enqueue(encoder.encode(`data: ${payload}\n\n`));
              }, modelToUse, generationSignal, safePrompt, reportUsage, async (model) => {
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
              deletedMessageIds = await prisma.$transaction(async (tx) => {
                const staleMessages = await tx.conversationMessage.findMany({
                  where: {
                    conversationId,
                    OR: [
                      { createdAt: { gt: targetMessage.createdAt } },
                      { createdAt: targetMessage.createdAt, id: { gt: messageId } },
                    ],
                  },
                  select: { id: true },
                });
                const staleIds = staleMessages.map((entry) => entry.id);
                if (staleIds.length > 0) {
                  await tx.conversationMessage.deleteMany({ where: { id: { in: staleIds } } });
                }
                await tx.conversationMessage.update({
                  where: { id: messageId },
                  data: { content: aiResponse, text: aiResponse, status: 'completed' },
                });
                await tx.conversation.update({
                  where: { id: conversationId },
                  data: { updatedAt: new Date(), ...buildConversationSummaryReset() },
                });
                return staleIds;
              });
            },
          });

          if (!isStreamClosed()) {
            enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', deletedMessageIds })}\n\n`));
          }
          close();
        } catch (err: unknown) {
          if (err instanceof AIGenerationCancelledError) {
            if (!isStreamClosed()) {
              enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'cancelled' })}\n\n`));
            }
            close();
            return;
          }
          const message = 'We couldn’t regenerate that reply right now. Please try again shortly.';
          // Keep the last completed answer intact. The client may show streamed
          // draft text, but failed regeneration must never destroy durable content.
          if (!isStreamClosed()) {
            const errorPayload = JSON.stringify({ type: 'error', message });
            enqueue(encoder.encode(`data: ${errorPayload}\n\n`));
          }
          close();
        } finally {
          generationLease.stop();
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
      return NextResponse.json(err.body, { status: err.status, headers: { ...buildCorsHeaders(req.headers.get('origin')), ...err.headers, 'Access-Control-Allow-Methods': CORS_METHODS } });
    }
    logger.error('Regenerate route failed', { error: err });
    return NextResponse.json({ error: 'Unable to regenerate the reply.', code: 'regeneration_failed' }, { status: 500, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
