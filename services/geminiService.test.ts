import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGeminiHealthCheckResult, classifyGeminiError, getModelCandidatesForKind, isGeminiResponseSuccessful, shouldTryNextGeminiModel } from './geminiService';

test('getModelCandidatesForKind uses a supported fallback chain', () => {
  const candidates = getModelCandidatesForKind('chat', 'gemini-3.5-flash');

  assert.deepEqual(candidates, ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite']);
});

test('buildGeminiHealthCheckResult preserves a provider error message', () => {
  const result = buildGeminiHealthCheckResult(1000, false, 'You exceeded your current quota.');

  assert.equal(result.success, false);
  assert.equal(result.modelAvailable, false);
  assert.equal(result.message, 'You exceeded your current quota.');
});

test('classifyGeminiError distinguishes invalid key and model missing cases', () => {
  const invalidKey = classifyGeminiError({ status: 401, message: 'API key not valid' });
  const modelMissing = classifyGeminiError({ status: 404, message: 'Model not found' });

  assert.equal(invalidKey.category, 'invalid_api_key');
  assert.equal(modelMissing.category, 'model_not_found');
});

test('tries another configured model for quota and provider-capacity failures only', () => {
  assert.equal(shouldTryNextGeminiModel({ status: 404, message: 'Model not found' }), true);
  assert.equal(shouldTryNextGeminiModel({ status: 429, message: 'Quota exceeded' }), true);
  assert.equal(shouldTryNextGeminiModel({ status: 503, message: 'Model overloaded' }), true);
  assert.equal(shouldTryNextGeminiModel({ status: 401, message: 'Invalid API key' }), false);
});

test('isGeminiResponseSuccessful treats a populated response object as healthy even without text', () => {
  const result = isGeminiResponseSuccessful({
    candidates: [{ content: { role: 'model' } }],
    responseId: 'abc',
  });

  assert.equal(result, true);
});
