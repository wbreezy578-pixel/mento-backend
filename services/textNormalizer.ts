/**
 * TEXT NORMALIZER FOR SECURITY DETECTION
 *
 * Normalizes text safely for injection detection without altering
 * the original content sent to Gemini.
 *
 * This module provides normalization specifically for detection purposes:
 * - Unicode normalization (NFC)
 * - Zero-width character removal
 * - Bidirectional override character removal
 * - Control character removal
 * - Homograph/diacritic analysis
 *
 * CRITICAL: Original learner content is NEVER modified.
 * Normalization is only for internal detection signals.
 */

export interface TextCharacteristics {
  originalLength: number;
  normalizedLength: number;
  hasZeroWidthChars: boolean;
  hasRTLOverride: boolean;
  hasControlChars: boolean;
  hasExcessiveDiacritics: boolean;
  scriptTypes: Set<string>;
  detectedLanguage: 'english' | 'arabic' | 'swahili' | 'mixed' | 'unknown';
}

export interface NormalizedText {
  original: string;
  normalized: string;
  characteristics: TextCharacteristics;
}

/**
 * Normalize text for security detection
 * Returns normalized text and original unchanged
 */
export function normalizeTextForDetection(text: string): NormalizedText {
  if (!text || typeof text !== 'string') {
    return {
      original: text || '',
      normalized: '',
      characteristics: {
        originalLength: 0,
        normalizedLength: 0,
        hasZeroWidthChars: false,
        hasRTLOverride: false,
        hasControlChars: false,
        hasExcessiveDiacritics: false,
        scriptTypes: new Set(),
        detectedLanguage: 'unknown',
      },
    };
  }

  const original = text;
  let normalized = text;

  // Detect characteristics before normalization
  const hasZeroWidthChars = /[\u200B\u200C\u200D\u2060\uFEFF]/.test(normalized);
  const hasRTLOverride = /[\u202E\u202D\u202C]/.test(normalized);
  const hasControlChars = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(normalized);

  // 1. Unicode NFC normalization
  try {
    normalized = normalized.normalize('NFC');
  } catch (e) {
    // If normalization fails, continue with unnormalized text
  }

  // 2. Remove zero-width characters (except ZWNJ which is legitimate in some scripts)
  // Keep: U+200C (zero-width non-joiner) for legitimate use in Arabic/Persian/Urdu
  // Remove: U+200B, U+200D (zero-width space/joiner), U+2060, U+FEFF
  normalized = normalized.replace(/[\u200B\u200D\u2060\uFEFF]/g, '');

  // 3. Remove bidirectional override characters (can be used to reverse text for obfuscation)
  // Keep: U+202A/U+202B (LRE/RLE) which are sometimes used legitimately
  // Remove: U+202E (RLO - right-to-left override), U+202D (LRO - left-to-right override)
  normalized = normalized.replace(/[\u202E\u202D]/g, '');

  // 4. Remove control characters (keep tab/newline/carriage return)
  normalized = normalized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // 5. Detect script types
  const scriptTypes = detectScriptTypes(normalized);

  // 6. Detect language
  const detectedLanguage = detectLanguage(normalized);

  // 7. Check for excessive diacritics (homograph attacks)
  const hasExcessiveDiacritics = checkExcessiveDiacritics(normalized);

  return {
    original,
    normalized,
    characteristics: {
      originalLength: original.length,
      normalizedLength: normalized.length,
      hasZeroWidthChars,
      hasRTLOverride,
      hasControlChars,
      hasExcessiveDiacritics,
      scriptTypes,
      detectedLanguage,
    },
  };
}

/**
 * Detect script types in text
 */
function detectScriptTypes(text: string): Set<string> {
  const scripts = new Set<string>();

  if (/[a-zA-Z0-9]/.test(text)) scripts.add('latin');
  if (/[а-яА-ЯёЁ]/.test(text)) scripts.add('cyrillic');
  if (/[\u0600-\u06FF]/.test(text)) scripts.add('arabic');
  if (/[\u0900-\u097F]/.test(text)) scripts.add('devanagari');
  if (/[\uAC00-\uD7AF]/.test(text)) scripts.add('hangul');
  if (/[\u4E00-\u9FFF]/.test(text)) scripts.add('cjk');
  if (/[\u0E00-\u0E7F]/.test(text)) scripts.add('thai');
  if (/[\u3040-\u309F]/.test(text)) scripts.add('hiragana');
  if (/[\u30A0-\u30FF]/.test(text)) scripts.add('katakana');

  return scripts;
}

