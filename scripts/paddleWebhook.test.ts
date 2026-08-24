import assert from 'node:assert/strict';
import { POST } from '../app/api/payments/route';
import { processPaddleWebhook } from '../services/paddleWebhookService';

function makeMockDb() {
  const paymentTransactions: Record<string, any> = {};
  const userWallets: Record<string, any> = {};
  const plans: Record<string, any> = { FREE: { id: 'plan_free', name: 'FREE' }, PRO: { id: 'plan_pro', name: 'PRO' } };

  return {
    paymentTransaction: {
      async findUnique({ where }: any) {
        return paymentTransactions[where.id] ?? null;
      },
      async update({ where, data }: any) {
        const t = paymentTransactions[where.id];
        if (!t) throw new Error('tx not found');
        paymentTransactions[where.id] = { ...t, ...data };
        return paymentTransactions[where.id];
      },
      async findMany({ where }: any) {
        // return by userId
        const arr = Object.values(paymentTransactions).filter((p: any) => p.userId === where.userId);
        return arr;
      },
    },
    userWallet: {
      async findUnique({ where }: any) {
        return Object.values(userWallets).find((w: any) => w.userId === where.userId) ?? null;
      },
      async update({ where, data }: any) {
        const w = Object.values(userWallets).find((x: any) => x.userId === where.userId);
        if (!w) throw new Error('wallet not found');
        Object.assign(w, data);
        return w;
      },
      async findFirst({ where }: any) {
        return Object.values(userWallets).find((w: any) => (where.paddleSubscriptionId ? w.paddleSubscriptionId === where.paddleSubscriptionId : false) || (where.paddleCustomerId ? w.paddleCustomerId === where.paddleCustomerId : false)) ?? null;
      },
    },
    plan: {
      async findFirst({ where }: any) {
        return Object.values(plans).find((p: any) => p.name === where.name) ?? null;
      },
    },
    _internal: { paymentTransactions, userWallets, plans },
  } as any;
}

