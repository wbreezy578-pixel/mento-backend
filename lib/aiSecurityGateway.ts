import { getUserFromRequest } from '../app/lib/auth';
import { enforceRateLimit } from './rate-limiter';
import { assessAndSecureChatRequest } from './aiSecurityIntegration';
import { BillingDecision, BillingReservationInput, finalizeUsage, rollbackUsage, reserveUsage } from '../services/billingService';
import { consumeLiveTutorSeconds } from '../services/liveTutorBillingService';
import logger from './logger';
import { observeMonitoringLatency } from './monitoring';
import { getRateLimitClientKey } from './requestMetadata';
import { createHash } from 'node:crypto';
import { prisma } from './prisma';

export class AIRequestGatewayError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? (typeof body === 'string' ? body : JSON.stringify(body)));
    this.status = status;
    this.body = body;
  }
}

export function getClientIp(req: Request): string {
  return getRateLimitClientKey(req.headers);
}

export function buildAIRequestId(prefix = 'ai'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
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
    conversationId: options.metadata?.conversationId ?? null,
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
  const boundRequestId = buildBoundAIRequestId(options);
  const existing = await prisma.usageLog.findUnique({
    where: { provider_requestId: { provider: options.provider, requestId: boundRequestId } },
    select: { id: true },
  });
  if (existing) {
    throw new AIRequestGatewayError(409, {
      error: 'This AI operation has already been processed. Reload the conversation before trying again.',
      code: 'operation_already_processed',
    });
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
    throw new AIRequestGatewayError(result.status ?? 429, {
      error: result.message,
      retryAfterSec: result.retryAfterSec,
    });
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
  securityContext?: {
    conversationId?: string;
    hasImage?: boolean;
  };
  callback: (context: {
    user: unknown;
    billingDecision: BillingDecision;
    sanitizedInput?: string;
  }) => Promise<T>;
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
  const billingMetadata = { ...boundMetadata, clientOperationId: options.requestId };

  if (typeof options.securityInput === 'string') {
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

  const billingDecision = await reserveAIUsage({
    userId,
    feature: options.feature,
    amount: options.amount,
    provider: options.provider,
    requestId,
    modelUsed: options.modelUsed ?? null,
    metadata: billingMetadata,
    pending: options.pending ?? true,
  });

  if (billingDecision.idempotent) {
    throw new AIRequestGatewayError(409, {
      error: 'This AI operation has already been processed. Reload the conversation before trying again.',
      code: 'operation_already_processed',
    });
  }
  if (!billingDecision.allowed) {
    throw new AIRequestGatewayError(402, {
      error: billingDecision.reason,
      billing: billingDecision,
    });
  }

  try {
    const result = await options.callback({
      user: options.user,
      billingDecision,
      sanitizedInput,
    });

    if (typeof result === 'string' && !result.trim()) {
      throw new AIRequestGatewayError(503, {
        error: 'The AI provider did not produce a usable response.',
        code: 'empty_ai_response',
      });
    }

    if (options.finalize !== false) await finalizeAIUsage({
      userId,
      feature: options.feature,
      amount: options.amount,
      provider: options.provider,
      requestId,
      modelUsed: options.modelUsed ?? null,
      metadata: billingMetadata,
    });

    return { result, billingDecision, sanitizedInput };
  } catch (error) {
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
        error: String(rollbackError),
        userId,
        requestId,
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
