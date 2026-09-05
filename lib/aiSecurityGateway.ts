import { getUserFromRequest } from '../app/lib/auth';
import { enforceRateLimit } from './rate-limiter';
import { assessAndSecureChatRequest } from './aiSecurityIntegration';
import { BillingDecision, BillingReservationInput, finalizeUsage, reconcileCancelledUsage, reconcilePersistenceFailureUsage, reconcileProviderFailureUsage, recordGeminiProviderAttempt, rollbackUsage, reserveUsage } from '../services/billingService';
import { consumeLiveTutorSeconds } from '../services/liveTutorBillingService';
import logger from './logger';
import { observeMonitoringLatency } from './monitoring';
import { getRateLimitClientKey } from './requestMetadata';
import { createHash } from 'node:crypto';
import { prisma } from './prisma';
import {
  GeminiDailyBudgetExceededError,
  GeminiDailyBudgetUnavailableError,
} from '../services/geminiDailyBudget';
import { buildGeminiAttemptAccounting, type GeminiAttemptUsage } from '../services/geminiAttemptAccounting';
import { recordEntitlementTelemetry } from '../services/entitlementService';

export class AIRequestGatewayError extends Error {
  status: number;
  body: unknown;
  headers: Record<string, string>;

  constructor(status: number, body: unknown, message?: string, headers: Record<string, string> = {}) {
    super(message ?? (typeof body === 'string' ? body : JSON.stringify(body)));
    this.status = status;
    this.body = body;
    this.headers = { 'Cache-Control': 'no-store', ...headers };
  }
}

export function getClientIp(req: Request): string {
  return getRateLimitClientKey(req.headers);
}

