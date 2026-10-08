import { describe, expect, it } from 'vitest';
import { buildChatRuntimeContext } from './chatRuntimeContext';

describe('chat runtime context', () => {
  it('supplies the current local date and time using the device timezone', () => {
    const context = buildChatRuntimeContext({
      now: new Date('2026-10-08T21:00:00.000Z'),
      timeZone: 'Africa/Nairobi',
    });

    expect(context).toContain('2026-10-09 00:00:00 (Africa/Nairobi)');
  });

  it('falls back to UTC for an invalid timezone', () => {
    const context = buildChatRuntimeContext({
      now: new Date('2026-01-01T00:30:00.000Z'),
      timeZone: 'not/a-real-timezone',
    });

    expect(context).toContain('2026-01-01 00:30:00 (UTC)');
  });

  it('includes validated approximate location without accepting malformed coordinates', () => {
    const valid = buildChatRuntimeContext({
      now: new Date('2026-10-08T21:00:00.000Z'),
      locationContext: {
        status: 'available',
        latitude: -1.2921,
        longitude: 36.8219,
        accuracyMeters: 30,
        place: { city: 'Nairobi', country: 'Kenya' },
      },
    });
    const invalid = buildChatRuntimeContext({
      now: new Date('2026-10-08T21:00:00.000Z'),
      locationContext: { status: 'available', latitude: 999, longitude: 36.8219 },
    });

    expect(valid).toContain('"city":"Nairobi"');
    expect(valid).toContain('"latitude":-1.2921');
    expect(invalid).not.toContain('device location');
  });
});
