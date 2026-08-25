import { NextResponse } from 'next/server';
import {
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  getClientIp,
  buildAIRequestId,
  AIRequestGatewayError,
} from '../../../../lib/aiSecurityGateway';
import { LiveTutorStreamingTtsService } from '../../../../services/liveTutorStreamingTtsService';
import { getOwnedActiveLiveTutorSession } from '../../../../services/simliService';
import logger from '../../../../lib/logger';

const MAX_TEXT_LENGTH = 1000;
const LEGACY_ROUTE_HEADERS = {
  Deprecation: 'true',
  Sunset: 'Wed, 30 Sep 2026 00:00:00 GMT',
};

/**
 * Streaming TTS endpoint using persistent Gemini Live sessions.
 * Returns audio chunks as they arrive from Gemini Live (resampled to 16kHz).
 * Uses Server-Sent Events (SSE) for streaming chunks to client.
 *
 * Request: POST { text: string, streamId?: string }
 * Response: Stream of events with resampled 16kHz PCM chunks
 */
export async function POST(req: Request) {
  const requestId = buildAIRequestId('live-tutor-tts-stream');

  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: 'Legacy streaming TTS has been retired. Use the Live Tutor voice WebSocket.' },
      { status: 410, headers: LEGACY_ROUTE_HEADERS },
    );
  }

  try {
    const user = await authenticateAIRequest(req);
    const clientIp = getClientIp(req);

    await enforceAIGatewayRateLimit(user.id, clientIp);

    logger.info('[StreamingTts] TTS stream request received', {
      userId: user.id,
      clientIp,
      requestId,
      category: 'streaming_tts_request',
    });

    // Parse request body
    let text: unknown;
    let streamId: unknown;
    try {
      const body = await req.json();
      text = body?.text;
      streamId = body?.streamId;
    } catch (parseError) {
      logger.warn('[StreamingTts] Failed to parse TTS request body', {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        requestId,
      });
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    // Validate text input
    if (typeof text !== 'string') {
      return NextResponse.json(
        { error: 'Text is required and must be a string' },
        { status: 400 }
      );
    }

    const trimmedText = text.trim();
    if (trimmedText.length === 0) {
      return NextResponse.json(
        { error: 'Text cannot be empty' },
        { status: 400 }
      );
    }

    if (trimmedText.length > MAX_TEXT_LENGTH) {
      return NextResponse.json(
        { error: `Text must not exceed ${MAX_TEXT_LENGTH} characters` },
        { status: 400 }
      );
    }

    const finalStreamId = typeof streamId === 'string' ? streamId.trim() : '';

    if (!finalStreamId) {
      logger.warn('[StreamingTts] No Simli session found for user', {
        userId: user.id,
        requestId,
      });
      return NextResponse.json(
        { error: 'streamId is required.' },
        { status: 400 }
      );
    }

    const ownedSession = await getOwnedActiveLiveTutorSession(user.id, finalStreamId);
    if (!ownedSession) {
      logger.warn('[StreamingTts] Stream ownership rejected', {
        userId: user.id,
        streamId: finalStreamId,
        requestId,
        category: 'streaming_tts_ownership_rejected',
      });
      return NextResponse.json(
        { error: 'Live Tutor session is invalid, expired, or not owned by this user.' },
        { status: 403 },
      );
    }

    logger.info('[StreamingTts] TTS stream starting', {
      userId: user.id,
      streamId: finalStreamId,
      textLength: trimmedText.length,
      requestId,
      category: 'streaming_tts_starting',
    });

    // Create ReadableStream that will emit audio chunks as events
    let ttsService: LiveTutorStreamingTtsService | null = null;
    let streamClosed = false;
    const closeTtsService = async (reason: string) => {
      if (streamClosed) return;
      streamClosed = true;
      if (ttsService) await ttsService.close(reason);
    };
    const stream = new ReadableStream({
      async start(controller) {
        let chunksSent = 0;
        const streamStartMs = Date.now();
        const enqueue = (payload: Record<string, unknown>) => {
          if (req.signal.aborted) throw new Error('TTS stream request was cancelled.');
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            throw new Error('TTS stream client is not consuming audio fast enough.');
          }
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
        };
        const abortHandler = () => {
          void closeTtsService('Client cancelled TTS stream');
        };
        req.signal.addEventListener('abort', abortHandler, { once: true });

        try {
          // Initialize the streaming TTS service
          ttsService = new LiveTutorStreamingTtsService(user.id, finalStreamId);
          await ttsService.initialize();

          logger.info('[StreamingTts] Service initialized, starting audio generation', {
            userId: user.id,
            streamId: finalStreamId,
            ts: Date.now(),
            setupLatencyMs: Date.now() - streamStartMs,
            category: 'streaming_tts_service_ready',
          });

          // Create callback for audio chunks from the audio bridge
          const onAudioChunk = async (chunk: Uint8Array, timestampMs: number) => {
            chunksSent++;

            // Convert resampled PCM to base64 for transport
            const audioBase64 = Buffer.from(chunk).toString('base64');

            const chunkEvent = {
              type: 'audio_chunk',
              index: chunksSent,
              audioBase64,
              byteLength: chunk.length,
              sampleRate: 16000,
              channels: 1,
              bitsPerSample: 16,
              timestamp: timestampMs,
            };

            // Send as SSE event
            enqueue(chunkEvent);

            logger.info('[StreamingTts] Audio chunk sent to client', {
              chunkIndex: chunksSent,
              byteLength: chunk.length,
              audioBase64Length: audioBase64.length,
              ts: timestampMs,
              category: 'streaming_tts_chunk_sent',
            });
          };

          // Connect audio bridge's resampled chunks directly to the streaming response
          const audioStreamResponse = new Promise<void>((resolve, reject) => {
            ttsService
              ?.generateStreamingSpeech(trimmedText, onAudioChunk)
              .then(() => resolve())
              .catch((error) => reject(error));
          });

          // Wait for speech generation to complete
          await audioStreamResponse;

          const streamEndMs = Date.now();

          // Send completion event
          const completeEvent = {
            type: 'stream_complete',
            chunksSent,
            totalDurationMs: streamEndMs - streamStartMs,
            category: 'streaming_tts_complete',
          };

          enqueue(completeEvent);

          logger.info('[StreamingTts] Audio stream complete', {
            userId: user.id,
            streamId: finalStreamId,
            chunksSent,
            totalDurationMs: streamEndMs - streamStartMs,
            ts: streamEndMs,
            category: 'streaming_tts_stream_complete',
          });

          if (!req.signal.aborted) controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          logger.error('[StreamingTts] Stream failed', {
            userId: user.id,
            streamId: finalStreamId,
            chunksSent,
            error: message,
            ts: Date.now(),
            category: 'streaming_tts_stream_error',
          });

          if (!req.signal.aborted) {
            try {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'error', message, chunksSent })}\n\n`));
              controller.close();
            } catch {
              // The consumer may already have cancelled the stream.
            }
          }
        } finally {
          req.signal.removeEventListener('abort', abortHandler);
          await closeTtsService(req.signal.aborted ? 'Client cancelled TTS stream' : 'Stream ended');
        }
      },
      async cancel(reason) {
        await closeTtsService(`Readable stream cancelled: ${String(reason ?? 'no reason')}`);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        ...LEGACY_ROUTE_HEADERS,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof AIRequestGatewayError ? error.status : 500;

    logger.error('[StreamingTts] Request failed', {
      error: message,
      status,
      requestId,
      category: 'streaming_tts_request_error',
    });

    return NextResponse.json(
      { error: message || 'Failed to stream speech' },
      { status }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
    status: 200,
  });
}