export function buildAIRequestId(prefix = 'ai'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function requireClientAIRequestId(req: Request, bodyValue?: unknown): string {
  const candidate = typeof bodyValue === 'string' && bodyValue.trim()
    ? bodyValue.trim()
    : req.headers.get('idempotency-key')?.trim() || req.headers.get('x-request-id')?.trim() || '';

  if (!candidate) {
    throw new AIRequestGatewayError(400, {
      error: 'A stable operation ID is required for this AI request.',
      code: 'missing_operation_id',
    });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(candidate)) {
    throw new AIRequestGatewayError(400, {
      error: 'Invalid request operation ID',
      code: 'invalid_operation_id',
    });
  }
  return candidate;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

export function buildInitialAIRequestId(options: {
  userId: string;
  feature: string;
  clientRequestId: string;
  operationType?: string;
  payloadHash?: string | null;
}): string {
  return buildBoundAIRequestId({
    userId: options.userId,
    feature: options.feature,
    clientRequestId: options.clientRequestId,
    metadata: {
      idempotencyScope: 'initial-chat',
      operationType: options.operationType ?? options.feature,
      payloadHash: options.payloadHash ?? null,
    },
  });
}

export function buildBoundAIRequestId(options: {
  userId: string;
  feature: string;
  clientRequestId: string;
  metadata?: Record<string, unknown>;
}): string {
  const clientRequestId = options.clientRequestId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(clientRequestId)) {
    throw new AIRequestGatewayError(400, { error: 'Invalid request operation ID', code: 'invalid_operation_id' });
  }
  const binding = stableSerialize({
    userId: options.userId,
    feature: options.feature,
    operationType: options.metadata?.operationType ?? options.feature,
    conversationId: options.metadata?.idempotencyScope === 'initial-chat'
      ? null
      : options.metadata?.conversationId ?? null,
    payloadHash: options.metadata?.payloadHash ?? null,
    clientRequestId,
  });
  return `ai-${createHash('sha256').update(binding).digest('hex')}`;
}

export async function assertAIRequestNotProcessed(options: {
  userId: string;
  feature: 'chat' | 'image' | 'live_tutor';
  provider: string;
  clientRequestId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const operationMetadata: Record<string, unknown> = { ...options.metadata };
  const boundRequestId = buildBoundAIRequestId({
    userId: options.userId,
    feature: options.feature,
    clientRequestId: options.clientRequestId,
    metadata: operationMetadata,
  });
  const existing = await prisma.usageLog.findUnique({
    where: { provider_requestId: { provider: options.provider, requestId: boundRequestId } },
    select: { id: true, metadata: true },
  });
  if (existing) {
    const metadata = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
      ? existing.metadata as Record<string, unknown>
      : null;
    if (metadata?.generationOutcome === 'persistence_failed') {
      throw new AIPersistenceFailureError();
    }
    throw new AIRequestGatewayError(409, {
      error: 'This AI operation has already been processed. Reload the conversation before trying again.',
      code: 'operation_already_processed',
    });
  }

  const payloadHash = typeof operationMetadata.payloadHash === 'string' ? operationMetadata.payloadHash : null;
  if (payloadHash) {
    const prior = await prisma.usageLog.findFirst({
      where: {
        userId: options.userId,
        provider: options.provider,
        metadata: {
          path: ['clientOperationId'],
          equals: options.clientRequestId,
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, metadata: true },
    });
    if (prior) {
      const metadata = prior.metadata && typeof prior.metadata === 'object' && !Array.isArray(prior.metadata)
        ? prior.metadata as Record<string, unknown>
        : null;
      const priorPayloadHash = typeof metadata?.payloadHash === 'string' ? metadata.payloadHash : null;
      if (priorPayloadHash && priorPayloadHash !== payloadHash) {
        throw new AIRequestGatewayError(409, {
          error: 'This request ID is already bound to different input. Use a new operation ID for a new prompt.',
          code: 'operation_id_conflict',
        });
      }
    }
  }
}

export async function authenticateAIRequest(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) {
    throw new AIRequestGatewayError(401, { error: 'Unauthorized' });
  }
  return user;
}

export async function enforceAIGatewayRateLimit(userId: string, clientIp: string) {
  const result = await enforceRateLimit(userId, clientIp);
  if (!result.ok) {
    throw new AIRequestGatewayError(
      result.status ?? 429,
      { error: result.message, code: result.code ?? 'rate_limit_exceeded', retryAfterSec: result.retryAfterSec },
      undefined,
      result.retryAfterSec ? { 'Retry-After': String(Math.ceil(result.retryAfterSec)) } : undefined,
    );
  }
}

interface AIRequestSecurityOptions {
  userId: string;
  requestId: string;
  ip: string;
  input: string;
  conversationId?: string;
  hasImage?: boolean;
}

type AITextSecurityResult = Awaited<ReturnType<typeof assessAndSecureChatRequest>>;
export type ApprovedAITextSecurityDecision = AITextSecurityResult;

const approvedAITextSecurityDecisions = new WeakMap<object, {
  userId: string;
  requestId: string;
  canonicalInput: string;
  hasImage: boolean;
  conversationId?: string;
}>();

function getUserId(user: unknown): string {
  if (typeof user === 'object' && user !== null && 'id' in user) {
    const userId = (user as { id?: unknown }).id;
    if (typeof userId === 'string' && userId.trim()) {
      return userId;
    }
  }
  throw new AIRequestGatewayError(401, { error: 'Unauthorized' });
}

export async function secureAITextInput(options: AIRequestSecurityOptions) {
  const result = await assessAndSecureChatRequest(options.input, {
    userId: options.userId,
    requestId: options.requestId,
    ip: options.ip,
    conversationId: options.conversationId,
    hasImage: options.hasImage,
  });

  if (!result.allowed) {
    throw new AIRequestGatewayError(result.statusCode ?? 400, result.errorResponse ?? { error: 'Request blocked by security policy' });
  }

  approvedAITextSecurityDecisions.set(result, {
    userId: options.userId,
    requestId: options.requestId,
    canonicalInput: result.sanitizedInput ?? options.input,
    hasImage: options.hasImage === true,
    conversationId: options.conversationId,
  });

  return result;
}

interface ReserveUsageOptions {
  userId: string;
  feature: 'chat' | 'image' | 'live_tutor';
  amount?: number;
  provider: string;
  requestId: string;
  modelUsed?: string | null;
  metadata?: Record<string, unknown>;
  pending?: boolean;
  finalize?: boolean;
}

export async function reserveAIUsage(options: ReserveUsageOptions): Promise<BillingDecision> {
  const amount = Math.max(1, Math.floor(options.amount ?? 1));
  if (options.feature === 'live_tutor') {
    return consumeLiveTutorSeconds(options.userId, amount, {
      requestId: options.requestId,
      metadata: options.metadata,
    });
  }

  return reserveUsage({
    userId: options.userId,
    feature: options.feature,
    amount,
    provider: options.provider,
    requestId: options.requestId,
    modelUsed: options.modelUsed ?? null,
    metadata: options.metadata,
    pending: options.pending ?? true,
  });
}

export async function finalizeAIUsage(options: BillingReservationInput): Promise<BillingDecision> {
  return finalizeUsage(options);
}

export async function rollbackAIUsage(options: BillingReservationInput): Promise<BillingDecision> {
  return rollbackUsage(options);
}

interface ExecuteAIRequestOptions<T> {
  user: unknown;
  clientIp: string;
  feature: 'chat' | 'image' | 'live_tutor';
  provider: string;
  amount?: number;
  requestId: string;
  modelUsed?: string | null;
  metadata?: Record<string, unknown>;
  pending?: boolean;
  finalize?: boolean;
  securityInput?: string;
  securityDecision?: ApprovedAITextSecurityDecision;
  securityContext?: {
    conversationId?: string;
    hasImage?: boolean;
  };
  callback: (context: {
    user: unknown;
    billingDecision: BillingDecision;
    sanitizedInput?: string;
    reportUsage: (usage: AIProviderUsage) => void;
    reportProviderAttempt: (model: string) => Promise<number>;
  }) => Promise<T>;
  beforeFinalize?: (result: T) => Promise<void>;
}

export type AIProviderUsage = {
  model: string;
  source: 'PROVIDER_REPORTED' | 'ESTIMATED' | 'UNKNOWN';
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  thinkingTokens?: number;
  totalTokens?: number;
};

export class AIGenerationCancelledError extends Error {
  readonly code = 'generation_cancelled';

  constructor() {
    super('Generation cancelled.');
    this.name = 'AIGenerationCancelledError';
  }
}

export class AIPersistenceFailureError extends AIRequestGatewayError {
  readonly code = 'chat_persistence_failed';

  constructor() {
    super(503, {
      error: 'We generated a reply but could not save it safely. Please retry.',
      code: 'chat_persistence_failed',
      retryable: true,
    });
    this.name = 'AIPersistenceFailureError';
  }
}

export class AIUsageReconciliationError extends AIRequestGatewayError {
  readonly code = 'ai_usage_reconciliation_failed';

  constructor() {
    super(503, {
      error: 'The AI response could not be finalized safely. Please reload before retrying.',
      code: 'ai_usage_reconciliation_failed',
      retryable: true,
    });
    this.name = 'AIUsageReconciliationError';
  }
}

export async function executeAIRequest<T>(options: ExecuteAIRequestOptions<T>): Promise<{
  result: T;
  billingDecision: BillingDecision;
  sanitizedInput?: string;
}> {
  const userId = getUserId(options.user);
  const boundMetadata = {
    ...options.metadata,
    payloadHash: options.metadata?.payloadHash
      ?? (typeof options.securityInput === 'string'
        ? createHash('sha256').update(options.securityInput).digest('hex')
        : null),
  };
  const requestId = buildBoundAIRequestId({
    userId,
    feature: options.feature,
    clientRequestId: options.requestId,
    metadata: boundMetadata,
  });
  let sanitizedInput: string | undefined;
  let providerUsage: AIProviderUsage | undefined;
  let providerAttemptCount = 0;
  let currentProviderAttempt = 0;
  const providerAttemptUsage: GeminiAttemptUsage[] = [];
  const billingMetadata = { ...boundMetadata, clientOperationId: options.requestId };
  const getAttemptAccounting = () => options.provider === 'Gemini'
    ? buildGeminiAttemptAccounting(providerAttemptCount, providerAttemptUsage)
    : null;
  const observeAttemptAccounting = (
    outcome: 'completed' | 'cancelled' | 'persistence_failed' | 'provider_failed',
    accounting: ReturnType<typeof buildGeminiAttemptAccounting> | null,
  ) => {
    if (!accounting || accounting.attemptCount === 0) return;
    logger.info('Gemini provider attempts reconciled', {
      requestId,
      outcome,
      providerAttemptCount: accounting.attemptCount,
      resolvedProviderAttempts: accounting.resolvedAttempts,
      unresolvedProviderAttempts: accounting.unresolvedAttempts,
      fallbackOccurred: accounting.attemptCount > 1,
    });
    if (accounting.unresolvedAttempts > 0) {
      logger.warn('Gemini unknown usage reservation retained', {
        requestId,
        outcome,
        unresolvedProviderAttempts: accounting.unresolvedAttempts,
      });
      if (outcome === 'cancelled') {
        logger.warn('Gemini cancellation retained unknown provider exposure', {
          requestId,
          unresolvedProviderAttempts: accounting.unresolvedAttempts,
        });
      }
    }
  };

  if (options.securityDecision) {
    const approved = approvedAITextSecurityDecisions.get(options.securityDecision);
    const canonicalInput = options.securityDecision.sanitizedInput ?? options.securityInput;
    if (
      !approved
      || approved.userId !== userId
      || approved.requestId !== options.requestId
      || approved.canonicalInput !== options.securityInput
      || canonicalInput !== options.securityInput
      || approved.hasImage !== (options.securityContext?.hasImage === true)
      || (approved.conversationId !== undefined && approved.conversationId !== options.securityContext?.conversationId)
    ) {
      throw new AIRequestGatewayError(500, {
        error: 'AI security validation could not be confirmed.',
        code: 'ai_security_context_invalid',
      });
    }
    // Decisions are request-scoped and single-use. A second provider operation
    // must obtain its own authoritative server-side assessment.
    approvedAITextSecurityDecisions.delete(options.securityDecision);
    sanitizedInput = approved.canonicalInput;
  } else if (typeof options.securityInput === 'string') {
    const securityStartedAt = Date.now();
    const securityResult = await secureAITextInput({
      userId,
      requestId,
      ip: options.clientIp,
      input: options.securityInput,
      conversationId: options.securityContext?.conversationId,
      hasImage: options.securityContext?.hasImage,
    });
    observeMonitoringLatency('api', Date.now() - securityStartedAt, { route: 'chat-stream', operation: 'security-check' });
    sanitizedInput = securityResult.sanitizedInput;
  }

  let billingDecision: BillingDecision;
  try {
    // For Normal Chat Gemini requests, reserveAIUsage performs the provider-wide
    // daily budget check and creates the estimated pending UsageLog atomically.
    billingDecision = await reserveAIUsage({
      userId,
      feature: options.feature,
      amount: options.amount,
      provider: options.provider,
      requestId,
      modelUsed: options.modelUsed ?? null,
      metadata: billingMetadata,
      pending: options.pending ?? true,
    });
  } catch (error) {
    if (error instanceof GeminiDailyBudgetExceededError) {
      logger.warn('Gemini budget enforcement blocked generation', { requestId, resetTime: error.resetTime });
      throw new AIRequestGatewayError(429, {
        error: 'Daily AI capacity has been reached. Please try again later.',
        code: 'ai_safety_budget_exceeded',
        retryable: true,
        resetTime: error.resetTime,
      });
    }
    if (error instanceof GeminiDailyBudgetUnavailableError) {
      logger.error('Gemini budget enforcement unavailable', { requestId });
      throw new AIRequestGatewayError(503, {
        error: 'AI service is temporarily unavailable. Please try again shortly.',
        code: 'ai_budget_check_unavailable',
        retryable: true,
      });
    }
    throw error;
  }

  if (billingDecision.idempotent) {
    throw new AIRequestGatewayError(409, {
      error: 'This AI operation has already been processed. Reload the conversation before trying again.',
      code: 'operation_already_processed',
    });
  }
  if (!billingDecision.allowed) {
    recordEntitlementTelemetry(options.feature === 'chat' ? 'chat_allowance_exhausted' : options.feature === 'live_tutor' ? 'live_allowance_exhausted' : 'entitlement_denied', { userId, feature: options.feature });
    throw new AIRequestGatewayError(429, {
      error: 'Your current Mento usage allowance has been reached.',
      code: 'product_allowance_exhausted',
      retryable: false,
      resetTime: billingDecision.resetTime,
    });
  }

  try {
    const result = await options.callback({
      user: options.user,
      billingDecision,
      sanitizedInput,
      reportUsage: (usage) => {
        providerUsage = usage;
        if (currentProviderAttempt > 0) {
          const existingIndex = providerAttemptUsage.findIndex((entry) => entry.attemptNumber === currentProviderAttempt);
          const report = { attemptNumber: currentProviderAttempt, usage };
          if (existingIndex >= 0) providerAttemptUsage[existingIndex] = report;
          else providerAttemptUsage.push(report);
        }
      },
      reportProviderAttempt: async (model) => {
        const attempt = await recordGeminiProviderAttempt({ userId, requestId, model });
        providerAttemptCount = Math.max(providerAttemptCount, attempt.attemptNumber);
        currentProviderAttempt = attempt.attemptNumber;
        return attempt.attemptNumber;
      },
    });

    const attemptAccounting = getAttemptAccounting();
    const effectiveUsage = attemptAccounting?.latestUsage ?? providerUsage;

    if (typeof result === 'string' && !result.trim()) {
      throw new AIRequestGatewayError(503, {
        error: 'The AI provider did not produce a usable response.',
        code: 'empty_ai_response',
      });
    }

    // Durable product state must exist before the pending accounting record is
    // reconciled. A persistence failure therefore rolls the reservation back.
    try {
      await options.beforeFinalize?.(result);
    } catch (persistenceError) {
      logger.error('AI response persistence failed', {
        errorName: persistenceError instanceof Error ? persistenceError.name : 'UnknownError',
        userId,
        requestId,
      });
      throw new AIPersistenceFailureError();
    }

    if (options.finalize !== false) {
      try {
        await finalizeAIUsage({
          userId,
          feature: options.feature,
          amount: options.amount,
          provider: options.provider,
          requestId,
          modelUsed: effectiveUsage?.model ?? options.modelUsed ?? null,
          metadata: {
            ...billingMetadata,
            cachedTokens: providerUsage?.cachedTokens ?? 0,
            thinkingTokens: providerUsage?.thinkingTokens ?? 0,
            totalTokens: providerUsage?.totalTokens ?? 0,
            providerAttempts: attemptAccounting?.attemptTelemetry ?? [],
            unresolvedProviderAttempts: attemptAccounting?.unresolvedAttempts ?? 0,
          },
          tokensInput: effectiveUsage?.inputTokens ?? 0,
          tokensOutput: effectiveUsage?.outputTokens ?? 0,
          tokensCached: effectiveUsage?.cachedTokens ?? 0,
          tokensThinking: effectiveUsage?.thinkingTokens ?? 0,
          tokensTotal: effectiveUsage?.totalTokens ?? 0,
          usageSource: attemptAccounting?.usageSource ?? effectiveUsage?.source ?? 'UNKNOWN',
          providerCostUSDOverride: attemptAccounting?.actualProviderCostUSD,
          providerExposureUSD: attemptAccounting?.providerExposureUSD,
          providerAttemptCount,
        });
      } catch (reconcileError) {
        logger.error('AI usage finalization failed; pending budget reservation retained', {
          requestId,
          errorName: reconcileError instanceof Error ? reconcileError.name : 'UnknownError',
        });
        throw new AIUsageReconciliationError();
      }
      observeAttemptAccounting('completed', attemptAccounting);
    }

    return { result, billingDecision, sanitizedInput };
  } catch (error) {
    if (error instanceof AIGenerationCancelledError) {
      const attemptAccounting = getAttemptAccounting();
      const effectiveUsage = attemptAccounting?.latestUsage ?? providerUsage;
      try {
        await reconcileCancelledUsage({
          userId,
          feature: options.feature,
          amount: options.amount,
          provider: options.provider,
          requestId,
          modelUsed: effectiveUsage?.model ?? options.modelUsed ?? null,
          metadata: {
            ...billingMetadata,
            generationOutcome: 'cancelled',
            cachedTokens: providerUsage?.cachedTokens ?? 0,
            thinkingTokens: providerUsage?.thinkingTokens ?? 0,
            totalTokens: providerUsage?.totalTokens ?? 0,
            providerAttempts: attemptAccounting?.attemptTelemetry ?? [],
            unresolvedProviderAttempts: attemptAccounting?.unresolvedAttempts ?? 0,
          },
          tokensInput: effectiveUsage?.inputTokens ?? 0,
          tokensOutput: effectiveUsage?.outputTokens ?? 0,
          tokensCached: effectiveUsage?.cachedTokens ?? 0,
          tokensThinking: effectiveUsage?.thinkingTokens ?? 0,
          tokensTotal: effectiveUsage?.totalTokens ?? 0,
          usageSource: attemptAccounting?.usageSource ?? effectiveUsage?.source ?? 'UNKNOWN',
          providerCostUSDOverride: attemptAccounting?.actualProviderCostUSD,
          providerExposureUSD: attemptAccounting?.providerExposureUSD,
          providerAttemptCount,
        });
        observeAttemptAccounting('cancelled', attemptAccounting);
      } catch (reconcileError) {
        logger.error('AI cancellation reconciliation failed', {
          requestId,
          errorName: reconcileError instanceof Error ? reconcileError.name : 'UnknownError',
        });
      }
      throw error;
    }
    if (error instanceof AIUsageReconciliationError) {
      // The provider has already run. Keep the estimated pending reservation
      // as a conservative provider-cost hold until operational repair.
      throw error;
    }
    if (error instanceof AIPersistenceFailureError) {
      const attemptAccounting = getAttemptAccounting();
      const effectiveUsage = attemptAccounting?.latestUsage ?? providerUsage;
      try {
        await reconcilePersistenceFailureUsage({
          userId,
          feature: options.feature,
          amount: options.amount,
          provider: options.provider,
          requestId,
          modelUsed: effectiveUsage?.model ?? options.modelUsed ?? null,
          metadata: {
            ...billingMetadata,
            generationOutcome: 'persistence_failed',
            cachedTokens: providerUsage?.cachedTokens ?? 0,
            thinkingTokens: providerUsage?.thinkingTokens ?? 0,
            totalTokens: providerUsage?.totalTokens ?? 0,
            providerAttempts: attemptAccounting?.attemptTelemetry ?? [],
            unresolvedProviderAttempts: attemptAccounting?.unresolvedAttempts ?? 0,
          },
          tokensInput: effectiveUsage?.inputTokens ?? 0,
          tokensOutput: effectiveUsage?.outputTokens ?? 0,
          tokensCached: effectiveUsage?.cachedTokens ?? 0,
          tokensThinking: effectiveUsage?.thinkingTokens ?? 0,
          tokensTotal: effectiveUsage?.totalTokens ?? 0,
          usageSource: attemptAccounting?.usageSource ?? effectiveUsage?.source ?? 'UNKNOWN',
          providerCostUSDOverride: attemptAccounting?.actualProviderCostUSD,
          providerExposureUSD: attemptAccounting?.providerExposureUSD,
          providerAttemptCount,
        });
        observeAttemptAccounting('persistence_failed', attemptAccounting);
      } catch (reconcileError) {
        logger.error('AI persistence-failure reconciliation failed', {
          errorName: reconcileError instanceof Error ? reconcileError.name : 'UnknownError',
          userId,
          requestId,
        });
      }
      throw error;
    }
    if (providerAttemptCount > 0 || providerUsage) {
      const attemptAccounting = getAttemptAccounting();
      const effectiveUsage = attemptAccounting?.latestUsage ?? providerUsage;
      try {
        await reconcileProviderFailureUsage({
          userId,
          feature: options.feature,
          amount: options.amount,
          provider: options.provider,
          requestId,
          modelUsed: effectiveUsage?.model ?? options.modelUsed ?? null,
          metadata: {
            ...billingMetadata,
            generationOutcome: 'provider_failed',
            cachedTokens: effectiveUsage?.cachedTokens ?? 0,
            thinkingTokens: effectiveUsage?.thinkingTokens ?? 0,
            totalTokens: effectiveUsage?.totalTokens ?? 0,
            providerAttempts: attemptAccounting?.attemptTelemetry ?? [],
            unresolvedProviderAttempts: attemptAccounting?.unresolvedAttempts ?? 0,
          },
          tokensInput: effectiveUsage?.inputTokens ?? 0,
          tokensOutput: effectiveUsage?.outputTokens ?? 0,
          tokensCached: effectiveUsage?.cachedTokens ?? 0,
          tokensThinking: effectiveUsage?.thinkingTokens ?? 0,
          tokensTotal: effectiveUsage?.totalTokens ?? 0,
          usageSource: attemptAccounting?.usageSource ?? effectiveUsage?.source ?? 'UNKNOWN',
          providerCostUSDOverride: attemptAccounting?.actualProviderCostUSD,
          providerExposureUSD: attemptAccounting?.providerExposureUSD,
          providerAttemptCount,
        });
        observeAttemptAccounting('provider_failed', attemptAccounting);
      } catch (reconcileError) {
        // Retain the pending reservation when provider-failure accounting is
        // unavailable. Rolling it back would erase possible provider expense.
        logger.error('AI provider-failure reconciliation failed; pending reservation retained', {
          requestId,
          errorName: reconcileError instanceof Error ? reconcileError.name : 'UnknownError',
        });
      }
      throw error;
    }
    try {
      await rollbackAIUsage({
        userId,
        feature: options.feature,
        amount: options.amount,
        provider: options.provider,
        requestId,
        modelUsed: options.modelUsed ?? null,
        metadata: billingMetadata,
      });
    } catch (rollbackError) {
      logger.error('AI billing rollback failed', {
        requestId,
        errorName: rollbackError instanceof Error ? rollbackError.name : 'UnknownError',
      });
    }
    throw error;
  }
}

const aiRequestGatewayApi = {
  AIRequestGatewayError,
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  executeAIRequest,
  getClientIp,
  buildAIRequestId,
};

export default aiRequestGatewayApi;
