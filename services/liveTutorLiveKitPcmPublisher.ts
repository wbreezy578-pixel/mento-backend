import logger from '../lib/logger';

export const LIVE_TUTOR_LIVEKIT_SAMPLE_RATE = 16_000;
export const LIVE_TUTOR_LIVEKIT_CHANNELS = 1;
export const LIVE_TUTOR_LIVEKIT_FRAME_MS = 20;
export const LIVE_TUTOR_LIVEKIT_FRAME_BYTES = 640;
export const LIVE_TUTOR_LIVEKIT_TARGET_PREBUFFER_MS = 60;
export const LIVE_TUTOR_LIVEKIT_MAX_QUEUE_MS = 400;

export type LiveTutorLiveKitPublisherMetrics = {
  activeGenerationId: number;
  queueDepthMs: number;
  maxQueueDepthMs: number;
  framesPublished: number;
  underrunCount: number;
  overflowCount: number;
  staleGenerationDrops: number;
  maxSchedulerLatenessMs: number;
};

export interface LiveTutorLiveKitAudioSink {
  capturePcm16Frame(frame: Int16Array): Promise<void>;
  finishSegment?(): void;
  clearQueue(): void;
  waitForPlayout(): Promise<void>;
  close(): Promise<void>;
}

type Timer = ReturnType<typeof setTimeout>;
type PublisherOptions = {
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => Timer;
  cancel?: (timer: Timer) => void;
  onMetrics?: (metrics: LiveTutorLiveKitPublisherMetrics) => void;
};

type DrainWaiter = { generationId: number; resolve: () => void };
type CapacityWaiter = () => void;

function pcm16LittleEndian(bytes: Uint8Array): Int16Array {
  const samples = new Int16Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true);
  return samples;
}

/**
 * Publishes already-resampled Gemini PCM into a LiveKit audio source. One
 * scheduler owns the media clock; it never catches up by bursting overdue
 * frames and it never manufactures silence.
 */
export class LiveTutorLiveKitPcmPublisher {
  private readonly frames: Uint8Array[] = [];
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => Timer;
  private readonly cancel: (timer: Timer) => void;
  private readonly onMetrics?: (metrics: LiveTutorLiveKitPublisherMetrics) => void;
  private readonly capacityWaiters: CapacityWaiter[] = [];
  private readonly drainWaiters: DrainWaiter[] = [];
  private timer: Timer | null = null;
  private publishing = false;
  private started = false;
  private completed = false;
  private closed = false;
  private nextDueAt: number | null = null;
  private generationId = -1;
  private maxQueueDepthMs = 0;
  private framesPublished = 0;
  private underrunCount = 0;
  private overflowCount = 0;
  private staleGenerationDrops = 0;
  private maxSchedulerLatenessMs = 0;

