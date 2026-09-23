import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBoundAIRequestId, buildInitialAIRequestId } from './aiSecurityGateway';

const source = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');

describe('initial Normal Chat identity integration', () => {
  it('builds initial identity before and independently of a generated conversation ID', () => {
    const initial = buildInitialAIRequestId({ userId: 'user-a', feature: 'chat', clientRequestId: 'request-123', operationType: 'chat.send', payloadHash: 'hash-a' });
    const same = buildBoundAIRequestId({ userId: 'user-a', feature: 'chat', clientRequestId: 'request-123', metadata: { operationType: 'chat.send', payloadHash: 'hash-a', idempotencyScope: 'initial-chat', conversationId: 'ignored-conversation' } });
    const changedPayload = buildInitialAIRequestId({ userId: 'user-a', feature: 'chat', clientRequestId: 'request-123', operationType: 'chat.send', payloadHash: 'hash-b' });
    expect(same).toBe(initial);
    expect(changedPayload).not.toBe(initial);
  });

  it('keeps existing-conversation identities conversation-bound', () => {
    const first = buildBoundAIRequestId({ userId: 'user-a', feature: 'chat', clientRequestId: 'request-123', metadata: { operationType: 'chat.send', payloadHash: 'hash-a', conversationId: 'conversation-a' } });
    const second = buildBoundAIRequestId({ userId: 'user-a', feature: 'chat', clientRequestId: 'request-123', metadata: { operationType: 'chat.send', payloadHash: 'hash-a', conversationId: 'conversation-b' } });
    expect(first).not.toBe(second);
  });

  it('claims before locking, reserving, or calling Gemini in both first-message routes', () => {
    for (const route of ['app/api/chat/route.ts', 'app/api/chat/stream/route.ts']) {
      const code = source(route);
      const claim = code.indexOf('claimInitialChatOperation({');
      expect(claim).toBeGreaterThan(-1);
      expect(code.indexOf('acquireAIGenerationLock(', claim)).toBeGreaterThan(claim);
      expect(code.indexOf('executeAIRequest({', claim)).toBeGreaterThan(claim);
      expect(code).toContain("claim.kind === 'completed'");
      expect(code).toContain("claim.kind !== 'claimed'");
    }
  });

  it('preserves lease checks and provider-attempt accounting after the claim', () => {
    for (const route of ['app/api/chat/route.ts', 'app/api/chat/stream/route.ts']) {
      const code = source(route);
      expect(code).toContain('await generationLease.assertOwned();');
      expect(code).toContain('return reportProviderAttempt(model);');
      expect(code).toContain('completeInitialChatOperation({');
      expect(code).toContain('failInitialChatOperation({');
    }
  });
});
