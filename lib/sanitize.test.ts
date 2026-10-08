import { describe, expect, it } from 'vitest';
import { sanitizeForLogging } from './sanitize';

describe('production log sanitization', () => {
  it('redacts personal identifiers and network addresses recursively', () => {
    expect(sanitizeForLogging({
      userId: 'user-123',
      email: 'student@example.com',
      clientIp: '203.0.113.20',
      nested: { streamId: 'stream-123', message: 'contact student@example.com from 198.51.100.2' },
      requestId: 'safe-operational-id',
    })).toEqual({
      userId: '[REDACTED]',
      email: '[REDACTED]',
      clientIp: '[REDACTED]',
      nested: { streamId: '[REDACTED]', message: 'contact [REDACTED_EMAIL] from [REDACTED_IP]' },
      requestId: 'safe-operational-id',
    });
  });
});