  constructor(private readonly sink: LiveTutorLiveKitAudioSink, options: PublisherOptions = {}) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? clearTimeout;
    this.onMetrics = options.onMetrics;
  }

  startGeneration(generationId: number): void {
    if (!Number.isInteger(generationId) || generationId < 0) throw new Error('A non-negative generation ID is required.');
    if (generationId === this.generationId) return;
    this.clearActiveGeneration();
    this.generationId = generationId;
    this.emitMetrics();
  }

  async enqueue(generationId: number, frame: Uint8Array): Promise<boolean> {
    if (this.closed) return false;
    if (generationId !== this.generationId) {
      this.staleGenerationDrops += 1;
      this.emitMetrics();
      return false;
    }
    if (frame.byteLength !== LIVE_TUTOR_LIVEKIT_FRAME_BYTES) {
      throw new Error(`LiveKit PCM frames must be exactly ${LIVE_TUTOR_LIVEKIT_FRAME_BYTES} bytes.`);
    }
    if (this.started && this.frames.length === 0 && this.nextDueAt !== null
        && this.now() - this.nextDueAt >= LIVE_TUTOR_LIVEKIT_TARGET_PREBUFFER_MS - LIVE_TUTOR_LIVEKIT_FRAME_MS) {
      this.underrunCount += 1;
      this.started = false;
      this.nextDueAt = null;
    }
    const maximumFrames = LIVE_TUTOR_LIVEKIT_MAX_QUEUE_MS / LIVE_TUTOR_LIVEKIT_FRAME_MS;
    while (!this.closed && generationId === this.generationId && this.frames.length >= maximumFrames) {
      this.overflowCount += 1;
      this.emitMetrics();
      await new Promise<void>((resolve) => this.capacityWaiters.push(resolve));
    }
    if (this.closed || generationId !== this.generationId) {
      this.staleGenerationDrops += 1;
      this.emitMetrics();
      return false;
    }
    this.frames.push(frame.slice());
    this.maxQueueDepthMs = Math.max(this.maxQueueDepthMs, this.queueDepthMs);
    this.emitMetrics();
    this.pump();
    return true;
  }

  async completeGeneration(generationId: number): Promise<boolean> {
    if (generationId !== this.generationId || this.closed) return false;
    this.completed = true;
    this.pump();
    if (this.frames.length > 0 || this.publishing || this.timer !== null) {
      await new Promise<void>((resolve) => this.drainWaiters.push({ generationId, resolve }));
    }
    if (generationId !== this.generationId || this.closed) return false;
    this.sink.finishSegment?.();
    await this.sink.waitForPlayout();
    return generationId === this.generationId && !this.closed;
  }

  interruptGeneration(generationId: number): boolean {
    if (generationId !== this.generationId || this.closed) return false;
    this.clearActiveGeneration();
    this.generationId = -1;
    this.emitMetrics();
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearActiveGeneration();
    await this.sink.close();
  }

  metrics(): LiveTutorLiveKitPublisherMetrics {
    return {
      activeGenerationId: this.generationId,
      queueDepthMs: this.queueDepthMs,
      maxQueueDepthMs: this.maxQueueDepthMs,
      framesPublished: this.framesPublished,
      underrunCount: this.underrunCount,
      overflowCount: this.overflowCount,
      staleGenerationDrops: this.staleGenerationDrops,
      maxSchedulerLatenessMs: this.maxSchedulerLatenessMs,
    };
  }

  private get queueDepthMs(): number {
    return this.frames.length * LIVE_TUTOR_LIVEKIT_FRAME_MS;
  }

  private pump(): void {
    if (this.closed || this.timer !== null || this.publishing || this.generationId < 0) return;
    const prebufferFrames = LIVE_TUTOR_LIVEKIT_TARGET_PREBUFFER_MS / LIVE_TUTOR_LIVEKIT_FRAME_MS;
    if (!this.started && !this.completed && this.frames.length < prebufferFrames) return;
    if (!this.started && this.frames.length > 0) {
      this.publishing = true;
      void this.primeNativePrebuffer(this.completed ? this.frames.length : prebufferFrames);
      return;
    }
    if (this.frames.length === 0) {
      this.emitMetrics();
      this.resolveDrainWaiters();
      return;
    }
    const now = this.now();
    const delayMs = Math.max(0, (this.nextDueAt ?? now) - now);
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.publishOne();
    }, delayMs);
  }

  private async primeNativePrebuffer(frameCount: number): Promise<void> {
    const primedGeneration = this.generationId;
    try {
      for (let index = 0; index < frameCount && primedGeneration === this.generationId; index += 1) {
        const frame = this.frames.shift();
        if (!frame) break;
        await this.sink.capturePcm16Frame(pcm16LittleEndian(frame));
        if (primedGeneration === this.generationId) this.framesPublished += 1;
        this.releaseCapacityWaiters();
      }
      if (primedGeneration === this.generationId) {
        this.started = true;
        this.nextDueAt = this.now() + LIVE_TUTOR_LIVEKIT_FRAME_MS;
      }
    } catch (error) {
      logger.error('[LiveTutorLiveKitPoc] PCM prebuffer publication failed', {
        generationId: primedGeneration,
        error: error instanceof Error ? error.message : String(error),
        category: 'live_tutor_livekit_poc',
      });
      this.clearActiveGeneration();
      this.generationId = -1;
    } finally {
      this.publishing = false;
      this.emitMetrics();
      this.pump();
      this.resolveDrainWaiters();
    }
  }

  private async publishOne(): Promise<void> {
    if (this.closed || this.generationId < 0 || this.publishing) return;
    const frame = this.frames.shift();
    if (!frame) return this.pump();
    const publishedGeneration = this.generationId;
    const now = this.now();
    const lateness = this.nextDueAt === null ? 0 : Math.max(0, now - this.nextDueAt);
    this.maxSchedulerLatenessMs = Math.max(this.maxSchedulerLatenessMs, lateness);
    this.nextDueAt = lateness > LIVE_TUTOR_LIVEKIT_FRAME_MS
      ? now + LIVE_TUTOR_LIVEKIT_FRAME_MS
      : (this.nextDueAt ?? now) + LIVE_TUTOR_LIVEKIT_FRAME_MS;
    this.publishing = true;
    try {
      await this.sink.capturePcm16Frame(pcm16LittleEndian(frame));
      if (publishedGeneration === this.generationId) {
        this.started = true;
        this.framesPublished += 1;
      }
    } catch (error) {
      logger.error('[LiveTutorLiveKitPoc] PCM publication failed', {
        generationId: publishedGeneration,
        error: error instanceof Error ? error.message : String(error),
        category: 'live_tutor_livekit_poc',
      });
      this.clearActiveGeneration();
      this.generationId = -1;
    } finally {
      this.publishing = false;
      this.releaseCapacityWaiters();
      this.emitMetrics();
      this.pump();
      this.resolveDrainWaiters();
    }
  }

  private clearActiveGeneration(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.frames.length = 0;
    this.started = false;
    this.completed = false;
    this.nextDueAt = null;
    this.sink.clearQueue();
    this.releaseCapacityWaiters();
    this.resolveDrainWaiters();
  }

  private releaseCapacityWaiters(): void {
    while (this.capacityWaiters.length > 0) this.capacityWaiters.shift()?.();
  }

  private resolveDrainWaiters(): void {
    if (this.frames.length !== 0 || this.publishing || this.timer !== null) return;
    while (this.drainWaiters.length > 0) this.drainWaiters.shift()?.resolve();
  }

  private emitMetrics(): void {
    this.onMetrics?.(this.metrics());
  }
}
