import { prisma } from '../lib/prisma';
import { buildLiveTutorRealtimeVoiceUsageRecord, type LiveTutorRealtimeVoiceUsageSnapshot } from './liveTutorRealtimeVoiceUsage';

export async function recordLiveTutorRealtimeVoiceUsage(input: {
  streamId: string;
  usage: LiveTutorRealtimeVoiceUsageSnapshot;
}): Promise<boolean> {
  const liveSession = await prisma.liveTutorSession.findUnique({
    where: { streamId: input.streamId },
    select: { userId: true },
  });
  if (!liveSession) return false;

  const record = buildLiveTutorRealtimeVoiceUsageRecord({
    userId: liveSession.userId,
    streamId: input.streamId,
    usage: input.usage,
  });
  await prisma.usageLog.upsert({
    where: { provider_requestId: { provider: record.provider, requestId: record.requestId } },
    create: record,
    update: record,
  });
  return true;
}