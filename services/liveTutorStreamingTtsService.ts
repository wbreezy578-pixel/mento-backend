import logger from '../lib/logger';
import {
  createGeminiLiveSession,
  sendTextAndStreamAudio,
  closeGeminiLiveSession,
  GeminiLiveSession,
} from './liveTutorGeminiLiveService';
import { LiveTutorAudioBridge } from './liveTutorAudioBridge';

/**
 * Coordinates Gemini Live streaming TTS with audio resampling.
 * Uses an isolated Gemini session and streams audio chunks immediately.
 */
export class LiveTutorStreamingTtsService {
  private geminiSession: GeminiLiveSession | null = null;
  private userId?: string;
  private streamId?: string;

  constructor(userId?: string, streamId?: string) {
    this.userId = userId;
    this.streamId = streamId;
  }

  /**
   * Initialize an isolated Gemini Live session.
   */
  async initialize(): Promise<void> {
    const initStartMs = Date.now();

    logger.info('[StreamingTts] Initializing streaming TTS service', {
      userId: this.userId,
      streamId: this.streamId,
      ts: initStartMs,
      category: 'streaming_tts_init',
    });

    try {
      this.geminiSession = await createGeminiLiveSession({
        userId: this.userId,
        streamId: this.streamId,
      });

      logger.info('[StreamingTts] Created isolated Gemini Live session', {
        sessionId: this.geminiSession.sessionId,
        userId: this.userId,
        streamId: this.streamId,
        ts: Date.now(),
        setupLatencyMs: Date.now() - initStartMs,
        category: 'streaming_tts_session_created',
      });

      logger.info('[StreamingTts] Initialization complete', {
        sessionId: this.geminiSession.sessionId,
        ts: Date.now(),
        totalInitLatencyMs: Date.now() - initStartMs,
        category: 'streaming_tts_init_complete',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[StreamingTts] Initialization failed', {
        userId: this.userId,
        streamId: this.streamId,
        error: message,
        ts: Date.now(),
        category: 'streaming_tts_init_error',
      });
      throw error;
    }
  }

  /**
   * Stream text to Gemini Live and get resampled audio chunks.
   * Yields chunks immediately as they arrive without buffering complete response.
   *
   * @param text - Text to convert to speech
   * @param onAudioChunk - Callback for each 16kHz PCM resampled chunk
   * @returns Promise that resolves when streaming completes
   */
  async generateStreamingSpeech(
    text: string,
    onAudioChunk: (chunk: Uint8Array, timestampMs: number) => Promise<void>
  ): Promise<void> {
    if (!this.geminiSession) {
      throw new Error('Service not initialized. Call initialize() first.');
    }

    if (!text || !text.trim()) {
      throw new Error('Text cannot be empty');
    }

    const streamStartMs = Date.now();
    let chunkCount = 0;

    logger.info('[StreamingTts] Starting streaming speech generation', {
      sessionId: this.geminiSession.sessionId,
      userId: this.userId,
      streamId: this.streamId,
      textLength: text.length,
      textPreview: text.slice(0, 100),
      ts: streamStartMs,
      category: 'streaming_tts_start',
    });

    try {
      // Create audio bridge with callback for resampled chunks
      const audioBridge = new LiveTutorAudioBridge(onAudioChunk);

      // Use Gemini Live to send text and stream audio
      await sendTextAndStreamAudio(
        this.geminiSession.sessionId,
        text,
        async (geminiAudioChunk: Uint8Array, geminiChunkTimestampMs: number) => {
          chunkCount++;

          const processStartMs = Date.now();

          logger.info('[StreamingTts] Received audio chunk from Gemini Live', {
            chunkIndex: chunkCount,
            inputByteLength: geminiAudioChunk.length,
            ts: processStartMs,
            category: 'streaming_tts_gemini_chunk',
          });

          // Process through audio bridge (resample + forward)
          await audioBridge.processAudioChunk(
            geminiAudioChunk,
            chunkCount,
            geminiChunkTimestampMs
          );
        },
        async () => {
          // Stream complete, flush any remaining samples
          await audioBridge.flush();
        }
      );

      const streamEndMs = Date.now();

      logger.info('[StreamingTts] Streaming speech generation complete', {
        sessionId: this.geminiSession.sessionId,
        userId: this.userId,
        streamId: this.streamId,
        chunkCount,
        ts: streamEndMs,
        totalStreamDurationMs: streamEndMs - streamStartMs,
        bridgeStats: audioBridge.getStats(),
        category: 'streaming_tts_complete',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      logger.error('[StreamingTts] Streaming speech generation failed', {
        sessionId: this.geminiSession.sessionId,
        userId: this.userId,
        streamId: this.streamId,
        chunkCount,
        error: message,
        ts: Date.now(),
        category: 'streaming_tts_error',
      });

      throw error;
    }
  }

  /**
   * Close the streaming service and clean up resources.
   */
  async close(reason?: string): Promise<void> {
    const closeStartMs = Date.now();

    if (this.geminiSession) {
      try {
        await closeGeminiLiveSession(this.geminiSession.sessionId, reason);

        logger.info('[StreamingTts] Service closed', {
          sessionId: this.geminiSession.sessionId,
          userId: this.userId,
          streamId: this.streamId,
          reason,
          ts: Date.now(),
          closeLatencyMs: Date.now() - closeStartMs,
          category: 'streaming_tts_closed',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('[StreamingTts] Error closing service', {
          error: message,
          ts: Date.now(),
          category: 'streaming_tts_close_error',
        });
      }
    }

    this.geminiSession = null;
  }

  /**
   * Get current service statistics.
   */
  getStats() {
    return {
      sessionId: this.geminiSession?.sessionId,
      sessionStatus: this.geminiSession?.status,
      userId: this.userId,
      streamId: this.streamId,
    };
  }
}
