import { normalizeWebsiteContent, type WebsiteContent } from './websiteContent';

export interface WebsiteStaticFile {
  body: string;
  contentType: string;
  cacheControl: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pagePath(slug: string): string {
  return slug === 'home' ? '/' : `/${slug}/`;
}

function renderPage(content: WebsiteContent, pageIndex: number): string {
  const page = content.pages[pageIndex];
  const navigation = content.pages.map((item) => (
    `<a href="${escapeHtml(pagePath(item.slug))}">${escapeHtml(item.title)}</a>`
  )).join('');
  const sections = page.sections.map((section) => (
    `<section><h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.body)}</p></section>`
  )).join('');
  const menu = content.menuCategories.map((category) => (
    `<section><h2>${escapeHtml(category.name)}</h2><ul>${category.items.map((item) => (
      `<li><strong>${escapeHtml(item.name)}</strong>${item.price ? ` — ${escapeHtml(item.currency)} ${escapeHtml(item.price)}` : ''}<p>${escapeHtml(item.description)}</p></li>`
    )).join('')}</ul></section>`
  )).join('');
  const gallery = content.galleryImageUrls.map((url) => (
    `<img src="${escapeHtml(url)}" alt="" loading="lazy" />`
  )).join('');
  const contact = [
    content.contact.address && `<p>${escapeHtml(content.contact.address)}</p>`,
    content.contact.phone && `<p><a href="tel:${escapeHtml(content.contact.phone)}">${escapeHtml(content.contact.phone)}</a></p>`,
    content.contact.whatsappNumber && `<p><a href="https://wa.me/${encodeURIComponent(content.contact.whatsappNumber.replace(/^\+/, ''))}">Contact on WhatsApp</a></p>`,
    content.contact.address && `<p><a href="${escapeHtml(content.contact.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(content.contact.address)}`)}" target="_blank" rel="noopener noreferrer">Get directions</a></p>`,
  ].filter(Boolean).join('');
  const socialLinks = Object.entries(content.socialLinks)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([network, url]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(network[0].toUpperCase() + network.slice(1))}</a>`)
    .join(' · ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="${escapeHtml(content.seo.description)}">
<meta property="og:title" content="${escapeHtml(content.seo.title)}">
<meta property="og:description" content="${escapeHtml(content.seo.description)}">
<meta name="twitter:card" content="summary">
<title>${escapeHtml(content.seo.title || `${page.title} | ${content.title}`)}</title>
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<header><a class="brand" href="/">${escapeHtml(content.title)}</a><nav>${navigation}</nav></header>
<main><h1>${escapeHtml(page.title)}</h1>${sections}${menu}${gallery ? `<div class="gallery">${gallery}</div>` : ''}${contact ? `<section><h2>Contact</h2>${contact}</section>` : ''}</main>
<footer>${socialLinks ? `<nav aria-label="Social links">${socialLinks}</nav>` : ''}<p>Published with Mento Websites</p></footer>
</body>
</html>`;
}

export function buildWebsiteStaticFiles(input: unknown, websiteId: string, deploymentId: string): {
  files: Map<string, WebsiteStaticFile>;
} {
  const content = normalizeWebsiteContent(input);
  if (!content) throw new Error('Website content is not valid for static publishing.');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(websiteId) || !/^[A-Za-z0-9_-]{1,80}$/.test(deploymentId)) {
    throw new Error('Website deployment identifiers are invalid.');
  }

  const files = new Map<string, WebsiteStaticFile>();
  files.set('assets/site.css', {
    body: `:root{color-scheme:light;--accent:${content.theme.primaryColor};font-family:system-ui,sans-serif;color:#17202a;background:#f8fafc}*{box-sizing:border-box}body{margin:0}header,main,footer{max-width:960px;margin:auto;padding:1.25rem}header{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;border-bottom:1px solid #e2e8f0}nav{display:flex;gap:1rem;flex-wrap:wrap}.brand{font-weight:700}a{color:var(--accent)}main{padding-top:3rem}h1{font-size:clamp(2rem,6vw,3.5rem)}section{background:white;border:1px solid #e2e8f0;border-radius:1rem;padding:1.25rem;margin:1rem 0}p{line-height:1.65}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem}.gallery img{width:100%;height:220px;object-fit:cover;border-radius:.75rem}footer{color:#64748b}`,
    contentType: 'text/css; charset=utf-8',
    cacheControl: 'public, max-age=31536000, immutable',
  });

  content.pages.forEach((page, index) => {
    const path = page.slug === 'home' ? 'index.html' : `${page.slug}/index.html`;
    files.set(path, {
      body: renderPage(content, index),
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-store',
    });
  });

  return { files };
}
