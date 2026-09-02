import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { AI_CONFIG } from '../app/lib/aiConfig';
import { AI_FEATURES } from '../app/lib/aiFeatures';
import { SAFETY_SETTINGS } from '../app/lib/aiSafety';
import { SYSTEM_PROMPT } from '../app/lib/aiSystemPrompt';
import { secureAIInput } from '../app/lib/aiSecurity';
import { retryGeminiCall } from '../app/lib/aiRetry';
import { streamTextInChunks } from '../app/lib/aiStreaming';
import logger from '../lib/logger';
import { getCircuitBreaker, getClientErrorMessage, getProviderRetryOptions, sanitizeForLogging } from '../lib/resilience';
import { incrementMonitoringFailure, observeMonitoringLatency } from '../lib/monitoring';
import '../lib/metrics';
import { getGeminiApiKey, loadAndValidateEnvironment } from '../lib/env';
import { isSupportedNormalChatModel, NORMAL_CHAT_COST_AWARE_FALLBACKS, NORMAL_CHAT_GEMINI_MODELS, type NormalChatGeminiModel } from './geminiPricing';
import { trimContextByTokenBudget, checkContextFitsBudget, UNTRUSTED_SUMMARY_ACKNOWLEDGEMENT, type ContextBudgetTrimResult } from './contextBudgetManager';

loadAndValidateEnvironment();
const geminiApiKey = getGeminiApiKey();
const geminiBreaker = getCircuitBreaker('gemini', 5, 30000);
const geminiProviderOptions = getProviderRetryOptions('gemini');

logger.info('Gemini environment loaded', {
  keyExists: Boolean(geminiApiKey),
});

const client = new GoogleGenAI({
  apiKey: geminiApiKey,
});

export type GeminiMessage = {
  role: 'user' | 'model' | 'system' | string;
  parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
};

export type GeminiContent = GeminiMessage;

type GeminiModelKind = 'chat' | 'image' | 'live-tutor';

export type GeminiUsage = {
  model: string;
  source: 'PROVIDER_REPORTED' | 'ESTIMATED' | 'UNKNOWN';
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  thinkingTokens: number;
  totalTokens: number;
};

type GeminiUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
};

function normalizeTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function normalizeGeminiUsage(model: string, metadata?: GeminiUsageMetadata): GeminiUsage {
  const inputTokens = normalizeTokenCount(metadata?.promptTokenCount);
  const outputTokens = normalizeTokenCount(metadata?.candidatesTokenCount);
  const cachedTokens = normalizeTokenCount(metadata?.cachedContentTokenCount);
  const thinkingTokens = normalizeTokenCount(metadata?.thoughtsTokenCount);
  return {
    model,
    source: metadata ? 'PROVIDER_REPORTED' : 'UNKNOWN',
    inputTokens,
    outputTokens,
    cachedTokens,
    thinkingTokens,
    totalTokens: normalizeTokenCount(metadata?.totalTokenCount),
  };
}

export type NormalChatModelTelemetry = {
  requestedModel: string;
  actualModel: string;
  fallbackOccurred: boolean;
  fallbackReason: string | null;
};

export function buildNormalChatModelTelemetry(
  requestedModel: string,
  actualModel: string,
  fallbackReason?: string,
): NormalChatModelTelemetry {
  return {
    requestedModel,
    actualModel,
    fallbackOccurred: requestedModel !== actualModel,
    fallbackReason: requestedModel !== actualModel ? (fallbackReason ?? 'provider_fallback') : null,
  };
}

export function getNormalChatModelCandidates(modelOverride?: string): NormalChatGeminiModel[] {
  const requestedModel = modelOverride?.trim() || AI_CONFIG.CHAT_MODEL;
  if (!isSupportedNormalChatModel(requestedModel)) {
    throw new Error('Unsupported Normal Chat Gemini model configuration.');
  }
  return [requestedModel, ...NORMAL_CHAT_COST_AWARE_FALLBACKS.filter((model) => model !== requestedModel)];
}

type GeminiRequestPayload = {
  contents: GeminiMessage[];
  systemInstruction: string;
  maxOutputTokens: number;
};

type GeminiErrorCategory = 'invalid_api_key' | 'model_not_found' | 'rate_limit' | 'model_overloaded' | 'timeout' | 'network_failure' | 'unknown';

function getConfiguredModelName(kind: GeminiModelKind): string {
  switch (kind) {
    case 'image':
      return AI_CONFIG.IMAGE_MODEL;
    case 'live-tutor':
      return AI_CONFIG.LIVE_TUTOR_MODEL;
    default:
      return AI_CONFIG.CHAT_MODEL;
  }
}

export function getModelCandidatesForKind(kind: GeminiModelKind, modelOverride?: string): string[] {
  if (kind === 'chat') {
    return getNormalChatModelCandidates(modelOverride);
  }
  const explicitOverride = modelOverride?.trim();
  const configuredModel = getConfiguredModelName(kind);
  const allowlist = new Set<string>(Object.keys(NORMAL_CHAT_GEMINI_MODELS));
  const requestedTier = kind === 'image' && explicitOverride && isSupportedNormalChatModel(explicitOverride)
    ? NORMAL_CHAT_GEMINI_MODELS[explicitOverride].tier
    : null;
  const fallbackModels = [configuredModel, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite']
    .filter((candidate) => allowlist.has(candidate))
    .filter((candidate) => requestedTier !== 'flash-lite' || NORMAL_CHAT_GEMINI_MODELS[candidate as NormalChatGeminiModel].tier === 'flash-lite');
  const candidates = explicitOverride
    ? [explicitOverride, ...fallbackModels.filter((candidate) => candidate && candidate !== explicitOverride)]
    : fallbackModels;

  return candidates.filter((candidate, index, list) => candidate && list.indexOf(candidate) === index);
}

function getErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : undefined;
  }
  return undefined;
}

