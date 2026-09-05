/**
 * Token Counting Service
 *
 * Handles token counting with dual-strategy approach:
 * 1. Provider token counting (Gemini API countTokens endpoint) - accurate but slower
 * 2. Conservative local estimation fallback - fast, used when provider unavailable
 *
 * Post-call validation: Compare pre-request estimates against provider-reported usage
 */

import logger from '../lib/logger';
import { getGeminiApiKey, loadAndValidateEnvironment } from '../lib/env';
import { estimateLanguageCharacteristics } from './contextBudgetConfig';

loadAndValidateEnvironment();
const geminiApiKey = getGeminiApiKey();

export type TokenCountingSource = 'PROVIDER_REPORTED' | 'ESTIMATED';

export interface TokenCountResult {
  tokens: number;
  source: TokenCountingSource;
  model: string;
  multilingual: boolean;
  debug?: {
    charCount: number;
    estimatedCharsPerToken: number;
    language: string;
  };
}

export interface GeminiCountTokensRequest {
  model: string;
  contents: Array<{
    role?: string;
    parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
  }>;
  systemInstruction?: string;
}

/**
 * Call Gemini API's countTokens endpoint
 * This is accurate but adds latency (~200-500ms per call)
 *
 * USE CASE: When budget checking is critical and latency is acceptable
 * AVOID: For every keystroke or frequent budget checks
 */
