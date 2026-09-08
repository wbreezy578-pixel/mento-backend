import { LiveTutorDeliveryClock } from './liveTutorDeliveryClock';

export const LIVE_TUTOR_BACKEND_MAX_QUEUED_PCM_FRAMES = 20;

type CapacityWaiter = () => void;
type DrainWaiter = { generationId: number; resolve: () => void };

type DeliveryQueueOptions<T> = {
  send: (item: T) => boolean;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
  maxFrames?: number;
};

/**
 * Keeps Gemini ingestion separate from real-time WebSocket delivery. Gemini
 * callbacks can enqueue immediately; one timer owns the paced outbound stream.
 */
export class LiveTutorPcmDeliveryQueue<T> {
  private readonly clock = new LiveTutorDeliveryClock();
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly maxFrames: number;
  private readonly frames: T[] = [];
  private readonly capacityWaiters: CapacityWaiter[] = [];
  private readonly drainWaiters: DrainWaiter[] = [];
  private generationId = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: DeliveryQueueOptions<T>) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? clearTimeout;
    this.maxFrames = options.maxFrames ?? LIVE_TUTOR_BACKEND_MAX_QUEUED_PCM_FRAMES;
  }

  startGeneration(generationId: number): void {
    if (generationId === this.generationId) return;
    this.clear();
    this.generationId = generationId;
  }

  async enqueue(generationId: number, item: T): Promise<boolean> {
    this.startGeneration(generationId);
    while (generationId === this.generationId && this.frames.length >= this.maxFrames) {
      await new Promise<void>((resolve) => this.capacityWaiters.push(resolve));
    }
    if (generationId !== this.generationId) return false;
    this.frames.push(item);
    this.pump();
    return true;
  }

  async waitForDrain(generationId: number): Promise<void> {
    if (generationId !== this.generationId || (this.frames.length === 0 && this.timer === null)) return;
    await new Promise<void>((resolve) => this.drainWaiters.push({ generationId, resolve }));
  }

  setClientQueueDepthMs(generationId: number, queueDepthMs: number): void {
    if (generationId !== this.generationId || !Number.isFinite(queueDepthMs)) return;
    this.clock.setClientQueueDepthMs(queueDepthMs);
  }

  clear(): void {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.frames.length = 0;
    this.generationId = -1;
    this.releaseCapacityWaiters();
    this.resolveDrained();
  }

  get queuedFrameCount(): number {
    return this.frames.length;
  }

  private pump(): void {
    if (this.timer !== null || this.frames.length === 0 || this.generationId < 0) {
      this.resolveDrained();
      return;
    }
    const delayMs = this.clock.delay(this.generationId, this.now());
    if (delayMs > 0) {
      this.timer = this.schedule(() => {
        this.timer = null;
        this.deliverOne();
      }, delayMs);
      return;
    }
    this.deliverOne();
  }

  private deliverOne(): void {
    const item = this.frames.shift();
    if (item === undefined) {
      this.resolveDrained();
      return;
    }
    if (!this.options.send(item)) {
      this.clear();
      return;
    }
    this.clock.sent(this.now());
    this.releaseCapacityWaiters();
    this.pump();
  }

  private releaseCapacityWaiters(): void {
    while (this.frames.length < this.maxFrames && this.capacityWaiters.length > 0) {
      this.capacityWaiters.shift()?.();
    }
  }

  private resolveDrained(): void {
    if (this.frames.length !== 0 || this.timer !== null) return;
    for (let index = this.drainWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.drainWaiters[index];
      if (waiter.generationId === this.generationId || this.generationId === -1) {
        this.drainWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }
}