function getErrorText(error: unknown): string {
  return getErrorMessage(error) ?? '';
}

function getErrorStack(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'stack' in error) {
    const stack = (error as { stack?: unknown }).stack;
    return typeof stack === 'string' ? stack : undefined;
  }
  return undefined;
}

function getErrorBody(error: unknown): unknown {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = (error as { response?: { body?: unknown; data?: unknown } }).response;
    if (response?.body) {
      return response.body;
    }
    if (response?.data) {
      return response.data;
    }
  }
  if (typeof error === 'object' && error !== null && 'body' in error) {
    const body = (error as { body?: unknown }).body;
    if (body) {
      return body;
    }
  }
  return undefined;
}

function getErrorDetails(error: unknown): unknown {
  if (typeof error === 'object' && error !== null) {
    const details = 'details' in error ? (error as { details?: unknown }).details : undefined;
    if (details !== undefined) return details;
    const errorValue = 'error' in error ? (error as { error?: unknown }).error : undefined;
    if (errorValue !== undefined) return errorValue;
    const response = 'response' in error ? (error as { response?: { details?: unknown } }).response : undefined;
    return response?.details;
  }
  return undefined;
}

export function classifyGeminiError(error: unknown): { category: GeminiErrorCategory; status?: number; message: string; responseBody?: unknown; details?: unknown } {
  const status = typeof error === 'object' && error !== null && 'status' in error && typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status?: number }).status
    : undefined;
  const message = getErrorText(error);
  const responseBody = getErrorBody(error);
  const details = getErrorDetails(error);

  if (status === 401 || /api key|invalid api|unauthorized|authentication/i.test(message)) {
    return { category: 'invalid_api_key', status, message, responseBody, details };
  }

  if (status === 404 || /model not found|not found/i.test(message)) {
    return { category: 'model_not_found', status, message, responseBody, details };
  }

  if (status === 429 || /rate limit|too many requests/i.test(message)) {
    return { category: 'rate_limit', status, message, responseBody, details };
  }

  if (status === 503 || /overloaded|service unavailable|temporarily unavailable/i.test(message)) {
    return { category: 'model_overloaded', status, message, responseBody, details };
  }

  if (status === 408 || status === 504 || /timeout|timed out|deadline exceeded/i.test(message)) {
    return { category: 'timeout', status, message, responseBody, details };
  }

  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
  if (/network|econnreset|econnrefused|socket hang up|fetch failed|etimedout/i.test(message) || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(code || '').toUpperCase())) {
    return { category: 'network_failure', status, message, responseBody, details };
  }

  return { category: 'unknown', status, message, responseBody, details };
}

export function buildGeminiFailureTelemetry(error: unknown): { category: GeminiErrorCategory; status?: number } {
  const classification = classifyGeminiError(error);
  return { category: classification.category, status: classification.status };
}

function isTransientGeminiError(error: unknown): boolean {
  const classification = classifyGeminiError(error);
  return classification.category === 'rate_limit' || classification.category === 'model_overloaded' || classification.category === 'timeout' || classification.category === 'network_failure';
}

export function shouldTryNextGeminiModel(error: unknown): boolean {
  const { category } = classifyGeminiError(error);
  return category === 'model_not_found' || category === 'rate_limit' || category === 'model_overloaded';
}

export function shouldFallbackStreamingModel(error: unknown, emittedToken: boolean): boolean {
  return !emittedToken && shouldTryNextGeminiModel(error);
}

function assertFeatureEnabled(feature: boolean, message: string): void {
  if (!feature) {
    throw new Error(message);
  }
}

function getModelForKind(kind: GeminiModelKind, modelOverride?: string): string {
  return getModelCandidatesForKind(kind, modelOverride)[0];
}

function getMaxOutputTokensForKind(kind: GeminiModelKind): number {
  switch (kind) {
    case 'image':
      return AI_CONFIG.IMAGE_MAX_OUTPUT_TOKENS;
    case 'live-tutor':
      return AI_CONFIG.LIVE_TUTOR_MAX_OUTPUT_TOKENS;
    default:
      return AI_CONFIG.CHAT_MAX_OUTPUT_TOKENS;
  }
}

function normalizeText(text?: string): string | undefined {
  const trimmedText = typeof text === 'string' ? text.trim() : '';
  return trimmedText ? trimmedText : undefined;
}

/**
 * DEPRECATED: boundGeminiContext (character-based)
 * ⚠️ DO NOT USE - Use trimContextByTokenBudget instead
 *
 * This function is kept for backwards compatibility only.
 * It has been replaced by token-aware budgeting in contextBudgetManager.ts
 */
export async function boundGeminiContext(messages: GeminiMessage[], maxChars?: number): Promise<GeminiMessage[]> {
  logger.warn('[GeminiService] boundGeminiContext (character-based) called - DEPRECATED. Use trimContextByTokenBudget instead.');
  // For backwards compatibility, import and use the new token-based trimming
  const { trimContextByTokenBudget } = await import('./contextBudgetManager');
  const systemPrompt = SYSTEM_PROMPT;
  const result = await trimContextByTokenBudget(messages, systemPrompt);
  return result.trimmedMessages;
}

