import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assess: vi.fn(),
  reserve: vi.fn(),
  finalize: vi.fn(),
}));

vi.mock('./aiSecurityIntegration', () => ({ assessAndSecureChatRequest: mocks.assess }));
vi.mock('../services/billingService', () => ({
  reserveUsage: mocks.reserve,
  finalizeUsage: mocks.finalize,
  rollbackUsage: vi.fn(),
  reconcileCancelledUsage: vi.fn(),
  reconcilePersistenceFailureUsage: vi.fn(),
  reconcileProviderFailureUsage: vi.fn(),
  recordGeminiProviderAttempt: vi.fn(),
}));
vi.mock('../services/liveTutorBillingService', () => ({ consumeLiveTutorSeconds: vi.fn() }));

import { AIRequestGatewayError, executeAIRequest, secureAITextInput } from './aiSecurityGateway';

const billingDecision = {
  allowed: true,
  idempotent: false,
  requestId: 'bound-request',
  modelUsed: 'test-model',
};

describe('request-scoped AI text security decisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assess.mockResolvedValue({ allowed: true, sanitizedInput: 'canonical learner input' });
    mocks.reserve.mockResolvedValue(billingDecision);
    mocks.finalize.mockResolvedValue(billingDecision);
  });

  it('reuses one authoritative decision for the same canonical operation input', async () => {
    const decision = await secureAITextInput({
      userId: 'user-1', requestId: 'operation-123', ip: '127.0.0.1', input: ' raw learner input ', hasImage: false,
    });

    const callback = vi.fn().mockResolvedValue('answer');
    await executeAIRequest({
      user: { id: 'user-1' }, clientIp: '127.0.0.1', feature: 'chat', provider: 'TestProvider',
      requestId: 'operation-123', securityInput: 'canonical learner input', securityDecision: decision,
      securityContext: { hasImage: false }, callback,
    });

    expect(mocks.assess).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ sanitizedInput: 'canonical learner input' }));
  });

  it('rejects substituted post-scan text before reservation or provider execution', async () => {
    const decision = await secureAITextInput({
      userId: 'user-1', requestId: 'operation-123', ip: '127.0.0.1', input: 'learner input', hasImage: false,
    });
    const callback = vi.fn();

    await expect(executeAIRequest({
      user: { id: 'user-1' }, clientIp: '127.0.0.1', feature: 'chat', provider: 'TestProvider',
      requestId: 'operation-123', securityInput: 'different input', securityDecision: decision,
      securityContext: { hasImage: false }, callback,
    })).rejects.toBeInstanceOf(AIRequestGatewayError);

    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not accept a decision for another user, request, image context, or second operation', async () => {
    const decision = await secureAITextInput({
      userId: 'user-1', requestId: 'operation-123', ip: '127.0.0.1', input: 'canonical learner input', hasImage: false,
    });
    const callback = vi.fn().mockResolvedValue('answer');

    await expect(executeAIRequest({
      user: { id: 'user-2' }, clientIp: '127.0.0.1', feature: 'chat', provider: 'TestProvider',
      requestId: 'operation-123', securityInput: 'canonical learner input', securityDecision: decision,
      securityContext: { hasImage: false }, callback,
    })).rejects.toBeInstanceOf(AIRequestGatewayError);

    await executeAIRequest({
      user: { id: 'user-1' }, clientIp: '127.0.0.1', feature: 'chat', provider: 'TestProvider',
      requestId: 'operation-123', securityInput: 'canonical learner input', securityDecision: decision,
      securityContext: { hasImage: false }, callback,
    });

    await expect(executeAIRequest({
      user: { id: 'user-1' }, clientIp: '127.0.0.1', feature: 'chat', provider: 'TestProvider',
      requestId: 'operation-123', securityInput: 'canonical learner input', securityDecision: decision,
      securityContext: { hasImage: false }, callback,
    })).rejects.toBeInstanceOf(AIRequestGatewayError);
  });

  it('binds approvals for existing conversations to the scanned conversation', async () => {
    const decision = await secureAITextInput({
      userId: 'user-1', requestId: 'operation-123', ip: '127.0.0.1', input: 'canonical learner input',
      conversationId: 'conversation-1', hasImage: false,
    });
    const callback = vi.fn();

    await expect(executeAIRequest({
      user: { id: 'user-1' }, clientIp: '127.0.0.1', feature: 'chat', provider: 'TestProvider',
      requestId: 'operation-123', securityInput: 'canonical learner input', securityDecision: decision,
      securityContext: { conversationId: 'conversation-2', hasImage: false }, callback,
    })).rejects.toBeInstanceOf(AIRequestGatewayError);
    expect(callback).not.toHaveBeenCalled();
  });

  it('keeps one fresh scan for regeneration and image paths without a prior decision', async () => {
    await executeAIRequest({
      user: { id: 'user-1' }, clientIp: '127.0.0.1', feature: 'image', provider: 'TestProvider',
      requestId: 'image-operation-123', securityInput: 'image question', securityContext: { hasImage: true },
      callback: vi.fn().mockResolvedValue('answer'),
    });
    expect(mocks.assess).toHaveBeenCalledTimes(1);
  });

  it('fails before reservation/provider execution when the scanner rejects or throws', async () => {
    const callback = vi.fn();
    mocks.assess.mockResolvedValueOnce({
      allowed: false,
      statusCode: 400,
      errorResponse: { error: 'Request blocked by security policy' },
    });
    await expect(executeAIRequest({
      user: { id: 'user-1' }, clientIp: '127.0.0.1', feature: 'chat', provider: 'TestProvider',
      requestId: 'operation-rejected', securityInput: 'rejected input', callback,
    })).rejects.toBeInstanceOf(AIRequestGatewayError);

    mocks.assess.mockRejectedValueOnce(new Error('scanner unavailable'));
    await expect(executeAIRequest({
      user: { id: 'user-1' }, clientIp: '127.0.0.1', feature: 'chat', provider: 'TestProvider',
      requestId: 'operation-error', securityInput: 'unscanned input', callback,
    })).rejects.toThrow();

    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });
});
