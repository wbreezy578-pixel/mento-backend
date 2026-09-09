import { AccessToken } from 'livekit-server-sdk';
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import {
  LIVE_TUTOR_LIVEKIT_CHANNELS,
  LIVE_TUTOR_LIVEKIT_MAX_QUEUE_MS,
  LIVE_TUTOR_LIVEKIT_SAMPLE_RATE,
  LiveTutorLiveKitPcmPublisher,
  type LiveTutorLiveKitAudioSink,
  type LiveTutorLiveKitPublisherMetrics,
} from './liveTutorLiveKitPcmPublisher';

export type LiveTutorLiveKitRoomConfig = {
  url: string;
  apiKey: string;
  apiSecret: string;
  roomName: string;
  publisherIdentity: string;
  subscriberIdentity: string;
};

export type LiveTutorLiveKitRoomPublisher = {
  roomName: string;
  subscriberToken: string;
  pcm: LiveTutorLiveKitPcmPublisher;
};

function required(value: string | undefined, name: string): string {
  const resolved = value?.trim();
  if (!resolved) throw new Error(`${name} is required for the LiveKit proof of concept.`);
  return resolved;
}

export function getLiveTutorLiveKitRoomConfig(options: Pick<LiveTutorLiveKitRoomConfig, 'roomName' | 'publisherIdentity' | 'subscriberIdentity'>): LiveTutorLiveKitRoomConfig {
  return {
    url: required(process.env.LIVEKIT_URL, 'LIVEKIT_URL'),
    apiKey: required(process.env.LIVEKIT_API_KEY, 'LIVEKIT_API_KEY'),
    apiSecret: required(process.env.LIVEKIT_API_SECRET, 'LIVEKIT_API_SECRET'),
    ...options,
  };
}

export async function createLiveTutorLiveKitRoomPublisher(
  config: LiveTutorLiveKitRoomConfig,
  onMetrics?: (metrics: LiveTutorLiveKitPublisherMetrics) => void,
): Promise<LiveTutorLiveKitRoomPublisher> {
  const publisherAccess = new AccessToken(config.apiKey, config.apiSecret, { identity: config.publisherIdentity, ttl: '10m' });
  publisherAccess.addGrant({ room: config.roomName, roomJoin: true, roomCreate: true, canPublish: true, canSubscribe: false });
  const subscriberAccess = new AccessToken(config.apiKey, config.apiSecret, { identity: config.subscriberIdentity, ttl: '10m' });
  subscriberAccess.addGrant({ room: config.roomName, roomJoin: true, canPublish: false, canSubscribe: true });

  const room = new Room();
  await room.connect(config.url, await publisherAccess.toJwt(), { autoSubscribe: false, dynacast: false });
  const localParticipant = room.localParticipant;
  if (!localParticipant) {
    await room.disconnect();
    throw new Error('LiveKit connected without a local publisher participant.');
  }
  const source = new AudioSource(LIVE_TUTOR_LIVEKIT_SAMPLE_RATE, LIVE_TUTOR_LIVEKIT_CHANNELS, LIVE_TUTOR_LIVEKIT_MAX_QUEUE_MS);
  const track = LocalAudioTrack.createAudioTrack('mento-gemini-native-audio', source);
  const publishOptions = new TrackPublishOptions();
  publishOptions.source = TrackSource.SOURCE_MICROPHONE;
  const publication = await localParticipant.publishTrack(track, publishOptions);

  const sink: LiveTutorLiveKitAudioSink = {
    capturePcm16Frame: (samples) => source.captureFrame(new AudioFrame(
      samples,
      LIVE_TUTOR_LIVEKIT_SAMPLE_RATE,
      LIVE_TUTOR_LIVEKIT_CHANNELS,
      samples.length,
    )),
    finishSegment: () => undefined,
    clearQueue: () => source.clearQueue(),
    waitForPlayout: () => source.waitForPlayout(),
    close: async () => {
      if (publication.sid) await localParticipant.unpublishTrack(publication.sid, true);
      else await track.close();
      await room.disconnect();
    },
  };

  return {
    roomName: config.roomName,
    subscriberToken: await subscriberAccess.toJwt(),
    pcm: new LiveTutorLiveKitPcmPublisher(sink, { onMetrics }),
  };
}