export function isGeminiResponseSuccessful(response: unknown): boolean {
  if (!response || typeof response !== 'object') {
    return false;
  }

  const candidateContent = (response as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates?.[0]?.content;
  const parts = candidateContent?.parts ?? [];
  const textFromParts = parts.map((part) => normalizeText(part.text)).filter((text): text is string => Boolean(text)).join('').trim();
  const rawText = (response as { text?: unknown }).text;
  const directText = typeof rawText === 'string' ? rawText.trim() : '';
  const candidates = (response as { candidates?: unknown }).candidates;

  return Boolean(directText || textFromParts || (Array.isArray(candidates) && candidates.length > 0));
}

function compactParts(parts: GeminiMessage['parts']): GeminiMessage['parts'] {
  const compacted: GeminiMessage['parts'] = [];
  let pendingText: string[] = [];

  const flushText = () => {
    const text = pendingText.join('\n').trim();
    if (text) {
      compacted.push({ text });
    }
    pendingText = [];
  };

  for (const part of parts) {
    const normalizedText = normalizeText(part.text);
    if (normalizedText) {
      pendingText.push(normalizedText);
      continue;
    }

    if (part.inlineData) {
      flushText();
      compacted.push({ inlineData: part.inlineData });
    }
  }

  flushText();
  return compacted;
}

function buildGeminiRequestPayloadSync(input: string | GeminiContent[], kind: GeminiModelKind): GeminiRequestPayload {
  const baseInstruction = kind === 'image'
    ? `${SYSTEM_PROMPT}\nWhen analyzing images, return a clear, structured explanation. Include a short "category" (e.g., Homework, Math equation, Diagram), a concise "description", an array of detected "objects" with brief notes, and an optional list of "followUpQuestions" to ask the user.`
    : kind === 'live-tutor'
    ? `${SYSTEM_PROMPT}\n\nVoice Response Guidelines:\n• Keep responses to 1–3 short sentences.\n• Answer the user's question directly and immediately.\n• Use conversational, natural spoken language.\n• Avoid long introductions or preambles.\n• Do not repeat the user's question.\n• Only provide essay-length or detailed responses if the user explicitly asks for them.\n• Speak as if talking to someone face-to-face.`
    : SYSTEM_PROMPT;

  if (typeof input === 'string') {
    const message = input.trim();
    if (!message) {
      throw new Error('Message cannot be empty');
    }

    return {
      contents: [{ role: 'user', parts: [{ text: message }] }],
      systemInstruction: baseInstruction,
      maxOutputTokens: getMaxOutputTokensForKind(kind),
    };
  }

  if (Array.isArray(input)) {
    if (input.length === 0) {
      throw new Error('Conversation is empty');
    }

    const typedMessages = input.filter(
      (item): item is GeminiMessage => typeof item === 'object' && 'role' in item && Array.isArray(item.parts)
    );
    const systemMessages = typedMessages.filter((message) => message.role === 'system');
    const nonSystemMessages = typedMessages.filter((message) => message.role !== 'system');

    if (nonSystemMessages.length === 0) {
      throw new Error('Conversation must contain at least one user or model message');
    }

    const systemInstructionParts = [baseInstruction];
    for (const message of systemMessages) {
      const systemText = message.parts
        .map((part) => normalizeText(part.text))
        .filter((text): text is string => Boolean(text))
        .join('\n');
      if (systemText) {
        systemInstructionParts.push(systemText);
      }
    }

    const compactedMessages = nonSystemMessages
      .map((message) => {
        const compactedParts = compactParts(message.parts);
        if (compactedParts.length === 0) {
          return null;
        }
        return {
          ...message,
          parts: compactedParts,
        };
      })
      .filter((message): message is GeminiMessage => Boolean(message));

    if (compactedMessages.length === 0) {
      throw new Error('Conversation must contain at least one user or model message');
    }

    return {
      contents: compactedMessages,
      systemInstruction: systemInstructionParts.filter(Boolean).join('\n'),
      maxOutputTokens: getMaxOutputTokensForKind(kind),
    };
  }

  throw new Error('Invalid Gemini input');
}

async function buildGeminiRequestPayload(input: string | GeminiContent[], kind: GeminiModelKind): Promise<GeminiRequestPayload & { contextBudgetDebug?: ContextBudgetTrimResult }> {
  // First, get the base payload structure
  const basePayload = buildGeminiRequestPayloadSync(input, kind);

  // If input is a string (single message), no trimming needed
  if (typeof input === 'string') {
    return basePayload;
  }

  // If input is an array of messages, apply token-aware context trimming
  if (!Array.isArray(input) || input.length === 0) {
    return basePayload;
  }

  if (kind !== 'live-tutor' && basePayload.contents.some((message) => message.role !== 'user' && message.role !== 'model')) {
    throw new Error('Conversation contains an unsupported message role.');
  }

  // Apply token-aware context trimming for conversation arrays
  try {
    const contextBudgetResult = await trimContextByTokenBudget(
      basePayload.contents,
      basePayload.systemInstruction,
      null,
      undefined,
      { secureUntrustedSummary: kind !== 'live-tutor' },
    );

    // Normal Chat summaries are derived from hostile conversation data. Keep
    // them structurally in user/model content and never promote them into the
    // trusted system instruction. Live Tutor retains its existing behavior.
    let finalSystemInstruction = basePayload.systemInstruction;
    let finalContents = contextBudgetResult.trimmedMessages;
    if (contextBudgetResult.summary) {
      if (kind === 'live-tutor') {
        finalSystemInstruction = `${basePayload.systemInstruction}\n\n${contextBudgetResult.summary}`;
      } else {
        finalContents = [
          { role: 'user', parts: [{ text: contextBudgetResult.summary }] },
          { role: 'model', parts: [{ text: UNTRUSTED_SUMMARY_ACKNOWLEDGEMENT }] },
          ...contextBudgetResult.trimmedMessages,
        ];
      }
    }

    logger.info('[GeminiService] Context trimmed by token budget', {
      originalMessages: basePayload.contents.length,
      trimmedMessages: contextBudgetResult.trimmedMessages.length,
      trimmedTurns: contextBudgetResult.trimmedTurns,
      wasTrimmed: contextBudgetResult.wasTrimmed,
      tokenEstimates: contextBudgetResult.tokenEstimates,
    });

    return {
      contents: finalContents,
      systemInstruction: finalSystemInstruction,
      maxOutputTokens: basePayload.maxOutputTokens,
      contextBudgetDebug: contextBudgetResult,
    };
  } catch (error) {
    // If context trimming fails (e.g., latest input too large), re-throw with better message
    if (error instanceof Error && error.message.includes('exceeds maximum')) {
      logger.error('[GeminiService] Latest input exceeds token budget', {
        error: error.message,
        kind,
      });
      throw error;
    }

    if (kind === 'live-tutor') {
      logger.warn('[GeminiService] Context trimming failed, using untrimmed Live Tutor payload', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
        messageCount: basePayload.contents.length,
      });
      return basePayload;
    }

    // Billable Normal Chat fails closed rather than bypassing the context
    // budget with an unbounded provider request.
    logger.error('[GeminiService] Normal Chat context preparation failed closed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      messageCount: basePayload.contents.length,
    });
    throw new Error('Conversation context could not be prepared safely. Please try again.');
  }
}

