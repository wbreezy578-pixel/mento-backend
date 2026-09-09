import { DataStreamAudioOutput } from '@livekit/agents';
import { AudioFrame, Room, RoomEvent, type RemoteParticipant } from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import {
  LIVE_TUTOR_LIVEKIT_CHANNELS,
  LIVE_TUTOR_LIVEKIT_SAMPLE_RATE,
  LiveTutorLiveKitPcmPublisher,
  type LiveTutorLiveKitAudioSink,
  type LiveTutorLiveKitPublisherMetrics,
} from './liveTutorLiveKitPcmPublisher';

const PUBLISH_ON_BEHALF_ATTRIBUTE = 'lk.publish_on_behalf';
const DEFAULT_SIMLI_API_URL = 'https://api.simli.ai';
const DEFAULT_AVATAR_IDENTITY = 'simli-avatar-agent';
const DEFAULT_JOIN_TIMEOUT_MS = 20_000;

export type LiveTutorSimliLiveKitConfig = {
  liveKitUrl: string;
  liveKitApiKey: string;
  liveKitApiSecret: string;
  roomName: string;
  agentIdentity: string;
  subscriberIdentity: string;
  simliApiKey: string;
  faceId: string;
  simliApiUrl?: string;
  avatarIdentity?: string;
  avatarName?: string;
  emotionId?: string;
  maxSessionLength?: number;
  maxIdleTime?: number;
  joinTimeoutMs?: number;
};

type AvatarAudioOutput = Pick<DataStreamAudioOutput, 'captureFrame' | 'clearBuffer' | 'flush' | 'waitForPlayout'>;
type PhaseThreeDependencies = {
  fetch?: typeof fetch;
  createRoom?: () => Room;
  createAudioOutput?: (room: Room, destinationIdentity: string) => AvatarAudioOutput;
};

export type LiveTutorSimliLiveKitAvatarSession = {
  roomName: string;
  avatarIdentity: string;
  subscriberToken: string;
  pcm: LiveTutorLiveKitPcmPublisher;
  close(): Promise<void>;
};

function present(value: string | undefined, name: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`${name} is required for the LiveKit Simli proof of concept.`);
  return result;
}

