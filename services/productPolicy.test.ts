import { afterEach, describe, expect, it } from 'vitest';
import { evaluateCompletedAllowance, getFreeMonthlyWindow, getProductPolicy, getUtcDayWindow, resolvePolicyModel } from './productPolicy';
import { allocateLiveTutorConsumption, resolveIncludedSecondsForEvent, shouldApplyEntitlementEvent } from './entitlementService';
import { classifyLiveTutorFinalizationTiming } from './simliService';
import { isSubscriptionActive } from './planService';

describe('canonical product policy', () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; });

  it('defines the launch Free policy centrally', () => {
    const policy = getProductPolicy('FREE');
    expect(policy.normalChat).toMatchObject({ model: 'gemini-3.5-flash-lite', dailyCompletedMessages: 30, monthlyCompletedMessages: 500, maxConcurrentGenerations: 1 });
    expect(policy.normalChat.allowedModels).toEqual(['gemini-3.5-flash-lite']);
    expect(policy.liveTutor.enabled).toBe(false);
  });

  it('defines conservative configurable Pro fair use and 120 included minutes', () => {
    const policy = getProductPolicy('PRO');
    expect(policy.priceMonthlyUSD).toBe(29);
    expect(policy.normalChat.model).toBe('gemini-3.5-flash');
    expect(policy.normalChat.dailyCompletedMessages).toBeGreaterThan(0);
    expect(policy.normalChat.monthlyCompletedMessages).toBeGreaterThan(policy.normalChat.dailyCompletedMessages);
    expect(policy.liveTutor).toMatchObject({ enabled: true, includedSecondsPerPeriod: 7200, maxConcurrentSessions: 1, maxSessionSeconds: 1800 });
  });

  it('fails closed on invalid server limit configuration', () => {
    process.env.FREE_CHAT_DAILY_LIMIT = 'unlimited';
    expect(() => getProductPolicy('FREE')).toThrow(/positive integer/);
  });

  it('uses UTC server-owned allowance boundaries', () => {
    const now = new Date('2026-09-01T23:59:00-07:00');
    expect(getUtcDayWindow(now)).toEqual({ start: new Date('2026-09-02T00:00:00.000Z'), end: new Date('2026-09-03T00:00:00.000Z') });
    expect(getFreeMonthlyWindow(now)).toEqual({ start: new Date('2026-09-01T00:00:00.000Z'), end: new Date('2026-10-01T00:00:00.000Z') });
  });

  it('recognizes active, grace, and cancelled-through-period-end access only', () => {
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    expect(isSubscriptionActive('active', future, past)).toBe(true);
    expect(isSubscriptionActive('grace_period', future, past)).toBe(true);
    expect(isSubscriptionActive('cancelled', future, past)).toBe(true);
    expect(isSubscriptionActive('cancelled', past, past)).toBe(false);
    expect(isSubscriptionActive('revoked', future, past)).toBe(false);
    expect(isSubscriptionActive('on_hold', future, past)).toBe(false);
    expect(isSubscriptionActive('active', future)).toBe(false);
    expect(isSubscriptionActive('active', future, future)).toBe(false);
    expect(isSubscriptionActive('active', future, past)).toBe(true);
    expect(isSubscriptionActive('active', new Date(), past, new Date())).toBe(false);
  });

  it('consumes included seconds before top-up and never permits negative balances', () => {
    expect(allocateLiveTutorConsumption(60, 100, 80)).toEqual({ includedUsed: 60, topUpUsed: 20 });
    expect(allocateLiveTutorConsumption(100, 100, 80)).toEqual({ includedUsed: 80, topUpUsed: 0 });
    expect(() => allocateLiveTutorConsumption(10, 10, 21)).toThrow(/exhausted/);
  });

  it('does not let stale events regress entitlement or same-period updates refill usage', () => {
    const periodStart = new Date('2026-09-01T00:00:00.000Z');
    const periodEnd = new Date('2026-10-01T00:00:00.000Z');
    expect(shouldApplyEntitlementEvent(new Date('2026-09-10T00:00:00.000Z'), new Date('2026-09-09T00:00:00.000Z'))).toBe(false);
    expect(shouldApplyEntitlementEvent(new Date('2026-09-10T00:00:00.000Z'), new Date('2026-09-11T00:00:00.000Z'))).toBe(true);
    expect(resolveIncludedSecondsForEvent({
      grantsAccess: true, allowanceSeconds: 7200, previousIncludedSeconds: 3600,
      previousPeriodStart: periodStart, previousPeriodEnd: periodEnd,
      incomingPeriodStart: periodStart, incomingPeriodEnd: periodEnd,
    })).toBe(3600);
    expect(resolveIncludedSecondsForEvent({
      grantsAccess: true, allowanceSeconds: 7200, previousIncludedSeconds: 0,
      previousPeriodStart: periodStart, previousPeriodEnd: periodEnd,
      incomingPeriodStart: periodEnd, incomingPeriodEnd: new Date('2026-11-01T00:00:00.000Z'),
    })).toBe(7200);
    expect(resolveIncludedSecondsForEvent({
      grantsAccess: false, allowanceSeconds: 7200, previousIncludedSeconds: 3600,
      previousPeriodStart: periodStart, previousPeriodEnd: periodEnd,
      incomingPeriodStart: null, incomingPeriodEnd: null,
    })).toBe(0);
  });

  it('requires both daily and monthly product allowance', () => {
    expect(evaluateCompletedAllowance({ dailyUsed: 29, monthlyUsed: 499, dailyLimit: 30, monthlyLimit: 500 })).toEqual({ allowed: true, dailyRemaining: 0, monthlyRemaining: 0 });
    expect(evaluateCompletedAllowance({ dailyUsed: 30, monthlyUsed: 100, dailyLimit: 30, monthlyLimit: 500 }).allowed).toBe(false);
    expect(evaluateCompletedAllowance({ dailyUsed: 1, monthlyUsed: 500, dailyLimit: 30, monthlyLimit: 500 }).allowed).toBe(false);
  });

  it('never lets client model input upgrade a Free request', () => {
    expect(resolvePolicyModel('FREE', 'gemini-3.5-flash')).toBe('gemini-3.5-flash-lite');
    expect(resolvePolicyModel('PRO', 'gemini-3.5-flash')).toBe('gemini-3.5-flash');
    expect(resolvePolicyModel('PRO', 'attacker-model')).toBe('gemini-3.5-flash');
  });

  it('classifies Live Tutor terminal timing explicitly and rejects unknown reasons', () => {
    expect(classifyLiveTutorFinalizationTiming('transport_recovery_timeout')).toBe('transport_recovery_end');
    expect(classifyLiveTutorFinalizationTiming('Screen closed')).toBe('transport_recovery_end');
    expect(classifyLiveTutorFinalizationTiming('Voice WebSocket reconnect grace expired: socket_lost')).toBe('transport_recovery_end');
    expect(classifyLiveTutorFinalizationTiming('Heartbeat expired; stale session recovery')).toBe('inactivity_end');
    expect(classifyLiveTutorFinalizationTiming('User ended session')).toBe('active_end');
    expect(() => classifyLiveTutorFinalizationTiming('unrecognized terminal reason')).toThrow(/Unknown Live Tutor finalization reason/);
  });
});