export async function countTokensViaProvider(
  request: GeminiCountTokensRequest,
): Promise<TokenCountResult | null> {
  if (!geminiApiKey) {
    logger.warn('[TokenCounter] Gemini API key not configured, cannot use provider token counting');
    return null;
  }

  try {
    // Provider integration would go here
    // For now, return null to indicate provider unavailable
    // In production, this would call: https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:countTokens
    logger.info('[TokenCounter] Provider token counting would be called here');
    return null;
  } catch (error) {
    logger.warn('[TokenCounter] Provider token counting failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Estimate token count from character count
 *
 * RATIONALE:
 * Gemini tokenization is roughly:
 * - English: 1 token ≈ 4 characters
 * - Swahili: 1 token ≈ 3.5 characters
 * - Arabic: 1 token ≈ 2 characters (includes diacritics, vowel marks)
 * - Mixed: 1 token ≈ 3 characters (conservative)
 *
 * This is NOT for billing (which requires provider-reported tokens),
 * but for PRE-request budget decisions to avoid rejected requests.
 *
 * Safety margin: Always round UP to be conservative
 */
export function estimateTokenCountFromText(text: string): {
  tokens: number;
  language: string;
  charsPerToken: number;
  charCount: number;
} {
  const charCount = text.length;
  const characteristics = estimateLanguageCharacteristics(text);

  // Exact Gemini tokenization is not available locally. Use the larger of the
  // language estimate and a language-agnostic UTF-8 byte floor. The byte floor
  // deliberately overestimates ASCII and remains conservative for CJK, emoji,
  // code and unusual Unicode rather than assuming one optimistic char ratio.
  const languageEstimate = Math.ceil(charCount / characteristics.estimatedCharsPerToken);
  const utf8ByteEstimate = Math.ceil(Buffer.byteLength(text, 'utf8') / 2);
  const tokens = Math.max(languageEstimate, utf8ByteEstimate);

  const language = characteristics.hasArabic ? 'arabic' : characteristics.isPrimarilyEnglish ? 'english' : 'mixed';

  return {
    tokens,
    language,
    charsPerToken: characteristics.estimatedCharsPerToken,
    charCount,
  };
}

/**
 * Estimate tokens from image (based on image dimensions and format)
 *
 * Gemini Vision pricing:
 * - Images are billed separately from text
 * - Approximately 258 tokens per image (base)
 * - Additional 258 tokens per million pixels
 *
 * Conservative estimate: 258 + image_tokens
 */
export function estimateTokenCountFromImage(
  imageSizeBytes: number,
  mimeType: string,
): { tokens: number; estimated: boolean } {
  // Base tokens for any image
  let baseTokens = 258;

  // Add tokens based on file size (very rough proxy for dimensions)
  // This is conservative - actual depends on exact dimensions
  // File size in MB -> approximate pixels
  const fileSizeMB = imageSizeBytes / (1024 * 1024);

  // Very conservative: assume ~1 pixel per 10 bytes for JPEGs
  // (actual is typically 1 pixel per 2-5 bytes depending on compression)
  const estimatedPixels = Math.ceil((imageSizeBytes / 10) * 1_000_000);
  const additionalTokens = Math.ceil(estimatedPixels / 1_000_000 * 258);

  return {
    tokens: baseTokens + additionalTokens,
    estimated: true, // Always estimated since we don't have true dimensions
  };
}

/**
 * Count tokens for a complete request
 *
 * Strategy:
 * 1. Try provider counting if strict accuracy needed
 * 2. Fall back to local estimation (fast)
 * 3. Log discrepancies for monitoring
 */
export async function countTokensForContent(
  model: string,
  contents: Array<{
    role?: string;
    parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
  }>,
  systemInstruction?: string,
  options?: {
    tryProvider?: boolean;
    forBudgetDecision?: boolean; // If true, use conservative estimation
  },
): Promise<TokenCountResult> {
  const tryProvider = options?.tryProvider ?? false;
  const forBudgetDecision = options?.forBudgetDecision ?? true;

  // Try provider if requested
  if (tryProvider) {
    const providerResult = await countTokensViaProvider({
      model,
      contents,
      systemInstruction,
    });
    if (providerResult) {
      return providerResult;
    }
  }

  // Fall back to local estimation
  let totalTokens = 0;
  let hasMultilingual = false;

  // Count system instruction
  if (systemInstruction) {
    const sysEstimate = estimateTokenCountFromText(systemInstruction);
    totalTokens += sysEstimate.tokens;
    if (sysEstimate.language === 'arabic' || sysEstimate.language === 'mixed') {
      hasMultilingual = true;
    }
  }

  // Count content
  for (const content of contents) {
    for (const part of content.parts) {
      if (part.text) {
        const textEstimate = estimateTokenCountFromText(part.text);
        totalTokens += textEstimate.tokens;
        if (textEstimate.language === 'arabic' || textEstimate.language === 'mixed') {
          hasMultilingual = true;
        }
      } else if (part.inlineData) {
        const imageEstimate = estimateTokenCountFromImage(
          Buffer.byteLength(part.inlineData.data, 'base64'),
          part.inlineData.mimeType,
        );
        totalTokens += imageEstimate.tokens;
      }
    }
  }

  // Add safety margin for estimation if used for budget decision
  // (provider tokens may vary slightly from our estimation)
  const safetyMargin = forBudgetDecision ? Math.ceil(totalTokens * 0.1) : 0; // +10% safety
  const finalTokens = totalTokens + safetyMargin;

  logger.info('[TokenCounter] Estimated token count', {
    model,
    estimatedTokens: totalTokens,
    withSafetyMargin: finalTokens,
    hasMultilingual,
    source: 'ESTIMATED',
  });

  return {
    tokens: finalTokens,
    source: 'ESTIMATED',
    model,
    multilingual: hasMultilingual,
    debug: {
      charCount: contents.reduce((sum, c) => sum + c.parts.reduce((s, p) => s + (p.text?.length ?? 0), 0), 0),
      estimatedCharsPerToken: 3.5, // Average of multilingual ratios
      language: hasMultilingual ? 'mixed' : 'english',
    },
  };
}

/**
 * Validate provider-reported usage against our pre-request estimate
 *
 * This helps us:
 * 1. Calibrate our estimation accuracy
 * 2. Detect provider API changes
 * 3. Catch over/under-billing scenarios
 */
export function validateProviderUsageVsEstimate(estimate: {
  estimatedInputTokens: number;
  estimatedTotalTokens: number;
}, actual: {
  actualInputTokens: number;
  actualTotalTokens: number;
}): {
  valid: boolean;
  discrepancy: number;
  warning?: string;
} {
  const inputDiscrepancy = Math.abs(actual.actualInputTokens - estimate.estimatedInputTokens);
  const totalDiscrepancy = Math.abs(actual.actualTotalTokens - estimate.estimatedTotalTokens);

  // Flag if actual is >20% more than estimated (indicates under-estimation)
  // or >10% less (indicates over-estimation, but less critical)
  const discrepancyPercent = (inputDiscrepancy / estimate.estimatedInputTokens) * 100;

  if (discrepancyPercent > 20) {
    return {
      valid: false,
      discrepancy: discrepancyPercent,
      warning: `Provider usage (${actual.actualInputTokens}) significantly exceeds estimate (${estimate.estimatedInputTokens}). Consider adjusting estimation ratios.`,
    };
  }

  if (discrepancyPercent > 10) {
    logger.warn('[TokenCounter] Mild estimation discrepancy detected', {
      estimated: estimate.estimatedInputTokens,
      actual: actual.actualInputTokens,
      discrepancyPercent,
    });
  }

  return {
    valid: true,
    discrepancy: discrepancyPercent,
  };
}
