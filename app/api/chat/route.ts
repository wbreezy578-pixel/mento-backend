import { NextResponse } from 'next/server';
import { askGemini, GeminiMessage } from '../../../services/geminiService';
import {
  getConversationHistoryForAI,
  validateConversationOwnership,
  persistCompletedChatExchange,
  setConversationTitleIfMissing,
  updateConversationSummary,
} from '@/lib/conversationDb';
import { AIRequestGatewayError, assertAIRequestNotProcessed, authenticateAIRequest, enforceAIGatewayRateLimit, executeAIRequest, getClientIp, buildAIRequestId, requireClientAIRequestId, secureAITextInput } from '../../../lib/aiSecurityGateway';
import { MAX_IMAGE_BYTES, validateImageBuffer } from '../../../lib/imageValidator';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../lib/requestBody';
import logger from '../../../lib/logger';
import { buildCorsHeaders } from '../../../lib/securityHeaders';
import { classifyAppError, createApiErrorResponse } from '../../../lib/errorHandling';
import { acquireAIGenerationLock, releaseAIGenerationLock, startAIGenerationLockHeartbeat } from '../../../lib/aiGenerationLock';
import { buildTutorLanguageInstruction, getTutorLanguage } from '../../../lib/userSettings';
import { createHash } from 'node:crypto';
import { ChatOperationConflictError, claimInitialChatOperation, completeInitialChatOperation, failInitialChatOperation } from '../../../services/chatOperationService';

const CORS_METHODS = 'POST, OPTIONS';
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_CHAT_JSON_BYTES = MAX_IMAGE_BASE64_CHARS + 128 * 1024;

function buildJsonHeaders(requestOrigin?: string | null, requestId?: string) {
  const headers = { ...buildCorsHeaders(requestOrigin), 'Access-Control-Allow-Methods': CORS_METHODS } as Record<string, string>;
  if (requestId) {
    headers['x-request-id'] = requestId;
  }
  return headers;
}

function buildErrorResponse(message: string, status: number, code: string, requestOrigin?: string | null, requestId?: string, details?: unknown) {
  return NextResponse.json(createApiErrorResponse(message, { status, code, requestId, details }), {
    status,
    headers: buildJsonHeaders(requestOrigin, requestId),
  });
}

export async function OPTIONS(req: Request) {
  logger.info('Chat OPTIONS preflight', {
    origin: req.headers.get('origin'),
  });
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS },
  });
}

