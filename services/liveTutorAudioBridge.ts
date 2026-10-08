import logger from '../lib/logger';

/** Streaming linear interpolation with a persistent fractional sample position.
 * Retains at most one interpolation neighbour; never buffers a whole response.
 */
export class PCMResampler {
  private samples: number[] = [];
  private position = 0;
  private samplesProcessed = 0;
  private chunksProcessed = 0;
  constructor(private readonly inputSampleRate = 24000, private readonly outputSampleRate = 16000) {
    if (![inputSampleRate, outputSampleRate].every(rate => Number.isFinite(rate) && rate > 0)) {
      throw new Error('Invalid PCM sample rate.');
    }
  }
  resampleChunk(bytes: Uint8Array, _chunkIndex = 0): Uint8Array {
    if (bytes.byteLength % 2) throw new Error('Invalid PCM16 audio chunk.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < bytes.byteLength; i += 2) this.samples.push(view.getInt16(i, true));
    this.samplesProcessed += bytes.byteLength / 2;
    this.chunksProcessed++;
    return this.produce(false);
  }
  private produce(final: boolean): Uint8Array {
    const output: number[] = [];
    const step = this.inputSampleRate / this.outputSampleRate;
    while (this.position < this.samples.length) {
      const lower = Math.floor(this.position);
      const fraction = this.position - lower;
      if (!final && fraction > 0 && lower + 1 >= this.samples.length) break;
      const a = this.samples[lower];
      const b = this.samples[Math.min(lower + 1, this.samples.length - 1)];
      output.push(Math.round(a + (b - a) * fraction));
      this.position += step;
    }
    const consumed = Math.min(Math.floor(this.position), this.samples.length);
    this.samples = this.samples.slice(consumed);
    this.position -= consumed;
    const bytes = new Uint8Array(output.length * 2);
    const view = new DataView(bytes.buffer);
    output.forEach((sample, index) => view.setInt16(index * 2, sample, true));
    return bytes;
  }
  flush(): Uint8Array {
    const bytes = this.produce(true);
    this.samples = [];
    this.position = 0;
    return bytes;
  }
  reset(): void {
    this.samples = [];
    this.position = 0;
    this.samplesProcessed = 0;
    this.chunksProcessed = 0;
  }
  getStats() {
    return { inputSampleRate: this.inputSampleRate, outputSampleRate: this.outputSampleRate,
      resampleRatio: (this.outputSampleRate / this.inputSampleRate).toFixed(4),
      samplesProcessed: this.samplesProcessed, chunksProcessed: this.chunksProcessed,
      bufferedSamples: this.samples.length };
  }
}

/**
 * Audio bridge manager that coordinates:
 * - Receiving 24kHz audio from Gemini Live
 * - Resampling to 16kHz for Simli compatibility
 * - Streaming chunks to Simli avatar immediately (no complete-response buffering)
 */
export class LiveTutorAudioBridge {
  private resampler: PCMResampler;
  private resampledChunkCount: number = 0;
  private onAudioChunkReady?: (chunk: Uint8Array, timestampMs: number) => Promise<void>;

  constructor(
    onAudioChunkReady?: (chunk: Uint8Array, timestampMs: number) => Promise<void>
  ) {
    this.resampler = new PCMResampler(24000, 16000);
    this.onAudioChunkReady = onAudioChunkReady;
  }

  /**
   * Process a 24kHz audio chunk from Gemini Live.
   * Resamples immediately and forwards to Simli without buffering.
   */
  async processAudioChunk(
    chunk: Uint8Array,
    chunkIndex: number,
    geminiChunkTimestampMs: number,
    trace?: { sessionId?: string; streamId?: string; generationId?: number; turnNumber?: number; mimeType?: string; }
  ): Promise<void> {
    const processStartMs = Date.now();

    logger.info('[AudioBridge] Processing audio chunk from Gemini', {
      sessionId: trace?.sessionId ?? null,
      streamId: trace?.streamId ?? null,
      generationId: trace?.generationId ?? null,
      turnNumber: trace?.turnNumber ?? null,
      mimeType: trace?.mimeType ?? null,
      chunkIndex,
      inputByteLength: chunk.length,
      geminiTimestamp: geminiChunkTimestampMs,
      ts: processStartMs,
      category: 'audio_bridge_process_start',
    });

    try {
      // Resample 24kHz → 16kHz
      const resampledChunk = this.resampler.resampleChunk(chunk, chunkIndex);

      if (resampledChunk.length === 0) {
        logger.info('[AudioBridge] Resampled chunk is empty (buffered in resampler)', {
          chunkIndex,
          ts: Date.now(),
          category: 'audio_bridge_buffered',
        });
        return;
      }

      this.resampledChunkCount++;

      const resampledTimestampMs = Date.now();

      logger.info('[AudioBridge] Resampled chunk ready', {
        sessionId: trace?.sessionId ?? null,
        streamId: trace?.streamId ?? null,
        generationId: trace?.generationId ?? null,
        turnNumber: trace?.turnNumber ?? null,
        mimeType: trace?.mimeType ?? null,
        chunkIndex,
        outputByteLength: resampledChunk.length,
        ts: resampledTimestampMs,
        resampleLatencyMs: resampledTimestampMs - processStartMs,
        category: 'resampled_first_chunk',
      });

      // Forward to Simli immediately (do NOT wait for complete response)
      if (this.onAudioChunkReady) {
        await this.onAudioChunkReady(resampledChunk, resampledTimestampMs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[AudioBridge] Audio chunk processing failed', {
        chunkIndex,
        error: message,
        ts: Date.now(),
        category: 'audio_bridge_process_error',
      });
      throw error;
    }
  }

  /**
   * Flush any remaining buffered samples at stream end.
   */
  async flush(): Promise<void> {
    const flushStartMs = Date.now();

    logger.info('[AudioBridge] Flushing resampler', {
      ts: flushStartMs,
      category: 'audio_bridge_final_flush_start',
    });

    try {
      const flushedChunk = this.resampler.flush();

      if (flushedChunk.length > 0 && this.onAudioChunkReady) {
        const flushedTimestampMs = Date.now();
        logger.info('[AudioBridge] Flushed chunk forwarding to Simli', {
          outputByteLength: flushedChunk.length,
          ts: flushedTimestampMs,
          category: 'audio_bridge_final_chunk_sent',
        });

        await this.onAudioChunkReady(flushedChunk, flushedTimestampMs);
      }

      const flushEndMs = Date.now();

      logger.info('[AudioBridge] Flush complete', {
        ts: flushEndMs,
        flushLatencyMs: flushEndMs - flushStartMs,
        totalResampledChunks: this.resampledChunkCount,
        category: 'audio_bridge_final_flush_complete',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[AudioBridge] Flush failed', {
        error: message,
        ts: Date.now(),
        category: 'audio_bridge_flush_error',
      });
      throw error;
    }
  }

  /**
   * Reset the bridge for a new stream.
   */
  reset(): void {
    this.resampler.reset();
    this.resampledChunkCount = 0;
    logger.info('[AudioBridge] Bridge reset', {
      category: 'audio_bridge_full_reset',
    });
  }

  /**
   * Get resampler statistics.
   */
  getStats() {
    return {
      ...this.resampler.getStats(),
      resampledChunkCount: this.resampledChunkCount,
    };
  }
}
