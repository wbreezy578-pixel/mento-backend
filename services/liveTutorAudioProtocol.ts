export const LIVE_TUTOR_INPUT_MIME_TYPE = 'audio/pcm;rate=16000';
export const SIMLI_PCM_SAMPLE_RATE = 16_000;
export const SIMLI_PCM_BYTES_PER_SAMPLE = 2;
export const SIMLI_PCM_FRAME_BYTES = 640;
export const SIMLI_PCM_FRAME_MS = SIMLI_PCM_FRAME_BYTES / SIMLI_PCM_BYTES_PER_SAMPLE / SIMLI_PCM_SAMPLE_RATE * 1_000;

export function splitPcmIntoSimliFrames(pcm: Uint8Array): Uint8Array[] {
  validateLiveTutorPcm16(pcm);
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < pcm.byteLength; offset += SIMLI_PCM_FRAME_BYTES) {
    frames.push(pcm.subarray(offset, Math.min(offset + SIMLI_PCM_FRAME_BYTES, pcm.byteLength)));
  }
  return frames;
}

export function validateLiveTutorPcm16(pcm: Uint8Array): void {
  if (!(pcm instanceof Uint8Array) || pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new Error('Invalid PCM16 audio chunk.');
  }
}

export function parsePcmMimeType(mimeType: string): { encoding: string; sampleRate: number; channels: number } {
  const [mediaType, ...parameters] = mimeType.split(';').map((part) => part.trim().toLowerCase());
  if (mediaType !== 'audio/pcm' && mediaType !== 'audio/l16') throw new Error(`Unsupported PCM MIME type: ${mimeType}`);

  const values = new Map(parameters.map((parameter) => {
    const [key, value] = parameter.split('=').map((part) => part.trim());
    return [key, value] as const;
  }));
  const sampleRate = Number(values.get('rate'));
  const channels = Number(values.get('channels') ?? '1');
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isInteger(channels) || channels <= 0) {
    throw new Error(`Unsupported PCM format: ${mimeType}`);
  }
  return { encoding: 'signed 16-bit little-endian PCM', sampleRate, channels };
}

export function resamplePcm16Mono(pcm: Uint8Array, sourceRate: number, targetRate: number, channels = 1): Uint8Array {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) {
    throw new Error('Invalid PCM sample rate.');
  }
  if (pcm.byteLength % (2 * channels) !== 0) throw new Error('Invalid PCM16 audio chunk.');

  const sourceChannelSamples = pcm.byteLength / 2 / channels;
  const monoPcm = channels === 1 ? pcm : new Uint8Array(sourceChannelSamples * 2);
  if (channels > 1) {
    const inputView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const monoView = new DataView(monoPcm.buffer);
    for (let sampleIndex = 0; sampleIndex < sourceChannelSamples; sampleIndex += 1) {
      let total = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        total += inputView.getInt16((sampleIndex * channels + channel) * 2, true);
      }
      monoView.setInt16(sampleIndex * 2, Math.round(total / channels), true);
    }
  }

  if (sourceRate === targetRate) return monoPcm;

  const sourceSamples = monoPcm.byteLength / 2;
  const targetSamples = Math.max(1, Math.round(sourceSamples * targetRate / sourceRate));
  const sourceView = new Int16Array(monoPcm.buffer, monoPcm.byteOffset, sourceSamples);
  const outputView = new Int16Array(targetSamples);

  if (sourceRate === 24000 && targetRate === 16000) {
    for (let index = 0; index < targetSamples; index += 1) {
      const sourcePosition = index * 1.5;
      const lowerIndex = Math.floor(sourcePosition);
      const upperIndex = Math.min(lowerIndex + 1, sourceSamples - 1);
      const fraction = sourcePosition - lowerIndex;
      outputView[index] = Math.round(sourceView[lowerIndex] + (sourceView[upperIndex] - sourceView[lowerIndex]) * fraction);
    }
    return new Uint8Array(outputView.buffer);
  }

  for (let index = 0; index < targetSamples; index += 1) {
    const sourcePosition = index * sourceRate / targetRate;
    const lowerIndex = Math.floor(sourcePosition);
    const upperIndex = Math.min(lowerIndex + 1, sourceSamples - 1);
    const fraction = sourcePosition - lowerIndex;
    const lower = sourceView[Math.min(lowerIndex, sourceSamples - 1)];
    const upper = sourceView[upperIndex];
    outputView[index] = Math.round(lower + (upper - lower) * fraction);
  }

  return new Uint8Array(outputView.buffer);
}

export function normalizePcmForSimli(pcm: Uint8Array, providerMimeType?: string): Uint8Array {
  validateLiveTutorPcm16(pcm);
  const normalizedMimeType = providerMimeType?.trim().toLowerCase();
  const isPcmMimeType = normalizedMimeType?.startsWith('audio/pcm') || normalizedMimeType?.startsWith('audio/l16');
  if (normalizedMimeType && !isPcmMimeType) {
    throw new Error(`Unsupported PCM MIME type: ${providerMimeType}`);
  }
  const format = isPcmMimeType && normalizedMimeType?.includes('rate=')
    ? parsePcmMimeType(providerMimeType!)
    : { sampleRate: 24000, channels: 1 };
  return resamplePcm16Mono(pcm, format.sampleRate, 16000, format.channels);
}
