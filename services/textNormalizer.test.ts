/**
 * TEXT NORMALIZER - TEST SUITE
 *
 * Tests for:
 * - Unicode normalization
 * - Character detection (zero-width, RTL, control)
 * - Language detection
 * - Obfuscation risk estimation
 *
 * Run with: npx vitest services/textNormalizer.test.ts
 */

import { describe, test, expect } from 'vitest';
import {
  normalizeTextForDetection,
  estimateObfuscationRisk,
  checkNormalizationDelta,
  sanitizeForLog,
} from './textNormalizer';

/**
 * ========================================
 * UNICODE NORMALIZATION
 * ========================================
 */
describe('Text Normalization - Unicode', () => {
  test('normalizes composed/decomposed characters', () => {
    // é (precomposed) vs e + ◌́ (decomposed)
    const decomposed = 'café'; // Using decomposed form
    const normalized = normalizeTextForDetection(decomposed);
    expect(normalized.normalized).toContain('café');
  });

  test('preserves original content unchanged', () => {
    const input = 'Hello world';
    const result = normalizeTextForDetection(input);
    expect(result.original).toBe(input);
    expect(result.original).not.toBe(result.normalized); // Unless already normalized
  });

  test('removes zero-width characters', () => {
    const input = 'Hello\u200BWorld\u200C\u200D'; // Zero-width space, joiner, non-joiner
    const result = normalizeTextForDetection(input);
    expect(result.normalized).not.toContain('\u200B');
    expect(result.normalized).not.toContain('\u200C');
    expect(result.normalized).not.toContain('\u200D');
    expect(result.characteristics.hasZeroWidthChars).toBe(true);
  });

  test('removes RTL override characters', () => {
    const input = 'test\u202Emore'; // RTL override
    const result = normalizeTextForDetection(input);
    expect(result.normalized).not.toContain('\u202E');
    expect(result.characteristics.hasRTLOverride).toBe(true);
  });

  test('removes control characters', () => {
    const input = 'Hello\x00World\x1FTest'; // Null and control chars
    const result = normalizeTextForDetection(input);
    expect(result.normalized).not.toContain('\x00');
    expect(result.normalized).not.toContain('\x1F');
    expect(result.characteristics.hasControlChars).toBe(true);
  });
});

/**
 * ========================================
 * SCRIPT TYPE DETECTION
 * ========================================
 */
describe('Script Detection', () => {
  test('detects Latin script', () => {
    const result = normalizeTextForDetection('Hello world');
    expect(result.characteristics.scriptTypes.has('latin')).toBe(true);
  });

  test('detects Arabic script', () => {
    const result = normalizeTextForDetection('السلام عليكم ورحمة الله');
    expect(result.characteristics.scriptTypes.has('arabic')).toBe(true);
  });

  test('detects Cyrillic script', () => {
    const result = normalizeTextForDetection('Привет мир');
    expect(result.characteristics.scriptTypes.has('cyrillic')).toBe(true);
  });

  test('detects multiple scripts', () => {
    const result = normalizeTextForDetection('Hello السلام Привет');
    expect(result.characteristics.scriptTypes.size).toBeGreaterThan(1);
  });

  test('detects CJK script', () => {
    const result = normalizeTextForDetection('你好世界');
    expect(result.characteristics.scriptTypes.has('cjk')).toBe(true);
  });
});

/**
 * ========================================
 * LANGUAGE DETECTION
 * ========================================
 */
describe('Language Detection', () => {
  test('detects English', () => {
    const result = normalizeTextForDetection('This is English text');
    expect(result.characteristics.detectedLanguage).toBe('english');
  });

  test('detects Arabic', () => {
    const result = normalizeTextForDetection('هذا نص عربي جميل');
    expect(result.characteristics.detectedLanguage).toBe('arabic');
  });

  test('detects Swahili', () => {
    const result = normalizeTextForDetection('Habari yako, ninalafika mzuri');
    expect(result.characteristics.detectedLanguage).toBe('swahili');
  });

  test('detects mixed language', () => {
    const result = normalizeTextForDetection('Hello السلام world');
    expect(result.characteristics.detectedLanguage).toBe('mixed');
  });

  test('handles unknown language', () => {
    const result = normalizeTextForDetection('🎉🎊🎈');
    expect(result.characteristics.detectedLanguage).toBe('unknown');
  });
});

/**
 * ========================================
 * DIACRITICS DETECTION
 * ========================================
 */
describe('Excessive Diacritics Detection', () => {
  test('allows normal diacritics', () => {
    const result = normalizeTextForDetection('café naïve résumé');
    expect(result.characteristics.hasExcessiveDiacritics).toBe(false);
  });

  test('detects excessive combining marks', () => {
    // Homograph attack: create a character with many diacritics
    const input = 'a\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308' +
      'a\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308';
    const result = normalizeTextForDetection(input);
    expect(result.characteristics.hasExcessiveDiacritics).toBe(true);
  });
});

/**
 * ========================================
 * OBFUSCATION RISK ESTIMATION
 * ========================================
 */
