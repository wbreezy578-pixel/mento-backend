import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveTutorVoiceTurnGate } from './liveTutorVoiceTurnGate.js';

test('an image reply waits until both sides of the voice turn are idle', async () => {
  const gate = new LiveTutorVoiceTurnGate();
  const waiting = gate.waitForIdle(1_000);

  gate.update(false);
  gate.update(true);

  assert.equal(await waiting, true);
});

test('an idle voice session lets the queued image reply proceed immediately', async () => {
  const gate = new LiveTutorVoiceTurnGate();
  gate.update(true);

  assert.equal(await gate.waitForIdle(1_000), true);
});

test('a queued image reply expires rather than overlapping a long voice turn', async () => {
  const gate = new LiveTutorVoiceTurnGate();

  assert.equal(await gate.waitForIdle(0), false);
});