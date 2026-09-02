import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../lib/auth';
import logger from '../../../lib/logger';
import { getEntitlementSnapshot } from '../../../services/entitlementService';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const snapshot = await getEntitlementSnapshot(user.id);
    const totalLiveSeconds = snapshot.liveTutor.includedSecondsRemaining + snapshot.liveTutor.topUpSecondsRemaining;

    return NextResponse.json({
      currentPlan: snapshot.plan,
      entitlementStatus: snapshot.status,
      entitlementPeriodEnd: snapshot.periodEnd,
      messagesRemaining: Math.min(snapshot.normalChat.dailyRemaining, snapshot.normalChat.monthlyRemaining),
      messagesRemainingDaily: snapshot.normalChat.dailyRemaining,
      messagesRemainingMonthly: snapshot.normalChat.monthlyRemaining,
      imagesRemaining: snapshot.images.dailyRemaining,
      liveTutorMinutes: Math.floor(totalLiveSeconds / 60),
      includedLiveTutorMinutes: Math.floor(snapshot.liveTutor.includedSecondsRemaining / 60),
      topUpLiveTutorMinutes: Math.floor(snapshot.liveTutor.topUpSecondsRemaining / 60),
      resetTime: snapshot.normalChat.dailyResetAt,
      upgradeAvailable: snapshot.plan !== 'PRO',
      features: {
        chatModel: snapshot.normalChat.modelPolicy,
        imageModel: snapshot.normalChat.modelPolicy,
        liveTutorEnabled: snapshot.liveTutor.allowed,
        fairUseEnabled: true,
        maxLiveTutorSessionSeconds: snapshot.liveTutor.maxSessionSeconds,
      },
    });
  } catch (error: unknown) {
    logger.error('Wallet route failed', { errorName: error instanceof Error ? error.name : 'UnknownError' });
    return NextResponse.json({ error: 'Product access is temporarily unavailable.', code: 'entitlement_unavailable', retryable: true }, { status: 503 });
  }
}