describe('Obfuscation Risk Estimation', () => {
  test('zero-width chars increase risk', () => {
    const input = 'Hello\u200BWorld'; // Zero-width space
    const result = normalizeTextForDetection(input);
    const risk = estimateObfuscationRisk(result.characteristics);
    expect(risk).toBeGreaterThan(20);
  });

  test('RTL override increases risk', () => {
    const input = 'Hello\u202Eworld'; // RTL override
    const result = normalizeTextForDetection(input);
    const risk = estimateObfuscationRisk(result.characteristics);
    expect(risk).toBeGreaterThan(25);
  });

  test('control chars increase risk', () => {
    const input = 'Hello\x00world'; // Null byte
    const result = normalizeTextForDetection(input);
    const risk = estimateObfuscationRisk(result.characteristics);
    expect(risk).toBeGreaterThan(15);
  });

  test('multiple anomalies compound risk', () => {
    const input = 'Hello\u200B\u202Eworld\x00'; // Zero-width + RTL + null
    const result = normalizeTextForDetection(input);
    const risk = estimateObfuscationRisk(result.characteristics);
    expect(risk).toBeGreaterThan(50);
  });

  test('mixed scripts in short text increase risk', () => {
    const input = 'Hi السلام привет'; // 3 scripts in 15 chars
    const result = normalizeTextForDetection(input);
    const risk = estimateObfuscationRisk(result.characteristics);
    expect(risk).toBeGreaterThan(15);
  });

  test('normal text has low obfuscation risk', () => {
    const input = 'This is normal English text with no obfuscation attempt';
    const result = normalizeTextForDetection(input);
    const risk = estimateObfuscationRisk(result.characteristics);
    expect(risk).toBeLessThan(10);
  });
});

/**
 * ========================================
 * NORMALIZATION DELTA DETECTION
 * ========================================
 */
describe('Normalization Delta Analysis', () => {
  test('detects significant character reduction', () => {
    // Many zero-width and control chars that will be removed
    const input = 'hello\u200B\u200C\u200D\u2060\uFEFF\x00\x1F world';
    const result = normalizeTextForDetection(input);
    const delta = checkNormalizationDelta(result);

    expect(delta.significantDelta).toBe(true);
    expect(delta.percentageChange).toBeGreaterThan(20);
  });

  test('ignores small character changes', () => {
    const input = 'Hello world'; // Already clean
    const result = normalizeTextForDetection(input);
    const delta = checkNormalizationDelta(result);

    expect(delta.significantDelta).toBe(false);
    expect(delta.percentageChange).toBeLessThan(10);
  });

  test('provides interpretation of delta', () => {
    const input = 'a'.repeat(10) + '\u200B'.repeat(50); // 10 chars + 50 zero-width
    const result = normalizeTextForDetection(input);
    const delta = checkNormalizationDelta(result);

    expect(delta.interpretation).toContain('obfuscation');
  });
});

/**
 * ========================================
 * SAFE LOGGING
 * ========================================
 */
describe('Safe Logging', () => {
  test('sanitizeForLog truncates long input', () => {
    const long = 'a'.repeat(200);
    const sanitized = sanitizeForLog(long, 50);
    expect(sanitized.length).toBeLessThanOrEqual(54); // 50 + "..."
    expect(sanitized).toContain('...');
  });

  test('sanitizeForLog removes newlines', () => {
    const input = 'Line 1\nLine 2\nLine 3';
    const sanitized = sanitizeForLog(input);
    expect(sanitized).not.toContain('\n');
  });

  test('sanitizeForLog removes control characters', () => {
    const input = 'Hello\x00World\x1FTest';
    const sanitized = sanitizeForLog(input);
    expect(sanitized).not.toContain('\x00');
    expect(sanitized).not.toContain('\x1F');
  });

  test('sanitizeForLog handles empty input', () => {
    const sanitized = sanitizeForLog('');
    expect(sanitized).toBe('[empty]');
  });

  test('sanitizeForLog is safe for logs', () => {
    const input = 'secret_password=xyz123\ncredit_card=1234-5678';
    const sanitized = sanitizeForLog(input, 20);
    // Should be truncated and safe
    expect(sanitized.length).toBeLessThan(input.length);
    expect(sanitized).not.toContain('secret_password');
    expect(sanitized).not.toContain('credit_card');
  });
});

/**
 * ========================================
 * EDGE CASES
 * ========================================
 */
describe('Edge Cases', () => {
  test('handles empty input', () => {
    const result = normalizeTextForDetection('');
    expect(result.original).toBe('');
    expect(result.normalized).toBe('');
    expect(result.characteristics.originalLength).toBe(0);
  });

  test('handles null/undefined gracefully', () => {
    const result = normalizeTextForDetection(null as any);
    expect(result.original).toBe('');
    expect(result.normalized).toBe('');
  });

  test('handles very long text', () => {
    const long = 'a'.repeat(100000);
    const result = normalizeTextForDetection(long);
    expect(result.normalized.length).toBe(100000);
  });

  test('handles text with only special characters', () => {
    const input = '!@#$%^&*()_+-=[]{}|;:,.<>?';
    const result = normalizeTextForDetection(input);
    expect(result.normalized).toBe(input);
  });

  test('handles emoji and symbols', () => {
    const input = '🎉🎊😀 Hello 世界';
    const result = normalizeTextForDetection(input);
    expect(result.characteristics.scriptTypes.has('cjk')).toBe(true);
  });
});
