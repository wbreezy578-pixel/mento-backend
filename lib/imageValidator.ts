import { Buffer } from 'buffer';

export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
export const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES ?? 10 * 1024 * 1024);

export type ImageValidationResult = {
  mimeType: string;
  buffer: Buffer;
  fileName?: string;
};

export function detectImageMimeType(buffer: Uint8Array): string | null {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (buffer.length >= 12 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    const brand = String.fromCharCode(buffer[8], buffer[9], buffer[10], buffer[11]);
    if (/heic|heix|mif1|msf1|miaf/i.test(brand)) {
      return 'image/heic';
    }
  }
  return null;
}

export function isExecutableMimeType(mimeType: string | null): boolean {
  if (!mimeType) return false;
  return /^application\//i.test(mimeType) || /^text\//i.test(mimeType);
}

export function normalizeMimeType(mimeType: string | null | undefined): string | null {
  if (!mimeType || typeof mimeType !== 'string') return null;
  return mimeType.trim().toLowerCase();
}

export function isAllowedImageMimeType(mimeType: string | null | undefined): mimeType is string {
  const normalized = normalizeMimeType(mimeType);
  return normalized !== null && ALLOWED_IMAGE_MIME_TYPES.includes(normalized);
}

export function decodeBase64Image(data: string): Buffer {
  const cleaned = data.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  return Buffer.from(cleaned, 'base64');
}

export function validateImageBuffer(buffer: Buffer, mimeType?: string | null): ImageValidationResult {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('Invalid image buffer');
  }

  if (buffer.length === 0) {
    throw new Error('Image data is empty');
  }

  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds maximum size of ${MAX_IMAGE_BYTES} bytes`);
  }

  const detectedMimeType = detectImageMimeType(new Uint8Array(buffer));
  const normalizedMimeType = normalizeMimeType(mimeType) ?? detectedMimeType;
  const canonicalDeclaredType = normalizedMimeType === 'image/heif' ? 'image/heic' : normalizedMimeType;

  if (!normalizedMimeType || !isAllowedImageMimeType(normalizedMimeType) || !detectedMimeType) {
    throw new Error('Unsupported or invalid image type');
  }

  if (canonicalDeclaredType !== detectedMimeType) {
    throw new Error('Declared image type does not match its contents');
  }

  if (isExecutableMimeType(normalizedMimeType)) {
    throw new Error('Executable files are not allowed');
  }

  return { mimeType: detectedMimeType, buffer };
}