export { buildGeminiRequestPayload };

export function extractLatestUserPrompt(input: string | GeminiContent[]): string {
  if (typeof input === 'string') {
    return input.trim();
  }

  if (Array.isArray(input)) {
    const latestUserMessage = [...input].reverse().find((item) => item.role === 'user');
    return latestUserMessage?.parts.map((part) => part.text || '').filter(Boolean).join('\n').trim() ?? '';
  }

  return '';
}

async function runSecurityCheck(input: string | GeminiContent[]): Promise<void> {
  const promptText = extractLatestUserPrompt(input);
  const result = await secureAIInput(promptText || 'Please continue the conversation.', {
    userId: 'gemini-service',
    requestId: `gemini-${Date.now()}`,
    ip: 'local',
  });

  if (!result.allowed) {
    const rawError = result.errorResponse && typeof result.errorResponse === 'object' && 'error' in result.errorResponse
      ? result.errorResponse.error
      : undefined;
    const errorMessage = typeof rawError === 'string' ? rawError : undefined;
    throw new Error(errorMessage || 'Request blocked by security policy');
  }
}

function createGeminiError(message: string, error: unknown): Error {
  const wrappedError = new Error(message) as Error & {
    status?: number;
    details?: unknown;
    responseBody?: unknown;
    cause?: unknown;
  };
  wrappedError.status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status?: unknown }).status) : undefined;
  wrappedError.details = getErrorDetails(error);
  wrappedError.responseBody = getErrorBody(error);
  wrappedError.cause = error;
  return wrappedError;
}

function createSafeNormalChatGeminiError(error: unknown, message: string): Error {
  const safeError = new Error(message) as Error & { status?: number; providerCategory?: GeminiErrorCategory };
  const telemetry = buildGeminiFailureTelemetry(error);
  safeError.status = telemetry.status;
  safeError.providerCategory = telemetry.category;
  return safeError;
}

function getPromptSizeBytes(contents: GeminiMessage[], systemInstruction: string): number {
  return Buffer.byteLength(JSON.stringify({ contents, systemInstruction }), 'utf8');
}

