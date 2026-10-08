import { NextResponse } from 'next/server';
import {
  AIRequestGatewayError,
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  executeAIRequest,
  getClientIp,
  buildAIRequestId,
} from '../../../../lib/aiSecurityGateway';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import logger from '../../../../lib/logger';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../lib/requestBody';

async function generateImage(prompt: string, amount: number) {
  return {
    result: 'accepted',
    prompt,
    amount,
  };
}

const CORS_METHODS = 'POST, OPTIONS';

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
}

export async function POST(req: Request) {
  try {
    const user = await authenticateAIRequest(req);
    const clientIp = getClientIp(req);
    await enforceAIGatewayRateLimit(user.id, clientIp);

    let body: { prompt?: unknown; amount?: unknown; requestId?: unknown } | null = null;
    try {
      body = await readJsonBodyWithLimit<{ prompt?: unknown; amount?: unknown; requestId?: unknown }>(req, 16 * 1024);
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
      return NextResponse.json({ error: bodyError.message, code: bodyError.code }, { status: bodyError.status, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    const amount = 1;
    const requestId = typeof body?.requestId === 'string' && body.requestId.trim()
      ? body.requestId.trim()
      : buildAIRequestId('image-gen');

    if (!prompt || prompt.length > 8_000) return NextResponse.json({ error: 'A prompt between 1 and 8,000 characters is required.' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });

    try {
      const { result: generatedImage } = await executeAIRequest({
        user,
        clientIp,
        feature: 'image',
        provider: 'ImageGen',
        amount,
        requestId,
        metadata: { promptLength: prompt.length },
        pending: true,
        securityInput: prompt,
        callback: async () => await generateImage(prompt, amount),
      });

      return NextResponse.json(generatedImage, { headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    } catch (error) {
      if (error instanceof AIRequestGatewayError) {
        return NextResponse.json(error.body, { status: error.status, headers: { ...buildCorsHeaders(req.headers.get('origin')), ...error.headers, 'Access-Control-Allow-Methods': CORS_METHODS } });
      }
      throw error;
    }
  } catch (err: unknown) {
    logger.error('Image generation failed', { error: err });
    return NextResponse.json({ error: 'Unable to generate an image right now.', code: 'image_generation_failed' }, { status: 500, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
