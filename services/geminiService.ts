import { GoogleGenAI } from '@google/genai';
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
  parts: Array<{ text?: string; image?: { mimeType: string; data: string } }>;
};

export type GeminiImageContent = {
  type: 'image';
  data: string;
  mime_type: string;
  uri?: string;
};

export type GeminiContent = GeminiMessage | GeminiImageContent;

type GeminiModelKind = 'chat' | 'image' | 'live-tutor';

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
  const explicitOverride = modelOverride?.trim();
  const configuredModel = getConfiguredModelName(kind);
  const fallbackModels = [configuredModel, 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'];
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

function isTransientGeminiError(error: unknown): boolean {
  const classification = classifyGeminiError(error);
  return classification.category === 'rate_limit' || classification.category === 'model_overloaded' || classification.category === 'timeout' || classification.category === 'network_failure';
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

    if (part.image) {
      flushText();
      compacted.push({ image: part.image });
    }
  }

  flushText();
  return compacted;
}

function buildGeminiRequestPayload(input: string | GeminiContent[], kind: GeminiModelKind): GeminiRequestPayload {
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

    const contents = nonSystemMessages
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

    if (contents.length === 0) {
      throw new Error('Conversation must contain at least one user or model message');
    }

    return {
      contents,
      systemInstruction: systemInstructionParts.filter(Boolean).join('\n'),
      maxOutputTokens: getMaxOutputTokensForKind(kind),
    };
  }

  throw new Error('Invalid Gemini input');
}

export { buildGeminiRequestPayload };

function extractPromptText(input: string | GeminiContent[]): string {
  if (typeof input === 'string') {
    return input.trim();
  }

  if (Array.isArray(input)) {
    const texts = input.flatMap((item) => {
      if (typeof item === 'object' && 'role' in item && Array.isArray(item.parts)) {
        return item.parts.map((part) => part.text || '').filter(Boolean);
      }
      return [];
    });
    return texts.join('\n').trim();
  }

  return '';
}

