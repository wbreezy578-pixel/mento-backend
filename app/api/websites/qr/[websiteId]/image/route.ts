import QRCode from 'qrcode';
import { NextResponse } from 'next/server';
import logger from '../../../../../../lib/logger';
import { getPublishedWebsiteQrTarget } from '../../../../../../services/websiteQrService';

type RouteContext = { params: Promise<{ websiteId: string }> };
type QrFormat = 'png' | 'svg' | 'print';

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character] ?? character);
}

function printLayout(svg: string, title: string, qrUrl: string, type: string): string {
  const content = svg.trim().match(/^<svg\b[^>]*>([\s\S]*)<\/svg>$/i)?.[1];
  if (!content) throw new Error('QR renderer returned invalid SVG.');
  const safeTitle = escapeXml(title);
  const safeUrl = escapeXml(qrUrl);
  const callToAction = type === 'restaurant' ? 'Scan to view our latest menu' : 'Scan to visit our website';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="150mm" viewBox="0 0 1000 1500" role="img" aria-labelledby="title description">
<title id="title">${safeTitle} QR code</title>
<desc id="description">${escapeXml(callToAction)} for ${safeTitle}.</desc>
<rect width="1000" height="1500" fill="#ffffff"/>
<text x="500" y="145" text-anchor="middle" font-family="Arial, sans-serif" font-size="54" font-weight="700" fill="#111111">${safeTitle}</text>
<text x="500" y="215" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" fill="#333333">${escapeXml(callToAction)}</text>
<svg x="100" y="270" width="800" height="800" viewBox="0 0 800 800">${content}</svg>
<text x="500" y="1160" text-anchor="middle" font-family="Arial, sans-serif" font-size="25" fill="#111111">Open camera and point it at the code</text>
<text x="500" y="1235" text-anchor="middle" font-family="Arial, sans-serif" font-size="17" fill="#444444">${safeUrl}</text>
<text x="500" y="1370" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" fill="#777777">Made with Mento Websites</text>
</svg>`;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { websiteId } = await context.params;
    const target = await getPublishedWebsiteQrTarget(websiteId);
    if (!target) {
      return NextResponse.json({ error: 'This published website is unavailable.' }, {
        status: 404,
        headers: { 'Cache-Control': 'no-store, private' },
      });
    }
    const requestedFormat = new URL(request.url).searchParams.get('format') ?? 'png';
    if (!['png', 'svg', 'print'].includes(requestedFormat)) {
      return NextResponse.json({ error: 'Choose PNG, SVG, or print format.' }, {
        status: 400,
        headers: { 'Cache-Control': 'no-store, private' },
      });
    }
    const format = requestedFormat as QrFormat;
    const options = {
      errorCorrectionLevel: 'H' as const,
      margin: 4,
      color: { dark: '#000000', light: '#FFFFFF' },
    };
    const headers = {
      'Cache-Control': 'public, max-age=60, s-maxage=60',
      'X-Content-Type-Options': 'nosniff',
    };
    if (format === 'png') {
      const image = await QRCode.toBuffer(target.qrUrl, { ...options, type: 'png', width: 1024 });
      return new NextResponse(new Uint8Array(image), {
        status: 200,
        headers: { ...headers, 'Content-Type': 'image/png' },
      });
    }

    const svg = await QRCode.toString(target.qrUrl, { ...options, type: 'svg', width: 800 });
    const body = format === 'print' ? printLayout(svg, target.title, target.qrUrl, target.type) : svg;
    return new NextResponse(body, {
      status: 200,
      headers: { ...headers, 'Content-Type': 'image/svg+xml; charset=utf-8' },
    });
  } catch (error) {
    logger.error('Published website QR image could not be generated', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return NextResponse.json({ error: 'The website QR code could not be generated.' }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store, private' },
    });
  }
}

export const runtime = 'nodejs';
