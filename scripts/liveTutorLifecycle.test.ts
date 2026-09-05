import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { reserveUsage, finalizeUsage } from '../services/billingService';
import { claimLiveTutorSession, completeSimliSessionLifecycle, markLiveTutorSessionUsable, markSessionActivity, reconcileStaleLiveTutorSession, recoverDurableLiveTutorSessions } from '../services/simliService';
import { ensureDefaultPlans } from '../services/planService';
import { creditLiveTutorTopUp, consumeLiveTutorEntitlement } from '../services/entitlementService';

async function main() {
  const email = `live-tutor-lifecycle-${Date.now()}@example.com`;
  const user = await prisma.user.create({ data: { email, password: 'test-password' } });
  const otherUser = await prisma.user.create({ data: { email: `other-${email}`, password: 'test-password' } });
  const entitlementUser = await prisma.user.create({ data: { email: `entitlement-${email}`, password: 'test-password' } });
  const streamId = `lifecycle-stream-${Date.now()}`;
  const requestId = `lifecycle-request-${Date.now()}`;

  try {
    await ensureDefaultPlans();
    const proPlan = await prisma.plan.findUniqueOrThrow({ where: { name: 'PRO' } });
    const subscriptionStartedAt = new Date();
    const subscriptionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    for (const testUser of [user, otherUser, entitlementUser]) {
      await prisma.userWallet.upsert({
        where: { userId: testUser.id },
        update: { planId: proPlan.id, subscriptionStatus: 'active', subscriptionStartedAt, subscriptionExpiresAt, subscriptionPeriodStart: subscriptionStartedAt },
        create: { userId: testUser.id, planId: proPlan.id, subscriptionStatus: 'active', subscriptionStartedAt, subscriptionExpiresAt, subscriptionPeriodStart: subscriptionStartedAt },
      });
      await prisma.liveTutorWallet.upsert({
        where: { userId: testUser.id },
        update: { minutesBalance: 2, includedSeconds: 120, topUpSeconds: 0 },
        create: { userId: testUser.id, minutesBalance: 2, includedSeconds: 120, topUpSeconds: 0 },
      });
    }

    const entitlementWalletBefore = await prisma.liveTutorWallet.findUniqueOrThrow({ where: { userId: entitlementUser.id } });
    await assert.rejects(
      creditLiveTutorTopUp({ userId: entitlementUser.id, seconds: 60, idempotencyKey: `${requestId}-expiring`, source: 'PADDLE', expiresAt: new Date(Date.now() + 60_000) }),
      /Expiring Live Tutor top-ups are not supported/,
    );
    const entitlementWalletAfter = await prisma.liveTutorWallet.findUniqueOrThrow({ where: { userId: entitlementUser.id } });
    assert.equal(entitlementWalletAfter.includedSeconds, entitlementWalletBefore.includedSeconds, 'rejected expiry must not mutate included seconds');
    assert.equal(entitlementWalletAfter.topUpSeconds, entitlementWalletBefore.topUpSeconds, 'rejected expiry must not mutate top-up seconds');
    assert.equal(await prisma.liveTutorMinuteLedger.count({ where: { userId: entitlementUser.id, idempotencyKey: `${requestId}-expiring` } }), 0, 'rejected expiry must not create a ledger row');

    const nonExpiringKey = `${requestId}-non-expiring`;
    const credited = await creditLiveTutorTopUp({ userId: entitlementUser.id, seconds: 60, idempotencyKey: nonExpiringKey, source: 'PADDLE', expiresAt: null });
    assert.equal(credited.duplicate, false, 'non-expiring top-up must credit once');
    const consumed = await consumeLiveTutorEntitlement({ userId: entitlementUser.id, seconds: 60, idempotencyKey: `${requestId}-consumption` });
    assert.equal(consumed.duplicate, false, 'non-expiring top-up must be consumable');
    assert.equal(consumed.includedSeconds, entitlementWalletBefore.includedSeconds - 60, 'included seconds must be consumed before top-up seconds');
    assert.equal(consumed.topUpSeconds, entitlementWalletBefore.topUpSeconds + 60, 'top-up seconds must remain when included seconds cover consumption');

    for (const [suffix, reason] of [['mobile-recovery', 'transport_recovery_timeout'], ['backend-recovery', 'Voice WebSocket reconnect grace expired: socket_lost']] as const) {
      const timingRequest = `${requestId}-${suffix}`;
      const timingStream = `${streamId}-${suffix}`;
      await reserveUsage({ userId: entitlementUser.id, feature: 'live_tutor', amount: 60, provider: 'Simli', requestId: timingRequest, pending: true, secondsUsed: 60 });
      const timingNow = Date.now();
      await prisma.liveTutorSession.create({
        data: {
          userId: entitlementUser.id,
          streamId: timingStream,
          billingRequestId: timingRequest,
          status: 'reconnecting',
          createdAt: new Date(timingNow - 5_000),
          lastActivityAt: new Date(timingNow - 4_000),
          expiresAt: new Date(timingNow + 600_000),
          secondsReserved: 60,
          billingFinalized: false,
        },
      });
      await completeSimliSessionLifecycle(timingStream, {
        status: 'disconnected',
        timing: 'transport_recovery_end',
        reason,
      }, entitlementUser.id);
      const timingSession = await prisma.liveTutorSession.findUnique({ where: { streamId: timingStream } });
      assert.equal(timingSession?.secondsConsumed, 0, `${suffix} must not charge a session that never became usable`);
      await prisma.liveTutorSession.delete({ where: { streamId: timingStream } });
    }

    const usableStream = `${streamId}-usable`;
    await prisma.liveTutorSession.create({
      data: {
        userId: entitlementUser.id,
        streamId: usableStream,
        billingRequestId: `${requestId}-usable`,
        status: 'active',
        createdAt: new Date(Date.now() - 5_000),
        lastActivityAt: new Date(Date.now() - 4_000),
        expiresAt: new Date(Date.now() + 600_000),
        secondsReserved: 60,
        billingFinalized: false,
      },
    });
    assert.equal(await markLiveTutorSessionUsable(usableStream, otherUser.id), null, 'a different user cannot mark the session usable');
    assert.equal(await prisma.liveTutorSession.findUnique({ where: { streamId: usableStream } }).then((session) => session?.usableAt), null, 'spoofed readiness must not move usableAt');
    const markedUsable = await markLiveTutorSessionUsable(usableStream, entitlementUser.id);
    assert.ok(markedUsable, 'authenticated readiness should mark the session usable');
    assert.ok(markedUsable && markedUsable.expiresAt.getTime() - markedUsable.usableAt.getTime() >= 59_000, 'readiness should establish the full reserved usable window');
    const duplicateUsable = await markLiveTutorSessionUsable(usableStream, entitlementUser.id);
    assert.equal(duplicateUsable?.usableAt.getTime(), markedUsable?.usableAt.getTime(), 'duplicate readiness must not move usableAt');
    assert.equal(duplicateUsable?.expiresAt.getTime(), markedUsable?.expiresAt.getTime(), 'duplicate readiness must not extend expiry');
    const usableBillingRequest = `${requestId}-usable-billing`;
    await reserveUsage({ userId: entitlementUser.id, feature: 'live_tutor', amount: 60, provider: 'Simli', requestId: usableBillingRequest, pending: true, secondsUsed: 60 });
    await prisma.liveTutorSession.update({ where: { streamId: usableStream }, data: {
      billingRequestId: usableBillingRequest,
      createdAt: new Date(Date.now() - 30_000),
      usableAt: new Date(Date.now() - 10_000),
      lastActivityAt: new Date(Date.now() - 10_000),
      expiresAt: new Date(Date.now() + 600_000),
      secondsReserved: 60,
    } });
    await completeSimliSessionLifecycle(usableStream, { status: 'completed', timing: 'active_end', reason: 'usable session test' }, entitlementUser.id);
    const usableBilling = await prisma.liveTutorSession.findUnique({ where: { streamId: usableStream } });
    assert.ok((usableBilling?.secondsConsumed ?? 0) >= 9 && (usableBilling?.secondsConsumed ?? 0) < 20, 'billing must start at usableAt, not createdAt');
    await prisma.liveTutorSession.delete({ where: { streamId: usableStream } });

    const recoveryStream = `${streamId}-fresh-recovery`;
    const recoveryRequest = `${requestId}-fresh-recovery`;
    const recoveryCreatedAt = new Date();
    await prisma.liveTutorSession.create({
      data: {
        userId: entitlementUser.id,
        streamId: recoveryStream,
        billingRequestId: recoveryRequest,
        status: 'recovery_required',
        createdAt: recoveryCreatedAt,
        lastActivityAt: recoveryCreatedAt,
        expiresAt: new Date(Date.now() + 600_000),
        finalizationStartedAt: new Date(),
        terminalStatus: null,
        terminalReason: 'billing_finalization_failed',
        billingFinalized: false,
      },
    });
    const recoveryBefore = await prisma.liveTutorSession.findUniqueOrThrow({ where: { streamId: recoveryStream } });
    assert.equal(await claimLiveTutorSession(entitlementUser.id, `${requestId}-blocked-recovery-a`), false, 'fresh recovery_required must block a new claim');
    assert.equal(await claimLiveTutorSession(entitlementUser.id, `${requestId}-blocked-recovery-b`), false, 'duplicate claim attempts must remain blocked');
    const recoveryAfter = await prisma.liveTutorSession.findUniqueOrThrow({ where: { streamId: recoveryStream } });
    assert.equal(recoveryAfter.streamId, recoveryBefore.streamId, 'fresh recovery must preserve streamId');
    assert.equal(recoveryAfter.billingRequestId, recoveryBefore.billingRequestId, 'fresh recovery must preserve billingRequestId');
    assert.equal(recoveryAfter.createdAt.getTime(), recoveryBefore.createdAt.getTime(), 'fresh recovery must preserve createdAt');
    assert.equal(recoveryAfter.finalizationStartedAt?.getTime(), recoveryBefore.finalizationStartedAt?.getTime(), 'fresh recovery must preserve finalization claim');
    await prisma.liveTutorSession.update({ where: { streamId: recoveryStream }, data: { lastActivityAt: new Date(Date.now() - 120_000), finalizationStartedAt: new Date(Date.now() - 120_000) } });
    await reserveUsage({ userId: entitlementUser.id, feature: 'live_tutor', amount: 60, provider: 'Simli', requestId: recoveryRequest, pending: true, secondsUsed: 60 });
    assert.equal(await claimLiveTutorSession(entitlementUser.id, `${requestId}-after-stale-recovery`), true, 'stale recovery must reconcile before allowing a new claim');
    const postRecovery = await prisma.liveTutorSession.findFirst({ where: { userId: entitlementUser.id } });
    assert.notEqual(postRecovery?.streamId, recoveryStream, 'new claim must not reuse the reconciled recovery stream');

    assert.equal(await claimLiveTutorSession(user.id, requestId), true, 'first device should claim the session');
    await prisma.liveTutorSession.update({
      where: { userId: user.id },
      data: { streamId, status: 'active', billingRequestId: requestId, usableAt: new Date(), lastActivityAt: new Date(), expiresAt: new Date(Date.now() + 600_000) },
    });
    assert.equal(await claimLiveTutorSession(user.id, `${requestId}-device-b`), false, 'second device must be rejected');

    await prisma.liveTutorSession.update({
      where: { userId: user.id },
      data: { streamId, status: 'active', billingRequestId: requestId, usableAt: new Date(Date.now() - 10_000), expiresAt: new Date(Date.now() + 600_000), lastActivityAt: new Date(Date.now() - 10_000) },
    });
    const reservation = await reserveUsage({ userId: user.id, feature: 'live_tutor', amount: 60, provider: 'Simli', requestId, pending: true, secondsUsed: 60 });
    assert.equal(reservation.allowed, true, 'funded session should reserve usage');

    assert.equal(await markSessionActivity(streamId, otherUser.id, 45), false, 'forged stream ownership must be rejected');
    assert.equal(await markSessionActivity(streamId, user.id, 45), true, 'valid heartbeat should be accepted');
    assert.equal(await markSessionActivity(streamId, user.id, 91), false, 'impossibly large heartbeat must be rejected');

    await Promise.all([
      completeSimliSessionLifecycle(streamId, { status: 'completed', timing: 'active_end', secondsUsed: 999 }, user.id),
      completeSimliSessionLifecycle(streamId, { status: 'completed', timing: 'active_end', secondsUsed: 999 }, user.id),
    ]);
    const finalized = await prisma.usageLog.findUnique({ where: { provider_requestId: { provider: 'Simli', requestId } } });
    assert.equal(finalized?.success, true, 'concurrent terminal requests must finalize one ledger entry');
    assert.equal(await prisma.usageLog.count({ where: { userId: user.id, provider: 'Simli', requestId } }), 1, 'duplicate finalization must not create a second ledger entry');
    assert.equal(await prisma.liveTutorSession.findUnique({ where: { userId: user.id } }).then((session) => session?.status), 'ended', 'normal terminal finalization must release the active claim');
    assert.equal(await prisma.liveTutorSession.findUnique({ where: { userId: user.id } }).then((session) => session?.secondsConsumed), 60, 'usage must not exceed the 60-second reservation');
    assert.equal(await claimLiveTutorSession(user.id, `${requestId}-after-end`), true, 'user must start a second session after normal end');
    await prisma.liveTutorSession.delete({ where: { userId: user.id } });

    const expiredStream = `${streamId}-expired`;
    await prisma.liveTutorSession.create({ data: { userId: otherUser.id, streamId: expiredStream, status: 'active', expiresAt: new Date(Date.now() - 1_000) } });
    assert.equal(await markSessionActivity(expiredStream, otherUser.id, 1), false, 'expired sessions must not remain billable');
    assert.equal(await reconcileStaleLiveTutorSession(otherUser.id), true, 'durable stale sessions must reconcile after restart');
    await prisma.liveTutorSession.update({ where: { userId: otherUser.id }, data: { status: 'finalizing', billingFinalized: false, lastActivityAt: new Date(Date.now() - 180_000) } });
    assert.equal(await reconcileStaleLiveTutorSession(otherUser.id), true, 'timed-out finalizing sessions must be recoverable after restart');
    const recoveredClaim = await Promise.all([
      claimLiveTutorSession(otherUser.id, `${requestId}-recovery-a`),
      claimLiveTutorSession(otherUser.id, `${requestId}-recovery-b`),
    ]);
    assert.equal(recoveredClaim.filter(Boolean).length, 1, 'simultaneous recovery attempts must create one active claim');

    const restartStream = `${streamId}-restart`;
    const restartRequest = `${requestId}-restart`;
    await reserveUsage({ userId: otherUser.id, feature: 'live_tutor', amount: 60, provider: 'Simli', requestId: restartRequest, pending: true, secondsUsed: 60 });
    await prisma.liveTutorSession.update({
      where: { userId: otherUser.id },
      data: { streamId: restartStream, status: 'active', billingRequestId: restartRequest, usableAt: new Date(), ownerProcessId: 'previous-process', lastActivityAt: new Date(), expiresAt: new Date(Date.now() + 600_000), billingFinalized: false },
    });
    await recoverDurableLiveTutorSessions('test server restart');
    const restarted = await prisma.liveTutorSession.findUnique({ where: { userId: otherUser.id } });
    assert.equal(restarted?.status, 'ended', 'previous-process sessions must become terminal during startup recovery');
    assert.equal(restarted?.billingFinalized, true, 'startup recovery must finalize billing before ending the session');
    assert.equal(await prisma.usageLog.count({ where: { userId: otherUser.id, provider: 'Simli', requestId: restartRequest } }), 1, 'startup recovery must record exactly one billing outcome');
    assert.equal(await recoverDurableLiveTutorSessions('repeated test server restart'), undefined, 'repeated startup recovery must be idempotent');
    await completeSimliSessionLifecycle(restartStream, { status: 'completed', timing: 'active_end', reason: 'duplicate after startup recovery' }, otherUser.id);
    assert.equal(await prisma.usageLog.count({ where: { userId: otherUser.id, provider: 'Simli', requestId: restartRequest } }), 1, 'already committed billing must short-circuit without a duplicate ledger entry');
    assert.equal(await claimLiveTutorSession(otherUser.id, `${requestId}-after-restart`), true, 'user must start after previous-process recovery');

    const hungTerminalStream = `terminal-spin-${Date.now()}`;
    const hungTerminalRequest = `${requestId}-terminal-spin`;
    const hungFinalizationClaim = new Date();
    await reserveUsage({ userId: user.id, feature: 'live_tutor', amount: 60, provider: 'Simli', requestId: hungTerminalRequest, pending: true, secondsUsed: 60 });
    await prisma.liveTutorSession.create({
      data: {
        userId: user.id,
        streamId: hungTerminalStream,
        billingRequestId: hungTerminalRequest,
        status: 'finalizing',
        usableAt: new Date(),
        finalizationStartedAt: hungFinalizationClaim,
        terminalStatus: 'completed',
        terminalReason: 'stale terminal record',
        lastActivityAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
        billingFinalized: false,
      },
    });
    await completeSimliSessionLifecycle(hungTerminalStream, { status: 'completed', timing: 'active_end', reason: 'foreign claim must not finalize', finalizationClaimedAt: new Date(hungFinalizationClaim.getTime() + 1) }, user.id);
    const foreignClaim = await prisma.liveTutorSession.findUnique({ where: { streamId: hungTerminalStream } });
    assert.equal(foreignClaim?.status, 'finalizing', 'a foreign claim must not finalize the row');
    assert.equal(foreignClaim?.billingFinalized, false, 'a foreign claim must not mark billing finalized');
    await completeSimliSessionLifecycle(hungTerminalStream, { status: 'completed', timing: 'active_end', reason: 'reconcile stuck finalizing record', finalizationClaimedAt: hungFinalizationClaim }, user.id);
    const hungTerminal = await prisma.liveTutorSession.findUnique({ where: { userId: user.id, streamId: hungTerminalStream } });
    assert.equal(hungTerminal?.status, 'ended', 'finalizing records must become terminal after billing');
    assert.equal(hungTerminal?.billingFinalized, true, 'finalizing records must not short-circuit before billing');
    assert.equal(await prisma.usageLog.count({ where: { userId: user.id, provider: 'Simli', requestId: hungTerminalRequest } }), 1, 'finalizing recovery must record one billing outcome');

    const noCredit = await prisma.liveTutorWallet.upsert({ where: { userId: otherUser.id }, update: { minutesBalance: 0 }, create: { userId: otherUser.id, minutesBalance: 0 } });
    assert.equal(noCredit.minutesBalance, 0);
    const denied = await reserveUsage({ userId: otherUser.id, feature: 'live_tutor', amount: 60, provider: 'Simli', requestId: `${requestId}-denied`, pending: true });
    if (process.env.DEV_LIVE_TUTOR_FREE !== 'true') {
      assert.equal(denied.allowed, false, 'insufficient credits must reject reservation');
    }

    console.log('Live Tutor lifecycle regression tests passed');
  } finally {
    await prisma.liveTutorSession.deleteMany({ where: { userId: { in: [user.id, otherUser.id, entitlementUser.id] } } }).catch(() => undefined);
    await prisma.usageLog.deleteMany({ where: { userId: { in: [user.id, otherUser.id, entitlementUser.id] } } }).catch(() => undefined);
    await prisma.liveTutorMinuteLedger.deleteMany({ where: { userId: entitlementUser.id } }).catch(() => undefined);
    await prisma.liveTutorWallet.deleteMany({ where: { userId: entitlementUser.id } }).catch(() => undefined);
    await prisma.userWallet.deleteMany({ where: { userId: entitlementUser.id } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: [user.id, otherUser.id, entitlementUser.id] } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});