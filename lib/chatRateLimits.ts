import { ensureSlidingWindow } from './rateLimiter';

export type ChatRateLimitOperation =
  | 'start'
  | 'history'
  | 'list'
  | 'edit'
  | 'delete-message'
  | 'feedback'
  | 'delete-conversation'
  | 'rename'
  | 'pin';

const POLICIES: Record<ChatRateLimitOperation, { limit: number; windowSeconds: number }> = {
  start: { limit: 20, windowSeconds: 60 * 60 },
  history: { limit: 300, windowSeconds: 15 * 60 },
  list: { limit: 300, windowSeconds: 15 * 60 },
  edit: { limit: 30, windowSeconds: 15 * 60 },
  'delete-message': { limit: 30, windowSeconds: 15 * 60 },
  feedback: { limit: 60, windowSeconds: 60 * 60 },
  'delete-conversation': { limit: 10, windowSeconds: 60 * 60 },
  rename: { limit: 60, windowSeconds: 15 * 60 },
  pin: { limit: 60, windowSeconds: 15 * 60 },
};

export function getChatRateLimitPolicy(operation: ChatRateLimitOperation) {
  return { ...POLICIES[operation] };
}

export async function enforceChatEndpointRateLimit(userId: string, operation: ChatRateLimitOperation) {
  const policy = getChatRateLimitPolicy(operation);
  return ensureSlidingWindow(
    `${operation}:${userId}`,
    policy.limit,
    policy.windowSeconds,
    'rl:chat',
  );
}

export function buildRateLimitHeaders(retryAfterSec?: number): Record<string, string> {
  return retryAfterSec && retryAfterSec > 0
    ? { 'Retry-After': String(Math.ceil(retryAfterSec)), 'Cache-Control': 'no-store' }
    : { 'Cache-Control': 'no-store' };
}
