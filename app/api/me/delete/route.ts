import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../../../lib/prisma';
import logger from '../../../../lib/logger';
import { getUserFromRequest, verifyPassword, getSensitiveActionRequirements, recordSecurityEvent } from '../../../lib/auth';
import { resolveDeletionCredential } from '../../../lib/accountDeletion';
import { revokeAllUserSessions } from '../../../../lib/authSession';
import { cancelPaddleSubscriptionForAccountDeletion } from '../../../../services/paddleService';
import { cancelGooglePlaySubscriptionsForAccountDeletion } from '../../../../services/nativeStoreService';
import { deleteSupabaseAuthUser } from '../../../../services/supabaseAdminService';

function buildDeletionResponse() {
  const response = NextResponse.json({ success: true, deleted: true });
  response.cookies.set('mento_access_token', '', { path: '/', maxAge: 0, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  response.cookies.set('mento_refresh_token', '', { path: '/', maxAge: 0, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  return response;
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { password, googleAccessToken, confirmPassword, confirmationText } = body as {
      password?: string;
      googleAccessToken?: string;
      confirmPassword?: string;
      confirmationText?: string;
    };
    const normalizedConfirmationText = typeof confirmationText === 'string' ? confirmationText.trim().toLowerCase() : '';

    if (normalizedConfirmationText !== 'delete my account') {
      return NextResponse.json({ error: 'Type "delete my account" to confirm.' }, { status: 400 });
    }

    const credential = await resolveDeletionCredential(
      { password, googleAccessToken },
      { authProvider: user.authProvider, email: user.email, lastOAuthReauthAt: user.lastOAuthReauthAt }
    );

    if (credential.mode === 'password') {
      if (typeof confirmPassword !== 'string' || confirmPassword !== password) {
        return NextResponse.json({ error: 'Password confirmation must match.' }, { status: 400 });
      }
      const passwordMatches = await verifyPassword(password, user.password);
      if (!passwordMatches) {
        return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 });
      }
    }

    const actionRequirements = getSensitiveActionRequirements(user);
    if (actionRequirements.requiresRecentOAuthReauth) {
      const providerName = user.authProvider === 'apple' ? 'Apple' : 'Google';
      return NextResponse.json({ error: `Please sign in with ${providerName} again before deleting your account.` }, { status: 403 });
    }

    const billingWallet = await prisma.userWallet.findUnique({
      where: { userId: user.id },
      select: { paddleSubscriptionId: true },
    });
    if (billingWallet?.paddleSubscriptionId) {
      await cancelPaddleSubscriptionForAccountDeletion(billingWallet.paddleSubscriptionId);
    }
    await cancelGooglePlaySubscriptionsForAccountDeletion(user.id);
    if (user.supabaseUserId) await deleteSupabaseAuthUser(user.supabaseUserId);

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const targetUser = await tx.user.findUnique({ where: { id: user.id } });
      if (!targetUser) {
        throw new Error('User not found');
      }

      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const succeededPayments = await tx.paymentTransaction.findMany({
        where: { userId: user.id, status: 'SUCCEEDED' },
        select: { id: true },
      });
      const preservedPaymentTransactionIds = succeededPayments.map(({ id }) => id);

      if (preservedPaymentTransactionIds.length > 0) {
        await tx.paymentTransaction.updateMany({
          where: { id: { in: preservedPaymentTransactionIds } },
          data: {
            userId: null,
            metadata: {} as Prisma.InputJsonValue,
            providerPayload: {} as Prisma.InputJsonValue,
          },
        });

        await tx.paymentReceipt.updateMany({
          where: { transactionId: { in: preservedPaymentTransactionIds } },
          data: {
            userId: null,
            payload: {} as Prisma.InputJsonValue,
          },
        });

        await tx.paymentLedgerEntry.updateMany({
          where: { transactionId: { in: preservedPaymentTransactionIds } },
          data: {
            userId: null,
            metadata: {} as Prisma.InputJsonValue,
          },
        });
      }

      const conversationIds = await tx.conversation.findMany({
        where: { userId: user.id },
        select: { id: true },
      });

      const conversationIdList = conversationIds.map(({ id }: { id: string }) => id);
      if (conversationIdList.length > 0) {
        await tx.conversationMessage.deleteMany({ where: { conversationId: { in: conversationIdList } } });
      }

      await tx.notification.deleteMany({ where: { userId: user.id } });
      await tx.notificationPreference.deleteMany({ where: { userId: user.id } });
      await tx.userSetting.deleteMany({ where: { userId: user.id } });
      await tx.conversation.deleteMany({ where: { userId: user.id } });
      await tx.userWallet.deleteMany({ where: { userId: user.id } });
      await tx.liveTutorWallet.deleteMany({ where: { userId: user.id } });
      await tx.usageLog.deleteMany({ where: { userId: user.id } });
      await tx.paymentLedgerEntry.deleteMany({ where: { userId: user.id } });
      await tx.paymentReceipt.deleteMany({ where: { userId: user.id } });
      await tx.paymentTransaction.deleteMany({ where: { userId: user.id } });
      await tx.securityEvent.deleteMany({ where: { userId: user.id } });

      await tx.user.delete({ where: { id: user.id } });
    });

    await revokeAllUserSessions(user.id);
    await recordSecurityEvent(null, 'account_deleted', {
      userId: user.id,
      deletedAt: new Date().toISOString(),
      deletionMode: credential.mode,
      gdprStyleDeletion: true,
      revokedSessions: true,
    });

    return buildDeletionResponse();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Account deletion failed.';
    logger.error('Account deletion failed', { error });

    if (error instanceof Error) {
      if (/incorrect password/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 401 });
      }
      if (/password confirmation|type "delete my account" to confirm|google re-authentication failed|google re-authentication is only supported|google re-authentication token does not match|oauth-linked accounts require/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 400 });
      }
      if (/please re-authenticate with google recently|google-linked accounts require a recent google re-authentication|please sign in with apple again/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 403 });
      }
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
