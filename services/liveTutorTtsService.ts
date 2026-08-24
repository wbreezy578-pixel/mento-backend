import { GoogleGenAI } from '@google/genai';
import { getGeminiApiKey, loadAndValidateEnvironment } from '../lib/env';
import logger from '../lib/logger';
import { normalizePcmForSimli } from './liveTutorAudioProtocol';

loadAndValidateEnvironment();
const geminiApiKey = getGeminiApiKey();

const client = new GoogleGenAI({
  apiKey: geminiApiKey,
});

const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const VOICE_NAME = 'Kore';
const REQUEST_TIMEOUT_MS = 30000;

export interface LiveTutorTtsResponse {
  audioBytes: Uint8Array;
  mimeType: string;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  byteLength: number;
}

/**
 * Generates speech audio for Live Tutor using Gemini TTS.
 * 
 * @param text - The text to convert to speech
 * @returns Promise resolving to audio bytes and metadata
 * @throws Error if text is empty or TTS generation fails
 */
export async function generateLiveTutorSpeech(text: string): Promise<LiveTutorTtsResponse> {
  const trimmed = text?.trim();
  if (!trimmed) {
    throw new Error('TTS text cannot be empty');
  }

  const requestStartedAt = Date.now();

  try {
    logger.info('[LiveTutorPerf] Gemini TTS request sent', {
      ttsInputCharCount: trimmed.length,
      model: TTS_MODEL,
      voice: VOICE_NAME,
      ts: requestStartedAt,
    });

    const response = await client.models.generateContent({
      model: TTS_MODEL,
      contents: [{ text: trimmed }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: VOICE_NAME,
            },
          },
        },
      },
    });

    const responseAvailableAt = Date.now();
    const providerLatencyMs = responseAvailableAt - requestStartedAt;

    logger.info('[LiveTutorPerf] Gemini TTS response available', {
      model: TTS_MODEL,
      providerLatencyMs,
      candidateCount: response.candidates?.length ?? 0,
      ts: responseAvailableAt,
    });

    const audioPart = response.candidates?.[0]?.content?.parts?.find(
      (part: any) => part.inlineData?.data || part.inlineData?.mimeType === 'audio/pcm'
    );
    const audioData = audioPart?.inlineData?.data;

    if (!audioData) {
      logger.error('[LiveTutor] TTS failed - no audio data in response', {
        providerLatencyMs,
        responseStructure: JSON.stringify(response, null, 2).slice(0, 500),
      });
      throw new Error('TTS service did not return audio data');
    }

    const providerAudioBytes = new Uint8Array(Buffer.from(audioData, 'base64'));
    const providerMimeType = audioPart?.inlineData?.mimeType;
    const audioBytes = normalizePcmForSimli(providerAudioBytes, providerMimeType);
    const firstAudioAvailableAt = Date.now();
    logger.info('[LiveTutorPerf] Gemini TTS first audio data available', {
      providerLatencyMs,
      decodeLatencyMs: firstAudioAvailableAt - responseAvailableAt,
      providerMimeType: providerMimeType ?? 'audio/pcm;rate=24000',
      providerAudioByteLength: providerAudioBytes.length,
      audioByteLength: audioBytes.length,
      ts: firstAudioAvailableAt,
    });

    logger.info('[LiveTutorPerf] Gemini TTS complete', {
      ttsInputCharCount: trimmed.length,
      ttsOutputByteLength: audioBytes.length,
      totalLatencyMs: firstAudioAvailableAt - requestStartedAt,
      model: TTS_MODEL,
      ts: firstAudioAvailableAt,
    });

    return {
      audioBytes,
      mimeType: 'audio/pcm;rate=16000',
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      byteLength: audioBytes.length,
    };
  } catch (error) {
    const latencyMs = Date.now() - requestStartedAt;
    const message = error instanceof Error ? error.message : String(error);

    logger.error('[LiveTutor] TTS request failed', {
      error: message,
      ttsInputCharCount: trimmed.length,
      ttsLatencyMs: latencyMs,
      model: TTS_MODEL,
    });

    throw error;
  }
}
