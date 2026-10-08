import { NextResponse } from 'next/server';
import { prisma } from '../../../../lib/prisma';
import { askGeminiStream, buildGeminiFailureTelemetry, GeminiMessage } from '../../../../services/geminiService';
import {
  getConversationHistoryForAI,
  validateConversationOwnership,
  initializeStreamingTurn,
  refreshConversationSummarySafely,
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
import { buildChatRuntimeContext } from '../chatRuntimeContext';
import { ChatOperationConflictError, claimInitialChatOperation, completeInitialChatOperation, failInitialChatOperation } from '../../../../services/chatOperationService';
import { observeChatGenerationTotal, observeChatHistoryLoad, observeChatTimeToFirstToken, recordChatFirstTokenMissing } from '../../../../lib/metrics';

const CORS_METHODS = 'POST, OPTIONS';
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_CHAT_JSON_BYTES = MAX_IMAGE_BASE64_CHARS + 128 * 1024;
const SLOW_FIRST_TOKEN_WARN_MS = 5_000;

function getSafePreflightErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { code?: unknown; errorCode?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : candidate.errorCode;
  return typeof code === 'string' && /^P\d{4}$/.test(code) ? code : undefined;
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS },
  });
}

export async function POST(req: Request) {
  const requestStartedAt = Date.now();
  const startupStageMs: Record<string, number | null> = {
    authentication: null,
    rateLimit: null,
    conversationOwnership: null,
    inputSecurity: null,
    initialOperationClaim: null,
    idempotency: null,
    generationLock: null,
    billingReservation: null,
    languageSettings: null,
    providerUsageAttempt: null,
  };
  try {
    logger.info('Chat stream auth attempt', {
      origin: req.headers.get('origin') ?? null,
      host: req.headers.get('host') ?? null,
      method: req.method,
      url: req.url,
    });

    const authStartedAt = Date.now();
    const user = await authenticateAIRequest(req);
    startupStageMs.authentication = Date.now() - authStartedAt;
    observeMonitoringLatency('api', startupStageMs.authentication, { route: 'chat-stream', operation: 'auth' });
    const userId = user.id;
    logger.info('Authenticated chat stream user', { userId });

    const clientIp = getClientIp(req);
    const rateLimitStartedAt = Date.now();
    await enforceAIGatewayRateLimit(userId, clientIp);
    startupStageMs.rateLimit = Date.now() - rateLimitStartedAt;
    observeMonitoringLatency('api', startupStageMs.rateLimit, { route: 'chat-stream', operation: 'rate-limit' });

    let body: { message?: unknown; image?: unknown; conversationId?: unknown; requestId?: unknown; answerMode?: unknown; timeZone?: unknown; locationContext?: unknown } | null = null;
    try {
      body = await readJsonBodyWithLimit<{ message?: unknown; image?: unknown; conversationId?: unknown; requestId?: unknown; answerMode?: unknown; timeZone?: unknown; locationContext?: unknown }>(req, MAX_CHAT_JSON_BYTES);
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
      return NextResponse.json({ error: bodyError.message, code: bodyError.code }, { status: bodyError.status, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    logger.info('Chat stream request payload received', { body: body ? { messageLength: String(body?.message || '').length, hasImage: Boolean(body?.image), conversationId: body?.conversationId ?? null } : null });

    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    const image = body?.image;
    const requestId = requireClientAIRequestId(req, body?.requestId);
    const answerMode = body?.answerMode === 'detailed' ? 'detailed' : 'short';
    const runtimeContext = buildChatRuntimeContext({
      now: new Date(requestStartedAt),
      timeZone: body?.timeZone,
      locationContext: body?.locationContext,
    });

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
    if (conversationId) {
      const ownershipStartedAt = Date.now();
      const ownsConversation = await validateConversationOwnership(conversationId, userId, 'chat');
      startupStageMs.conversationOwnership = Date.now() - ownershipStartedAt;
      if (!ownsConversation) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
      }
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

    const securityStartedAt = Date.now();
    const securedInput = await secureAITextInput({
      userId,
      requestId,
      ip: clientIp,
      input: userText,
      conversationId,
      hasImage: Boolean(validatedImage),
    });
    startupStageMs.inputSecurity = Date.now() - securityStartedAt;
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
      const claimStartedAt = Date.now();
      let claim;
      try {
        claim = await claimInitialChatOperation({ userId, clientRequestId: requestId, payloadHash: operationPayloadHash, initialMessage: savedUserText });
      } catch (error) {
        if (error instanceof ChatOperationConflictError) {
          return NextResponse.json({ error: error.message, code: error.code }, { status: 409, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
        }
        throw error;
      }
      startupStageMs.initialOperationClaim = Date.now() - claimStartedAt;
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
    const idempotencyStartedAt = Date.now();
    try {
      await assertAIRequestNotProcessed({ userId, feature: validatedImage ? 'image' : 'chat', provider: 'Gemini', clientRequestId: requestId, metadata: operationMetadata });
      startupStageMs.idempotency = Date.now() - idempotencyStartedAt;
    } catch (error) {
      if (initialOperationId) await failInitialChatOperation({ operationId: initialOperationId, userId, conversationId, errorCode: 'idempotency_check_failed' }).catch(() => undefined);
      throw error;
    }
    logger.info('Chat stream conversation selected', {
      userId,
      conversationId,
      elapsedMs: Date.now() - requestStartedAt,
    });

    const generationOwnerId = `${userId}:${requestId}`;
    const generationLockStartedAt = Date.now();
    const generationLockAcquired = await acquireAIGenerationLock(conversationId, generationOwnerId);
    startupStageMs.generationLock = Date.now() - generationLockStartedAt;
    observeMonitoringLatency('api', startupStageMs.generationLock, {
      route: 'chat-stream',
      operation: 'generation-lock',
      status: generationLockAcquired ? 'acquired' : 'contended',
    });
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

    let historyForAI: GeminiMessage[] = [];
    let historyDurationMs = 0;
    let historyReadyAt = 0;

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const { enqueue, close, isStreamClosed } = createSafeStreamWriter(controller, generationSignal);
        let assistantMessageId: string | null = null;
        let assistantText = '';
        let promptHash = '';
        let turnInitializationDurationMs: number | null = null;
        let contextPreparationDurationMs: number | null = null;
        let geminiServiceStartedAt: number | null = null;
        let geminiStartedAt: number | null = null;
        let geminiFinishedAt: number | null = null;
        let firstTokenAt: number | null = null;
        let failureStage = 'turn_initialization';
        let streamPreparationPromise: Promise<void> | null = null;

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

        promptHash = createHash('sha256').update(savedUserText.trim().toLowerCase()).digest('hex');
        const turnStartedAt = Date.now();
        const turnInitializationPromise = initializeStreamingTurn({
            conversationId,
            userId,
            requestId,
            userText: savedUserText,
            titleText: message || null,
            userMessageAlreadySaved: createdForRequest,
            repeatedPromptHash: promptHash,
          }).then((initializedTurn) => {
          turnInitializationDurationMs = Date.now() - turnStartedAt;
          userMessageId = initializedTurn.userMessageId;
          assistantMessageId = initializedTurn.assistantMessageId;
          logger.info('Chat stream turn initialized', {
            conversationId,
            elapsedMs: Date.now() - requestStartedAt,
          });
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
          return initializedTurn;
        });
        const historyStartedAt = Date.now();
        const historyPromise = getConversationHistoryForAI(conversationId, { excludeMessageRequestId: requestId }).then((history) => {
          historyForAI = history;
          historyDurationMs = Date.now() - historyStartedAt;
          historyReadyAt = Date.now();
          observeMonitoringLatency('database', historyDurationMs, { route: 'chat-stream', operation: 'history' });
          observeChatHistoryLoad(historyDurationMs, historyForAI.length > 30 ? 'long' : 'fresh');
          observeMonitoringLatency('api', historyReadyAt - requestStartedAt, { route: 'chat-stream', operation: 'history-ready' });
          logger.info('Chat stream history ready', {
            conversationId,
            elapsedMs: historyReadyAt - requestStartedAt,
          });
          return history;
        });
        const setupPromise = Promise.allSettled([turnInitializationPromise, historyPromise]).then(([turnResult, historyResult]) => {
          if (turnResult.status === 'rejected') throw turnResult.reason;
          if (historyResult.status === 'rejected') throw historyResult.reason;
          return { initializedTurn: turnResult.value, history: historyResult.value };
        });
        streamPreparationPromise = setupPromise.then(() => undefined);
        void streamPreparationPromise.catch(() => undefined);

        try {
          const gatewayStartedAt = Date.now();
          const languageLookupStartedAt = Date.now();
          const tutorLanguagePromise = getTutorLanguage(userId).then(
            (language) => ({ language, durationMs: Date.now() - languageLookupStartedAt }),
            (error: unknown) => ({ error, durationMs: Date.now() - languageLookupStartedAt }),
          );
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
              startupStageMs.billingReservation = Date.now() - gatewayStartedAt;
              await generationLease.assertOwned();
              failureStage = 'context_preparation';
              const contextStartedAt = Date.now();
              const { history: preparedHistory } = await setupPromise;
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
              const priorHistory = preparedHistory;
              const languageResult = await tutorLanguagePromise;
              startupStageMs.languageSettings = languageResult.durationMs;
              observeMonitoringLatency('database', startupStageMs.languageSettings, {
                route: 'chat-stream',
                operation: 'settings-language',
              });
              if ('error' in languageResult) throw languageResult.error;
              const tutorLanguage = languageResult.language;
              const contents: GeminiMessage[] = [
                { role: 'system', parts: [{ text: `${buildTutorLanguageInstruction(tutorLanguage)}\n${runtimeContext}` }] },
                ...priorHistory,
                userEntry,
              ];
              contextPreparationDurationMs = Date.now() - contextStartedAt;

              const modelToUse = answerMode === 'short' && !validatedImage
                ? 'gemini-3.1-flash-lite'
                : billingDecision.modelUsed ?? undefined;
              assistantText = '';
              geminiServiceStartedAt = Date.now();
              geminiStartedAt = null;
              failureStage = 'gemini_provider';
              let firstTokenObserved = false;
              observeMonitoringLatency('api', geminiServiceStartedAt - requestStartedAt, {
                route: 'chat-stream',
                operation: 'gemini-service-start',
              });
              const generation = await askGeminiStream(contents, async (token: string) => {
                if (isStreamClosed()) {
                  return;
                }
                if (!firstTokenObserved) {
                  firstTokenObserved = true;
                  firstTokenAt = Date.now();
                  observeMonitoringLatency('gemini', firstTokenAt - geminiStartedAt!, {
                    provider: 'Gemini',
                    operation: 'first-token',
                    status: 'success',
                  });
                  observeChatTimeToFirstToken(firstTokenAt - requestStartedAt, answerMode);
                  const endToEndElapsedMs = firstTokenAt - requestStartedAt;
                  const geminiElapsedMs = firstTokenAt - geminiStartedAt!;
                  // Production suppresses routine info logs. Keep this event at
                  // warn level so Cloud Logging can measure every user-visible
                  // first token, while the category identifies slow requests.
                  logger.warn('Chat stream first Gemini token', {
                    requestId,
                    conversationId,
                    startupStageMs,
                    category: endToEndElapsedMs >= SLOW_FIRST_TOKEN_WARN_MS ? 'chat_first_token_slow' : 'chat_first_token',
                    answerMode,
                    historyDurationMs,
                    requestToHistoryReadyMs: historyReadyAt ? historyReadyAt - requestStartedAt : null,
                    historyMessageCount: historyForAI.length,
                    turnInitializationDurationMs,
                    contextPreparationDurationMs,
                    requestToGeminiStartMs: geminiStartedAt === null ? null : geminiStartedAt - requestStartedAt,
                    geminiPreflightMs: geminiServiceStartedAt === null || geminiStartedAt === null ? null : geminiStartedAt - geminiServiceStartedAt,
                    endToEndElapsedMs,
                    geminiElapsedMs,
                  });
                }
                assistantText += token;
                const payload = JSON.stringify({ type: 'token', token });
                enqueue(encoder.encode(`data: ${payload}\n\n`));

              }, modelToUse, generationSignal, sanitizedText, reportUsage, async (model) => {
                const preflightStartedAt = Date.now();
                let preflightStep = 'generation_lease';
                try {
                  await generationLease.assertOwned();
                  preflightStep = 'usage_attempt';
                  const usageAttemptStartedAt = Date.now();
                  const attempt = await reportProviderAttempt(model);
                  startupStageMs.providerUsageAttempt = Date.now() - usageAttemptStartedAt;
                  return attempt;
                } catch (error) {
                  logger.error('Chat provider preflight failed', {
                    requestId,
                    step: preflightStep,
                    model,
                    errorName: error instanceof Error ? error.name : 'UnknownError',
                    errorCode: getSafePreflightErrorCode(error),
                    elapsedMs: Date.now() - preflightStartedAt,
                  });
                  throw error;
                }
              }, sanitizedText, {
                requestId,
                normalChatRecovery: true,
                onProviderStart: () => {
                  if (geminiStartedAt === null) geminiStartedAt = Date.now();
                },
              });

              geminiFinishedAt = Date.now();

              if (generationLease.signal.aborted) {
                throw generationLease.signal.reason;
              }
              if (!firstTokenObserved) {
                recordChatFirstTokenMissing(answerMode);
                logger.warn('Chat stream completed without a first Gemini token', {
                  requestId,
                  conversationId,
                  category: 'chat_first_token_missing',
                  answerMode,
                  generationOutcome: generation.outcome,
                  endToEndElapsedMs: Date.now() - requestStartedAt,
                });
              }
              if (generation.outcome === 'cancelled' || req.signal.aborted || isStreamClosed()) {
                throw new AIGenerationCancelledError();
              }

              failureStage = 'finalization';
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
            },
          });

          if (initialOperationId) {
            await completeInitialChatOperation({ operationId: initialOperationId, userId, conversationId, responseText: assistantText });
          }

          if (!isStreamClosed()) {
            enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`));
          }
          void refreshConversationSummarySafely(conversationId).catch((summaryError) => {
            logger.warn('Conversation summary refresh deferred after chat response', {
              conversationId,
              errorName: summaryError instanceof Error ? summaryError.name : 'UnknownError',
            });
          });
          const totalGenerationMs = Date.now() - requestStartedAt;
          observeMonitoringLatency('api', totalGenerationMs, { route: 'chat-stream', operation: 'total' });
          observeChatGenerationTotal(totalGenerationMs, 'success');
          logger.warn('Chat stream stage timings', {
            requestId,
            conversationId,
            startupStageMs,
            outcome: 'completed',
            requestToHistoryReadyMs: historyReadyAt ? historyReadyAt - requestStartedAt : null,
            historyLoadDurationMs: historyDurationMs,
            historyMessageCount: historyForAI.length,
            turnInitializationDurationMs,
            contextPreparationDurationMs,
            requestToGeminiServiceStartMs: geminiServiceStartedAt === null ? null : geminiServiceStartedAt - requestStartedAt,
            requestToGeminiStartMs: geminiStartedAt === null ? null : geminiStartedAt - requestStartedAt,
            geminiPreflightMs: geminiServiceStartedAt === null || geminiStartedAt === null ? null : geminiStartedAt - geminiServiceStartedAt,
            geminiToFirstTokenMs: geminiStartedAt === null || firstTokenAt === null ? null : firstTokenAt - geminiStartedAt,
            requestToFirstTokenMs: firstTokenAt === null ? null : firstTokenAt - requestStartedAt,
            geminiStreamDurationMs: geminiStartedAt === null || geminiFinishedAt === null ? null : geminiFinishedAt - geminiStartedAt,
            requestToGeminiStreamFinishedMs: geminiFinishedAt === null ? null : geminiFinishedAt - requestStartedAt,
            requestToResponseFinalizedMs: totalGenerationMs,
            responseCharacterCount: assistantText.length,
          });
          close();
        } catch (err: unknown) {
          if (streamPreparationPromise) await streamPreparationPromise.catch(() => undefined);
          if (err instanceof AIGenerationCancelledError) {
            observeChatGenerationTotal(Date.now() - requestStartedAt, 'cancelled');
            if (initialOperationId) await failInitialChatOperation({ operationId: initialOperationId, userId, conversationId, errorCode: 'generation_cancelled' }).catch(() => undefined);
            if (assistantMessageId) {
              await prisma.conversationMessage.deleteMany({
                where: { id: assistantMessageId, userId, status: 'streaming' },
              }).catch((dbErr) => {
                logger.error('Failed to discard cancelled assistant message', { error: String(dbErr), assistantMessageId });
              });
            }
            await refreshConversationSummarySafely(conversationId);
            await prisma.chatAnalyticsEvent.create({
              data: { userId, conversationId, eventType: 'generation_cancelled', metadata: { requestId } },
            }).catch(() => undefined);
            if (!isStreamClosed()) {
              enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'cancelled' })}\n\n`));
            }
            close();
            return;
          }
          const gatewayBody = err instanceof AIRequestGatewayError && err.body && typeof err.body === 'object' && !Array.isArray(err.body)
            ? err.body as Record<string, unknown>
            : null;
          const appError = {
            message: typeof gatewayBody?.error === 'string'
              ? gatewayBody.error
              : 'We couldn’t finish that reply right now. Please try again shortly.',
            status: err instanceof AIRequestGatewayError
              ? err.status
              : typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status?: unknown }).status === 'number'
                ? (err as { status?: number }).status
                : undefined,
            code: typeof gatewayBody?.code === 'string' ? gatewayBody.code : 'stream_error',
            upgradeAvailable: gatewayBody?.upgradeAvailable === true,
            resetTime: typeof gatewayBody?.resetTime === 'string' ? gatewayBody.resetTime : null,
          };
          observeChatGenerationTotal(Date.now() - requestStartedAt, 'failed');
          const failureTelemetry = buildGeminiFailureTelemetry(err);
          const safeError = typeof err === 'object' && err !== null ? err as Record<string, unknown> : null;
          const failedAt = Date.now();
          logger.error('Chat stream error', {
            requestId,
            conversationId,
            startupStageMs,
            stage: failureStage,
            errorName: err instanceof Error ? err.name : 'UnknownError',
            status: appError.status,
            providerCategory: safeError?.providerCategory ?? failureTelemetry.category,
            providerCode: safeError?.providerCode ?? failureTelemetry.providerCode,
            retryable: safeError?.retryable ?? failureTelemetry.retryable,
            providerAttemptCount: safeError?.providerAttemptCount,
            requestElapsedMs: failedAt - requestStartedAt,
            requestToHistoryReadyMs: historyReadyAt ? historyReadyAt - requestStartedAt : null,
            historyLoadDurationMs: historyDurationMs,
            historyMessageCount: historyForAI.length,
            turnInitializationDurationMs,
            contextPreparationDurationMs,
            requestToGeminiServiceStartMs: geminiServiceStartedAt === null ? null : geminiServiceStartedAt - requestStartedAt,
            requestToGeminiStartMs: geminiStartedAt === null ? null : geminiStartedAt - requestStartedAt,
            geminiPreflightMs: geminiServiceStartedAt === null || geminiStartedAt === null ? null : geminiStartedAt - geminiServiceStartedAt,
            geminiElapsedMs: geminiStartedAt === null ? null : failedAt - geminiStartedAt,
            geminiToFirstTokenMs: geminiStartedAt === null || firstTokenAt === null ? null : firstTokenAt - geminiStartedAt,
            requestToFirstTokenMs: firstTokenAt === null ? null : firstTokenAt - requestStartedAt,
            partialResponseCharacterCount: assistantText.length,
          });
          if (initialOperationId) await failInitialChatOperation({ operationId: initialOperationId, userId, conversationId, errorCode: 'generation_failed' }).catch(() => undefined);
          if (assistantMessageId) {
            await prisma.conversationMessage.update({
              where: { id: assistantMessageId },
              data: { status: 'failed' },
            }).catch((dbErr) => {
              logger.error('Failed to mark assistant message as failed', { error: String(dbErr), assistantMessageId });
            });
          }
          await refreshConversationSummarySafely(conversationId);
          await prisma.chatAnalyticsEvent.create({
            data: { userId, conversationId, messageId: assistantMessageId, eventType: 'unanswered_question', metadata: { requestId, reason: 'generation_failed' } },
          }).catch(() => undefined);
          if (!isStreamClosed()) {
            const errPayload = JSON.stringify({
              type: 'error',
              message: appError.message,
              code: appError.code,
              upgradeAvailable: appError.upgradeAvailable,
              resetTime: appError.resetTime,
            });
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
