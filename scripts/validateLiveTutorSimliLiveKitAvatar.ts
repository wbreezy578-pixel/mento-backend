import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AudioStream, Room, RoomEvent, TrackKind, VideoStream, dispose } from '@livekit/rtc-node';
import {
  LIVE_TUTOR_LIVEKIT_FRAME_BYTES,
  LIVE_TUTOR_LIVEKIT_FRAME_MS,
} from '../services/liveTutorLiveKitPcmPublisher';
import {
  createLiveTutorSimliLiveKitAvatarSession,
  getLiveTutorSimliLiveKitConfig,
} from '../services/liveTutorSimliLiveKitAvatarSession';

const wait = (milliseconds: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds));

function pcmFromWav(wav: Buffer): Uint8Array {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Test clip must be a PCM WAV file.');
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunk = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (chunk === 'fmt ') {
      if (wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1 || wav.readUInt32LE(start + 4) !== 16_000 || wav.readUInt16LE(start + 14) !== 16) {
        throw new Error('Test clip must be 16 kHz, mono, PCM16 WAV.');
      }
    }
    if (chunk === 'data') return new Uint8Array(wav.buffer, wav.byteOffset + start, size).slice();
    offset = start + size + (size % 2);
  }
  throw new Error('Test clip has no WAV data chunk.');
}

async function main() {
  const clipPath = resolve(process.env.LIVE_TUTOR_PHASE3_CLIP || '../mento-mobile/artifacts/voice-comparison/test-clip-30-40s.wav');
  const pcm = pcmFromWav(await readFile(clipPath));
  const roomName = `mento-phase3-${Date.now()}`;
  const config = getLiveTutorSimliLiveKitConfig({
    roomName,
    agentIdentity: 'mento-gemini-phase3',
    subscriberIdentity: 'mento-phase3-validator',
  });
  const session = await createLiveTutorSimliLiveKitAvatarSession(config);
  const subscriber = new Room();
  let audioSamples = 0;
  let videoFrames = 0;
  let audioReader: ReadableStreamDefaultReader<import('@livekit/rtc-node').AudioFrame> | undefined;
  let videoReader: ReadableStreamDefaultReader<import('@livekit/rtc-node').VideoFrameEvent> | undefined;

  try {
    const tracksReady = new Promise<void>((resolveReady) => {
      let audioReady = false;
      let videoReady = false;
      const check = () => { if (audioReady && videoReady) resolveReady(); };
      subscriber.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === TrackKind.KIND_AUDIO && !audioReader) {
          audioReader = new AudioStream(track, { sampleRate: 16_000, numChannels: 1, frameSizeMs: 20 }).getReader();
          audioReady = true;
          void (async () => {
            while (audioReader) {
              const next = await audioReader.read();
              if (next.done) break;
              audioSamples += next.value.data.length;
            }
          })();
        }
        if (track.kind === TrackKind.KIND_VIDEO && !videoReader) {
          videoReader = new VideoStream(track).getReader();
          videoReady = true;
          void (async () => {
            while (videoReader) {
              const next = await videoReader.read();
              if (next.done) break;
              videoFrames += 1;
            }
          })();
        }
        check();
      });
    });
    await subscriber.connect(config.liveKitUrl, session.subscriberToken, { autoSubscribe: true, dynacast: false });
    await Promise.race([tracksReady, wait(15_000).then(() => { throw new Error('Simli did not publish both avatar tracks.'); })]);

    const generationId = 1;
    session.pcm.startGeneration(generationId);
    const completeBytes = pcm.byteLength - (pcm.byteLength % LIVE_TUTOR_LIVEKIT_FRAME_BYTES);
    for (let offset = 0; offset < completeBytes; offset += LIVE_TUTOR_LIVEKIT_FRAME_BYTES) {
      await session.pcm.enqueue(generationId, pcm.subarray(offset, offset + LIVE_TUTOR_LIVEKIT_FRAME_BYTES));
      if (offset >= LIVE_TUTOR_LIVEKIT_FRAME_BYTES * 3) await wait(LIVE_TUTOR_LIVEKIT_FRAME_MS);
    }
    if (!await session.pcm.completeGeneration(generationId)) throw new Error('Phase 3 generation did not complete.');
    await wait(500);
    const metrics = session.pcm.metrics();
    if (audioSamples === 0 || videoFrames === 0) throw new Error('Simli avatar tracks contained no media.');
    console.log(JSON.stringify({ result: 'passed', roomName, clipPath, audioSamples, videoFrames, ...metrics }));
  } finally {
    await audioReader?.cancel().catch(() => undefined);
    await videoReader?.cancel().catch(() => undefined);
    await subscriber.disconnect();
    await session.close();
    await dispose();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
