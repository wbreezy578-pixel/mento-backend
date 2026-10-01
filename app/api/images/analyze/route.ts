import { NextResponse } from 'next/server';
import { analyzeImage } from '../../../../services/geminiService';
import saveChatToDatabase from '../../../../services/chatService';
import logger from '../../../../lib/logger';
import {
  AIRequestGatewayError,
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  executeAIRequest,
  getClientIp,
  buildAIRequestId,
  requireClientAIRequestId,
} from '../../../../lib/aiSecurityGateway';
import { validateImageBuffer, detectImageMimeType } from '../../../../lib/imageValidator';
import { classifyAppError, createApiErrorResponse } from '../../../../lib/errorHandling';
import { assertRequestContentLength, readJsonBodyWithLimit, RequestBodyError } from '../../../../lib/requestBody';
import { createHash } from 'node:crypto';

const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES ?? 10 * 1024 * 1024); // 10MB default
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_IMAGE_REQUEST_BYTES = MAX_IMAGE_BASE64_CHARS + 256 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

function buildJsonHeaders(requestId?: string) {
  const headers: Record<string, string> = {};
  if (requestId) {
    headers['x-request-id'] = requestId;
  }
  return headers;
}

function buildErrorResponse(message: string, status: number, code: string, requestId?: string, details?: unknown) {
  return NextResponse.json(createApiErrorResponse(message, { status, code, requestId, details }), { status, headers: buildJsonHeaders(requestId) });
}

type MultipartFormLike = {
  get: (key: string) => unknown;
};

function asMultipartForm(input: unknown): MultipartFormLike {
  return input as unknown as MultipartFormLike;
}

export async function POST(req: Request) {
  try {
    const user = await authenticateAIRequest(req);
    const clientIp = getClientIp(req);
    await enforceAIGatewayRateLimit(user.id, clientIp);

    let buffer: Buffer | null = null;
    let mimeType: string | null = null;
    let prompt: string | null = null;
    const contentType = req.headers.get('content-type') || '';
    assertRequestContentLength(req, MAX_IMAGE_REQUEST_BYTES);

    let requestId: string | undefined;
    let formVar: MultipartFormLike | null = null;
    if (contentType.includes('multipart/form-data')) {
      if (!req.headers.get('content-length')) {
        return buildErrorResponse('A Content-Length header is required for image uploads.', 411, 'validation_error', requestId);
      }
      formVar = asMultipartForm(await req.formData());
      requestId = requireClientAIRequestId(req, formVar.get('requestId'));
      const file = formVar.get('image');
      if (!file || typeof file === 'string' || typeof (file as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer !== 'function') {
        return buildErrorResponse('No image file provided', 400, 'validation_error', requestId);
      }
      const fileBlob = file as { arrayBuffer: () => Promise<ArrayBuffer>; type?: string };
      const ab = await fileBlob.arrayBuffer();
      buffer = Buffer.from(ab);
      mimeType = fileBlob.type || detectImageMimeType(new Uint8Array(ab));
    } else {
      const json = await readJsonBodyWithLimit<{ image?: unknown; prompt?: unknown; requestId?: unknown }>(req, MAX_IMAGE_REQUEST_BYTES);
      requestId = requireClientAIRequestId(req, json?.requestId);
      const img = json?.image;
      prompt = typeof json?.prompt === 'string' ? json.prompt : null;
      if (!img) return buildErrorResponse('No image provided', 400, 'validation_error', undefined);
      if (typeof img === 'string' && img.length > MAX_IMAGE_BASE64_CHARS + 128) {
        return buildErrorResponse('Image is too large.', 413, 'file_upload_error', requestId);
      }
      if (typeof img === 'string' && img.startsWith('data:')) {
        const match = img.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return buildErrorResponse('Invalid data URL', 400, 'validation_error', undefined);
        mimeType = match[1];
        buffer = Buffer.from(match[2], 'base64');
      } else if (typeof img === 'string') {
        buffer = Buffer.from(img, 'base64');
        mimeType = detectImageMimeType(new Uint8Array(buffer)) || null;
      } else {
        return buildErrorResponse('Invalid image payload', 400, 'validation_error', undefined);
      }
    }

    if (!buffer || buffer.length === 0) {
      return buildErrorResponse('Empty image', 400, 'validation_error', undefined);
    }

    // Validate image using shared validator
    let validated;
    try {
      validated = validateImageBuffer(buffer, mimeType ?? undefined);
      mimeType = validated.mimeType;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Image validation failed';
      if (errMsg.includes('exceeds max size')) {
        return buildErrorResponse(errMsg, 413, 'file_upload_error');
      }
      if (errMsg.includes('Unsupported') || errMsg.includes('not allowed')) {
        return buildErrorResponse(errMsg, 415, 'file_upload_error');
      }
      return buildErrorResponse(errMsg, 400, 'file_upload_error');
    }

    if (contentType.includes('multipart/form-data')) {
      const maybePrompt = formVar?.get('prompt');
      if (typeof maybePrompt === 'string') prompt = maybePrompt;
    }

    const operationPayloadHash = createHash('sha256')
      .update(buffer)
      .update('\0')
      .update(prompt?.trim() ?? '')
      .update('\0')
      .update(mimeType)
      .digest('hex');

    let persistedConversationId: string | null = null;
    const { result: analysisText, billingDecision } = await executeAIRequest({
        user,
        clientIp,
        feature: 'image',
        provider: 'Gemini',
        amount: 1,
        requestId,
        metadata: {
          operationType: 'image.analyze',
          payloadHash: operationPayloadHash,
          promptLength: prompt?.length ?? 0,
          mimeType,
          imageSize: buffer.length,
        },
        pending: true,
        securityInput: prompt ?? undefined,
        callback: async ({ billingDecision, reportUsage, reportProviderAttempt }) => {
          return await analyzeImage(buffer, mimeType, prompt ?? undefined, billingDecision.modelUsed ?? undefined, reportUsage, reportProviderAttempt);
        },
        beforeFinalize: async (result) => {
          const saved = await saveChatToDatabase(
            user.id,
            prompt?.trim() || 'Image uploaded for analysis',
            result,
            requestId,
          );
          persistedConversationId = saved.conversationId;
        },
    });

    return NextResponse.json({ analysis: analysisText, conversationId: persistedConversationId, billing: billingDecision });
  } catch (error: unknown) {
    if (error instanceof RequestBodyError) {
      return buildErrorResponse(error.message, error.status, error.code);
    }
    if (error instanceof AIRequestGatewayError) {
      return NextResponse.json(error.body, { status: error.status, headers: error.headers });
    }

    const appError = classifyAppError(error, { status: (error as { status?: number })?.status, source: 'image', requestId: buildAIRequestId('image-analyze') });
    const message = appError.message;
    const status = appError.httpStatus;
    logger.error('Image analyze route error:', { error: { message, status, code: appError.code } });
    return buildErrorResponse(message, status, appError.code, appError.requestId);
  }
}

export const runtime = 'nodejs';
