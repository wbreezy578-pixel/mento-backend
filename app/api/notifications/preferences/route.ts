import { NextResponse } from 'next/server';
import { getUserFromRequest } from '@/app/lib/auth';
import logger from '@/lib/logger';
import { getNotificationPreferences, updateNotificationPreferences } from '@/app/services/notificationService';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const prefs = await getNotificationPreferences(user.id);
    return NextResponse.json({ preferences: prefs });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    logger.error('Failed to fetch notification preferences', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await req.json();
    const patch: Partial<{ emailEnabled: boolean; pushEnabled: boolean; marketingEnabled: boolean; weeklyDigestEnabled: boolean; }> = {};

    if (typeof payload.emailEnabled === 'boolean') patch.emailEnabled = payload.emailEnabled;
    if (typeof payload.pushEnabled === 'boolean') patch.pushEnabled = payload.pushEnabled;
    if (typeof payload.marketingEnabled === 'boolean') patch.marketingEnabled = payload.marketingEnabled;
    if (typeof payload.weeklyDigestEnabled === 'boolean') patch.weeklyDigestEnabled = payload.weeklyDigestEnabled;

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'No valid preference fields provided' }, { status: 400 });
    }

    const updated = await updateNotificationPreferences(user.id, patch);
    if (!updated) {
      return NextResponse.json(
        { error: 'Notification preferences are temporarily unavailable.' },
        { status: 503 },
      );
    }
    return NextResponse.json({ preferences: updated });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    logger.error('Failed to update notification preferences', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
