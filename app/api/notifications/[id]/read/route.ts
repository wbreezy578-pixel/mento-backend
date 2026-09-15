import { NextResponse } from 'next/server';
import { getUserFromRequest } from '@/app/lib/auth';
import logger from '@/lib/logger';
import { markAsRead } from '@/app/services/notificationService';

export async function PATCH(req: Request, context: { params: { id: string } }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const notificationId = context.params?.id;
    if (!notificationId) {
      return NextResponse.json({ error: 'Notification id is required' }, { status: 400 });
    }

    const success = await markAsRead(user.id, notificationId);
    if (!success) {
      return NextResponse.json({ error: 'Notification not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    logger.error('Failed to mark notification as read', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