export async function askGemini(
  input: string | GeminiContent[],
  modelOverride?: string,
  onUsage?: (usage: GeminiUsage) => void,
  onProviderAttempt?: (model: string) => Promise<unknown>,
  operationSignal?: AbortSignal,
): Promise<string> {
  assertFeatureEnabled(AI_FEATURES.CHAT, 'Chat AI is currently disabled.');

  if (!geminiApiKey) {
    throw new Error('Gemini provider is not configured. Please try again later.');
  }

  if (geminiBreaker.isOpen()) {
    throw new Error('Gemini is temporarily unavailable. Please try again shortly.');
  }

  await runSecurityCheck(input);
  const payload = await buildGeminiRequestPayload(input, 'chat');
  const requestStartedAt = Date.now();
  const candidates = getModelCandidatesForKind('chat', modelOverride);
  const requestedModel = modelOverride?.trim() || AI_CONFIG.CHAT_MODEL;
  let fallbackReason: string | undefined;

  let lastError: unknown;
  for (const model of candidates) {
    try {
      const response = await retryGeminiCall(async () => {
        if (operationSignal?.aborted) throw operationSignal.reason ?? new Error('Generation aborted.');
        await onProviderAttempt?.(model);
        if (operationSignal?.aborted) throw operationSignal.reason ?? new Error('Generation aborted.');
        logger.info('Calling Gemini provider', { model, kind: 'chat', promptSizeBytes: getPromptSizeBytes(payload.contents, payload.systemInstruction) });
        const result = await client.models.generateContent({
          model,
          contents: payload.contents,
          config: {
            systemInstruction: payload.systemInstruction,
            safetySettings: SAFETY_SETTINGS,
            ...getGeminiGenerationTuning(model),
            maxOutputTokens: payload.maxOutputTokens,
          },
        });
        return result;
      }, {
        ...geminiProviderOptions,
        timeoutMs: geminiProviderOptions.timeoutMs ?? AI_CONFIG.GEMINI_TIMEOUT_MS,
        shouldRetry: (error: unknown) => isTransientGeminiError(error),
      });

      if (operationSignal?.aborted) throw operationSignal.reason ?? new Error('Generation aborted.');

      const text = response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const responseSizeBytes = Buffer.byteLength(text, 'utf8');
      logger.info('Gemini request completed', {
        provider: 'gemini',
        kind: 'chat',
        model,
        latencyMs: Date.now() - requestStartedAt,
        promptSizeBytes: getPromptSizeBytes(payload.contents, payload.systemInstruction),
        responseSizeBytes,
        ...buildNormalChatModelTelemetry(requestedModel, model, fallbackReason),
      });

      if (!text || text.trim() === '') {
        geminiBreaker.recordFailure();
        throw new Error('Gemini returned an empty response');
      }

      geminiBreaker.recordSuccess();
      onUsage?.(normalizeGeminiUsage(model, response?.usageMetadata));
      observeMonitoringLatency('gemini', Date.now() - requestStartedAt, { provider: 'gemini', operation: 'chat' });
      return text.trim();
    } catch (error: unknown) {
      lastError = error;
      const classification = classifyGeminiError(error);
      logger.warn('Gemini model attempt failed', {
        provider: 'gemini',
        kind: 'chat',
        model,
        classification: buildGeminiFailureTelemetry(error),
        latencyMs: Date.now() - requestStartedAt,
      });

      if (shouldTryNextGeminiModel(error) && model !== candidates[candidates.length - 1]) {
        fallbackReason = classification.category;
        logger.warn('Falling back to the next Gemini model', { provider: 'gemini', kind: 'chat', fromModel: model, nextModel: candidates[candidates.indexOf(model) + 1] });
        continue;
      }

      geminiBreaker.recordFailure();
      observeMonitoringLatency('gemini', Date.now() - requestStartedAt, { provider: 'gemini', operation: 'chat', status: classification.status ?? 'error' });
      incrementMonitoringFailure('tutor', { provider: 'gemini', feature: 'chat', reason: classification.category });
      logger.error('Gemini request failed', {
        provider: 'gemini',
        kind: 'chat',
        classification: buildGeminiFailureTelemetry(error),
        latencyMs: Date.now() - requestStartedAt,
        promptSizeBytes: getPromptSizeBytes(payload.contents, payload.systemInstruction),
      });
      throw createSafeNormalChatGeminiError(error, 'Gemini is temporarily unavailable. Please try again shortly.');
    }
  }

  throw lastError
    ? createSafeNormalChatGeminiError(lastError, 'Gemini is temporarily unavailable. Please try again shortly.')
    : new Error('Unable to generate a response right now.');
}

export async function askGeminiLiveTutor(input: string | GeminiContent[], modelOverride?: string): Promise<string> {
  assertFeatureEnabled(AI_FEATURES.CHAT, 'Chat AI is currently disabled.');

  if (!geminiApiKey) {
    throw new Error('Gemini provider is not configured. Please try again later.');
  }

  if (geminiBreaker.isOpen()) {
    throw new Error('Gemini is temporarily unavailable. Please try again shortly.');
  }

  await runSecurityCheck(input);
  const payload = await buildGeminiRequestPayload(input, 'live-tutor');
  const requestStartedAt = Date.now();
  const candidates = getModelCandidatesForKind('live-tutor', modelOverride);
  const configuredModel = getConfiguredModelName('live-tutor');

  // Calculate input character count (sum of all message text) - for logging only, actual limits are token-based
  let inputCharCount = 0;
  for (const msg of payload.contents) {
    for (const part of msg.parts) {
      if (part.text) {
        inputCharCount += part.text.length;
      }
    }
  }

  logger.info('[LiveTutorGemini] live tutor Gemini request started', {
    promptMessageCount: payload.contents.length,
    promptCharCount: inputCharCount,
    promptSizeBytes: getPromptSizeBytes(payload.contents, payload.systemInstruction),
    model: configuredModel,
  });

  let lastError: unknown;
  for (const model of candidates) {
    try {
      const response = await retryGeminiCall(async () => {
        logger.info('[LiveTutorGemini] Calling Gemini provider', { model, kind: 'live-tutor', promptSizeBytes: getPromptSizeBytes(payload.contents, payload.systemInstruction) });
        const result = await client.models.generateContent({
          model,
          contents: payload.contents,
          config: {
            systemInstruction: payload.systemInstruction,
            safetySettings: SAFETY_SETTINGS,
            ...getGeminiGenerationTuning(model),
            maxOutputTokens: payload.maxOutputTokens,
          },
        });
        return result;
      }, {
        ...geminiProviderOptions,
        timeoutMs: geminiProviderOptions.timeoutMs ?? AI_CONFIG.GEMINI_TIMEOUT_MS,
        shouldRetry: (error: unknown) => isTransientGeminiError(error),
      });

      const text = response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const responseLength = text.length;
      logger.info('[LiveTutorGemini] response completed', {
        model,
        latencyMs: Date.now() - requestStartedAt,
        promptMessageCount: payload.contents.length,
        promptCharCount: inputCharCount,
        promptSizeBytes: getPromptSizeBytes(payload.contents, payload.systemInstruction),
        responseCharCount: responseLength,
      });

      if (!text || text.trim() === '') {
        geminiBreaker.recordFailure();
        throw new Error('Gemini returned an empty response');
      }

      geminiBreaker.recordSuccess();
      observeMonitoringLatency('gemini', Date.now() - requestStartedAt, { provider: 'gemini', operation: 'live-tutor' });
      return text.trim();
    } catch (error: unknown) {
      lastError = error;
      const classification = classifyGeminiError(error);
      logger.warn('[LiveTutorGemini] Gemini model attempt failed', {
        provider: 'gemini',
        kind: 'live-tutor',
        model,
        classification,
        latencyMs: Date.now() - requestStartedAt,
      });

      if (shouldTryNextGeminiModel(error) && model !== candidates[candidates.length - 1]) {
        logger.warn('[LiveTutorGemini] Falling back to the next Gemini model', { provider: 'gemini', kind: 'live-tutor', fromModel: model, nextModel: candidates[candidates.indexOf(model) + 1] });
        continue;
      }

      geminiBreaker.recordFailure();
      observeMonitoringLatency('gemini', Date.now() - requestStartedAt, { provider: 'gemini', operation: 'live-tutor', status: classification.status ?? 'error' });
      incrementMonitoringFailure('tutor', { provider: 'gemini', feature: 'live-tutor', reason: classification.category });
      const errorMessage = getErrorMessage(error);
      const rootCause = classification.message || getClientErrorMessage(errorMessage, 'Unable to generate a response right now.');
      logger.error('[LiveTutorGemini] Gemini request failed', {
        error: sanitizeForLogging({
          status: classification.status,
          message: rootCause,
          responseBody: classification.responseBody,
          details: classification.details,
          stack: getErrorStack(error),
        }),
        provider: 'gemini',
        kind: 'live-tutor',
        classification,
        latencyMs: Date.now() - requestStartedAt,
        promptSizeBytes: getPromptSizeBytes(payload.contents, payload.systemInstruction),
      });
      throw createGeminiError(rootCause, error);
    }
  }

  throw lastError ? createGeminiError(getErrorText(lastError) || 'Unable to generate a response right now.', lastError) : new Error('Unable to generate a response right now.');
}

