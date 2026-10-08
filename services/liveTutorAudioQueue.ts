export const MAX_LIVE_TUTOR_AUDIO_QUEUE_BYTES = 16_000 * 2 * 2;

export type QueuedPcmChunk = { generation: number; data: Uint8Array; mimeType: string };

export class BoundedPcmQueue {
  private readonly chunks: QueuedPcmChunk[] = [];
  private bytes = 0;

  enqueue(data: Uint8Array, mimeType: string, generation: number): void {
    if (data.byteLength === 0 || data.byteLength > MAX_LIVE_TUTOR_AUDIO_QUEUE_BYTES) return;
    while (this.bytes + data.byteLength > MAX_LIVE_TUTOR_AUDIO_QUEUE_BYTES) {
      const stale = this.chunks.shift();
      if (!stale) break;
      this.bytes -= stale.data.byteLength;
    }
    this.chunks.push({ generation, data, mimeType });
    this.bytes += data.byteLength;
  }

  clear(): void {
    this.chunks.length = 0;
    this.bytes = 0;
  }

  take(generation: number): QueuedPcmChunk | undefined {
    const item = this.chunks.shift();
    if (!item) return undefined;
    this.bytes -= item.data.byteLength;
    return item.generation === generation ? item : undefined;
  }

  metrics() {
    return { queueDepth: this.chunks.length, bytesBuffered: this.bytes, chunksBuffered: this.chunks.length };
  }
}
