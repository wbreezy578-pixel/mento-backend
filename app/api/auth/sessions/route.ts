import { NextResponse } from 'next/server';
import { getActiveSessionId, getUserFromRequest } from '../../../lib/auth';
import { prisma } from '../../../../lib/prisma';
import { ensureSlidingWindow } from '../../../../lib/rateLimiter';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';

const responseHeaders = (req: Request) => ({ ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS' });

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: responseHeaders(req) });
}

function maskNetworkAddress(value: string | null) {
  if (!value) return null;
  const first = value.split(',')[0]?.trim() ?? '';
  const ipv4 = first.split('.');
  if (ipv4.length === 4) return `${ipv4[0]}.${ipv4[1]}.*.*`;
  const ipv6 = first.split(':').filter(Boolean);
  return ipv6.length > 1 ? `${ipv6.slice(0, 2).join(':')}:…` : null;
}

export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: responseHeaders(req) });
  }

  const sessions = await prisma.session.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      userAgent: true,
      ipAddress: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
      revokedAt: true,
    },
  });

  const activeSessionId = getActiveSessionId();
  return NextResponse.json({ sessions: sessions.map((session) => ({ ...session, ipAddress: maskNetworkAddress(session.ipAddress), current: session.id === activeSessionId })) }, { headers: responseHeaders(req) });
}

export async function DELETE(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: responseHeaders(req) });
  }
  const limit = await ensureSlidingWindow(`sessions:revoke:${user.id}`, 20, 15 * 60);
  if (!limit.ok) return NextResponse.json({ error: 'Too many session changes. Please try again later.' }, { status: 429, headers: responseHeaders(req) });

  const { sessionId, allOther } = await req.json().catch(() => ({ sessionId: null, allOther: false }));
  if (sessionId) {
    await prisma.session.updateMany({
      where: { id: sessionId, userId: user.id },
      data: { revokedAt: new Date() },
    });
  } else if (allOther === true) {
    const activeSessionId = getActiveSessionId();
    await prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null, ...(activeSessionId ? { id: { not: activeSessionId } } : {}) },
      data: { revokedAt: new Date() },
    });
  } else {
    await prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  return NextResponse.json({ ok: true }, { headers: responseHeaders(req) });
}
