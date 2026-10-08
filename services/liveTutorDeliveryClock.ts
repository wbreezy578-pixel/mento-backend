// This is only the backend-to-phone relay cadence. The phone still feeds Simli
// exactly one 640-byte, 20ms PCM frame at a time. Sending at the same media
// clock avoids steadily filling the phone queue during a long response.
const RELAY_FRAME_DURATION_MS = 20;
const STARTUP_LEAD_FRAMES = 12;

/**
 * Give the phone a 240ms reserve before the relay settles to the media clock.
 * The mobile pacer starts once its 160ms threshold is present, so a provider
 * burst gains 80ms of jitter protection without delaying the first PCM frame.
 */
export class LiveTutorDeliveryClock {
  private generation = -1;
  private nextAt = 0;
  private initialFrames = 0;
  private sendingInitialFrame = false;
  setClientQueueDepthMs(_queueDepthMs: number): void {
    // Kept as an integration point for transport telemetry. Relay cadence must
    // remain the PCM media clock regardless of a transient client queue spike.
  }

  delay(generation: number, now: number): number {
    if (generation !== this.generation) {
      this.generation = generation;
      this.initialFrames = STARTUP_LEAD_FRAMES;
      this.nextAt = now;
    }
    if (this.initialFrames > 0) {
      this.initialFrames--;
      this.sendingInitialFrame = true;
      return 0;
    }
    this.sendingInitialFrame = false;
    return Math.max(0, this.nextAt - now);
  }

  sent(now: number): void {
    if (this.sendingInitialFrame) {
      if (this.initialFrames === 0) this.nextAt = now + this.frameDurationMs;
      this.sendingInitialFrame = false;
      return;
    }
    // A backend timer delay must not permanently slow the stream. Keep the
    // original relay deadline so the phone receives a small catch-up burst;
    // the WebView still releases exactly one 20ms frame to Simli at a time.
    this.nextAt += this.frameDurationMs;
  }

  private get frameDurationMs(): number {
    return RELAY_FRAME_DURATION_MS;
  }
}