export default askGemini;

export type GeminiStreamResult = {
  outcome: 'completed' | 'cancelled';
  text: string;
  usage: GeminiUsage;
};

export async function askGeminiStream(
  input: string | GeminiContent[],
  onToken: (token: string) => Promise<void> | void,
  modelOverride?: string,
  abortSignal?: AbortSignal,
  securityInputOverride?: string,
  onUsage?: (usage: GeminiUsage) => void,
  onProviderAttempt?: (model: string) => Promise<unknown>,
): Promise<GeminiStreamResult> {
  assertFeatureEnabled(AI_FEATURES.CHAT, 'Chat AI is currently disabled.');
  assertFeatureEnabled(AI_FEATURES.STREAMING, 'Streaming is currently disabled.');
  const requestKind: GeminiModelKind = Array.isArray(input) && input.some(
    (message) => message.parts.some((part) => Boolean(part.inlineData)),
  ) ? 'image' : 'chat';
  if (requestKind === 'image') {
    assertFeatureEnabled(AI_FEATURES.IMAGE_UNDERSTANDING, 'Image understanding is currently disabled.');
  }

  if (!geminiApiKey) {
    throw new Error('Gemini API key is missing');
  }

  if (geminiBreaker.isOpen()) {
    throw new Error('Gemini is temporarily unavailable. Please try again shortly.');
  }

  await runSecurityCheck(securityInputOverride ?? input);
  const payload = await buildGeminiRequestPayload(input, requestKind);
  const requestStartedAt = Date.now();
  const candidates = getModelCandidatesForKind(requestKind, modelOverride);
  const requestedModel = modelOverride?.trim() || getConfiguredModelName(requestKind);
  let fallbackReason: string | undefined;

  logger.info('Gemini stream request started', {
    inputKind: typeof input === 'string' ? 'text' : 'conversation-array',
    inputLength: typeof input === 'string' ? input.length : input.length,
    promptSizeBytes: getPromptSizeBytes(payload.contents, payload.systemInstruction),
  });

  let lastError: unknown;
  let currentStream: AsyncIterable<{ text?: string; usageMetadata?: GeminiUsageMetadata }> | null = null;
  const abortHandler = async () => {
    const cancellableStream = currentStream as (AsyncIterable<{ text?: string; usageMetadata?: GeminiUsageMetadata }> & {
      return?: () => Promise<unknown>;
    }) | null;
    if (typeof cancellableStream?.return === 'function') {
      try {
        await cancellableStream.return();
      } catch {
        // Ignore provider stream cancellation failures.
      }
    }
  };

  const abortListener = () => {
    void abortHandler();
  };

  if (abortSignal) {
    abortSignal.addEventListener('abort', abortListener, { once: true });
  }

  try {
    for (const model of candidates) {
      if (abortSignal?.aborted) {
        logger.info('Gemini stream aborted before provider request', { provider: 'gemini', kind: requestKind, model });
        const usage = normalizeGeminiUsage(model);
        onUsage?.(usage);
        return { outcome: 'cancelled', text: '', usage };
      }

      let emittedTokenForModel = false;
      let completionText = '';
      let usageMetadata: GeminiUsageMetadata | undefined;
      try {
        currentStream = await retryGeminiCall(async () => {
          await onProviderAttempt?.(model);
          logger.info('Calling Gemini streaming provider', {
            model,
            kind: requestKind,
            promptSizeBytes: getPromptSizeBytes(payload.contents, payload.systemInstruction),
          });
          return await client.models.generateContentStream({
            model,
            contents: payload.contents,
            config: {
              systemInstruction: payload.systemInstruction,
              safetySettings: SAFETY_SETTINGS,
              ...getGeminiGenerationTuning(model),
              maxOutputTokens: payload.maxOutputTokens,
            },
          });
        }, {
          ...geminiProviderOptions,
          timeoutMs: geminiProviderOptions.timeoutMs ?? AI_CONFIG.GEMINI_TIMEOUT_MS,
          shouldRetry: (error: unknown) => isTransientGeminiError(error),
        });

        let firstTokenObserved = false;
        for await (const chunk of currentStream) {
          if (abortSignal?.aborted) {
            await abortHandler();
            break;
          }

          if (chunk?.usageMetadata) {
            usageMetadata = chunk.usageMetadata;
          }
          const chunkText = typeof chunk?.text === 'string' ? chunk.text : '';
          if (!chunkText) {
            continue;
          }

          completionText += chunkText;
          emittedTokenForModel = true;
          if (!firstTokenObserved) {
            firstTokenObserved = true;
            observeMonitoringLatency('gemini', Date.now() - requestStartedAt, { provider: 'gemini', operation: 'first-token' });
          }
          await onToken(chunkText);
        }

        if (abortSignal?.aborted) {
          logger.info('Gemini stream aborted while receiving content', { provider: 'gemini', kind: requestKind, model });
          const usage = normalizeGeminiUsage(model, usageMetadata);
          onUsage?.(usage);
          return { outcome: 'cancelled', text: completionText.trim(), usage };
        }

        if (!completionText.trim()) {
          geminiBreaker.recordFailure();
          throw new Error('Gemini returned an empty response');
        }

        geminiBreaker.recordSuccess();
        const usage = normalizeGeminiUsage(model, usageMetadata);
        onUsage?.(usage);
        observeMonitoringLatency('gemini', Date.now() - requestStartedAt, { provider: 'gemini', operation: requestKind });
        logger.info('Gemini stream completed', {
          provider: 'gemini',
          kind: requestKind,
          model,
          latencyMs: Date.now() - requestStartedAt,
          responseSizeBytes: Buffer.byteLength(completionText, 'utf8'),
          ...(requestKind === 'chat' ? buildNormalChatModelTelemetry(requestedModel, model, fallbackReason) : {}),
        });
        return { outcome: 'completed', text: completionText.trim(), usage };
      } catch (error: unknown) {
        if (abortSignal?.aborted) {
          logger.info('Gemini stream aborted during provider attempt', { provider: 'gemini', kind: requestKind, model });
          const usage = normalizeGeminiUsage(model, usageMetadata);
          onUsage?.(usage);
          return { outcome: 'cancelled', text: completionText.trim(), usage };
        }

        // A stream may fail after Gemini has already emitted billable work.
        // Preserve provider-reported metadata when available; otherwise mark
        // the usage UNKNOWN rather than fabricating token counts.
        if (emittedTokenForModel || usageMetadata) {
          onUsage?.(normalizeGeminiUsage(model, usageMetadata));
        }

        lastError = error;
        const classification = classifyGeminiError(error);
        logger.warn('Gemini stream attempt failed', {
          provider: 'gemini',
          kind: requestKind,
          model,
          classification: buildGeminiFailureTelemetry(error),
          latencyMs: Date.now() - requestStartedAt,
        });

        if (!shouldFallbackStreamingModel(error, emittedTokenForModel)) {
          break;
        }
        fallbackReason = classification.category;
      }
    }
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener('abort', abortListener);
    }
  }

  const fallbackMessage = 'Gemini is temporarily unavailable. Please try again shortly.';
  logger.warn('Gemini stream degraded gracefully', {
    fallbackMessage,
    classification: buildGeminiFailureTelemetry(lastError),
  });
  throw createSafeNormalChatGeminiError(lastError, fallbackMessage);
}