async function readJson(response: Response, label: string): Promise<Record<string, unknown>> {
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
  if (!response.ok) throw new Error(`${label} failed with status ${response.status}.`);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} returned an invalid response.`);
  return parsed as Record<string, unknown>;
}

function waitForAvatar(room: Room, identity: string, timeoutMs: number): Promise<RemoteParticipant> {
  const current = room.remoteParticipants.get(identity);
  if (current) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      room.off(RoomEvent.ParticipantConnected, onParticipant);
      reject(new Error(`Simli avatar did not join LiveKit within ${timeoutMs}ms.`));
    }, timeoutMs);
    const onParticipant = (participant: RemoteParticipant) => {
      if (participant.identity !== identity) return;
      clearTimeout(timer);
      room.off(RoomEvent.ParticipantConnected, onParticipant);
      resolve(participant);
    };
    room.on(RoomEvent.ParticipantConnected, onParticipant);
  });
}

export function getLiveTutorSimliLiveKitConfig(options: Pick<LiveTutorSimliLiveKitConfig, 'roomName' | 'agentIdentity' | 'subscriberIdentity'>): LiveTutorSimliLiveKitConfig {
  return {
    liveKitUrl: present(process.env.LIVEKIT_URL, 'LIVEKIT_URL'),
    liveKitApiKey: present(process.env.LIVEKIT_API_KEY, 'LIVEKIT_API_KEY'),
    liveKitApiSecret: present(process.env.LIVEKIT_API_SECRET, 'LIVEKIT_API_SECRET'),
    simliApiKey: present(process.env.SIMLI_API_KEY, 'SIMLI_API_KEY'),
    faceId: present(process.env.SIMLI_FACE_ID || process.env.SIMLI_AVATAR_ID, 'SIMLI_FACE_ID'),
    simliApiUrl: process.env.SIMLI_API_BASE_URL || DEFAULT_SIMLI_API_URL,
    ...options,
  };
}

export async function createLiveTutorSimliLiveKitAvatarSession(
  config: LiveTutorSimliLiveKitConfig,
  onMetrics?: (metrics: LiveTutorLiveKitPublisherMetrics) => void,
  dependencies: PhaseThreeDependencies = {},
): Promise<LiveTutorSimliLiveKitAvatarSession> {
  const request = dependencies.fetch ?? fetch;
  const room = dependencies.createRoom?.() ?? new Room();
  const avatarIdentity = config.avatarIdentity?.trim() || DEFAULT_AVATAR_IDENTITY;
  const avatarName = config.avatarName?.trim() || avatarIdentity;
  const apiUrl = (config.simliApiUrl || DEFAULT_SIMLI_API_URL).replace(/\/$/, '');
  const agentAccess = new AccessToken(config.liveKitApiKey, config.liveKitApiSecret, {
    identity: config.agentIdentity,
    name: config.agentIdentity,
    ttl: '10m',
  });
  agentAccess.kind = 'agent';
  agentAccess.addGrant({ room: config.roomName, roomJoin: true, roomCreate: true, canPublish: true, canSubscribe: false });
  const avatarAccess = new AccessToken(config.liveKitApiKey, config.liveKitApiSecret, {
    identity: avatarIdentity,
    name: avatarName,
    attributes: { [PUBLISH_ON_BEHALF_ATTRIBUTE]: config.agentIdentity },
    ttl: '10m',
  });
  avatarAccess.kind = 'agent';
  avatarAccess.addGrant({ room: config.roomName, roomJoin: true, canPublish: true, canSubscribe: true });
  const subscriberAccess = new AccessToken(config.liveKitApiKey, config.liveKitApiSecret, {
    identity: config.subscriberIdentity,
    ttl: '10m',
  });
  subscriberAccess.addGrant({ room: config.roomName, roomJoin: true, canPublish: false, canSubscribe: true });

  let pcm: LiveTutorLiveKitPcmPublisher | undefined;
  try {
    await room.connect(config.liveKitUrl, await agentAccess.toJwt(), { autoSubscribe: false, dynacast: false });
    const composeResponse = await request(`${apiUrl}/compose/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-simli-api-key': config.simliApiKey },
      body: JSON.stringify({
        faceId: config.faceId,
        ...(config.emotionId ? { emotionId: config.emotionId } : {}),
        handleSilence: true,
        maxSessionLength: config.maxSessionLength ?? 600,
        maxIdleTime: config.maxIdleTime ?? 180,
      }),
    });
    const compose = await readJson(composeResponse, 'Simli session creation');
    const sessionToken = typeof compose.session_token === 'string' ? compose.session_token : null;
    if (!sessionToken) throw new Error('Simli session creation did not return session_token.');

    const integrationResponse = await request(`${apiUrl}/integrations/livekit/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_token: sessionToken,
        livekit_token: await avatarAccess.toJwt(),
        livekit_url: config.liveKitUrl,
      }),
    });
    await readJson(integrationResponse, 'Simli LiveKit attachment');
    await waitForAvatar(room, avatarIdentity, config.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS);

    const output = dependencies.createAudioOutput?.(room, avatarIdentity) ?? new DataStreamAudioOutput({
      room,
      destinationIdentity: avatarIdentity,
      sampleRate: LIVE_TUTOR_LIVEKIT_SAMPLE_RATE,
    });
    const sink: LiveTutorLiveKitAudioSink = {
      capturePcm16Frame: (samples) => output.captureFrame(new AudioFrame(
        samples,
        LIVE_TUTOR_LIVEKIT_SAMPLE_RATE,
        LIVE_TUTOR_LIVEKIT_CHANNELS,
        samples.length,
      )),
      finishSegment: () => output.flush(),
      clearQueue: () => output.clearBuffer(),
      waitForPlayout: async () => { await output.waitForPlayout(); },
      close: async () => {
        output.flush();
        await room.disconnect();
      },
    };
    pcm = new LiveTutorLiveKitPcmPublisher(sink, { onMetrics });
    return {
      roomName: config.roomName,
      avatarIdentity,
      subscriberToken: await subscriberAccess.toJwt(),
      pcm,
      close: () => pcm!.close(),
    };
  } catch (error) {
    if (pcm) await pcm.close();
    else await room.disconnect();
    throw error;
  }
}
