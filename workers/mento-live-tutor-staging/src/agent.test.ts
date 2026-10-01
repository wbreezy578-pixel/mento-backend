import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./agent.ts', import.meta.url), 'utf8');

test('image analysis acknowledges promptly using the active avatar session', () => {
  assert.match(source, /Let me take a closer look\./i);
  assert.doesNotMatch(source, /Let me check that image\./i);
  assert.match(source, /session\.generateReply\(/);
});
