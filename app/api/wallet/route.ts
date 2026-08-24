import { NextResponse } from 'next/server';
import { getUserFromRequest } from '../../lib/auth';
import logger from '../../../lib/logger';
import { canUseChat, canGenerateImage, canUseLiveTutor } from '../../../services/billingService';
import { getEffectivePlanForUser } from '../../../services/planService';
import { getWalletSummary } from '../../../services/walletService';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const [chatDecision, imageDecision, liveTutorDecision, walletSummary, plan] = await Promise.all([
      canUseChat(user.id),
      canGenerateImage(user.id),
      canUseLiveTutor(user.id),
      getWalletSummary(user.id),
      getEffectivePlanForUser(user.id),
    ]);

    const resetTime = chatDecision.resetTime ?? imageDecision.resetTime ?? liveTutorDecision.resetTime ?? null;
    const upgradeAvailable = chatDecision.upgradeAvailable || imageDecision.upgradeAvailable || liveTutorDecision.upgradeAvailable;

    return NextResponse.json({
      currentPlan: plan.name,
      messagesRemaining: chatDecision.remainingUsage ?? null,
      imagesRemaining: imageDecision.remainingUsage ?? null,
      liveTutorMinutes: walletSummary.liveTutorMinutesBalance,
      resetTime,
      upgradeAvailable,
      features: {
        chatModel: plan.chatModel,
        imageModel: plan.features.imageModel ?? plan.chatModel,
        liveTutorEnabled: plan.liveTutorEnabled,
        fairUseEnabled: plan.fairUseEnabled || plan.features.fairUseEnabled === true,
        imageDailyLimit: plan.imageDailyLimit,
        messageLimit: plan.messageLimit,
        imageLimit: plan.imageLimit,
        fairUseChatLimit: plan.features.fairUseChatLimit ?? null,
        fairUseImageLimit: plan.features.fairUseImageLimit ?? null,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    logger.error('Wallet route failed', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
