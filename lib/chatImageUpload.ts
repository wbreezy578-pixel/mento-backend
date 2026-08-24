import crypto from 'node:crypto';

const uploads = new Map<string, { data: string; mimeType: string; expiresAt: number }>();
const UPLOAD_TTL_MS = 10 * 60 * 1000;

export function storeChatImage(data: string, mimeType: string) {
  const id = crypto.randomBytes(18).toString('base64url');
  uploads.set(id, { data, mimeType, expiresAt: Date.now() + UPLOAD_TTL_MS });
  return id;
}

export function takeChatImage(id: string) {
  const upload = uploads.get(id);
  if (!upload || upload.expiresAt <= Date.now()) {
    uploads.delete(id);
    return null;
  }
  uploads.delete(id);
  return upload;
}
