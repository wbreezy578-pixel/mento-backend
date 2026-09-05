import { NextResponse } from 'next/server';
import { getUserFromRequest, buildUserSummary } from '../../lib/auth';

const authJson = (body: unknown, init: ResponseInit = {}) => NextResponse.json(body, {
  ...init,
  headers: { 'Cache-Control': 'no-store', ...(init.headers ?? {}) },
});

export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return authJson({ error: 'Unauthorized' }, { status: 401 });
  }

  return authJson({ user: buildUserSummary(user) });
}
