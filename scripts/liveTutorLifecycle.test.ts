import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { reserveUsage, finalizeUsage } from '../services/billingService';
import { claimLiveTutorSession, completeSimliSessionLifecycle, markSessionActivity, reconcileStaleLiveTutorSession, recoverDurableLiveTutorSessions } from '../services/simliService';

async function main() {
  const email = `live-tutor-lifecycle-${Date.now()}@example.com`;
  const user = await prisma.user.create({ data: { email, password: 'test-password' } });
  const otherUser = await prisma.user.create({ data: { email: `other-${email}`, password: 'test-password' } });
  const streamId = `lifecycle-stream-${Date.now()}`;
  const requestId = `lifecycle-request-${Date.now()}`;

  try {
    assert.equal(await claimLiveTutorSession(user.id, requestId), true, 'first device should claim the session');
    await prisma.liveTutorSession.update({
      where: { userId: user.id },
      data: { streamId, status: 'active', billingRequestId: requestId, lastActivityAt: new Date(), expiresAt: new Date(Date.now() + 600_000) },
    });
    assert.equal(await claimLiveTutorSession(user.id, `${requestId}-device-b`), false, 'second device must be rejected');

    await prisma.liveTutorSession.update({
      where: { userId: user.id },
      data: { streamId, status: 'active', billingRequestId: requestId, expiresAt: new Date(Date.now() + 600_000), lastActivityAt: new Date(Date.now() - 10_000) },
    });
    const reservation = await reserveUsage({ userId: user.id, feature: 'live_tutor', amount: 60, provider: 'Simli', requestId, pending: true, secondsUsed: 60 });
    assert.equal(reservation.allowed, true, 'funded session should reserve usage');

    assert.equal(await markSessionActivity(streamId, otherUser.id, 45), false, 'forged stream ownership must be rejected');
    assert.equal(await markSessionActivity(streamId, user.id, 45), true, 'valid heartbeat should be accepted');
    assert.equal(await markSessionActivity(streamId, user.id, 91), false, 'impossibly large heartbeat must be rejected');

    await Promise.all([
      completeSimliSessionLifecycle(streamId, { status: 'completed', secondsUsed: 999 }, user.id),
      completeSimliSessionLifecycle(streamId, { status: 'completed', secondsUsed: 999 }, user.id),
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
    await prisma.liveTutorSession.update({
      where: { userId: otherUser.id },
      data: { streamId: restartStream, status: 'active', billingRequestId: null, ownerProcessId: 'previous-process', lastActivityAt: new Date(), expiresAt: new Date(Date.now() + 600_000), billingFinalized: false },
    });
    await recoverDurableLiveTutorSessions('test server restart');
    const restarted = await prisma.liveTutorSession.findUnique({ where: { userId: otherUser.id } });
    assert.equal(restarted?.status, 'ended', 'previous-process sessions must become terminal during startup recovery');
    assert.equal(await claimLiveTutorSession(otherUser.id, `${requestId}-after-restart`), true, 'user must start after previous-process recovery');

    const hungTerminalStream = `terminal-spin-${Date.now()}`;
    await prisma.liveTutorSession.create({
      data: {
        userId: user.id,
        streamId: hungTerminalStream,
        billingRequestId: `${requestId}-terminal-spin`,
        status: 'finalizing',
        finalizationStartedAt: new Date(),
        terminalStatus: 'completed',
        terminalReason: 'stale terminal record',
        lastActivityAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
        billingFinalized: false,
      },
    });
    await completeSimliSessionLifecycle(hungTerminalStream, { status: 'completed', reason: 'reconcile stuck finalizing record' }, user.id);
    const hungTerminal = await prisma.liveTutorSession.findUnique({ where: { userId: user.id, streamId: hungTerminalStream } });
    assert.equal(hungTerminal?.status, 'ended', 'finalizing records with terminal metadata must be committed to a true terminal state');
    assert.equal(hungTerminal?.terminalStatus, 'completed', 'terminal metadata must be preserved when reconciling a stuck finalizing record');

    const noCredit = await prisma.liveTutorWallet.upsert({ where: { userId: otherUser.id }, update: { minutesBalance: 0 }, create: { userId: otherUser.id, minutesBalance: 0 } });
    assert.equal(noCredit.minutesBalance, 0);
    const denied = await reserveUsage({ userId: otherUser.id, feature: 'live_tutor', amount: 60, provider: 'Simli', requestId: `${requestId}-denied`, pending: true });
    if (process.env.DEV_LIVE_TUTOR_FREE !== 'true') {
      assert.equal(denied.allowed, false, 'insufficient credits must reject reservation');
    }

    console.log('Live Tutor lifecycle regression tests passed');
  } finally {
    await prisma.liveTutorSession.deleteMany({ where: { userId: { in: [user.id, otherUser.id] } } }).catch(() => undefined);
    await prisma.usageLog.deleteMany({ where: { userId: { in: [user.id, otherUser.id] } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: [user.id, otherUser.id] } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});