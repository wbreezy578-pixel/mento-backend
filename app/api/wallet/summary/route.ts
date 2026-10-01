import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../../lib/auth';
import logger from '../../../../lib/logger';
import { getEntitlementSnapshot } from '../../../../services/entitlementService';
import { getProductPolicy } from '../../../../services/productPolicy';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const userId = user.id;
    const snapshot = await getEntitlementSnapshot(userId);
    const imageLimit = getProductPolicy(snapshot.plan).normalChat.imageQuestionsPerDay;
    const todaysImageUsage = Math.max(imageLimit - snapshot.images.dailyRemaining, 0);

    return NextResponse.json({
      currentPlan: snapshot.plan,
      entitlementStatus: snapshot.status,
      entitlementPeriodEnd: snapshot.periodEnd,
      todaysImageUsage,
      fairUseEnabled: true,
      liveTutorBalance: Math.floor(snapshot.liveTutor.availableSeconds / 60),
      liveTutorSeconds: snapshot.liveTutor.availableSeconds,
      subscriptionStatus: snapshot.liveTutor.allowed ? 'enabled' : 'disabled',
      upgradeAvailable: snapshot.plan !== 'PRO',
      messagesRemaining: Math.min(snapshot.normalChat.dailyRemaining, snapshot.normalChat.monthlyRemaining),
      messagesRemainingDaily: snapshot.normalChat.dailyRemaining,
      messagesRemainingMonthly: snapshot.normalChat.monthlyRemaining,
      imagesRemaining: snapshot.images.dailyRemaining,
      resetTime: snapshot.normalChat.dailyResetAt,
      dailyResetTime: snapshot.normalChat.dailyResetAt,
      monthlyResetTime: snapshot.normalChat.monthlyResetAt,
    });
  } catch (err: unknown) {
    logger.error('Wallet summary failed', { errorName: err instanceof Error ? err.name : 'UnknownError' });
    return NextResponse.json({ error: 'Product access is temporarily unavailable.', code: 'entitlement_unavailable', retryable: true }, { status: 503 });
  }
}