export async function analyzeImage(
  imageBuffer: Buffer,
  mimeType: string,
  promptOverride?: string,
  modelOverride?: string,
  onUsage?: (usage: GeminiUsage) => void,
  onProviderAttempt?: (model: string) => Promise<unknown>,
): Promise<string> {
  assertFeatureEnabled(AI_FEATURES.IMAGE_UNDERSTANDING, 'Image understanding is currently disabled.');

  if (!geminiApiKey) {
    throw new Error('Gemini provider is not configured. Please try again later.');
  }

  if (geminiBreaker.isOpen()) {
    throw new Error('Gemini is temporarily unavailable. Please try again shortly.');
  }

  await runSecurityCheck(promptOverride ?? 'Please analyze the uploaded image.');

  const base64 = imageBuffer.toString('base64');
  const payload = await buildGeminiRequestPayload(promptOverride ?? 'Please analyze the uploaded image and return a structured JSON response.', 'image');
  const requestStartedAt = Date.now();
  const contents: GeminiMessage[] = payload.contents.map((message: GeminiMessage) => ({ ...message }));
  if (contents[0]) {
    contents[0] = {
      ...contents[0],
      parts: [...contents[0].parts, { inlineData: { mimeType, data: base64 } }],
    };
  }

  const candidates = getModelCandidatesForKind('image', modelOverride);

  let lastError: unknown;
  for (const model of candidates) {
    try {
      const response = await retryGeminiCall(async () => {
        await onProviderAttempt?.(model);
        logger.info('Calling Gemini Vision provider', { model, mimeType, imageBytes: imageBuffer.length, promptSizeBytes: getPromptSizeBytes(contents, payload.systemInstruction) });
        const result = await client.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: payload.systemInstruction,
            safetySettings: SAFETY_SETTINGS,
            ...getGeminiGenerationTuning(model),
            maxOutputTokens: payload.maxOutputTokens,
          },
        });
        return result;
      }, {
        ...geminiProviderOptions,
        timeoutMs: geminiProviderOptions.timeoutMs ?? AI_CONFIG.GEMINI_TIMEOUT_MS,
        shouldRetry: (error: unknown) => isTransientGeminiError(error),
      });

      const text = response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const responseSizeBytes = Buffer.byteLength(text, 'utf8');
      logger.info('Gemini image analysis completed', {
        provider: 'gemini',
        kind: 'image',
        model,
        latencyMs: Date.now() - requestStartedAt,
        promptSizeBytes: getPromptSizeBytes(contents, payload.systemInstruction),
        responseSizeBytes,
      });

      if (!text || text.trim() === '') {
        geminiBreaker.recordFailure();
        throw new Error('Gemini returned an empty response for image analysis');
      }

      geminiBreaker.recordSuccess();
      onUsage?.(normalizeGeminiUsage(model, response?.usageMetadata));
      observeMonitoringLatency('gemini', Date.now() - requestStartedAt, { provider: 'gemini', operation: 'image' });
      return text.trim();
    } catch (error: unknown) {
      lastError = error;
      const classification = classifyGeminiError(error);
      logger.warn('Gemini image model attempt failed', {
        provider: 'gemini',
        kind: 'image',
        model,
        classification: buildGeminiFailureTelemetry(error),
        latencyMs: Date.now() - requestStartedAt,
      });

      if (shouldTryNextGeminiModel(error) && model !== candidates[candidates.length - 1]) {
        logger.warn('Falling back to the next Gemini image model', { provider: 'gemini', kind: 'image', fromModel: model, nextModel: candidates[candidates.indexOf(model) + 1] });
        continue;
      }

      geminiBreaker.recordFailure();
      observeMonitoringLatency('gemini', Date.now() - requestStartedAt, { provider: 'gemini', operation: 'image', status: classification.status ?? 'error' });
      incrementMonitoringFailure('tutor', { provider: 'gemini', feature: 'image', reason: classification.category });
      logger.error('Gemini image analysis failed', {
        provider: 'gemini',
        kind: 'image',
        classification: buildGeminiFailureTelemetry(error),
        latencyMs: Date.now() - requestStartedAt,
        promptSizeBytes: getPromptSizeBytes(contents, payload.systemInstruction),
      });
      throw createSafeNormalChatGeminiError(error, 'Gemini is temporarily unavailable. Please try again shortly.');
    }
  }

  throw lastError
    ? createSafeNormalChatGeminiError(lastError, 'Gemini is temporarily unavailable. Please try again shortly.')
    : new Error('Unable to analyze image right now.');
}