/**
 * Detect primary language of text
 */
function detectLanguage(
  text: string
): 'english' | 'arabic' | 'swahili' | 'mixed' | 'unknown' {
  if (!text) return 'unknown';

  // Check for Arabic (including Persian, Urdu variants)
  const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const arabicRatio = arabicChars / text.length;

  // Check for Latin/English
  const latinChars = (text.match(/[a-zA-Z0-9]/g) || []).length;
  const latinRatio = latinChars / text.length;

  // Check for Cyrillic (might indicate Russian)
  const cyrillicChars = (text.match(/[а-яА-ЯёЁ]/g) || []).length;
  const cyrillicRatio = cyrillicChars / text.length;

  // Predominantly Arabic
  if (arabicRatio > 0.6) {
    return 'arabic';
  }

  // Predominantly Latin/English
  if (latinRatio > 0.7) {
    return 'english';
  }

  // Check if Swahili (Latin with accents + context)
  // Swahili uses Latin script with common patterns
  if (latinRatio > 0.5 && arabicChars === 0) {
    // Swahili typically has Latin words, no Arabic
    return 'swahili';
  }

  // Mixed content
  if (arabicRatio > 0.1 && latinRatio > 0.1) {
    return 'mixed';
  }

  return 'unknown';
}

/**
 * Check if text has excessive diacritics (potential homograph attack)
 * Excessive combining marks can be used to obfuscate text or create look-alike characters
 */
function checkExcessiveDiacritics(text: string): boolean {
  // Unicode combining marks and diacritics
  // https://en.wikipedia.org/wiki/Combining_Diacritical_Marks
  const combiningMarks = text.match(/[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF]/g);

  if (!combiningMarks || combiningMarks.length === 0) {
    return false;
  }

  // Flag if more than 30% of characters are combining marks (highly suspicious)
  const ratio = combiningMarks.length / Math.max(text.length, 1);
  return ratio > 0.3;
}

/**
 * Estimate if text is likely attempting obfuscation
 * based on characteristic patterns
 */
export function estimateObfuscationRisk(characteristics: TextCharacteristics): number {
  let risk = 0;

  // Zero-width characters in short text = suspicious
  if (characteristics.hasZeroWidthChars) {
    risk += 25;
  }

  // RTL override characters = suspicious
  if (characteristics.hasRTLOverride) {
    risk += 30;
  }

  // Control characters = very suspicious
  if (characteristics.hasControlChars) {
    risk += 20;
  }

  // Excessive diacritics = suspicious
  if (characteristics.hasExcessiveDiacritics) {
    risk += 15;
  }

  // Mixed scripts in short text = suspicious
  if (characteristics.scriptTypes.size > 2 && characteristics.originalLength < 100) {
    risk += 20;
  }

  // Very short text with multiple scripts = highly suspicious
  if (characteristics.scriptTypes.size > 3 && characteristics.originalLength < 50) {
    risk += 25;
  }

  return Math.min(100, risk);
}

/**
 * Check if normalized and original lengths differ significantly
 * This could indicate aggressive removal of characters during normalization
 */
export function checkNormalizationDelta(normalized: NormalizedText): {
  significantDelta: boolean;
  percentageChange: number;
  interpretation: string;
} {
  if (normalized.characteristics.originalLength === 0) {
    return {
      significantDelta: false,
      percentageChange: 0,
      interpretation: 'Empty input',
    };
  }

  const percentageChange = (
    (normalized.characteristics.originalLength - normalized.characteristics.normalizedLength) /
    normalized.characteristics.originalLength
  ) * 100;

  // More than 20% character reduction = significant
  const significantDelta = percentageChange > 20;

  let interpretation = 'Normal';
  if (percentageChange > 50) {
    interpretation = 'Very aggressive obfuscation attempt';
  } else if (percentageChange > 30) {
    interpretation = 'Moderate obfuscation attempt';
  } else if (percentageChange > 20) {
    interpretation = 'Potential obfuscation';
  }

  return {
    significantDelta,
    percentageChange,
    interpretation,
  };
}

/**
 * Safely escape text for logging (don't expose raw learner content)
 */
export function sanitizeForLog(text: string, maxLength: number = 50): string {
  if (!text) return '[empty]';

  // Truncate
  let truncated = text.length > maxLength ? text.substring(0, maxLength) + '...' : text;

  // Remove newlines for log readability
  truncated = truncated.replace(/[\r\n]/g, ' ');

  // Remove control characters
  truncated = truncated.replace(/[\x00-\x1F\x7F]/g, '');

  return truncated;
}
