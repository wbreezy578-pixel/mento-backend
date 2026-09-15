import { AudioStream, Room, RoomEvent, dispose } from '@livekit/rtc-node';
import {
  LIVE_TUTOR_LIVEKIT_FRAME_BYTES,
  LIVE_TUTOR_LIVEKIT_FRAME_MS,
  LIVE_TUTOR_LIVEKIT_SAMPLE_RATE,
} from '../services/liveTutorLiveKitPcmPublisher';
import { createLiveTutorLiveKitRoomPublisher, getLiveTutorLiveKitRoomConfig } from '../services/liveTutorLiveKitRoomPublisher';

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
async function main() {
const roomName = `mento-phase2-${Date.now()}`;
const config = getLiveTutorLiveKitRoomConfig({
  roomName,
  publisherIdentity: 'mento-gemini-pcm-publisher',
  subscriberIdentity: 'mento-phase2-validator',
});

const publisher = await createLiveTutorLiveKitRoomPublisher(config);
const subscriber = new Room();
let receivedSamples = 0;
let nonzeroSamples = 0;
let reader: ReadableStreamDefaultReader<import('@livekit/rtc-node').AudioFrame> | null = null;

const trackReady = new Promise<void>((resolve) => {
  subscriber.on(RoomEvent.TrackSubscribed, (track) => {
    if (reader) return;
    reader = new AudioStream(track, { sampleRate: LIVE_TUTOR_LIVEKIT_SAMPLE_RATE, numChannels: 1, frameSizeMs: LIVE_TUTOR_LIVEKIT_FRAME_MS }).getReader();
    resolve();
    void (async () => {
      while (reader) {
        const next = await reader.read();
        if (next.done) break;
        receivedSamples += next.value.data.length;
        for (const sample of next.value.data) if (sample !== 0) nonzeroSamples += 1;
      }
    })();
  });
});

await subscriber.connect(config.url, publisher.subscriberToken, { autoSubscribe: true, dynacast: false });
await Promise.race([trackReady, wait(5_000).then(() => { throw new Error('Subscriber did not receive the audio track.'); })]);

const generationId = 1;
publisher.pcm.startGeneration(generationId);
const totalFrames = 50;
for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
  const bytes = new Uint8Array(LIVE_TUTOR_LIVEKIT_FRAME_BYTES);
  const view = new DataView(bytes.buffer);
  for (let sampleIndex = 0; sampleIndex < bytes.byteLength / 2; sampleIndex += 1) {
    const absoluteSample = frameIndex * 320 + sampleIndex;
    view.setInt16(sampleIndex * 2, Math.round(Math.sin(absoluteSample * 2 * Math.PI * 440 / LIVE_TUTOR_LIVEKIT_SAMPLE_RATE) * 8_000), true);
  }
  await publisher.pcm.enqueue(generationId, bytes);
  // Model Gemini's common 40ms output chunks at real-time cadence. The native
  // LiveKit source receives the initial 60ms reserve before this clock begins.
  if (frameIndex >= 3 && frameIndex % 2 === 1 && frameIndex < totalFrames - 1) await wait(40);
}

if (!await publisher.pcm.completeGeneration(generationId)) throw new Error('Publisher generation did not complete.');
await wait(500);
const metrics = publisher.pcm.metrics();
await reader?.cancel();
await subscriber.disconnect();
await publisher.pcm.close();
await dispose();

if (receivedSamples < LIVE_TUTOR_LIVEKIT_SAMPLE_RATE * 0.8) throw new Error(`Received only ${receivedSamples} samples.`);
if (nonzeroSamples < LIVE_TUTOR_LIVEKIT_SAMPLE_RATE * 0.5) throw new Error('Subscriber audio was unexpectedly silent.');
if (metrics.framesPublished !== totalFrames || metrics.staleGenerationDrops !== 0) throw new Error('Publisher frame accounting failed.');
if (metrics.underrunCount !== 0 || metrics.overflowCount !== 0) throw new Error('Publisher queue was not continuous and bounded.');

console.log(JSON.stringify({
  result: 'passed',
  roomName,
  publishedFrames: metrics.framesPublished,
  publishedDurationMs: metrics.framesPublished * LIVE_TUTOR_LIVEKIT_FRAME_MS,
  receivedSamples,
  nonzeroSamples,
  maxQueueDepthMs: metrics.maxQueueDepthMs,
  underrunCount: metrics.underrunCount,
  overflowCount: metrics.overflowCount,
  staleGenerationDrops: metrics.staleGenerationDrops,
  maxSchedulerLatenessMs: metrics.maxSchedulerLatenessMs,
}));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
