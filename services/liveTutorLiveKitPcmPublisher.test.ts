import { describe, expect, it } from 'vitest';
import {
  LIVE_TUTOR_LIVEKIT_FRAME_BYTES,
  LIVE_TUTOR_LIVEKIT_FRAME_MS,
  LIVE_TUTOR_LIVEKIT_MAX_QUEUE_MS,
  LIVE_TUTOR_LIVEKIT_TARGET_PREBUFFER_MS,
  LiveTutorLiveKitPcmPublisher,
  type LiveTutorLiveKitAudioSink,
} from './liveTutorLiveKitPcmPublisher';

function fixture(blockCapture = false) {
  let now = 1_000;
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const captured: Int16Array[] = [];
  let clears = 0;
  let closes = 0;
  let playoutWaits = 0;
  let finishes = 0;
  const captureGate = blockCapture ? new Promise<void>(() => undefined) : null;
  const sink: LiveTutorLiveKitAudioSink = {
    capturePcm16Frame: async (frame) => { captured.push(frame.slice()); if (captureGate) await captureGate; },
    finishSegment: () => { finishes += 1; },
    clearQueue: () => { clears += 1; },
    waitForPlayout: async () => { playoutWaits += 1; },
    close: async () => { closes += 1; },
  };
  const publisher = new LiveTutorLiveKitPcmPublisher(sink, {
    now: () => now,
    schedule: (callback, delayMs) => {
      const timer = setTimeout(() => undefined, 60_000);
      clearTimeout(timer);
      scheduled.push({ callback, delayMs });
      return timer;
    },
    cancel: () => undefined,
  });
  const runNext = async (extraLatenessMs = 0) => {
    const next = scheduled.shift();
    if (!next) throw new Error('No scheduled frame');
    now += next.delayMs + extraLatenessMs;
    next.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { publisher, scheduled, captured, runNext, counts: () => ({ clears, closes, playoutWaits, finishes }) };
}

function frame(firstSample: number) {
  const bytes = new Uint8Array(LIVE_TUTOR_LIVEKIT_FRAME_BYTES);
  new DataView(bytes.buffer).setInt16(0, firstSample, true);
  return bytes;
}

describe('LiveTutorLiveKitPcmPublisher', () => {
  it('publishes exact PCM16 mono 16kHz frames in order after a 60ms prebuffer', async () => {
    const test = fixture();
    test.publisher.startGeneration(7);
    await test.publisher.enqueue(7, frame(-12_345));
    await test.publisher.enqueue(7, frame(2));
    expect(test.scheduled).toHaveLength(0);
    await test.publisher.enqueue(7, frame(3));
    expect(LIVE_TUTOR_LIVEKIT_TARGET_PREBUFFER_MS).toBe(60);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(test.captured.map((item) => item[0])).toEqual([-12_345, 2, 3]);
    expect(test.scheduled).toHaveLength(0);

    const completion = test.publisher.completeGeneration(7);
    await expect(completion).resolves.toBe(true);

    expect(test.captured.map((item) => item[0])).toEqual([-12_345, 2, 3]);
    expect(test.captured.every((item) => item.length === 320)).toBe(true);
    expect(test.counts().playoutWaits).toBe(1);
    expect(test.counts().finishes).toBe(1);
    expect(test.publisher.metrics()).toMatchObject({ framesPublished: 3, underrunCount: 0, staleGenerationDrops: 0 });
  });

  it('paces one frame per 20ms and never bursts after scheduler lateness', async () => {
    const test = fixture();
    test.publisher.startGeneration(1);
    for (let index = 0; index < 6; index += 1) await test.publisher.enqueue(1, frame(index));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(test.scheduled[0]?.delayMs).toBe(LIVE_TUTOR_LIVEKIT_FRAME_MS);
    await test.runNext();
    expect(test.scheduled[0]?.delayMs).toBe(LIVE_TUTOR_LIVEKIT_FRAME_MS);
    await test.runNext(75);
    expect(test.scheduled[0]?.delayMs).toBe(LIVE_TUTOR_LIVEKIT_FRAME_MS);
    expect(test.publisher.metrics().maxSchedulerLatenessMs).toBe(75);
  });

  it('clears only the interrupted generation and rejects its late frames', async () => {
    const test = fixture();
    test.publisher.startGeneration(2);
    await test.publisher.enqueue(2, frame(2));
    expect(test.publisher.interruptGeneration(1)).toBe(false);
    expect(test.publisher.interruptGeneration(2)).toBe(true);
    expect(await test.publisher.enqueue(2, frame(22))).toBe(false);

    test.publisher.startGeneration(3);
    await test.publisher.enqueue(3, frame(31));
    await test.publisher.enqueue(3, frame(32));
    await test.publisher.enqueue(3, frame(33));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(test.captured[0]?.[0]).toBe(31);
    expect(test.publisher.metrics().staleGenerationDrops).toBe(1);
  });

  it('bounds the queue and releases blocked ingestion when the generation is cancelled', async () => {
    const test = fixture(true);
    test.publisher.startGeneration(4);
    const maximumFrames = LIVE_TUTOR_LIVEKIT_MAX_QUEUE_MS / LIVE_TUTOR_LIVEKIT_FRAME_MS;
    for (let index = 0; index < maximumFrames + 1; index += 1) await test.publisher.enqueue(4, frame(index));
    const blocked = test.publisher.enqueue(4, frame(99));
    expect(test.publisher.metrics()).toMatchObject({ queueDepthMs: 400, maxQueueDepthMs: 400, overflowCount: 1 });
    test.publisher.interruptGeneration(4);
    await expect(blocked).resolves.toBe(false);
    expect(test.publisher.metrics().queueDepthMs).toBe(0);
  });

  it('rejects partial frames instead of inserting silence', async () => {
    const test = fixture();
    test.publisher.startGeneration(5);
    await expect(test.publisher.enqueue(5, new Uint8Array(638))).rejects.toThrow('exactly 640 bytes');
    expect(test.captured).toHaveLength(0);
  });
});
