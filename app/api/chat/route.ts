import { NextResponse } from 'next/server';
import { askGemini, GeminiMessage } from '../../../services/geminiService';
import {
  getConversationHistoryForAI,
  validateConversationOwnership,
  createConversationWithInitialMessage,
  addMessageToConversation,
  setConversationTitleIfMissing,
  updateConversationSummary,
} from '@/lib/conversationDb';
import { AIRequestGatewayError, assertAIRequestNotProcessed, authenticateAIRequest, enforceAIGatewayRateLimit, executeAIRequest, getClientIp, buildAIRequestId } from '../../../lib/aiSecurityGateway';
import { validateImageBuffer } from '../../../lib/imageValidator';
import logger from '../../../lib/logger';
import { buildCorsHeaders } from '../../../lib/securityHeaders';
import { classifyAppError, createApiErrorResponse } from '../../../lib/errorHandling';
import { acquireAIGenerationLock, releaseAIGenerationLock } from '../../../lib/aiGenerationLock';
import { buildTutorLanguageInstruction, getTutorLanguage } from '../../../lib/userSettings';
import { createHash } from 'node:crypto';

const CORS_METHODS = 'POST, OPTIONS';

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
      body = (await req.json()) as { message?: unknown; image?: unknown; conversationId?: unknown; requestId?: unknown; answerMode?: unknown };
    } catch {
      return buildErrorResponse('Invalid JSON body', 400, 'validation_error', req.headers.get('origin'), requestId);
    }

    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    const image = body?.image;
    requestId = typeof body?.requestId === 'string' && body.requestId.trim()
      ? body.requestId.trim()
      : requestId;
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
    if (conversationId && !(await validateConversationOwnership(conversationId, userId))) {
      return buildErrorResponse('Forbidden', 403, 'authorization_failed', req.headers.get('origin'), requestId);
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
    }

    const savedUserText = message || (validatedImage ? 'Image attached' : '');
    if (!conversationId) {
      const conv = await createConversationWithInitialMessage(userId, savedUserText, { requestId });
      conversationId = conv.id;
      createdForRequest = true;
    }
    logger.info('Chat conversation selected', { userId, conversationId });

    const operationPayloadHash = createHash('sha256')
      .update(savedUserText)
      .update('\0')
      .update(answerMode)
      .update('\0')
      .update(validatedImage ? createHash('sha256').update(validatedImage.data).digest('hex') : 'no-image')
      .digest('hex');
    const generationOwnerId = `${userId}:${requestId}`;
    if (!(await acquireAIGenerationLock(conversationId, generationOwnerId))) {
      return buildErrorResponse('A response is already being generated for this conversation.', 409, 'generation_in_progress', req.headers.get('origin'), requestId);
    }

    try {
      await assertAIRequestNotProcessed({
        userId,
        feature: validatedImage ? 'image' : 'chat',
        provider: 'Gemini',
        clientRequestId: requestId,
        metadata: { conversationId, operationType: 'chat.send', payloadHash: operationPayloadHash },
      });

      const historyForAI = await getConversationHistoryForAI(conversationId);

    const result = await executeAIRequest({
      user,
      clientIp,
      feature: validatedImage ? 'image' : 'chat',
      provider: 'Gemini',
      amount: 1,
      requestId,
      metadata: { conversationId, operationType: 'chat.send', payloadHash: operationPayloadHash },
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
        const tutorLanguage = await getTutorLanguage(userId);
        const contents: GeminiMessage[] = [
          { role: 'system', parts: [{ text: buildTutorLanguageInstruction(tutorLanguage) }] },
          ...priorHistory,
          userEntry,
        ];

        const modelToUse = billingDecision.modelUsed ?? undefined;
        return askGemini(contents, modelToUse);
      },
    });

    try {
      if (message) {
        await setConversationTitleIfMissing(conversationId, message);
      }
      const assistantText = typeof result.result === 'string' ? result.result : String(result.result ?? '');
      if (!createdForRequest) {
        await addMessageToConversation(conversationId, 'user', savedUserText, userId, { requestId });
      }
      await addMessageToConversation(conversationId, 'assistant', assistantText, userId, { requestId });
      await updateConversationSummary(conversationId);
    } catch (dbErr) {
      logger.error('Failed to save chat to DB', { error: String(dbErr) });
    }

      return NextResponse.json({ result: result.result, conversationId }, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    } finally {
      await releaseAIGenerationLock(conversationId, generationOwnerId).catch((lockError) => {
        logger.error('Failed to release chat generation lock', { conversationId, error: String(lockError) });
      });
    }
  } catch (err: unknown) {
    if (err instanceof AIRequestGatewayError) {
      return NextResponse.json(err.body, { status: err.status, headers: buildJsonHeaders(req.headers.get('origin')) });
    }

    const appError = classifyAppError(err, { status: typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status?: unknown }).status === 'number' ? (err as { status?: number }).status : undefined, source: 'chat', requestId });
    const message = appError.message;
    const status = appError.httpStatus;
    logger.error('Chat route error', { error: { message, status, code: appError.code }, requestId });
    return buildErrorResponse(message, status, appError.code, req.headers.get('origin'), requestId);
  }
}
