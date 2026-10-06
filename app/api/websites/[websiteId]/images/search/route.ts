import { NextResponse } from 'next/server';
import { AIRequestGatewayError, authenticateAIRequest, enforceAIGatewayRateLimit, getClientIp } from '../../../../../../lib/aiSecurityGateway';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../../../lib/requestBody';
import { buildCorsHeaders } from '../../../../../../lib/securityHeaders';
import { prisma } from '../../../../../../lib/prisma';
import { normalizeWebsiteContent } from '../../../../../../services/websiteContent';
import { searchPexelsImages } from '../../../../../../services/pexelsService';

type RouteContext = { params: Promise<{ websiteId: string }> };

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': 'POST, OPTIONS' } });
}

export async function POST(req: Request, context: RouteContext) {
  try {
    const user = await authenticateAIRequest(req);
    await enforceAIGatewayRateLimit(user.id, getClientIp(req));
    const { websiteId } = await context.params;
    const website = await prisma.website.findFirst({ where: { id: websiteId, userId: user.id }, select: { id: true, content: true } });
    if (!website) return NextResponse.json({ error: 'Website not found.' }, { status: 404, headers: headers(req) });

    const body = await readJsonBodyWithLimit<{ slotId?: unknown; query?: unknown }>(req, 2048);
    const slotId = typeof body.slotId === 'string' ? body.slotId : '';
    const content = normalizeWebsiteContent(website.content);
    const slot = content?.imageSlots.find((imageSlot) => imageSlot.id === slotId);
    if (!slot) return NextResponse.json({ error: 'Image slot not found.' }, { status: 404, headers: headers(req) });
    const query = typeof body.query === 'string' ? body.query.trim().slice(0, 120) : slot.query;
    if (!query) return NextResponse.json({ error: 'Describe the image to search for.' }, { status: 400, headers: headers(req) });

    const orientation = slot.role === 'menu_item' ? 'square' : 'landscape';
    const results = await searchPexelsImages(query, orientation);
    return NextResponse.json({ results, attribution: { label: 'Photos provided by Pexels', url: 'https://www.pexels.com' } }, { headers: headers(req) });
  } catch (error) {
    if (error instanceof RequestBodyError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: headers(req) });
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Image search is unavailable.' }, { status: 503, headers: headers(req) });
  }
}

export const runtime = 'nodejs';