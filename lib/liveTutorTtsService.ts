import { fetchWithTimeout } from './resilience';

export interface LiveTutorTtsService {
  generateSpeech(text: string): Promise<{ audioBase64: string; mimeType: string; sampleRate: number; channels: number; bitsPerSample: number }>;
}

export class RemoteLiveTutorTtsService implements LiveTutorTtsService {
  async generateSpeech(text: string): Promise<{ audioBase64: string; mimeType: string; sampleRate: number; channels: number; bitsPerSample: number }> {
    if (!text || !text.trim()) {
      throw new Error('TTS text cannot be empty');
    }

    const response = await fetchWithTimeout(
      '/api/live-tutor/tts',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      },
      35000,
      'tts'
    );

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to generate speech');
    }

    if (!payload.audioBase64) {
      throw new Error('TTS response missing audio data');
    }

    return {
      audioBase64: payload.audioBase64,
      mimeType: payload.mimeType || 'audio/pcm',
      sampleRate: payload.sampleRate || 16000,
      channels: payload.channels || 1,
      bitsPerSample: payload.bitsPerSample || 16,
    };
  }
}
