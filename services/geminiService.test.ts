import { test } from 'vitest';
import assert from 'node:assert/strict';
import { boundGeminiContext, buildGeminiHealthCheckResult, buildGeminiRequestPayload, classifyGeminiError, extractLatestUserPrompt, getModelCandidatesForKind, isGeminiResponseSuccessful, shouldFallbackStreamingModel, shouldTryNextGeminiModel } from './geminiService';

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

test('buildGeminiRequestPayload preserves image bytes as Gemini inlineData', () => {
  const payload = buildGeminiRequestPayload([
    {
      role: 'user',
      parts: [
        { text: 'What is shown here?' },
        { inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQ' } },
      ],
    },
  ], 'image');

  assert.deepEqual(payload.contents[0].parts[1], {
    inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQ' },
  });
  assert.match(payload.systemInstruction, /When analyzing images/);
});

test('security input uses only the latest user turn instead of accumulated history', () => {
  const prompt = extractLatestUserPrompt([
    { role: 'user', parts: [{ text: 'older question' }] },
    { role: 'model', parts: [{ text: 'a very long previous answer' }] },
    { role: 'user', parts: [{ text: 'new question' }] },
  ]);

  assert.equal(prompt, 'new question');
});

test('context budgeting preserves the newest turns and drops old context', () => {
  const bounded = boundGeminiContext([
    { role: 'user', parts: [{ text: 'old-12345' }] },
    { role: 'model', parts: [{ text: 'middle-12345' }] },
    { role: 'user', parts: [{ text: 'latest' }] },
  ], 18);

  assert.deepEqual(bounded.map((message) => message.parts[0].text), ['latest']);
});

test('streaming model fallback is allowed only before any token is emitted', () => {
  const overload = { status: 503, message: 'Model overloaded' };
  assert.equal(shouldFallbackStreamingModel(overload, false), true);
  assert.equal(shouldFallbackStreamingModel(overload, true), false);
  assert.equal(shouldFallbackStreamingModel({ status: 401, message: 'Invalid key' }, false), false);
});
