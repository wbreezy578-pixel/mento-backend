import { beforeEach, describe, expect, it, vi } from 'vitest';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

const mocks = vi.hoisted(() => ({
  getPublishedWebsiteQrTarget: vi.fn(),
}));

vi.mock('../../../../services/websiteQrService', () => ({
  getPublishedWebsiteQrTarget: mocks.getPublishedWebsiteQrTarget,
}));

import { GET as redirectQr } from './[websiteId]/route';
import { GET as getQrImage } from './[websiteId]/image/route';

const context = { params: Promise.resolve({ websiteId: 'website-1' }) };
const target = {
  id: 'website-1',
  title: 'Bella Restaurant',
  type: 'restaurant',
  hostname: 'web-bella.trymentoapp.com',
  destinationUrl: 'https://web-bella.trymentoapp.com/',
  qrUrl: 'https://api.trymentoapp.com/api/websites/qr/website-1',
};

describe('published website QR routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPublishedWebsiteQrTarget.mockResolvedValue(target);
  });

  it('redirects a stable Mento QR URL to the current published host without caching it', async () => {
    const response = await redirectQr(new Request('https://api.trymentoapp.com/api/websites/qr/website-1'), context);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(target.destinationUrl);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('returns an unavailable response for unpublished or suspended websites', async () => {
    mocks.getPublishedWebsiteQrTarget.mockResolvedValueOnce(null);
    const response = await redirectQr(new Request('https://api.trymentoapp.com/api/websites/qr/website-1'), context);
    expect(response.status).toBe(404);
  });

  it('generates a high-resolution, logo-free PNG that decodes to the stable URL', async () => {
    const response = await getQrImage(new Request('https://api.trymentoapp.com/api/websites/qr/website-1/image?format=png'), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
    expect(png.width).toBeGreaterThan(1000);
    expect(png.height).toBe(png.width);
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(decoded?.data).toBe(target.qrUrl);
  });

  it('provides vector and print-ready SVG files without a center logo', async () => {
    const vector = await getQrImage(new Request('https://api.trymentoapp.com/api/websites/qr/website-1/image?format=svg'), context);
    const print = await getQrImage(new Request('https://api.trymentoapp.com/api/websites/qr/website-1/image?format=print'), context);
    const vectorSvg = await vector.text();
    const printSvg = await print.text();

    expect(vector.headers.get('content-type')).toContain('image/svg+xml');
    expect(vectorSvg).toContain('width="800" height="800"');
    expect(printSvg).toContain('width="100mm" height="150mm"');
    expect(printSvg).toContain('Scan to view our latest menu');
    expect(printSvg).toContain(target.qrUrl);
    expect(printSvg).not.toContain('<image');
  });

  it('rejects unsupported output formats', async () => {
    const response = await getQrImage(new Request('https://api.trymentoapp.com/api/websites/qr/website-1/image?format=pdf'), context);
    expect(response.status).toBe(400);
  });
});
