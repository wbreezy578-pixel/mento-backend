import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveTutorDeliveryClock } from './liveTutorDeliveryClock';

test('960ms provider burst keeps a bounded relay lead for network jitter', () => {
  const clock = new LiveTutorDeliveryClock();
  let now = 0;
  for (let frame = 0; frame < 48; frame++) {
    now += clock.delay(4, now);
    clock.sent(now);
    assert.ok((frame + 1) * 20 - now <= 300);
  }
  assert.equal(now, 720);
});

test('a delayed backend timer catches the relay back up and a new generation starts immediately', () => {
  const clock = new LiveTutorDeliveryClock();
  for (let i = 0; i < 12; i++) { clock.delay(4, 0); clock.sent(0); }
  assert.equal(clock.delay(4, 34), 0);
  clock.sent(34);
  assert.equal(clock.delay(4, 34), 6, 'the next backend packet restores the original relay deadline');
  assert.equal(clock.delay(5, 200), 0);
});

test('ordinary timer lateness does not accumulate into slow delivery', () => {
  const clock = new LiveTutorDeliveryClock();
  let now = 0;
  for (let frame = 0; frame < 50; frame++) {
    const delay = clock.delay(7, now);
    now += delay + (delay > 0 ? 5 : 0);
    clock.sent(now);
  }

  assert.ok(now <= 845, `50 frames drifted to ${now}ms`);
  assert.ok(1_000 - now <= 300, 'delivery exceeded the bounded relay lead');
});

test('uses the exact 20ms relay cadence regardless of reported client reserve', () => {
  const clock = new LiveTutorDeliveryClock();
  for (let index = 0; index < 12; index += 1) { clock.delay(8, 0); clock.sent(0); }
  clock.setClientQueueDepthMs(240);
  assert.equal(clock.delay(8, 0), 20, 'the first relay slot uses the media clock');
  clock.sent(20);
  assert.equal(clock.delay(8, 20), 20);
});
