import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGeminiRequestPayload } from './geminiService';
import { SYSTEM_PROMPT } from '../app/lib/aiSystemPrompt';

test('buildGeminiRequestPayload uses systemInstruction only and avoids prepending the prompt', async () => {
  const payload = await buildGeminiRequestPayload('  Hello there  ', 'chat');

  assert.equal(payload.systemInstruction, SYSTEM_PROMPT);
  assert.equal(payload.contents.length, 1);
  assert.equal(payload.contents[0].role, 'user');
  assert.equal(payload.contents[0].parts[0].text, 'Hello there');
  assert.equal(payload.contents[0].parts[0].text?.includes(SYSTEM_PROMPT), false);
  assert.equal(payload.maxOutputTokens, 1024);
});

test('buildGeminiRequestPayload removes empty parts and preserves non-system messages', async () => {
  const payload = await buildGeminiRequestPayload([
    { role: 'system', parts: [{ text: '   ' }] },
    { role: 'user', parts: [{ text: '  First message  ' }, { text: '   ' }] },
    { role: 'model', parts: [{ text: 'Got it' }] },
  ] as Array<{ role: string; parts: Array<{ text?: string }> }>, 'live-tutor');

  assert.equal(payload.contents.length, 2);
  assert.equal(payload.contents[0].role, 'user');
  assert.equal(payload.contents[0].parts[0].text, 'First message');
  assert.equal(payload.contents[1].role, 'model');
  assert.equal(payload.maxOutputTokens, 512); // Live tutor max output tokens
});

test('buildGeminiRequestPayload uses the image analysis token budget', async () => {
  const payload = await buildGeminiRequestPayload('Analyze this image', 'image');

  assert.equal(payload.maxOutputTokens, 4096);
  assert.equal(payload.systemInstruction.includes('structured explanation'), true);
});