async function runSecurityCheck(input: string | GeminiContent[]): Promise<void> {
  const promptText = extractPromptText(input);
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

function getPromptSizeBytes(contents: GeminiMessage[], systemInstruction: string): number {
  return Buffer.byteLength(JSON.stringify({ contents, systemInstruction }), 'utf8');
}

export async function askGemini(input: string | GeminiContent[], modelOverride?: string): Promise<string> {
  assertFeatureEnabled(AI_FEATURES.CHAT, 'Chat AI is currently disabled.');

  if (!geminiApiKey) {
    throw new Error('Gemini provider is not configured. Please try again later.');
  }

  if (geminiBreaker.isOpen()) {
    throw new Error('Gemini is temporarily unavailable. Please try again shortly.');
  }

  await runSecurityCheck(input);
  const payload = buildGeminiRequestPayload(input, 'chat');
  const requestStartedAt = Date.now();
  const candidates = getModelCandidatesForKind('chat', modelOverride);

  let lastError: unknown;
  for (const model of candidates) {
    try {
      const response = await retryGeminiCall(async () => {
        logger.info('Calling Gemini provider', { model, kind: 'chat', promptSizeBytes: getPromptSizeBytes(payload.contents, payload.systemInstruction) });
        const result = await client.models.generateContent({
          model,
          contents: payload.contents,
          config: {
            systemInstruction: payload.systemInstruction,
            safetySettings: SAFETY_SETTINGS,
            temperature: AI_CONFIG.TEMPERATURE,
            topP: AI_CONFIG.TOP_P,
            topK: AI_CONFIG.TOP_K,
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
      logger.info('Gemini request completed', {
        provider: 'gemini',
        kind: 'chat',
        model,
        latencyMs: Date.now() - requestStartedAt,
        promptSizeBytes: getPromptSizeBytes(payload.contents, payload.systemInstruction),
        responseSizeBytes,
      });

      if (!text || text.trim() === '') {
        geminiBreaker.recordFailure();
        throw new Error('Gemini returned an empty response');
      }

      geminiBreaker.recordSuccess();
      observeMonitoringLatency('gemini', Date.now() - requestStartedAt, { provider: 'gemini', operation: 'chat' });
      return text.trim();
    } catch (error: unknown) {
      lastError = error;
      const classification = classifyGeminiError(error);
      logger.warn('Gemini model attempt failed', {
        provider: 'gemini',
        kind: 'chat',
        model,
        classification,
        latencyMs: Date.now() - requestStartedAt,
      });

      if (classification.category === 'model_not_found' && model !== candidates[candidates.length - 1]) {
        logger.warn('Falling back to the next Gemini model', { provider: 'gemini', kind: 'chat', fromModel: model, nextModel: candidates[candidates.indexOf(model) + 1] });
        continue;
      }

      geminiBreaker.recordFailure();
      observeMonitoringLatency('gemini', Date.now() - requestStartedAt, { provider: 'gemini', operation: 'chat', status: classification.status ?? 'error' });
      incrementMonitoringFailure('tutor', { provider: 'gemini', feature: 'chat', reason: classification.category });
      const errorMessage = getErrorMessage(error);
      const rootCause = classification.message || getClientErrorMessage(errorMessage, 'Unable to generate a response right now.');
      logger.error('Gemini request failed', {
        error: sanitizeForLogging({
          status: classification.status,
          message: rootCause,
          responseBody: classification.responseBody,
          details: classification.details,
          stack: getErrorStack(error),
        }),
        provider: 'gemini',
        kind: 'chat',
        classification,
        latencyMs: Date.now() - requestStartedAt,
        promptSizeBytes: getPromptSizeBytes(payload.contents, payload.systemInstruction),
      });
      throw createGeminiError(rootCause, error);
    }
  }

  throw lastError ? createGeminiError(getErrorText(lastError) || 'Unable to generate a response right now.', lastError) : new Error('Unable to generate a response right now.');
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
  const payload = buildGeminiRequestPayload(input, 'live-tutor');
  const requestStartedAt = Date.now();
  const candidates = getModelCandidatesForKind('live-tutor', modelOverride);
  const configuredModel = getConfiguredModelName('live-tutor');

  // Calculate input character count (sum of all message text)
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
            temperature: AI_CONFIG.TEMPERATURE,
            topP: AI_CONFIG.TOP_P,
            topK: AI_CONFIG.TOP_K,
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

      if (classification.category === 'model_not_found' && model !== candidates[candidates.length - 1]) {
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

export async function askGeminiStream(
  input: string | GeminiContent[],
  onToken: (token: string) => Promise<void> | void,
  modelOverride?: string,
  abortSignal?: AbortSignal
): Promise<string> {
  assertFeatureEnabled(AI_FEATURES.CHAT, 'Chat AI is currently disabled.');
  assertFeatureEnabled(AI_FEATURES.STREAMING, 'Streaming is currently disabled.');

  if (!geminiApiKey) {
    throw new Error('Gemini API key is missing');
  }

  if (geminiBreaker.isOpen()) {
    throw new Error('Gemini is temporarily unavailable. Please try again shortly.');
  }

  await runSecurityCheck(input);
  const payload = buildGeminiRequestPayload(input, 'chat');
  const requestStartedAt = Date.now();
  const candidates = getModelCandidatesForKind('chat', modelOverride);

  logger.info('Gemini stream request started', {
    inputPreview: typeof input === 'string' ? input.slice(0, 80) : 'conversation-array',
    promptSizeBytes: getPromptSizeBytes(payload.contents, payload.systemInstruction),
  });

  let lastError: unknown;
  let currentStream: AsyncIterable<{ text?: string }> | null = null;
  const abortHandler = async () => {
    if (currentStream && typeof (currentStream as any).return === 'function') {
      try {
        await (currentStream as any).return();
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
        logger.info('Gemini stream aborted before provider request', { provider: 'gemini', kind: 'chat', model });
        return '';
      }

      try {
        currentStream = await retryGeminiCall(async () => {
          logger.info('Calling Gemini streaming provider', {
            model,
            kind: 'chat',
            promptSizeBytes: getPromptSizeBytes(payload.contents, payload.systemInstruction),
          });
          return await client.models.generateContentStream({
            model,
            contents: payload.contents,
            config: {
              systemInstruction: payload.systemInstruction,
              safetySettings: SAFETY_SETTINGS,
              temperature: AI_CONFIG.TEMPERATURE,
              topP: AI_CONFIG.TOP_P,
              topK: AI_CONFIG.TOP_K,
              maxOutputTokens: payload.maxOutputTokens,
            },
          });
        }, {
          ...geminiProviderOptions,
          timeoutMs: geminiProviderOptions.timeoutMs ?? AI_CONFIG.GEMINI_TIMEOUT_MS,
          shouldRetry: (error: unknown) => isTransientGeminiError(error),
        });

        let completionText = '';
        let firstTokenObserved = false;
        for await (const chunk of currentStream) {
          if (abortSignal?.aborted) {
            await abortHandler();
            break;
          }

          const chunkText = typeof chunk?.text === 'string' ? chunk.text : '';
          if (!chunkText) {
            continue;
          }

          completionText += chunkText;
          if (!firstTokenObserved) {
            firstTokenObserved = true;
            observeMonitoringLatency('gemini', Date.now() - requestStartedAt, { provider: 'gemini', operation: 'first-token' });
          }
          await onToken(chunkText);
        }

        if (abortSignal?.aborted) {
          logger.info('Gemini stream aborted while receiving content', { provider: 'gemini', kind: 'chat', model });
          return completionText.trim();
        }

        if (!completionText.trim()) {
          geminiBreaker.recordFailure();
          throw new Error('Gemini returned an empty response');
        }

        geminiBreaker.recordSuccess();
        observeMonitoringLatency('gemini', Date.now() - requestStartedAt, { provider: 'gemini', operation: 'chat' });
        logger.info('Gemini stream completed', {
          provider: 'gemini',
          kind: 'chat',
          model,
          latencyMs: Date.now() - requestStartedAt,
          responseSizeBytes: Buffer.byteLength(completionText, 'utf8'),
        });
        return completionText.trim();
      } catch (error: unknown) {
        if (abortSignal?.aborted) {
          logger.info('Gemini stream aborted during provider attempt', { provider: 'gemini', kind: 'chat', model, error: String(error) });
          return ''; // Return partial text if available but do not escalate as provider error.
        }

        lastError = error;
        const classification = classifyGeminiError(error);
        logger.warn('Gemini stream attempt failed', {
          provider: 'gemini',
          kind: 'chat',
          model,
          classification,
          latencyMs: Date.now() - requestStartedAt,
        });
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
    cause: lastError instanceof Error ? lastError.message : String(lastError),
  });
  throw new Error(fallbackMessage);
}

export async function analyzeImage(
  imageBuffer: Buffer,
  mimeType: string,
  promptOverride?: string,
  modelOverride?: string,
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
  const payload = buildGeminiRequestPayload(promptOverride ?? 'Please analyze the uploaded image and return a structured JSON response.', 'image');
  const requestStartedAt = Date.now();
  const contents: GeminiMessage[] = payload.contents.map((message: GeminiMessage) => ({ ...message }));
  if (contents[0]) {
    contents[0] = {
      ...contents[0],
      parts: [...contents[0].parts, { image: { mimeType, data: base64 } }],
    };
  }

  const candidates = getModelCandidatesForKind('image', modelOverride);

  let lastError: unknown;
  for (const model of candidates) {
    try {
      const response = await retryGeminiCall(async () => {
        logger.info('Calling Gemini Vision provider', { model, mimeType, preview: (base64 || '').slice(0, 40), promptSizeBytes: getPromptSizeBytes(contents, payload.systemInstruction) });
        const result = await client.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: payload.systemInstruction,
            safetySettings: SAFETY_SETTINGS,
            temperature: AI_CONFIG.TEMPERATURE,
            topP: AI_CONFIG.TOP_P,
            topK: AI_CONFIG.TOP_K,
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
      observeMonitoringLatency('gemini', Date.now() - requestStartedAt, { provider: 'gemini', operation: 'image' });
      return text.trim();
    } catch (error: unknown) {
      lastError = error;
      const classification = classifyGeminiError(error);
      logger.warn('Gemini image model attempt failed', {
        provider: 'gemini',
        kind: 'image',
        model,
        classification,
        latencyMs: Date.now() - requestStartedAt,
      });

      if (classification.category === 'model_not_found' && model !== candidates[candidates.length - 1]) {
        logger.warn('Falling back to the next Gemini image model', { provider: 'gemini', kind: 'image', fromModel: model, nextModel: candidates[candidates.indexOf(model) + 1] });
        continue;
      }

      geminiBreaker.recordFailure();
      observeMonitoringLatency('gemini', Date.now() - requestStartedAt, { provider: 'gemini', operation: 'image', status: classification.status ?? 'error' });
      incrementMonitoringFailure('tutor', { provider: 'gemini', feature: 'image', reason: classification.category });
      const errorMessage = getErrorMessage(error);
      const rootCause = classification.message || getClientErrorMessage(errorMessage, 'Unable to analyze image right now.');
      logger.error('Gemini image analysis failed', {
        error: sanitizeForLogging({
          status: classification.status,
          message: rootCause,
          responseBody: classification.responseBody,
          details: classification.details,
          stack: getErrorStack(error),
        }),
        provider: 'gemini',
        kind: 'image',
        classification,
        latencyMs: Date.now() - requestStartedAt,
        promptSizeBytes: getPromptSizeBytes(contents, payload.systemInstruction),
      });
      throw createGeminiError(rootCause, error);
    }
  }

  throw lastError ? createGeminiError(getErrorText(lastError) || 'Unable to analyze image right now.', lastError) : new Error('Unable to analyze image right now.');
}

let startupHealthCheckRan = false;

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

if (!startupHealthCheckRan) {
  startupHealthCheckRan = true;
  void runGeminiStartupHealthCheck();
}