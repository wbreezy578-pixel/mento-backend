import { AccessToken } from 'livekit-server-sdk';

const PUBLISH_ON_BEHALF_ATTRIBUTE = 'lk.publish_on_behalf';
const DEFAULT_SIMLI_API_URL = 'https://api.simli.ai';
const DEFAULT_AVATAR_IDENTITY = 'simli-avatar-agent';
const DEFAULT_JOIN_TIMEOUT_MS = 20_000;
const LIVEKIT_TOKEN_GRACE_SECONDS = 60;
const SIMLI_ATTACHMENT_MAX_ATTEMPTS = 3;
const SIMLI_ATTACHMENT_RETRY_BASE_MS = 1_000;

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

type PhaseThreeDependencies = {
  fetch?: typeof fetch;
  wait?: (delayMs: number) => Promise<void>;
};

export class SimliLiveKitAttachmentError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Simli LiveKit attachment failed with status ${status}.`);
    this.name = 'SimliLiveKitAttachmentError';
    this.status = status;
  }
}

export type LiveTutorSimliLiveKitAvatarSession = {
  token: string;
  sessionToken: string;
  streamId: string;
  sessionId?: string;
  avatarId?: string;
  expiresAt?: string;
  roomName: string;
  avatarIdentity: string;
  subscriberToken: string;
  startupTimings: {
    tokenPreparationMs: number;
    simliSessionCreateMs: number;
    simliLiveKitAttachMs: number;
  };
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

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfterSeconds = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(Math.round(retryAfterSeconds * 1_000), 10_000);
  }
  return SIMLI_ATTACHMENT_RETRY_BASE_MS * attempt;
}

async function attachSimliToLiveKit(
  request: typeof fetch,
  wait: (delayMs: number) => Promise<void>,
  url: string,
  body: Record<string, string>,
): Promise<void> {
  for (let attempt = 1; attempt <= SIMLI_ATTACHMENT_MAX_ATTEMPTS; attempt += 1) {
    const response = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) {
      await readJson(response, 'Simli LiveKit attachment');
      return;
    }

    // A short bounded retry prevents a transient provider throttle from being
    // presented as a generic startup failure. Reuse the same Simli session
    // token; creating a new session for each retry would amplify the limit.
    if (response.status === 429 && attempt < SIMLI_ATTACHMENT_MAX_ATTEMPTS) {
      await response.text();
      await wait(retryDelayMs(response, attempt));
      continue;
    }

    await response.text();
    throw new SimliLiveKitAttachmentError(response.status);
  }
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
  _onMetrics?: unknown,
  dependencies: PhaseThreeDependencies = {},
): Promise<LiveTutorSimliLiveKitAvatarSession> {
  const request = dependencies.fetch ?? fetch;
  const wait = dependencies.wait ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const avatarIdentity = config.avatarIdentity?.trim() || DEFAULT_AVATAR_IDENTITY;
  const avatarName = config.avatarName?.trim() || avatarIdentity;
  const apiUrl = (config.simliApiUrl || DEFAULT_SIMLI_API_URL).replace(/\/$/, '');
  const maxSessionLength = Math.max(1, Math.floor(config.maxSessionLength ?? 600));
  const liveKitTokenTtlMinutes = Math.ceil((maxSessionLength + LIVEKIT_TOKEN_GRACE_SECONDS) / 60);

  const tokenPreparationStartedAt = Date.now();
  const avatarAccess = new AccessToken(config.liveKitApiKey, config.liveKitApiSecret, {
    identity: avatarIdentity,
    name: avatarName,
    attributes: { [PUBLISH_ON_BEHALF_ATTRIBUTE]: config.agentIdentity },
    ttl: `${liveKitTokenTtlMinutes}m`,
  });
  avatarAccess.kind = 'agent';
  avatarAccess.addGrant({ room: config.roomName, roomJoin: true, canPublish: true, canSubscribe: true });

  const subscriberAccess = new AccessToken(config.liveKitApiKey, config.liveKitApiSecret, {
    identity: config.subscriberIdentity,
    ttl: `${liveKitTokenTtlMinutes}m`,
  });
  subscriberAccess.addGrant({ room: config.roomName, roomJoin: true, canPublish: true, canSubscribe: true });
  const [avatarToken, subscriberToken] = await Promise.all([
    avatarAccess.toJwt(),
    subscriberAccess.toJwt(),
  ]);

  const simliSessionCreateStartedAt = Date.now();
  const composeResponse = await request(`${apiUrl}/compose/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-simli-api-key': config.simliApiKey },
    body: JSON.stringify({
      faceId: config.faceId,
      ...(config.emotionId ? { emotionId: config.emotionId } : {}),
      handleSilence: true,
      maxSessionLength,
      maxIdleTime: config.maxIdleTime ?? 180,
    }),
  });
  const compose = await readJson(composeResponse, 'Simli session creation');
  const simliSessionCreateMs = Date.now() - simliSessionCreateStartedAt;
  const sessionToken = typeof compose.session_token === 'string' ? compose.session_token : null;
  if (!sessionToken) throw new Error('Simli session creation did not return session_token.');

  const streamId = typeof compose.stream_id === 'string' ? compose.stream_id : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = typeof compose.session_id === 'string' ? compose.session_id : streamId;
  const avatarId = typeof compose.avatar_id === 'string' ? compose.avatar_id : typeof compose.avatarId === 'string' ? compose.avatarId : undefined;
  const expiresAt = typeof compose.expires_at === 'string' ? compose.expires_at : typeof compose.expiresAt === 'string' ? compose.expiresAt : undefined;

  const simliLiveKitAttachStartedAt = Date.now();
  await attachSimliToLiveKit(request, wait, `${apiUrl}/integrations/livekit/agents`, {
    session_token: sessionToken,
    livekit_token: avatarToken,
    livekit_url: config.liveKitUrl,
  });
  const simliLiveKitAttachMs = Date.now() - simliLiveKitAttachStartedAt;

  return {
    token: sessionToken,
    sessionToken,
    streamId,
    sessionId,
    avatarId,
    expiresAt,
    roomName: config.roomName,
    avatarIdentity,
    subscriberToken,
    startupTimings: {
      tokenPreparationMs: simliSessionCreateStartedAt - tokenPreparationStartedAt,
      simliSessionCreateMs,
      simliLiveKitAttachMs,
    },
    close: async () => undefined,
  };
}
