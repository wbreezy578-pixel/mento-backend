import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../lib/auth';

const authJson = (body: unknown, init: ResponseInit = {}) => NextResponse.json(body, {
  ...init,
  headers: { 'Cache-Control': 'no-store', ...(init.headers ?? {}) },
});

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return authJson({ error: 'Unauthorized' }, { status: 401 });
    }

    return authJson({
      id: user.id,
      email: user.email,
      authProvider: user.authProvider,
      oauthProvider: user.oauthProvider,
      hasPassword: typeof user.password === 'string' && user.password.trim().length > 0,
      emailVerified: Boolean(user.emailVerified),
    });
  } catch {
    return authJson({ error: 'Unable to fetch profile' }, { status: 500 });
  }
}
