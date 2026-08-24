import { NextResponse } from 'next/server';
import { analyzeImage } from '../../../../services/geminiService';
import saveChatToDatabase from '../../../../services/chatService';
import logger from '../../../../lib/logger';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  AIRequestGatewayError,
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  executeAIRequest,
  getClientIp,
  buildAIRequestId,
} from '../../../../lib/aiSecurityGateway';
import { validateImageBuffer, detectImageMimeType } from '../../../../lib/imageValidator';
import { classifyAppError, createApiErrorResponse } from '../../../../lib/errorHandling';

const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES ?? 10 * 1024 * 1024); // 10MB default
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
    const contentType = req.headers.get('content-type') || '';

    const requestId = buildAIRequestId('image-analyze');
    let formVar: MultipartFormLike | null = null;
    if (contentType.includes('multipart/form-data')) {
      formVar = asMultipartForm(await req.formData());
      const file = formVar.get('image');
      if (!file || typeof file === 'string' || typeof (file as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer !== 'function') {
        return buildErrorResponse('No image file provided', 400, 'validation_error', requestId);
      }
      const fileBlob = file as { arrayBuffer: () => Promise<ArrayBuffer>; type?: string };
      const ab = await fileBlob.arrayBuffer();
      buffer = Buffer.from(ab);
      mimeType = fileBlob.type || detectImageMimeType(new Uint8Array(ab));
    } else {
      const json = await req.json().catch(() => null);
      const img = json?.image;
      if (!img) return buildErrorResponse('No image provided', 400, 'validation_error', undefined);
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

    let prompt: string | null = null;
    if (contentType.includes('multipart/form-data')) {
      const maybePrompt = formVar?.get('prompt');
      if (typeof maybePrompt === 'string') prompt = maybePrompt;
    } else {
      const json = await req.json().catch(() => null);
      prompt = typeof json?.prompt === 'string' ? json.prompt : null;
    }

    const tmpDir = path.join(os.tmpdir(), 'mento-uploads');
    await fs.mkdir(tmpDir, { recursive: true }).catch(() => undefined);
    const tmpPath = path.join(tmpDir, `${requestId}.${mimeType.split('/')[1] || 'bin'}`);
    try {
      await fs.writeFile(tmpPath, buffer);
      const { result: analysisText, billingDecision } = await executeAIRequest({
        user,
        clientIp,
        feature: 'image',
        provider: 'Gemini',
        amount: 1,
        requestId,
        metadata: {
          promptPreview: prompt?.slice(0, 200),
          mimeType,
          imageSize: buffer.length,
        },
        pending: true,
        securityInput: prompt ?? undefined,
        callback: async () => {
          return await analyzeImage(buffer, mimeType, prompt ?? undefined);
        },
      });

      try {
        await saveChatToDatabase(user.id, 'Image uploaded for analysis', analysisText);
      } catch (err) {
        logger.warn('Failed to persist image analysis to conversation', { error: String(err) });
      }

      return NextResponse.json({ analysis: analysisText, billing: billingDecision });
    } finally {
      try {
        await fs.unlink(tmpPath).catch(() => undefined);
      } catch {
        // ignore
      }
    }
  } catch (error: unknown) {
    if (error instanceof AIRequestGatewayError) {
      return NextResponse.json(error.body, { status: error.status });
    }

    const appError = classifyAppError(error, { status: (error as { status?: number })?.status, source: 'image', requestId: buildAIRequestId('image-analyze') });
    const message = appError.message;
    const status = appError.httpStatus;
    logger.error('Image analyze route error:', { error: { message, status, code: appError.code } });
    return buildErrorResponse(message, status, appError.code, appError.requestId);
  }
}

export const runtime = 'nodejs';
