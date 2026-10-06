import { randomUUID } from 'node:crypto';

export function slugifyWebsiteName(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  const canonicalSlug = slug.replace(/-+$/g, '');
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(canonicalSlug) ? canonicalSlug : '';
}

export function createDraftWebsiteSlug(input: string): string {
  const baseSlug = slugifyWebsiteName(input);
  if (!baseSlug) return '';
  return `${baseSlug.slice(0, 27)}-${randomUUID().replace(/-/g, '')}`;
}

export function isWebsiteSlugUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2002') return false;
  if (!('meta' in error) || !error.meta || typeof error.meta !== 'object') return false;

  const target = 'target' in error.meta ? error.meta.target : null;
  const targetText = Array.isArray(target) ? target.join(',') : typeof target === 'string' ? target : '';
  return targetText.toLowerCase().includes('slug');
}

export function normalizeHostname(hostname: string): string {
  const match = hostname.trim().match(/^([a-z0-9.-]+)(?::(\d{1,5}))?$/i);
  if (!match) return '';

  const host = match[1].toLowerCase().replace(/\.$/, '');
  const port = match[2] ? Number(match[2]) : null;
  const labels = host.split('.');
  if (
    host.length > 253
    || (port !== null && port > 65535)
    || labels.some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
  ) {
    return '';
  }
  return host;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildWebsitePublicHtml(website: { title: string; description?: string; content?: unknown }): string {
  const content = (website.content && typeof website.content === 'object') ? (website.content as Record<string, unknown>) : {};
  const pages = Array.isArray(content.pages) ? (content.pages as Array<Record<string, unknown>>) : [];
  const firstPage = pages[0] ?? {};
  const sections = Array.isArray(firstPage.sections) ? (firstPage.sections as Array<Record<string, unknown>>) : [];
  const title = website.title || 'Mento Website';
  const description = typeof website.description === 'string' && website.description.trim() ? website.description.trim() : 'Website preview';

  const bodySections = sections.map((section) => {
    const sectionTitle = typeof section.title === 'string' ? section.title : 'Section';
    const sectionBody = typeof section.body === 'string' ? section.body : '';
    return `<section><h2>${escapeHtml(sectionTitle)}</h2><p>${escapeHtml(sectionBody)}</p></section>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${escapeHtml(description)}" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 0; background: #f7f7f7; color: #111827; }
      main { max-width: 960px; margin: 0 auto; padding: 48px 20px 72px; }
      h1 { font-size: 2.5rem; margin: 0 0 16px; }
      p { line-height: 1.6; }
      section { background: white; border-radius: 12px; padding: 20px; margin-top: 20px; box-shadow: 0 8px 24px rgba(0,0,0,0.05); }
      footer { margin-top: 32px; color: #4b5563; font-size: 0.9rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(description)}</p>
      ${bodySections || '<section><p>Website preview is ready.</p></section>'}
      <footer>Published by Mento Webs</footer>
    </main>
  </body>
</html>`;
}
