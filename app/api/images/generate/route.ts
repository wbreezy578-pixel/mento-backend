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
      body = (await req.json()) as { prompt?: unknown; amount?: unknown; requestId?: unknown };
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
    }

    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    const amount = typeof body?.amount === 'number' && body.amount > 0 ? Math.floor(body.amount) : 1;
    const requestId = typeof body?.requestId === 'string' && body.requestId.trim()
      ? body.requestId.trim()
      : buildAIRequestId('image-gen');

    if (!prompt) return NextResponse.json({ error: 'Prompt is required' }, { status: 400, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });

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
        return NextResponse.json(error.body, { status: error.status, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
      }
      throw error;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    logger.error('Image generation failed', { error: err });
    return NextResponse.json({ error: message }, { status: 500, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS } });
  }
}
