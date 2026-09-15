import { NextResponse } from 'next/server';
import { generateLiveTutorSpeech } from '../../../../services/liveTutorTtsService';
import {
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  getClientIp,
  buildAIRequestId,
  AIRequestGatewayError,
} from '../../../../lib/aiSecurityGateway';
import logger from '../../../../lib/logger';

const MAX_TEXT_LENGTH = 1000;
const TTS_TIMEOUT_MS = 35000; // 35s to account for TTS generation time

const LEGACY_ROUTE_HEADERS = {
  Deprecation: 'true',
  Sunset: 'Wed, 30 Sep 2026 00:00:00 GMT',
};

export async function POST(req: Request) {
  const requestId = buildAIRequestId('live-tutor-tts');

  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: 'Legacy Live Tutor TTS has been retired. Use the Live Tutor voice WebSocket.' },
      { status: 410, headers: LEGACY_ROUTE_HEADERS },
    );
  }

  try {
    const user = await authenticateAIRequest(req);
    const clientIp = getClientIp(req);

    await enforceAIGatewayRateLimit(user.id, clientIp);

    logger.info('[LiveTutor] TTS request received', {
      userId: user.id,
      clientIp,
      requestId,
      category: 'live_tutor_tts_request',
    });

    // Parse request body
    let text: unknown;
    try {
      const body = await req.json();
      text = body?.text;
    } catch (parseError) {
      logger.warn('[LiveTutor] Failed to parse TTS request body', {
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

    logger.info('[LiveTutor] TTS generating speech', {
      userId: user.id,
      textLength: trimmedText.length,
      requestId,
      category: 'live_tutor_tts_generating',
    });

    // Generate speech with timeout
    const ttsPromise = generateLiveTutorSpeech(trimmedText);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('TTS generation timeout')), TTS_TIMEOUT_MS)
    );

    const result = await Promise.race([ttsPromise, timeoutPromise]);

    logger.info('[LiveTutor] TTS generation successful', {
      userId: user.id,
      audioByteLength: result.byteLength,
      requestId,
      category: 'live_tutor_tts_success',
    });

    // Encode audio as base64 for JSON response
    const audioBase64 = Buffer.from(result.audioBytes).toString('base64');

    return NextResponse.json({
      audioBase64,
      mimeType: result.mimeType,
      sampleRate: result.sampleRate,
      channels: result.channels,
      bitsPerSample: result.bitsPerSample,
    }, { headers: LEGACY_ROUTE_HEADERS });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof AIRequestGatewayError ? error.status : 500;

    logger.error('[LiveTutor] TTS request failed', {
      error: message,
      status,
      requestId,
      category: 'live_tutor_tts_failed',
    });

    return NextResponse.json(
      { error: message || 'Failed to generate speech' },
      { status }
    );
  }
}
