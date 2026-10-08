export function sanitizeForLogging<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value
      .replace(/(api[_-]?key|token|secret|password|database_url|connectionstring|authorization|cookie|refresh[_-]?token|jwt)([^\n\r]*)/gi, '[REDACTED]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]') as T;
  }
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeForLogging(item)) as T;
    }
    const sanitized: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey.includes('key') ||
        normalizedKey.includes('token') ||
        normalizedKey.includes('secret') ||
        normalizedKey.includes('password') ||
        normalizedKey.includes('authorization') ||
        normalizedKey.includes('cookie') ||
        normalizedKey.includes('jwt') ||
        normalizedKey.includes('refresh') ||
        normalizedKey.includes('url') ||
        normalizedKey.includes('connection') ||
        normalizedKey === 'email' ||
        normalizedKey === 'userid' ||
        normalizedKey === 'user_id' ||
        normalizedKey === 'ip' ||
        normalizedKey === 'clientip' ||
        normalizedKey === 'client_ip' ||
        normalizedKey === 'sessionid' ||
        normalizedKey === 'streamid' ||
        normalizedKey === 'conversationid' ||
        normalizedKey === 'messageid'
      ) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeForLogging(entryValue);
      }
    }
    return sanitized as T;
  }
  return value;
}
