import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const event = {
    id: 'event-a',
    status: 'PROCESSING',
    attempts: 1,
    eventId: 'message-a',
  };
  return {
    event,
    payload: { email_verified: true, email: 'pubsub@example.test' },
    verifyIdToken: vi.fn(),
    getRequiredEnv: vi.fn(),
    processGooglePlayRtdn: vi.fn(),
    prisma: {
      paymentWebhookEvent: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
    },
  };
});

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn(function OAuth2ClientMock() {
    return { verifyIdToken: mocks.verifyIdToken };
  }),
}));
vi.mock('../../../../../lib/env', () => ({ getRequiredEnv: mocks.getRequiredEnv }));
vi.mock('../../../../../lib/prisma', () => ({ prisma: mocks.prisma }));
vi.mock('../../../../../services/nativeStoreService', () => ({ processGooglePlayRtdn: mocks.processGooglePlayRtdn }));

import { POST } from './route';

const validMessage = {
  message: {
    messageId: 'message-a',
    data: 'encoded-rtdn-data',
    publishTime: '2026-09-02T12:00:00.000Z',
  },
};

function request(body: unknown = validMessage, token = 'id-token') {
  return new Request('https://mento.test/api/payments/mobile/google-rtdn', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

function uniqueError() {
  return Object.assign(new Error('unique'), { code: 'P2002' });
}

describe('Google Play RTDN route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.payload.email_verified = true;
    mocks.payload.email = 'pubsub@example.test';
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      if (name === 'GOOGLE_PLAY_RTDN_AUDIENCE') return 'rtdn-audience';
      if (name === 'GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL') return 'pubsub@example.test';
      throw new Error(`missing ${name}`);
    });
    mocks.verifyIdToken.mockResolvedValue({ getPayload: () => mocks.payload });
    mocks.processGooglePlayRtdn.mockResolvedValue({ handled: true, type: 'subscription:4' });
    mocks.prisma.paymentWebhookEvent.create.mockResolvedValue({ ...mocks.event });
    mocks.prisma.paymentWebhookEvent.findUnique.mockResolvedValue(null);
    mocks.prisma.paymentWebhookEvent.findUniqueOrThrow.mockResolvedValue({ ...mocks.event });
    mocks.prisma.paymentWebhookEvent.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.paymentWebhookEvent.update.mockResolvedValue({});
  });

  it('returns 401 when the bearer token is missing', async () => {
    const response = await POST(request(validMessage, ''));

    expect(response.status).toBe(401);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
  });

  it('rejects an unverified email', async () => {
    mocks.payload.email_verified = false;

    expect((await POST(request())).status).toBe(401);
  });

  it('rejects the wrong service-account email', async () => {
    mocks.payload.email = 'other@example.test';

    expect((await POST(request())).status).toBe(401);
  });

  it('accepts a correctly verified email and audience', async () => {
    const response = await POST(request());

    expect(response.status).toBe(204);
    expect(mocks.verifyIdToken).toHaveBeenCalledWith({ idToken: 'id-token', audience: 'rtdn-audience' });
    expect(mocks.processGooglePlayRtdn).toHaveBeenCalledWith('encoded-rtdn-data');
  });

  it('fails closed when the service-account email is not configured', async () => {
    mocks.getRequiredEnv.mockImplementation((name: string) => {
      if (name === 'GOOGLE_PLAY_RTDN_AUDIENCE') return 'rtdn-audience';
      throw new Error('missing configuration');
    });

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'RTDN processing failed.' });
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
  });

  it('claims a new message as PROCESSING and processes it once', async () => {
    await POST(request());

    expect(mocks.prisma.paymentWebhookEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'PROCESSING', attempts: 1, eventId: 'message-a' }),
    });
    expect(mocks.processGooglePlayRtdn).toHaveBeenCalledTimes(1);
  });

  it('does not process an existing PROCESSED message', async () => {
    mocks.prisma.paymentWebhookEvent.create.mockRejectedValue(uniqueError());
    mocks.prisma.paymentWebhookEvent.findUnique.mockResolvedValue({ ...mocks.event, status: 'PROCESSED' });

    expect((await POST(request())).status).toBe(204);
    expect(mocks.processGooglePlayRtdn).not.toHaveBeenCalled();
  });

  it('does not process an existing PROCESSING message', async () => {
    mocks.prisma.paymentWebhookEvent.create.mockRejectedValue(uniqueError());
    mocks.prisma.paymentWebhookEvent.findUnique.mockResolvedValue({ ...mocks.event, status: 'PROCESSING' });

    expect((await POST(request())).status).toBe(204);
    expect(mocks.processGooglePlayRtdn).not.toHaveBeenCalled();
  });

  it('atomically reclaims a FAILED message and retries it', async () => {
    mocks.prisma.paymentWebhookEvent.create.mockRejectedValue(uniqueError());
    mocks.prisma.paymentWebhookEvent.findUnique.mockResolvedValue({ ...mocks.event, status: 'FAILED' });

    expect((await POST(request())).status).toBe(204);
    expect(mocks.prisma.paymentWebhookEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'event-a', status: 'FAILED' },
      data: { status: 'PROCESSING', attempts: { increment: 1 }, error: null },
    });
    expect(mocks.processGooglePlayRtdn).toHaveBeenCalledTimes(1);
  });

  it('does not process when another request wins the FAILED claim', async () => {
    mocks.prisma.paymentWebhookEvent.create.mockRejectedValue(uniqueError());
    mocks.prisma.paymentWebhookEvent.findUnique.mockResolvedValue({ ...mocks.event, status: 'FAILED' });
    mocks.prisma.paymentWebhookEvent.updateMany.mockResolvedValue({ count: 0 });

    expect((await POST(request())).status).toBe(204);
    expect(mocks.processGooglePlayRtdn).not.toHaveBeenCalled();
  });

  it('marks a processing failure FAILED and returns generic 500', async () => {
    mocks.processGooglePlayRtdn.mockRejectedValue(new Error('provider failure'));

    expect((await POST(request())).status).toBe(500);
    expect(mocks.prisma.paymentWebhookEvent.update).toHaveBeenCalledWith({
      where: { id: 'event-a' },
      data: { status: 'FAILED', attempts: { increment: 1 }, error: 'provider failure' },
    });
  });

  it('marks successful processing PROCESSED with its result type', async () => {
    await POST(request());

    expect(mocks.prisma.paymentWebhookEvent.update).toHaveBeenCalledWith({
      where: { id: 'event-a' },
      data: expect.objectContaining({ status: 'PROCESSED', eventType: 'subscription:4', error: null }),
    });
  });

  it('falls back from invalid publishTime without storing Invalid Date', async () => {
    await POST(request({ message: { ...validMessage.message, publishTime: 'not-a-date' } }));

    const createData = mocks.prisma.paymentWebhookEvent.create.mock.calls[0][0].data;
    expect(createData.occurredAt).toBeInstanceOf(Date);
    expect(Number.isNaN(createData.occurredAt.getTime())).toBe(false);
  });

  it('returns 400 for missing messageId or data', async () => {
    expect((await POST(request({ message: { data: 'data' } }))).status).toBe(400);
    expect((await POST(request({ message: { messageId: 'message-a' } }))).status).toBe(400);
    expect(mocks.prisma.paymentWebhookEvent.create).not.toHaveBeenCalled();
  });
});