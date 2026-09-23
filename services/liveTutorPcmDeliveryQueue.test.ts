import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveTutorPcmDeliveryQueue } from './liveTutorPcmDeliveryQueue';

type FakeTimer = { at: number; callback: () => void };

function createQueueHarness() {
  let now = 0;
  let timerId = 0;
  const timers = new Map<number, FakeTimer>();
  const sent: Array<{ frame: number; at: number }> = [];
  const queue = new LiveTutorPcmDeliveryQueue<number>({
    send: (frame) => { sent.push({ frame, at: now }); return true; },
    now: () => now,
    schedule: (callback, delayMs) => {
      const id = ++timerId;
      timers.set(id, { at: now + delayMs, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (timer) => timers.delete(timer as unknown as number),
  });
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const entry = [...timers.entries()].filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!entry) break;
      timers.delete(entry[0]);
      now = entry[1].at;
      entry[1].callback();
    }
    now = target;
  };
  return { queue, sent, advance };
}

test('decouples Gemini bursts from the paced relay without dropping frames', async () => {
  const { queue, sent, advance } = createQueueHarness();
  for (let frame = 0; frame < 32; frame += 1) await queue.enqueue(4, frame);
  assert.equal(sent.length, 12, 'startup reserve is delivered immediately');
  assert.equal(queue.queuedFrameCount, 20, 'provider backpressure starts before an unbounded queue can form');

  const blockedEnqueue = queue.enqueue(4, 32);
  advance(20);
  await blockedEnqueue;
  assert.equal(sent[12].at, 20);
  assert.equal(queue.queuedFrameCount, 20);

  for (let frame = 0; frame < 20; frame += 1) advance(20);
  assert.deepEqual(sent.map(({ frame }) => frame), Array.from({ length: 33 }, (_, frame) => frame));
});

test('clears pending frames immediately when a generation is interrupted', async () => {
  const { queue, sent, advance } = createQueueHarness();
  for (let frame = 0; frame < 16; frame += 1) await queue.enqueue(4, frame);
  assert.equal(sent.length, 12);
  queue.clear();
  advance(500);
  assert.equal(sent.length, 12, 'old-generation frames cannot reach the socket after interruption');

  await queue.enqueue(5, 99);
  assert.deepEqual(sent.at(-1), { frame: 99, at: 500 });
});
