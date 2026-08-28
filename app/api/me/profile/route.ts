import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../lib/auth';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return NextResponse.json({
      id: user.id,
      email: user.email,
      authProvider: user.authProvider,
      oauthProvider: user.oauthProvider,
      hasPassword: typeof user.password === 'string' && user.password.trim().length > 0,
      emailVerified: Boolean(user.emailVerified),
    });
  } catch {
    return NextResponse.json({ error: 'Unable to fetch profile' }, { status: 500 });
  }
}
