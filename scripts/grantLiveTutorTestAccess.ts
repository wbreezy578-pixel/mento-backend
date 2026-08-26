import { prisma } from '../lib/prisma';

const email = process.env.MENTO_TEST_ACCOUNT_EMAIL?.trim().toLowerCase();
const confirmation = process.env.MENTO_TEST_GRANT_CONFIRM;
const minutes = 200;

async function main() {
  if (!email || (!email.includes('+livetutor') && !email.includes('test'))) {
    throw new Error('MENTO_TEST_ACCOUNT_EMAIL must identify a dedicated test account (include "+livetutor" or "test").');
  }
  if (confirmation !== 'GRANT_PRO_TEST_ACCESS') {
    throw new Error('Set MENTO_TEST_GRANT_CONFIRM=GRANT_PRO_TEST_ACCESS to confirm this auditable test grant.');
  }
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, emailVerified: true } });
  if (!user) throw new Error('Test account does not exist. Sign up normally first.');
  if (!user.emailVerified) throw new Error('Verify the test account email before granting access.');
  const proPlan = await prisma.plan.findUnique({ where: { name: 'PRO' }, select: { id: true } });
  if (!proPlan) throw new Error('PRO plan is missing. Run the normal plan bootstrap first.');

  const idempotencyKey = `internal-live-tutor-test-grant:${user.id}:v1`;
  await prisma.$transaction(async (tx) => {
    await tx.userWallet.upsert({ where: { userId: user.id }, update: { planId: proPlan.id, subscriptionStatus: 'active' }, create: { userId: user.id, planId: proPlan.id, subscriptionStatus: 'active' } });
    await tx.liveTutorWallet.upsert({ where: { userId: user.id }, update: { minutesBalance: minutes }, create: { userId: user.id, minutesBalance: minutes } });
    const transaction = await tx.paymentTransaction.upsert({
      where: { idempotencyKey },
      update: { status: 'COMPLETED', metadata: { purpose: 'internal_live_tutor_test', minutesGranted: minutes } },
      create: { userId: user.id, provider: 'internal_test', type: 'LIVE_TUTOR_TEST_GRANT', status: 'COMPLETED', amountUsd: 0, amountMinor: 0, currency: 'USD', description: 'Internal Live Tutor production-readiness test grant', idempotencyKey, metadata: { purpose: 'internal_live_tutor_test', minutesGranted: minutes } },
    });
    await tx.paymentLedgerEntry.upsert({
      where: { transactionId_entryType: { transactionId: transaction.id, entryType: 'TEST_CREDIT' } },
      update: { metadata: { purpose: 'internal_live_tutor_test', minutesAfter: minutes } },
      create: { transactionId: transaction.id, userId: user.id, entryType: 'TEST_CREDIT', amountUsd: 0, amountMinor: 0, currency: 'USD', balanceAfter: 0, referenceType: 'live_tutor_wallet', referenceId: user.id, description: 'Set internal test Live Tutor balance to 200 minutes', metadata: { purpose: 'internal_live_tutor_test', minutesAfter: minutes } },
    });
  });
  console.log(`Granted PRO test access and ${minutes} Live Tutor minutes to ${user.email}.`);
}

main().finally(async () => prisma.$disconnect());
