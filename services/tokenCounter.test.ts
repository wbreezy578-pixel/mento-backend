/**
 * Tests for Token Counting Service
 *
 * Tests:
 * - Character-to-token estimation
 * - Multilingual token estimation
 * - Image token estimation
 * - Language detection
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  estimateTokenCountFromText,
  estimateTokenCountFromImage,
  estimateLanguageCharacteristics,
} from '../services/tokenCounter';
import {
  hasArabicScript,
  isPrimarilyEnglish,
  MULTILINGUAL_TOKEN_ESTIMATION,
} from '../services/contextBudgetConfig';

test('Token Counter: English text estimation', () => {
  const text = 'Hello, this is an English sentence with multiple words.';
  const result = estimateTokenCountFromText(text);

  assert.equal(result.language, 'english');
  assert.equal(result.charCount, text.length);
  // English: ~4.2 chars per token
  // 56 chars / 4.2 ≈ 13 tokens (rounded up)
  assert(result.tokens > 0 && result.tokens < 20, `Expected ~13 tokens, got ${result.tokens}`);
});

test('Token Counter: Arabic text estimation', () => {
  const text = 'السلام عليكم ورحمة الله وبركاته'; // Arabic: Peace be upon you
  const result = estimateTokenCountFromText(text);

  assert.equal(result.language, 'arabic');
  assert(result.tokens > 0);
  // Arabic typically needs more tokens than English for same character count
  const englishEquivalent = estimateTokenCountFromText('Hello this is peace upon you');
  // Arabic should have more tokens due to diacritics/marks
  assert(result.charsPerToken <= MULTILINGUAL_TOKEN_ESTIMATION.arabic.charsPerToken * 1.2);
});

test('Token Counter: Swahili text estimation', () => {
  const text = 'Habari yako? Nzuri sana, asante.'; // Swahili: How are you?
  const result = estimateTokenCountFromText(text);

  // Swahili is primarily latin characters, so should be treated like English
  assert.equal(result.language, 'english');
  assert(result.tokens > 0);
});

test('Token Counter: Mixed language text estimation', () => {
  const text = 'Hello مرحبا mix world';
  const result = estimateTokenCountFromText(text);

  assert.equal(result.language, 'mixed');
  assert(result.tokens > 0);
  // Mixed should use conservative middle-ground estimation
  assert.equal(result.charsPerToken, MULTILINGUAL_TOKEN_ESTIMATION.mixed.charsPerToken);
});

test('Token Counter: Arabic script detection', () => {
  const arabicText = 'مرحبا بالعالم'; // Hello world in Arabic
  const englishText = 'Hello world';
  const mixedText = 'Hello مرحبا world';

  assert.equal(hasArabicScript(arabicText), true);
  assert.equal(hasArabicScript(englishText), false);
  assert.equal(hasArabicScript(mixedText), true);
});

test('Token Counter: English script detection', () => {
  const englishText = 'The quick brown fox jumps over the lazy dog.';
  const arabicText = 'السلام عليكم ورحمة الله وبركاته';
  const mixedText = 'Hello 123 مرحبا';

  assert.equal(isPrimarilyEnglish(englishText), true);
  assert.equal(isPrimarilyEnglish(arabicText), false);
  assert.equal(isPrimarilyEnglish(mixedText), false); // Mixed should not be primarily English
});

test('Token Counter: Empty text estimation', () => {
  const result = estimateTokenCountFromText('');

  assert.equal(result.tokens, 0);
  assert.equal(result.charCount, 0);
});

test('Token Counter: Single character', () => {
  const result = estimateTokenCountFromText('a');

  assert.equal(result.tokens, 1); // Even single char rounds up to 1 token
});

test('Token Counter: Image token estimation', () => {
  // Small image: ~50KB
  const smallImage = estimateTokenCountFromImage(50 * 1024, 'image/jpeg');
  assert.equal(smallImage.tokens, 258 + Math.ceil((50 * 1024 / 10) / 1_000_000 * 258));

  // Larger image: ~1MB
  const largeImage = estimateTokenCountFromImage(1 * 1024 * 1024, 'image/jpeg');
  assert.equal(largeImage.tokens, 258 + Math.ceil((1 * 1024 * 1024 / 10) / 1_000_000 * 258));

  // Larger image should have more tokens
  assert(largeImage.tokens > smallImage.tokens);
});

test('Token Counter: Language characteristics detection', () => {
  const english = estimateLanguageCharacteristics('Hello world');
  assert.equal(english.isPrimarilyEnglish, true);
  assert.equal(english.hasArabic, false);

  const arabic = estimateLanguageCharacteristics('مرحبا بالعالم');
  assert.equal(arabic.isPrimarilyEnglish, false);
  assert.equal(arabic.hasArabic, true);

  const mixed = estimateLanguageCharacteristics('Hello مرحبا world');
  assert.equal(mixed.isPrimarilyEnglish, false);
  assert.equal(mixed.hasArabic, true);
});

test('Token Counter: Very long text', () => {
  const longText = 'word '.repeat(10000); // 50,000+ characters
  const result = estimateTokenCountFromText(longText);

  // Should estimate reasonable token count
  assert(result.tokens > 1000 && result.tokens < 15000);
});

test('Token Counter: Special characters and punctuation', () => {
  const withPunctuation = 'Hello, world! How are you? Fine: very fine.';
  const result = estimateTokenCountFromText(withPunctuation);

  // Punctuation should be counted as characters
  assert.equal(result.charCount, withPunctuation.length);
  assert(result.tokens > 0);
});