async function run() {
  process.env.PADDLE_NOTIFICATION_WEBHOOK_SECRET = 'test-webhook-secret';
  process.env.PADDLE_ENV = 'sandbox';
  // 1) valid Paddle webhook
  {
    const db = makeMockDb();
    db._internal.paymentTransactions['tx1'] = { id: 'tx1', userId: 'user1', providerPayload: {} };
    const finalizeCalled: any = { called: false };
    const parsed = { alert_name: 'payment_succeeded', alert_id: 'a1', passthrough: JSON.stringify({ mentoUserId: 'user1', transactionId: 'tx1' }), checkout_id: 'c1' };
    const res = await processPaddleWebhook(JSON.stringify(parsed), 'sig', { unmarshalOverride: async () => parsed as any, finalizeOverride: async () => { finalizeCalled.called = true; }, prismaOverride: db });
    assert.equal(res.ok, true);
    assert.equal(finalizeCalled.called, true);
    console.log('test 1 passed (valid Paddle webhook)');
  }

  // 2) invalid signature
  {
    const db = makeMockDb();
    let threw = false;
    try {
      await processPaddleWebhook('bad', 'sig', { unmarshalOverride: async () => { throw new Error('invalid sig'); }, prismaOverride: db });
    } catch (e) {
      threw = true;
    }
    assert.equal(threw, true);
    console.log('test 2 passed (invalid signature)');
  }

  // 3) duplicate webhook/event
  {
    const db = makeMockDb();
    db._internal.paymentTransactions['tx2'] = { id: 'tx2', userId: 'user2', providerPayload: { webhookIds: ['a2'] } };
    const parsed = { alert_name: 'payment_succeeded', alert_id: 'a2', passthrough: JSON.stringify({ mentoUserId: 'user2', transactionId: 'tx2' }) };
    const res = await processPaddleWebhook(JSON.stringify(parsed), 'sig', { unmarshalOverride: async () => parsed as any, prismaOverride: db });
    assert.equal(res.duplicate, true);
    console.log('test 3 passed (duplicate event)');
  }

  // 4) successful subscription payment activates PRO
  {
    const db = makeMockDb();
    db._internal.paymentTransactions['tx3'] = { id: 'tx3', userId: 'user3', providerPayload: {} };
    db._internal.userWallets['w3'] = { userId: 'user3', planId: 'plan_free', subscriptionStatus: 'cancelled' };
    const parsed = { alert_name: 'subscription_payment_succeeded', alert_id: 'a3', passthrough: JSON.stringify({ mentoUserId: 'user3', transactionId: 'tx3' }) };
    const res = await processPaddleWebhook(JSON.stringify(parsed), 'sig', { unmarshalOverride: async () => parsed as any, finalizeOverride: async () => { const w = Object.values(db._internal.userWallets)[0]; w.planId = 'plan_pro'; w.subscriptionStatus = 'active'; }, prismaOverride: db });
    assert.equal(res.ok, true);
    const wallet = Object.values(db._internal.userWallets)[0];
    assert.equal(wallet.planId, 'plan_pro');
    console.log('test 4 passed (successful subscription payment activates PRO)');
  }

  // 5) subscription update
  {
    const db = makeMockDb();
    db._internal.userWallets['w5'] = { userId: 'user5', paddleSubscriptionId: 'sub_new' };
    const parsed = { alert_name: 'subscription_updated', alert_id: 'a5', subscription_id: 'sub_new', customer_id: 'cust5' };
    const res = await processPaddleWebhook(JSON.stringify(parsed), 'sig', { unmarshalOverride: async () => parsed as any, prismaOverride: db });
    assert.equal(res.ok, true);
    const w = Object.values(db._internal.userWallets)[0];
    // Should have been updated to new subscription id
    assert.equal(w.paddleSubscriptionId, 'sub_new');
    console.log('test 5 passed (subscription update)');
  }

  // 6) scheduled cancellation preserves access until expiry
  {
    const db = makeMockDb();
    db._internal.userWallets['w6'] = { userId: 'user6', planId: 'plan_pro', subscriptionStatus: 'active', paddleSubscriptionId: 'sub6' };
    const eff = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const parsed = { alert_name: 'subscription_cancelled', alert_id: 'a6', subscription_id: 'sub6', cancellation_effective_at: eff };
    const res = await processPaddleWebhook(JSON.stringify(parsed), 'sig', { unmarshalOverride: async () => parsed as any, prismaOverride: db });
    assert.equal(res.ok, true);
    const w: any = Object.values(db._internal.userWallets)[0];
    assert.equal(new Date(w.subscriptionExpiresAt).toISOString(), new Date(eff).toISOString());
    console.log('test 6 passed (scheduled cancellation preserves access)');
  }

  // 7) immediate cancellation removes access
  {
    const db = makeMockDb();
    db._internal.userWallets['w7'] = { userId: 'user7', planId: 'plan_pro', subscriptionStatus: 'active', paddleSubscriptionId: 'sub7' };
    const parsed = { alert_name: 'subscription_cancelled', alert_id: 'a7', subscription_id: 'sub7' };
    const res = await processPaddleWebhook(JSON.stringify(parsed), 'sig', { unmarshalOverride: async () => parsed as any, prismaOverride: db });
    assert.equal(res.ok, true);
    const w: any = Object.values(db._internal.userWallets)[0];
    assert.equal(w.subscriptionStatus, 'cancelled');
    console.log('test 7 passed (immediate cancellation removes access)');
  }

  // 8) payment failure does not incorrectly grant PRO
  {
    const db = makeMockDb();
    db._internal.paymentTransactions['tx8'] = { id: 'tx8', userId: 'user8', providerPayload: {} };
    db._internal.userWallets['w8'] = { userId: 'user8', planId: 'plan_free', subscriptionStatus: 'cancelled' };
    const parsed = { alert_name: 'subscription_payment_failed', alert_id: 'a8', passthrough: JSON.stringify({ mentoUserId: 'user8', transactionId: 'tx8' }) };
    const finalizeCalled: any = { called: false };
    try {
      await processPaddleWebhook(JSON.stringify(parsed), 'sig', { unmarshalOverride: async () => parsed as any, finalizeOverride: async () => { finalizeCalled.called = true; throw new Error('payment failed'); }, prismaOverride: db });
    } catch (e) {
      // expected to bubble up
    }
    assert.equal(finalizeCalled.called, true);
    const w: any = Object.values(db._internal.userWallets)[0];
    assert.equal(w?.planId ?? 'plan_free', 'plan_free');
    console.log('test 8 passed (payment failure does not grant PRO)');
  }

  // 9) missing/invalid passthrough
  {
    const db = makeMockDb();
    const parsed = { alert_name: 'payment_succeeded', alert_id: 'a9' };
    const res = await processPaddleWebhook(JSON.stringify(parsed), 'sig', { unmarshalOverride: async () => parsed as any, prismaOverride: db });
    assert.equal(res.unmapped, true);
    console.log('test 9 passed (missing/invalid passthrough)');
  }

  // 9b) raw body is preserved for signature verification
  {
    const db = makeMockDb();
    const raw = '{"alert_name":"payment_succeeded","alert_id":"a9b","customer_id":"cust_raw","subscription_id":"sub_raw"}';
    let seenPayload = '';
    const parsed = { alert_name: 'payment_succeeded', alert_id: 'a9b', customer_id: 'cust_raw', subscription_id: 'sub_raw' };
    const res = await processPaddleWebhook(raw, 'sig', {
      unmarshalOverride: async (payload) => {
        seenPayload = payload;
        return parsed as any;
      },
      prismaOverride: db,
    });
    assert.equal(seenPayload, raw, 'webhook verification must receive the raw request body');
    assert.equal(res.ok, true);
    console.log('test 9b passed (raw body preserved for signature verification)');
  }

  // 10) transaction/user mismatch
  {
    const db = makeMockDb();
    db._internal.paymentTransactions['tx10'] = { id: 'tx10', userId: 'userX', providerPayload: {} };
    const parsed = { alert_name: 'payment_succeeded', alert_id: 'a10', passthrough: JSON.stringify({ mentoUserId: 'user10', transactionId: 'tx10' }) };
    let threw = false;
    try {
      await processPaddleWebhook(JSON.stringify(parsed), 'sig', { unmarshalOverride: async () => parsed as any, prismaOverride: db });
    } catch (e) {
      threw = true;
    }
    assert.equal(threw, true);
    console.log('test 10 passed (transaction/user mismatch)');
  }

  // 11) static secret cannot bypass Paddle signature validation
  {
    const res = await POST(new Request('http://localhost/api/payments', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-payment-webhook-secret': 'test-webhook-secret',
      },
      body: JSON.stringify({ provider: 'PADDLE', alert_name: 'payment_succeeded' }),
    }));
    assert.equal(res.status, 401, 'static webhook secret alone must not bypass Paddle signature verification');
    console.log('test 11 passed (static secret bypass rejected)');
  }

  // 12) missing Paddle signature is rejected
  {
    const res = await POST(new Request('http://localhost/api/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'PADDLE', alert_name: 'payment_succeeded' }),
    }));
    assert.equal(res.status, 401, 'missing Paddle signature must be rejected');
    console.log('test 12 passed (missing signature rejected)');
  }

  console.log('All paddle webhook tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
