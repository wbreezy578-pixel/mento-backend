import { NextResponse } from 'next/server';
import { getActiveSessionId, getUserFromRequest } from '../../../lib/auth';
import { prisma } from '../../../../lib/prisma';

export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sessions = await prisma.session.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
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
  return NextResponse.json({ sessions: sessions.map((session) => ({ ...session, current: session.id === activeSessionId })) });
}

export async function DELETE(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { sessionId } = await req.json().catch(() => ({ sessionId: null }));
  if (sessionId) {
    await prisma.session.updateMany({
      where: { id: sessionId, userId: user.id },
      data: { revokedAt: new Date() },
    });
  } else {
    await prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  return NextResponse.json({ ok: true });
}
