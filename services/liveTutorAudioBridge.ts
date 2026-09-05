import logger from '../lib/logger';

/**
 * Streaming PCM audio resampler that converts 24kHz audio to 16kHz.
 * Implements linear interpolation for smooth resampling without buffering entire audio.
 * Handles streaming chunks incrementally.
 */
export class PCMResampler {
  private inputSampleRate: number = 24000;
  private outputSampleRate: number = 16000;
  private resampleRatio: number;
  private sampleBuffer: Float32Array = new Float32Array(0);
  private inputPosition: number = 0;
  private bytesPerSample: number = 2; // 16-bit PCM
  private samplesProcessed: number = 0;
  private chunksProcessed: number = 0;

  constructor(inputSampleRate: number = 24000, outputSampleRate: number = 16000) {
    this.inputSampleRate = inputSampleRate;
    this.outputSampleRate = outputSampleRate;
    this.resampleRatio = outputSampleRate / inputSampleRate;
  }

  /**
   * Resamples a 24kHz PCM chunk to 16kHz.
   * Returns available output samples; partial samples retained for next chunk.
   *
   * @param pcmBytes - 16-bit PCM data (little-endian)
   * @param chunkIndex - For logging/tracking
   * @returns Resampled 16-bit PCM data at 16kHz
   */
  resampleChunk(pcmBytes: Uint8Array, chunkIndex: number = 0): Uint8Array {
    const chunkStartMs = Date.now();
    const inputSampleCount = pcmBytes.length / this.bytesPerSample;

    logger.info('[AudioBridge] Resampling chunk', {
      chunkIndex,
      inputSampleCount,
      inputByteLength: pcmBytes.length,
      ts: chunkStartMs,
      category: 'audio_bridge_resample_start',
    });

    // Decode PCM: 16-bit signed integers, little-endian
    const inputSamples = this.decodePCM16LE(pcmBytes);

    // Combine with any leftover samples from the previous chunk
    const combinedSamples = new Float32Array(this.sampleBuffer.length + inputSamples.length);
    combinedSamples.set(this.sampleBuffer);
    combinedSamples.set(inputSamples, this.sampleBuffer.length);

    // Calculate how many output samples we can produce
    const totalInputSamples = combinedSamples.length;
    const maxOutputSamples = Math.floor(totalInputSamples * this.resampleRatio);

    // Resample using linear interpolation
    const outputSamples = new Float32Array(maxOutputSamples);
    let outputIndex = 0;

    for (let i = 0; i < maxOutputSamples; i++) {
      const inputPosition = i / this.resampleRatio;
      const sample = this.interpolateSample(combinedSamples, inputPosition);
      outputSamples[outputIndex++] = sample;
    }

    // Retain leftover samples for next chunk
    const samplesUsed = Math.floor(maxOutputSamples / this.resampleRatio);
    const leftoverCount = totalInputSamples - samplesUsed;
    this.sampleBuffer = leftoverCount > 0
      ? combinedSamples.subarray(samplesUsed)
      : new Float32Array(0);

    // Encode back to PCM 16-bit
    const outputBytes = this.encodePCM16LE(outputSamples);

    this.samplesProcessed += inputSampleCount;
    this.chunksProcessed++;

    const resampleEndMs = Date.now();

    logger.info('[AudioBridge] Resampling chunk complete', {
      chunkIndex,
      inputSampleCount,
      outputSampleCount: outputIndex,
      outputByteLength: outputBytes.length,
      compressionRatio: (inputSampleCount / outputIndex).toFixed(2),
      leftoverSamples: this.sampleBuffer.length,
      ts: resampleEndMs,
      resampleLatencyMs: resampleEndMs - chunkStartMs,
      category: 'audio_bridge_resample_complete',
    });

    return outputBytes;
  }

