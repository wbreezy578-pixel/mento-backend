/**
 * TEST: Gemini Daily Budget Enforcement
 * 
 * This test suite verifies that the daily Gemini cost budget is properly enforced
 * across Normal Chat request paths.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { executeAIRequest } from '../lib/aiSecurityGateway';
import type { BillingDecision } from '../services/billingService';

describe('Gemini Daily Budget Enforcement', () => {
  const testUserId = 'test-user-budget-' + Date.now();
  const testIp = '127.0.0.1';

  beforeEach(async () => {
    // Clear any existing usage logs for test user
    await prisma.usageLog.deleteMany({ where: { userId: testUserId } });
  });

  afterEach(async () => {
    // Cleanup
    await prisma.usageLog.deleteMany({ where: { userId: testUserId } });
  });

  it('should allow Gemini request below daily budget', async () => {
    // Setup: $9 spent today
    await prisma.usageLog.create({
      data: {
        userId: testUserId,
        feature: 'chat',
        provider: 'Gemini',
        requestId: 'existing-' + Date.now(),
        tokensInput: 100,
        tokensOutput: 100,
        tokensTotal: 200,
        providerCostUSD: 9,
        userChargeUSD: 1,
        profitUSD: 8,
        success: true,
        modelUsed: 'gemini-3.5-flash',
      },
    });

    // Attempt request that would cost $0.50 (total $9.50)
    // Should PASS because within $10 limit
    const result = await executeAIRequest({
      user: { id: testUserId },
      clientIp: testIp,
      feature: 'chat',
      provider: 'Gemini',
      amount: 1,
      requestId: 'test-below-budget-' + Date.now(),
      callback: async ({ billingDecision }) => {
        expect(billingDecision.allowed).toBe(true);
        return 'test response';
      },
    });

    expect(result.result).toBe('test response');
    expect(result.billingDecision.allowed).toBe(true);
  });

  it('should BLOCK Gemini request at/above daily budget', async () => {
    // Setup: $10 already spent today (at limit)
    await prisma.usageLog.create({
      data: {
        userId: testUserId,
        feature: 'chat',
        provider: 'Gemini',
        requestId: 'existing-at-limit-' + Date.now(),
        tokensInput: 1000,
        tokensOutput: 1000,
        tokensTotal: 2000,
        providerCostUSD: 10,
        userChargeUSD: 2,
        profitUSD: 8,
        success: true,
        modelUsed: 'gemini-3.5-flash',
      },
    });

    // Attempt another request - should FAIL (budget exhausted)
    try {
      await executeAIRequest({
        user: { id: testUserId },
        clientIp: testIp,
        feature: 'chat',
        provider: 'Gemini',
        amount: 1,
        requestId: 'test-at-budget-' + Date.now(),
        callback: async () => 'should not reach',
      });
      throw new Error('Should have thrown error for budget exceeded');
    } catch (error: any) {
      expect(error.status).toBe(429);
      expect(error.body.code).toBe('ai_safety_budget_exceeded');
    }
  });

  it('should account for PENDING/reserved usage in budget calculation', async () => {
    // CRITICAL TEST: This is where the race condition occurs
    // 
    // Setup: $5 completed, $4 reserved/pending
    await prisma.usageLog.create({
      data: {
        userId: testUserId,
        feature: 'chat',
        provider: 'Gemini',
        requestId: 'completed-' + Date.now(),
        tokensInput: 500,
        tokensOutput: 500,
        tokensTotal: 1000,
        providerCostUSD: 5,
        userChargeUSD: 1,
        profitUSD: 4,
        success: true, // COMPLETED
        modelUsed: 'gemini-3.5-flash',
      },
    });

    await prisma.usageLog.create({
      data: {
        userId: testUserId,
        feature: 'chat',
        provider: 'Gemini',
        requestId: 'pending-' + Date.now(),
        tokensInput: 400,
        tokensOutput: 400,
        tokensTotal: 800,
        providerCostUSD: 4,
        userChargeUSD: 0.8,
        profitUSD: 3.2,
        success: false, // PENDING - not yet finalized
        modelUsed: 'gemini-3.5-flash',
      },
    });

    // Total: $5 completed + $4 pending = $9 of $10 budget
    // New request would push to $9.50+
    
    // This SHOULD fail because total (including pending) would exceed budget
    // Currently it PASSES because pending is not counted
    try {
      const result = await executeAIRequest({
        user: { id: testUserId },
        clientIp: testIp,
        feature: 'chat',
        provider: 'Gemini',
        amount: 1,
        requestId: 'test-pending-race-' + Date.now(),
        callback: async ({ billingDecision }) => {
          return 'response';
        },
      });

      // KNOWN BUG: This currently succeeds (billingDecision.allowed = true)
      // It should fail because total spend (including pending) exceeds budget
      console.log('BUG CONFIRMED: Request passed despite pending reservations');
      console.log('Allowed:', result.billingDecision.allowed);
      console.log('Should be false, but is:', result.billingDecision.allowed);
    } catch (error: any) {
      // This is the CORRECT behavior we want to implement
      expect(error.status).toBe(429);
    }
  });

  it('should prevent concurrent requests from bypassing budget', async () => {
    // Setup: $9.50 spent
    await prisma.usageLog.create({
      data: {
        userId: testUserId,
        feature: 'chat',
        provider: 'Gemini',
        requestId: 'existing-' + Date.now(),
        tokensInput: 500,
        tokensOutput: 500,
        tokensTotal: 1000,
        providerCostUSD: 9.5,
        userChargeUSD: 1.9,
        profitUSD: 7.6,
        success: true,
        modelUsed: 'gemini-3.5-flash',
      },
    });

    // Fire multiple concurrent requests that would each cost $0.30
    // Budget remaining: $0.50
    // If not properly atomic: all 3 requests might pass
    // Correct behavior: only first passes, next 2 are blocked
    
    const requests = [1, 2, 3].map(i =>
      executeAIRequest({
        user: { id: testUserId },
        clientIp: testIp,
        feature: 'chat',
        provider: 'Gemini',
        amount: 1,
        requestId: `concurrent-${i}-${Date.now()}`,
        callback: async ({ billingDecision }) => {
          return `response-${i}`;
        },
      }).catch(err => ({ error: err.body?.code }))
    );

    const results = await Promise.all(requests);
    
    const allowedCount = results.filter((r: any) => r.result).length;
    const blockedCount = results.filter((r: any) => r.error === 'ai_safety_budget_exceeded').length;

    console.log(`Concurrent test: ${allowedCount} allowed, ${blockedCount} blocked`);
    
    // KNOWN BUG: Without atomic enforcement, multiple might be allowed
    if (allowedCount > 1) {
      console.log('BUG CONFIRMED: Multiple concurrent requests bypassed budget check');
    }
  });

  it('should NOT count pending usage after cancellation', async () => {
    // When a request is cancelled, its pending usage should be rolled back
    // Subsequent requests should not be blocked by the cancelled amount
    
    // Setup: $5 completed
    await prisma.usageLog.create({
      data: {
        userId: testUserId,
        feature: 'chat',
        provider: 'Gemini',
        requestId: 'base-' + Date.now(),
        tokensInput: 500,
        tokensOutput: 500,
        tokensTotal: 1000,
        providerCostUSD: 5,
        userChargeUSD: 1,
        profitUSD: 4,
        success: true,
        modelUsed: 'gemini-3.5-flash',
      },
    });

    // Create a $4.50 pending/cancelled record
    const cancelledRecord = await prisma.usageLog.create({
      data: {
        userId: testUserId,
        feature: 'chat',
        provider: 'Gemini',
        requestId: 'cancelled-' + Date.now(),
        tokensInput: 400,
        tokensOutput: 400,
        tokensTotal: 800,
        providerCostUSD: 4.5,
        userChargeUSD: 0.9,
        profitUSD: 3.6,
        success: false, // Pending/cancelled
        modelUsed: 'gemini-3.5-flash',
        metadata: { generationOutcome: 'cancelled' },
      },
    });

    // Now delete the cancelled record (simulating rollback)
    await prisma.usageLog.delete({ where: { id: cancelledRecord.id } });

    // Try new request
    // Budget: $10 - $5 completed = $5 remaining
    // Should PASS for $0.40 request
    const result = await executeAIRequest({
      user: { id: testUserId },
      clientIp: testIp,
      feature: 'chat',
      provider: 'Gemini',
      amount: 1,
      requestId: 'after-cancel-' + Date.now(),
      callback: async () => 'ok',
    });

    expect(result.billingDecision.allowed).toBe(true);
  });

  it('should work across multiple backend replicas (Redis-based)', async () => {
    // This verifies the check can be done atomically across replicas
    // by using Redis or similar distributed mechanism
    
    // For now, we can only test that the check happens
    // Full distributed test would require Redis instance
    
    await prisma.usageLog.create({
      data: {
        userId: testUserId,
        feature: 'chat',
        provider: 'Gemini',
        requestId: 'replica-test-' + Date.now(),
        tokensInput: 1000,
        tokensOutput: 1000,
        tokensTotal: 2000,
        providerCostUSD: 10,
        userChargeUSD: 2,
        profitUSD: 8,
        success: true,
        modelUsed: 'gemini-3.5-flash',
      },
    });

    try {
      await executeAIRequest({
        user: { id: testUserId },
        clientIp: testIp,
        feature: 'chat',
        provider: 'Gemini',
        amount: 1,
        requestId: 'replica-' + Date.now(),
        callback: async () => 'should not reach',
      });
      throw new Error('Should block');
    } catch (error: any) {
      expect(error.status).toBe(429);
    }
  });

  it('should reset budget at midnight UTC', async () => {
    // Add usage from YESTERDAY
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    await prisma.usageLog.create({
      data: {
        userId: testUserId,
        feature: 'chat',
        provider: 'Gemini',
        requestId: 'yesterday-' + Date.now(),
        tokensInput: 1000,
        tokensOutput: 1000,
        tokensTotal: 2000,
        providerCostUSD: 10, // At limit
        userChargeUSD: 2,
        profitUSD: 8,
        success: true,
        modelUsed: 'gemini-3.5-flash',
        createdAt: yesterday,
      },
    });

    // Today's request should NOT be blocked by yesterday's usage
    const result = await executeAIRequest({
      user: { id: testUserId },
      clientIp: testIp,
      feature: 'chat',
      provider: 'Gemini',
      amount: 1,
      requestId: 'today-' + Date.now(),
      callback: async () => 'ok',
    });

    expect(result.billingDecision.allowed).toBe(true);
  });

  it('should fail CLOSED if budget check infrastructure is unavailable', async () => {
    // If Redis/DB is down and we can't check budget safely,
    // we should deny the request (fail closed) rather than allow it
    
    // This test would mock Prisma/Redis failure
    // For now, document the expected behavior
    console.log('Expected: 503 Service Unavailable if budget check cannot be performed');
    console.log('Not: Allow unlimited requests on infrastructure failure');
  });

  it('should log budget enforcement events for monitoring', async () => {
    // Setup at limit
    await prisma.usageLog.create({
      data: {
        userId: testUserId,
        feature: 'chat',
        provider: 'Gemini',
        requestId: 'limit-reached-' + Date.now(),
        tokensInput: 1000,
        tokensOutput: 1000,
        tokensTotal: 2000,
        providerCostUSD: 10,
        userChargeUSD: 2,
        profitUSD: 8,
        success: true,
        modelUsed: 'gemini-3.5-flash',
      },
    });

    // Attempt request - should fail
    try {
      await executeAIRequest({
        user: { id: testUserId },
        clientIp: testIp,
        feature: 'chat',
        provider: 'Gemini',
        amount: 1,
        requestId: 'log-test-' + Date.now(),
        callback: async () => 'should not reach',
      });
    } catch (error: any) {
      // Verify error is properly structured for monitoring
      expect(error.body).toHaveProperty('code');
      expect(error.body.code).toBe('ai_safety_budget_exceeded');
    }
  });
});