export async function POST(req: Request) {
  logger.info('Chat POST received', { origin: req.headers.get('origin') });
  let requestId = buildAIRequestId('chat');
  try {
    const user = await authenticateAIRequest(req);
    const userId = user.id;
    logger.info('Authenticated chat user', { userId });

    const clientIp = getClientIp(req);
    await enforceAIGatewayRateLimit(userId, clientIp);

    let body: { message?: unknown; image?: unknown; conversationId?: unknown; requestId?: unknown; answerMode?: unknown } | null = null;
    try {
      body = await readJsonBodyWithLimit<{ message?: unknown; image?: unknown; conversationId?: unknown; requestId?: unknown; answerMode?: unknown }>(req, MAX_CHAT_JSON_BYTES);
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
      return buildErrorResponse(bodyError.message, bodyError.status, bodyError.code, req.headers.get('origin'), requestId);
    }

    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    const image = body?.image;
    requestId = requireClientAIRequestId(req, body?.requestId);
    const answerMode = body?.answerMode === 'short' ? 'short' : 'detailed';

    if (!message && !image) {
      return buildErrorResponse('Invalid input: message or image is required', 400, 'validation_error', req.headers.get('origin'), requestId);
    }

    if (image !== undefined && image !== null && typeof image !== 'object') {
      return buildErrorResponse('Invalid input: image payload is malformed', 400, 'validation_error', req.headers.get('origin'), requestId);
    }

    const imagePayload = image && typeof image === 'object'
      ? image as { data?: unknown; mimeType?: unknown; uri?: unknown }
      : null;

    let conversationId = typeof body?.conversationId === 'string' ? body.conversationId : undefined;
    let createdForRequest = false;
    if (conversationId && !(await validateConversationOwnership(conversationId, userId, 'chat'))) {
      return buildErrorResponse('Conversation not found', 404, 'not_found', req.headers.get('origin'), requestId);
    }

    const userText = message || (imagePayload ? 'Please analyze the attached image and explain it clearly as a tutor.' : '');

    // Validate image if provided
    let validatedImage: { data: string; mimeType: string; uri?: string | null } | null = null;
    if (imagePayload) {
      if (typeof imagePayload.data !== 'string' || typeof imagePayload.mimeType !== 'string') {
        return buildErrorResponse('Invalid image: data and mimeType are required', 400, 'validation_error', req.headers.get('origin'), requestId);
      }
      try {
        const imageBuffer = Buffer.from(imagePayload.data, 'base64');
        const validated = validateImageBuffer(imageBuffer, imagePayload.mimeType);
        validatedImage = {
          data: imagePayload.data,
          mimeType: validated.mimeType,
          uri: typeof imagePayload.uri === 'string' ? imagePayload.uri : undefined,
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : 'Image validation failed';
        return buildErrorResponse(`Invalid image: ${errMsg}`, 400, 'file_upload_error', req.headers.get('origin'), requestId);
      }
      if (imagePayload.data.length > MAX_IMAGE_BASE64_CHARS) {
        return buildErrorResponse('Invalid image: image is too large', 413, 'file_upload_error', req.headers.get('origin'), requestId);
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
        if (error instanceof ChatOperationConflictError) return buildErrorResponse(error.message, 409, error.code, req.headers.get('origin'), requestId);
        throw error;
      }
      conversationId = claim.conversationId;
      initialOperationId = claim.operationId;
      if (claim.kind === 'completed' && claim.responseText) {
        return NextResponse.json({ result: claim.responseText, conversationId, replayed: true }, { headers: buildJsonHeaders(req.headers.get('origin'), requestId) });
      }
      if (claim.kind !== 'claimed') {
        return buildErrorResponse(claim.kind === 'in_progress' ? 'This message is already being processed.' : 'The previous attempt did not complete. Send it again as a new message.', 409, claim.kind === 'in_progress' ? 'operation_in_progress' : claim.errorCode ?? 'operation_failed', req.headers.get('origin'), requestId, { conversationId });
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
    logger.info('Chat conversation selected', { userId, conversationId });

    const generationOwnerId = `${userId}:${requestId}`;
    if (!(await acquireAIGenerationLock(conversationId, generationOwnerId))) {
      if (initialOperationId) await failInitialChatOperation({ operationId: initialOperationId, userId, conversationId, errorCode: 'generation_lock_unavailable' }).catch(() => undefined);
      return buildErrorResponse('A response is already being generated for this conversation.', 409, 'generation_in_progress', req.headers.get('origin'), requestId);
    }
    const generationLease = startAIGenerationLockHeartbeat(conversationId, generationOwnerId);

    try {
      const historyForAI = await getConversationHistoryForAI(conversationId);

    const result = await executeAIRequest({
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
        const tutorLanguage = await getTutorLanguage(userId);
        const contents: GeminiMessage[] = [
          { role: 'system', parts: [{ text: buildTutorLanguageInstruction(tutorLanguage) }] },
          ...priorHistory,
          userEntry,
        ];

        const modelToUse = billingDecision.modelUsed ?? undefined;
        return askGemini(contents, modelToUse, reportUsage, async (model) => {
          await generationLease.assertOwned();
          return reportProviderAttempt(model);
        }, generationLease.signal);
      },
      beforeFinalize: async (aiResponse) => {
        await generationLease.assertOwned();
        if (message) await setConversationTitleIfMissing(conversationId, message);
        const assistantText = typeof aiResponse === 'string' ? aiResponse : String(aiResponse ?? '');
        await persistCompletedChatExchange({
          conversationId,
          userId,
          requestId,
          userText: savedUserText,
          assistantText,
          userMessageAlreadySaved: createdForRequest,
        });
        // Summary is derived from the durable completed messages. A summary
        // refresh failure must not misrepresent whether the exchange was saved.
        await updateConversationSummary(conversationId).catch((summaryError) => {
          logger.warn('Deferred conversation summary refresh', {
            conversationId,
            errorName: summaryError instanceof Error ? summaryError.name : 'UnknownError',
          });
        });
      },
    });

      if (initialOperationId) await completeInitialChatOperation({ operationId: initialOperationId, userId, conversationId, responseText: result.result });
      return NextResponse.json({ result: result.result, conversationId }, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    } catch (error) {
      if (initialOperationId) await failInitialChatOperation({ operationId: initialOperationId, userId, conversationId, errorCode: 'generation_failed' }).catch(() => undefined);
      throw error;
    } finally {
      generationLease.stop();
      await releaseAIGenerationLock(conversationId, generationOwnerId).catch((lockError) => {
        logger.error('Failed to release chat generation lock', { conversationId, error: String(lockError) });
      });
    }
  } catch (err: unknown) {
    if (err instanceof AIRequestGatewayError) {
      return NextResponse.json(err.body, { status: err.status, headers: { ...buildJsonHeaders(req.headers.get('origin')), ...err.headers } });
    }

    const appError = classifyAppError(err, { status: typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status?: unknown }).status === 'number' ? (err as { status?: number }).status : undefined, source: 'chat', requestId });
    const message = appError.message;
    const status = appError.httpStatus;
    logger.error('Chat route error', { error: { message, status, code: appError.code }, requestId });
    return buildErrorResponse(message, status, appError.code, req.headers.get('origin'), requestId);
  }
}
