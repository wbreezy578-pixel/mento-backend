import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import { AIRequestGatewayError, authenticateAIRequest } from '../../../../../lib/aiSecurityGateway';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../../lib/requestBody';
import { buildCorsHeaders } from '../../../../../lib/securityHeaders';

const MAX_BODY_BYTES = 8 * 1024;
type RouteContext = { params: Promise<{ websiteId: string }> };

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

export async function POST(req: Request, context: RouteContext) {
  try {
    const user = await authenticateAIRequest(req);
    const { websiteId } = await context.params;

    let body: { reason?: unknown; description?: unknown; reporterEmail?: unknown };
    try {
      body = await readJsonBodyWithLimit(req, MAX_BODY_BYTES);
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
      return NextResponse.json({ error: bodyError.message, code: bodyError.code }, { status: bodyError.status, headers: headers(req) });
    }

    const website = await prisma.website.findFirst({ where: { id: websiteId, deletedAt: null }, select: { id: true } });
    if (!website) return NextResponse.json({ error: 'Website not found.' }, { status: 404, headers: headers(req) });

    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const reporterEmail = typeof body.reporterEmail === 'string' ? body.reporterEmail.trim() : user.email ?? null;

    if (!reason || reason.length > 120) {
      return NextResponse.json({ error: 'Choose a valid report reason.', code: 'invalid_website_report_reason' }, { status: 400, headers: headers(req) });
    }

    if (!description || description.length > 2000) {
      return NextResponse.json({ error: 'Add a short report description under 2,000 characters.', code: 'invalid_website_report_description' }, { status: 400, headers: headers(req) });
    }

    const report = await prisma.websiteReport.create({
      data: {
        websiteId,
        reason,
        description,
        reporterEmail,
        status: 'open',
      },
    });

    return NextResponse.json({ report }, { status: 201, headers: headers(req) });
  } catch (error) {
    if (error instanceof RequestBodyError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: headers(req) });
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    return NextResponse.json({ error: 'Website report could not be created.' }, { status: 500, headers: headers(req) });
  }
}

export const runtime = 'nodejs';
