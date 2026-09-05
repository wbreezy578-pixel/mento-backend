import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../lib/auth';
import { buildCorsHeaders } from '../../../lib/securityHeaders';
import { getTutorLanguage, isTutorLanguage, setTutorLanguage } from '../../../lib/userSettings';

function json(req: Request, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: buildCorsHeaders(req.headers.get('origin')) });
}

export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return json(req, { error: 'Unauthorized' }, 401);
  return json(req, { settings: { tutorLanguage: await getTutorLanguage(user.id) } });
}

export async function PATCH(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return json(req, { error: 'Unauthorized' }, 401);
  const body = await req.json().catch(() => null) as { tutorLanguage?: unknown } | null;
  if (!isTutorLanguage(body?.tutorLanguage)) {
    return json(req, { error: 'Unsupported tutor language.' }, 400);
  }
  const settings = await setTutorLanguage(user.id, body.tutorLanguage);
  return json(req, { settings: { tutorLanguage: settings.language } });
}