  /**
   * Flushes any remaining buffered samples at stream end.
   * Must be called after the last chunk to ensure no samples are lost.
   */
  flush(): Uint8Array {
    if (this.sampleBuffer.length === 0) {
      logger.info('[AudioBridge] Flush called with empty buffer', {
        totalSamplesProcessed: this.samplesProcessed,
        totalChunksProcessed: this.chunksProcessed,
        category: 'audio_bridge_flush_empty',
      });
      return new Uint8Array(0);
    }

    const flushStartMs = Date.now();

    logger.info('[AudioBridge] Flushing remaining samples', {
      bufferSampleCount: this.sampleBuffer.length,
      ts: flushStartMs,
      category: 'audio_bridge_flush_start',
    });

    // Resample any remaining buffered samples
    const outputSamples = new Float32Array(
      Math.ceil(this.sampleBuffer.length * this.resampleRatio)
    );
    let outputIndex = 0;

    for (let i = 0; i < outputSamples.length; i++) {
      const inputPosition = i / this.resampleRatio;
      const sample = this.interpolateSample(this.sampleBuffer, inputPosition);
      outputSamples[outputIndex++] = sample;
    }

    const outputBytes = this.encodePCM16LE(outputSamples.subarray(0, outputIndex));

    // Clear buffer after flush
    this.sampleBuffer = new Float32Array(0);

    const flushEndMs = Date.now();

    logger.info('[AudioBridge] Flush complete', {
      outputByteLength: outputBytes.length,
      ts: flushEndMs,
      flushLatencyMs: flushEndMs - flushStartMs,
      totalSamplesProcessed: this.samplesProcessed,
      totalChunksProcessed: this.chunksProcessed,
      category: 'audio_bridge_flush_complete',
    });

    return outputBytes;
  }

  /**
   * Decodes 16-bit signed PCM (little-endian) to float samples normalized to [-1, 1].
   */
  private decodePCM16LE(bytes: Uint8Array): Float32Array {
    const sampleCount = bytes.length / 2;
    const samples = new Float32Array(sampleCount);

    for (let i = 0; i < sampleCount; i++) {
      // Read 16-bit signed little-endian
      const byte1 = bytes[i * 2];
      const byte2 = bytes[i * 2 + 1];
      const int16 = byte1 | (byte2 << 8);

      // Convert to signed (-32768 to 32767) and normalize to [-1, 1]
      const signed = int16 << 16 >> 16; // Sign extend
      samples[i] = signed / 32768;
    }

    return samples;
  }

  /**
   * Encodes float samples normalized to [-1, 1] to 16-bit signed PCM (little-endian).
   */
  private encodePCM16LE(samples: Float32Array): Uint8Array {
    const bytes = new Uint8Array(samples.length * 2);

    for (let i = 0; i < samples.length; i++) {
      // Clamp to [-1, 1] and scale to 16-bit range
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      const int16 = Math.round(clamped * 32767);

      // Encode as 16-bit signed little-endian
      bytes[i * 2] = int16 & 0xff;
      bytes[i * 2 + 1] = (int16 >> 8) & 0xff;
    }

    return bytes;
  }

  /**
   * Linear interpolation to get sample value at fractional position.
   */
  private interpolateSample(samples: Float32Array, position: number): number {
    if (position >= samples.length - 1) {
      return samples[samples.length - 1] || 0;
    }

    const intPart = Math.floor(position);
    const fracPart = position - intPart;

    const sample0 = samples[intPart] || 0;
    const sample1 = samples[intPart + 1] || 0;

    // Linear interpolation
    return sample0 + (sample1 - sample0) * fracPart;
  }

  /**
   * Returns statistics about the resampling process.
   */
  getStats() {
    return {
      inputSampleRate: this.inputSampleRate,
      outputSampleRate: this.outputSampleRate,
      resampleRatio: this.resampleRatio.toFixed(4),
      samplesProcessed: this.samplesProcessed,
      chunksProcessed: this.chunksProcessed,
      bufferedSamples: this.sampleBuffer.length,
    };
  }

  /**
   * Resets the resampler state for a new audio stream.
   */
  reset(): void {
    this.sampleBuffer = new Float32Array(0);
    this.samplesProcessed = 0;
    this.chunksProcessed = 0;
    logger.info('[AudioBridge] Resampler reset', {
      category: 'audio_bridge_reset',
    });
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
