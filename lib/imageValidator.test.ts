import { describe, expect, it } from 'vitest';
import { validateImageBuffer } from './imageValidator';

describe('validateImageBuffer', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

  it('accepts an image whose declared type matches its signature', () => {
    expect(validateImageBuffer(jpeg, 'image/jpeg').mimeType).toBe('image/jpeg');
  });

  it('rejects a declared type that does not match the file signature', () => {
    expect(() => validateImageBuffer(jpeg, 'image/png')).toThrow(/does not match/);
  });

  it('rejects non-image content even when it claims to be an image', () => {
    expect(() => validateImageBuffer(Buffer.from('not an image'), 'image/jpeg')).toThrow(/invalid image type/);
  });
});
