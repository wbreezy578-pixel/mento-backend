import { NextResponse } from 'next/server';
import {
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  getClientIp,
  buildAIRequestId,
  AIRequestGatewayError,
} from '../../../../lib/aiSecurityGateway';
import { LiveTutorStreamingTtsService } from '../../../../services/liveTutorStreamingTtsService';
import { getActiveSimliSessionForUser } from '../../../../services/simliService';
import logger from '../../../../lib/logger';

const MAX_TEXT_LENGTH = 5000;

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

    // Get Simli session for user
    const simliSession = getActiveSimliSessionForUser(user.id);
    const finalStreamId = typeof streamId === 'string' ? streamId : simliSession?.streamId;

    if (!finalStreamId) {
      logger.warn('[StreamingTts] No Simli session found for user', {
        userId: user.id,
        requestId,
      });
      return NextResponse.json(
        { error: 'No active Simli session. Please start a Live Tutor session first.' },
        { status: 400 }
      );
    }

    logger.info('[StreamingTts] TTS stream starting', {
      userId: user.id,
      streamId: finalStreamId,
      textLength: trimmedText.length,
      textPreview: trimmedText.slice(0, 100),
      requestId,
      category: 'streaming_tts_starting',
    });

    // Create ReadableStream that will emit audio chunks as events
    const stream = new ReadableStream({
      async start(controller) {
        let ttsService: LiveTutorStreamingTtsService | null = null;
        let chunksSent = 0;
        const streamStartMs = Date.now();

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
            const eventData = `data: ${JSON.stringify(chunkEvent)}\n\n`;
            controller.enqueue(new TextEncoder().encode(eventData));

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

          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify(completeEvent)}\n\n`
            )
          );

          logger.info('[StreamingTts] Audio stream complete', {
            userId: user.id,
            streamId: finalStreamId,
            chunksSent,
            totalDurationMs: streamEndMs - streamStartMs,
            ts: streamEndMs,
            category: 'streaming_tts_stream_complete',
          });

          controller.close();
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

          // Send error event
          const errorEvent = {
            type: 'error',
            message,
            chunksSent,
          };

          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify(errorEvent)}\n\n`
            )
          );

          controller.close();
        } finally {
          // Clean up resources
          if (ttsService) {
            await ttsService.close('Stream ended');
          }
        }
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

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
    status: 200,
  });
}