export function buildGeminiHealthCheckResult(startedAt: number, success: boolean, message: string): { apiKeyLoaded: boolean; modelAvailable: boolean; responseTimeMs: number; success: boolean; message: string } {
  return {
    apiKeyLoaded: true,
    modelAvailable: success,
    responseTimeMs: Date.now() - startedAt,
    success,
    message,
  };
}

export async function runGeminiStartupHealthCheck(): Promise<{ apiKeyLoaded: boolean; modelAvailable: boolean; responseTimeMs: number; success: boolean; message: string }> {
  if (!geminiApiKey) {
    logger.warn('Gemini startup health check skipped', { reason: 'missing_api_key', apiKeyLoaded: false });
    return { apiKeyLoaded: false, modelAvailable: false, responseTimeMs: 0, success: false, message: 'Gemini API key is missing.' };
  }

  const startedAt = Date.now();
  const candidates = getModelCandidatesForKind('chat');
  let lastError: unknown;
  let lastClassification: ReturnType<typeof classifyGeminiError> | undefined;

  for (const model of candidates) {
    try {
      const response = await client.models.generateContent({
        model,
        contents: 'Hello',
        config: {
          systemInstruction: 'Reply briefly with a greeting.',
          maxOutputTokens: 16,
        },
      });

      const success = isGeminiResponseSuccessful(response);
      const message = success ? 'Gemini is reachable.' : 'Gemini responded without text.';
      const result = buildGeminiHealthCheckResult(startedAt, success, message);
      logger.info('Gemini startup health check completed', {
        apiKeyLoaded: true,
        modelAvailable: success,
        responseTimeMs: result.responseTimeMs,
        success,
        model,
      });
      return result;
    } catch (error: unknown) {
      lastError = error;
      lastClassification = classifyGeminiError(error);
      logger.warn('Gemini startup health check attempt failed', {
        apiKeyLoaded: true,
        modelAvailable: false,
        responseTimeMs: Date.now() - startedAt,
        model,
        classification: lastClassification,
      });

      if (lastClassification.category === 'model_not_found' && model !== candidates[candidates.length - 1]) {
        continue;
      }

      break;
    }
  }

  const responseTimeMs = Date.now() - startedAt;
  const classification = lastClassification ?? classifyGeminiError(lastError ?? new Error('Gemini health check failed.'));
  logger.error('Gemini startup health check failed', {
    apiKeyLoaded: true,
    modelAvailable: false,
    responseTimeMs,
    success: false,
    classification,
    error: sanitizeForLogging({
      status: classification.status,
      message: classification.message,
      responseBody: classification.responseBody,
      details: classification.details,
      stack: getErrorStack(lastError),
    }),
  });
  return buildGeminiHealthCheckResult(startedAt, false, classification.message || 'Gemini health check failed.');
}

function getGeminiGenerationTuning(model: string) {
  // Gemini 3.x uses thinking configuration. Google recommends omitting the
  // legacy sampling parameters for these models.
  if (model.startsWith('gemini-3')) {
    return { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } };
  }

  return {
    temperature: AI_CONFIG.TEMPERATURE,
    topP: AI_CONFIG.TOP_P,
    topK: AI_CONFIG.TOP_K,
  };
}
