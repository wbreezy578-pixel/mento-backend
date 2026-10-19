import { normalizeWebsiteContent, type WebsiteContent, type WebsiteImageSlot, type WebsiteSection } from './websiteContent';

export interface WebsiteStaticFile {
  body: string | Uint8Array;
  contentType: string;
  cacheControl: string;
}

export interface WebsiteStaticImageAsset {
  id: string;
  slotId: string;
  source: 'pexels' | 'pixabay' | 'unsplash' | 'user_upload' | 'imagen_generated' | 'gemini_generated';
  remoteUrl: string | null;
  sourcePageUrl: string | null;
  creatorName: string | null;
  creatorProfileUrl: string | null;
  alt: string;
  mimeType: string | null;
  bytes?: Uint8Array;
}

const SAFE_IMAGE_HOSTS = new Set(['images.pexels.com', 'images.unsplash.com']);

const websiteTypographyCss = `
:root{
  --space-1:.25rem;
  --space-2:.5rem;
  --space-3:.75rem;
  --space-4:1rem;
  --space-5:1.5rem;
  --space-6:2rem;
  --space-7:3rem;
  --space-8:4rem;
  --text-small:.875rem;
  --text-body:1rem;
  --text-lead:1.125rem;
  --text-h4:1rem;
  --text-h3:1.25rem;
  --text-h2:clamp(1.75rem,3vw,2rem);
  --text-h1:clamp(2.5rem,6vw,4.25rem);
}
body{font-size:var(--text-body);line-height:1.65}
.topbar{padding-top:var(--space-4);padding-bottom:var(--space-4);gap:var(--space-6);font-size:var(--text-small)}
.brand{font-size:1.125rem}
.topbar nav{gap:var(--space-5)}
.section{padding:var(--space-8) max(7vw,24px)}
.hero{padding-top:calc(var(--space-8) + var(--space-4));padding-bottom:calc(var(--space-8) + var(--space-4));gap:var(--space-7)}
h1,h2,h3{font-family:var(--display);font-weight:700;text-wrap:balance}
h1{font-size:var(--text-h1);line-height:1.05;letter-spacing:-.035em;margin:0 0 var(--space-5)}
h2{font-size:var(--text-h2);line-height:1.2;letter-spacing:-.02em;margin:0 0 var(--space-4)}
.hero h1,.hero h2{font-size:var(--text-h1);line-height:1.05;letter-spacing:-.035em;margin-bottom:var(--space-5)}
h3{font-size:var(--text-h3);line-height:1.3;margin:var(--space-6) 0 var(--space-3)}
h4{font-family:var(--body);font-size:var(--text-h4);line-height:1.4;margin:0 0 var(--space-2)}
.eyebrow{margin:0 0 var(--space-3)}
.section p{font-size:var(--text-body);line-height:1.7;margin:0 0 var(--space-4)}
.section p:last-child{margin-bottom:0}
.trust-details{display:grid;gap:var(--space-2);margin:var(--space-4) 0}
.section .trust-item,.section .trust-copy p{margin:0}
.trust-copy h3{margin:var(--space-3) 0 var(--space-2)}
.trust-quote{margin:var(--space-4) 0;padding:var(--space-4) var(--space-5);border-left:3px solid var(--secondary);background:var(--surface);font-family:var(--display);font-size:var(--text-lead);line-height:1.55}
.hero p:not(.eyebrow){font-size:var(--text-lead);max-width:620px}
.hero-action{margin-top:var(--space-3);width:fit-content}
.button:focus-visible{outline:3px solid var(--secondary);outline-offset:3px}
a:focus-visible{outline:3px solid var(--secondary);outline-offset:3px;border-radius:3px}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.menu-category h3{margin-top:var(--space-7)}
.menu-item{padding:var(--space-4) 0;gap:var(--space-4)}
.menu-copy p{font-size:var(--text-small);margin:0}
.price{font-size:var(--text-small)}
.gallery{gap:var(--space-3)}
.button{padding:var(--space-3) var(--space-5);font-size:var(--text-small)}
.footer{padding:var(--space-5) 7vw;font-size:var(--text-small);line-height:1.5}
@media(max-width:640px){
  .topbar{padding:var(--space-3) var(--space-5)}
  .section{padding:var(--space-7) var(--space-5)}
  .hero{padding-top:var(--space-8);padding-bottom:var(--space-8);gap:var(--space-5)}
  .hero h1,.hero h2{font-size:clamp(2.375rem,11vw,3rem)}
  h2{font-size:1.75rem}
  .gallery{gap:var(--space-3)}
  .menu-item{gap:var(--space-3)}
  .menu-image{width:60px;height:60px}
  .price{font-size:.8125rem}
}
`;

const websitePhoneCss = `
@media(max-width:640px){
  html,body{width:100%;max-width:100%;overflow-x:clip}
  img{display:block;max-width:100%}
  h1,h2,h3,h4,p,a,button{overflow-wrap:anywhere}
  main,.section,.section-copy,.menu-copy{min-width:0}
  .topbar{height:auto;min-height:58px;padding:var(--space-3) var(--space-5);flex-wrap:wrap;gap:var(--space-2)}
  .brand{width:100%;max-width:100%;font-size:1.0625rem}
  .topbar nav{display:flex;order:2;width:100%;gap:var(--space-2);overflow-x:auto;overflow-y:hidden;padding-bottom:var(--space-1);scrollbar-width:thin;-webkit-overflow-scrolling:touch}
  .topbar nav a{flex:0 0 auto;min-height:44px;display:inline-flex;align-items:center;padding:0 var(--space-2)}
  .topbar nav a:focus-visible{outline:2px solid var(--secondary);outline-offset:-2px;border-radius:4px}
  .section{padding:var(--space-6) var(--space-5)}
  .hero{padding-top:var(--space-7);padding-bottom:var(--space-7);grid-template-columns:minmax(0,1fr);gap:var(--space-5)}
  .hero h1,.hero h2{font-size:clamp(2.125rem,10vw,3rem)}
  h2{font-size:1.75rem}
  .hero-image{aspect-ratio:16/10}
  .gallery{grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3)}
  .gallery-image{aspect-ratio:1}
  .menu-item{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;column-gap:var(--space-3);row-gap:var(--space-1);padding:var(--space-4) 0}
  .menu-item .menu-copy{grid-column:1;grid-row:1}
  .menu-item .price{grid-column:2;grid-row:1;font-size:.8125rem;white-space:normal;min-width:0;text-align:right}
  .menu-item.has-image{grid-template-columns:52px minmax(0,1fr) auto}
  .menu-item.has-image>.asset-figure{grid-column:1;grid-row:1 / span 2}
  .menu-item.has-image .menu-copy{grid-column:2;grid-row:1 / span 2}
  .menu-item.has-image .price{grid-column:3;grid-row:1;white-space:normal;min-width:0;text-align:right}
  .menu-image{width:52px;height:52px}
  .button{min-height:48px;max-width:100%;white-space:normal;text-align:center}
  .hero-action{width:fit-content}
  .photo-credit{overflow-wrap:anywhere}
}
`;

const websiteBackgroundCss = `
.page>.section:nth-of-type(even):not(.hero){background:linear-gradient(135deg,var(--surface),var(--paper) 72%)}
body.preset-coastal-editorial .hero-image-background{position:relative;isolation:isolate;display:block;min-height:min(680px,75vh);background:#193630;color:#fff;overflow:hidden}
body.preset-coastal-editorial .hero-image-background:before{position:absolute;z-index:1;inset:0;content:"";background:linear-gradient(90deg,rgba(12,28,25,.82),rgba(12,28,25,.49) 55%,rgba(12,28,25,.13))}
body.preset-coastal-editorial .hero-image-background>.asset-figure{position:absolute;z-index:0;inset:0;margin:0;width:100%;height:100%;overflow:hidden}
body.preset-coastal-editorial .hero-image-background .hero-image{width:100%;height:100%;max-height:none;aspect-ratio:auto;object-fit:cover;object-position:center 45%;border-radius:0;opacity:1;filter:saturate(.82) brightness(.78)}
body.preset-coastal-editorial .hero-image-background .section-copy{position:relative;z-index:2;max-width:min(760px,78%);padding-top:var(--space-7);padding-bottom:var(--space-7)}
body.preset-coastal-editorial .hero-image-background .eyebrow{color:#f0d5a4}
body.preset-coastal-editorial .hero-image-background p:not(.eyebrow),body.preset-coastal-editorial .hero-image-background .photo-credit{color:rgba(255,255,255,.86)}
body.preset-trustworthy-professional .hero-image-background,body.preset-local-service .hero-image-background,body.preset-creative-portfolio .hero-image-background{grid-template-columns:minmax(0,1fr) minmax(260px,.92fr);gap:var(--space-7);background:var(--paper);min-height:0}
body.preset-trustworthy-professional .hero-image-background .section-copy,body.preset-local-service .hero-image-background .section-copy,body.preset-creative-portfolio .hero-image-background .section-copy{grid-column:1;max-width:none;padding:var(--space-7) 0}
body.preset-trustworthy-professional .hero-image-background>.asset-figure,body.preset-local-service .hero-image-background>.asset-figure,body.preset-creative-portfolio .hero-image-background>.asset-figure{grid-column:2;grid-row:1;margin:var(--space-4) 0;border-radius:14px;overflow:hidden}
body.preset-trustworthy-professional .hero-image-background .hero-image,body.preset-local-service .hero-image-background .hero-image,body.preset-creative-portfolio .hero-image-background .hero-image{opacity:1;filter:none;border-radius:14px;min-height:320px;height:100%;object-position:center}
body.preset-creative-portfolio .hero-image-background{min-height:min(740px,80vh);background:linear-gradient(135deg,#fff,var(--paper) 70%)}
body.preset-creative-portfolio .hero-image-background>.asset-figure{margin:0}
body.preset-creative-portfolio .hero-image-background .hero-image{box-shadow:0 24px 70px rgba(34,38,32,.12)}
body.preset-modern-business .hero.hero-no-image{background:radial-gradient(ellipse at 85% 14%,rgba(52,115,190,.2),transparent 32%),radial-gradient(ellipse at 70% 85%,rgba(51,154,144,.19),transparent 36%),linear-gradient(120deg,var(--paper),var(--surface))}
body.preset-modern-business .hero.hero-no-image:after{position:absolute;z-index:-1;content:"";width:min(42vw,460px);aspect-ratio:1;border:1px solid rgba(49,92,145,.12);border-radius:42% 58% 64% 36% / 41% 37% 63% 59%;right:7%;top:12%;box-shadow:0 0 0 26px rgba(49,92,145,.035),0 0 0 58px rgba(40,98,95,.025);transform:rotate(-18deg)}
body.preset-coastal-editorial .hero.hero-no-image{background:radial-gradient(ellipse at 88% 12%,rgba(168,77,53,.16),transparent 27%),radial-gradient(ellipse at 8% 100%,rgba(82,98,72,.13),transparent 34%),linear-gradient(118deg,#fffdf9,var(--paper) 58%,#f1e5d2)}
body.preset-coastal-editorial .page>.section:nth-of-type(even):not(.hero){background:radial-gradient(ellipse at 100% 0%,rgba(168,77,53,.055),transparent 38%),linear-gradient(135deg,#f3ecdf,var(--paper) 74%)}
body.preset-trustworthy-professional .hero.hero-no-image{background:radial-gradient(ellipse at 92% 14%,rgba(40,91,118,.13),transparent 31%),linear-gradient(125deg,#fff,var(--paper) 66%,#e8f0f3)}
body.preset-trustworthy-professional .page>.section:nth-of-type(even):not(.hero){background:linear-gradient(120deg,#edf3f5,var(--paper) 64%,#f7fafb)}
body.preset-local-service .hero.hero-no-image{background:radial-gradient(ellipse at 100% 0%,rgba(40,96,76,.16),transparent 36%),radial-gradient(ellipse at 0% 100%,rgba(115,81,22,.07),transparent 34%),linear-gradient(135deg,#fff,var(--surface) 76%)}
body.preset-local-service .page>.section:nth-of-type(even):not(.hero){background:radial-gradient(ellipse at 0% 0%,rgba(40,96,76,.07),transparent 42%),linear-gradient(135deg,var(--surface),var(--paper) 76%)}
body.preset-creative-portfolio .hero.hero-no-image{background:radial-gradient(ellipse at 100% 0%,rgba(104,66,140,.10),transparent 31%),linear-gradient(135deg,#fff 0%,var(--paper) 68%,#f1eae1)}
body.preset-creative-portfolio .page>.section:nth-of-type(even):not(.hero){background:linear-gradient(120deg,#fff,var(--paper) 62%,#f0e9e1)}
body.preset-creative-portfolio .page>.section{padding-top:calc(var(--space-8) + var(--space-3));padding-bottom:calc(var(--space-8) + var(--space-3))}
@media(max-width:640px){
  body.preset-coastal-editorial .hero-image-background{min-height:clamp(520px,78vh,740px)}
  body.preset-coastal-editorial .hero-image-background:before{background:linear-gradient(180deg,rgba(12,28,25,.12),rgba(12,28,25,.68) 43%,rgba(12,28,25,.86))}
  body.preset-coastal-editorial .hero-image-background .hero-image{object-position:center 40%}
  body.preset-trustworthy-professional .hero-image-background,body.preset-local-service .hero-image-background,body.preset-creative-portfolio .hero-image-background{display:flex;min-height:0;flex-direction:column;gap:var(--space-4)}
  body.preset-trustworthy-professional .hero-image-background>.asset-figure,body.preset-local-service .hero-image-background>.asset-figure,body.preset-creative-portfolio .hero-image-background>.asset-figure{position:relative;inset:auto;width:100%;height:auto;min-height:0;order:0;margin:0}
  body.preset-trustworthy-professional .hero-image-background .hero-image,body.preset-local-service .hero-image-background .hero-image,body.preset-creative-portfolio .hero-image-background .hero-image{aspect-ratio:16/10;min-height:0;height:auto}
  body.preset-trustworthy-professional .hero-image-background .section-copy,body.preset-local-service .hero-image-background .section-copy,body.preset-creative-portfolio .hero-image-background .section-copy{order:1;padding:var(--space-3) 0 0}
  body.preset-modern-business .hero.hero-no-image:after{width:72vw;right:-10%;top:auto;bottom:-12%;opacity:.75}
}
`;

const websiteEditorialCss = `
.topbar{position:sticky;top:0;z-index:20;background:var(--paper);box-shadow:0 8px 24px rgba(34,38,32,.06)}
.section{scroll-margin-top:84px}
.menu-nav{padding-top:var(--space-2);padding-bottom:var(--space-4)}
.menu-nav a{background:var(--paper);transition:background-color .18s ease,color .18s ease}
.menu-nav a:hover{background:var(--surface);color:var(--accent)}
.menu-categories{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));align-items:start;gap:var(--space-4)}
.menu-category{max-width:none;padding:var(--space-5);border:1px solid var(--line);border-radius:16px;background:var(--surface)}
.menu-category h3{margin:0 0 var(--space-2);padding-bottom:var(--space-3);border-bottom:1px solid var(--line);color:var(--accent)}
.menu-category .menu-item:last-child{border-bottom:0}
.menu-image,.section-image,.gallery-image,.menu-feature-image{border-radius:12px}
.price{font-weight:700;font-variant-numeric:tabular-nums}
.footer{border-top:1px solid var(--line)}
@media(max-width:640px){.menu-category{padding:var(--space-4);border-radius:14px}}
`;

const websiteHeroLayoutCss = `
body .hero-layout-cinematic.hero-image-background{position:relative;isolation:isolate;display:block;min-height:min(680px,75vh);background:#193630;color:#fff;overflow:hidden}
body .hero-layout-cinematic.hero-image-background:before{position:absolute;z-index:1;inset:0;content:"";background:linear-gradient(90deg,rgba(12,28,25,.82),rgba(12,28,25,.49) 55%,rgba(12,28,25,.13))}
body .hero-layout-cinematic.hero-image-background>.asset-figure{position:absolute;z-index:0;inset:0;width:100%;height:100%;margin:0;overflow:hidden}
body .hero-layout-cinematic.hero-image-background .hero-image{width:100%;height:100%;max-height:none;aspect-ratio:auto;object-fit:cover;object-position:center 45%;border-radius:0;opacity:1;filter:saturate(.82) brightness(.78)}
body .hero-layout-cinematic.hero-image-background .section-copy{position:relative;z-index:2;max-width:min(760px,78%);padding-top:var(--space-7);padding-bottom:var(--space-7)}
body .hero-layout-cinematic.hero-image-background .eyebrow{color:#f0d5a4}
body .hero-layout-cinematic.hero-image-background p:not(.eyebrow),body .hero-layout-cinematic.hero-image-background .photo-credit{color:rgba(255,255,255,.9)}
body .hero-layout-split.hero-image-inline{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,.92fr);gap:var(--space-7)}
body .hero-layout-split.hero-image-inline .section-copy{grid-column:1;grid-row:1}
body .hero-layout-split.hero-image-inline>.asset-figure{grid-column:2;grid-row:1;align-self:stretch;margin:0;overflow:hidden;border-radius:14px}
body .hero-layout-split.hero-image-inline .hero-image{height:100%;min-height:320px;max-height:none;aspect-ratio:auto;object-fit:cover;border-radius:14px}
body .hero-layout-split.hero-no-image .section-copy{max-width:760px}
body .hero-layout-centered-editorial{display:flex;flex-direction:column;align-items:center;text-align:center;gap:var(--space-4)}
body .hero-layout-centered-editorial .section-copy{width:100%;max-width:760px}
body .hero-layout-centered-editorial .section-copy h1,body .hero-layout-centered-editorial .section-copy h2,body .hero-layout-centered-editorial .section-copy p{margin-left:auto;margin-right:auto}
body .hero-layout-centered-editorial>.asset-figure{width:min(100%,900px);margin:0;overflow:hidden;border-radius:14px}
body .hero-layout-centered-editorial .hero-image{width:100%;max-height:460px;aspect-ratio:16/9;object-fit:cover;border-radius:14px}
@media(max-width:640px){
  body .hero-layout-cinematic.hero-image-background{min-height:clamp(500px,76vh,700px)}
  body .hero-layout-cinematic.hero-image-background:before{background:linear-gradient(180deg,rgba(12,28,25,.12),rgba(12,28,25,.68) 43%,rgba(12,28,25,.86))}
  body .hero-layout-cinematic.hero-image-background .section-copy{max-width:100%;padding-top:var(--space-7);padding-bottom:var(--space-7)}
  body .hero-layout-split.hero-image-inline{display:flex;flex-direction:column;align-items:stretch;gap:var(--space-4)}
  body .hero-layout-split.hero-image-inline>.asset-figure{width:100%;height:auto;min-height:0}
  body .hero-layout-split.hero-image-inline .hero-image{width:100%;height:auto;min-height:0;aspect-ratio:16/10}
  body .hero-layout-centered-editorial{align-items:stretch}
  body .hero-layout-centered-editorial .section-copy{align-self:center}
  body .hero-layout-centered-editorial .hero-image{aspect-ratio:4/3}
}
`;

function buildWebsitePaletteCss(content: WebsiteContent): string {
  const { primaryColor, secondaryColor, backgroundColor, surfaceColor } = content.theme;
  return `
:root{--accent:${primaryColor};--secondary:${secondaryColor};--paper:${backgroundColor};--surface:${surfaceColor}}
body{background:var(--paper)}
body[class*="preset-"]{--paper:${backgroundColor};--surface:${surfaceColor}}
body[class*="preset-"] .hero{background:var(--surface)}
.whatsapp,.footer{background:var(--surface)}
.eyebrow,.price{color:var(--secondary)}
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeImageUrl(value: string | null): string | null {
  if (!value) return null;
  const url = safeExternalUrl(value);
  if (!url) return null;
  try {
    return SAFE_IMAGE_HOSTS.has(new URL(url).hostname.toLowerCase()) ? url : null;
  } catch {
    return null;
  }
}

function responsiveImageUrl(value: string, width: number): string {
  const url = new URL(value);
  if (url.hostname === 'images.unsplash.com') {
    url.searchParams.set('auto', 'format');
    url.searchParams.set('fit', 'max');
    url.searchParams.set('w', String(width));
    url.searchParams.set('q', '80');
  } else if (url.hostname === 'images.pexels.com') {
    url.searchParams.set('auto', 'compress');
    url.searchParams.set('cs', 'tinysrgb');
    url.searchParams.set('w', String(width));
  }
  return url.toString();
}

function imageSizes(className: string): string {
  if (className === 'hero-image') return '(max-width: 640px) calc(100vw - 40px), 48vw';
  if (className === 'menu-image') return '(max-width: 640px) 52px, 76px';
  if (className === 'gallery-image') return '(max-width: 640px) calc((100vw - 52px) / 2), 32vw';
  return '(max-width: 640px) calc(100vw - 40px), 60vw';
}

function imageWidths(className: string): number[] {
  if (className === 'menu-image') return [96, 192, 320];
  if (className === 'gallery-image') return [320, 640, 960, 1200];
  return [480, 768, 1200, 1800];
}

function responsiveImageAttributes(value: string, className: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (!SAFE_IMAGE_HOSTS.has(url.hostname.toLowerCase())) return '';
  const srcset = imageWidths(className)
    .map((width) => `${escapeHtml(responsiveImageUrl(value, width))} ${width}w`)
    .join(', ');
  return ` srcset="${srcset}" sizes="${imageSizes(className)}"`;
}

function safePexelsUrl(value: string | null): string | null {
  const url = safeExternalUrl(value);
  if (!url) return null;
  try {
    return ['pexels.com', 'www.pexels.com'].includes(new URL(url).hostname.toLowerCase()) ? url : null;
  } catch {
    return null;
  }
}

function safePixabayUrl(value: string | null): string | null {
  const url = safeExternalUrl(value);
  if (!url) return null;
  try {
    return ['pixabay.com', 'www.pixabay.com'].includes(new URL(url).hostname.toLowerCase()) ? url : null;
  } catch {
    return null;
  }
}

function safeUnsplashUrl(value: string | null): string | null {
  const url = safeExternalUrl(value);
  if (!url) return null;
  try {
    return ['unsplash.com', 'www.unsplash.com'].includes(new URL(url).hostname.toLowerCase()) ? url : null;
  } catch {
    return null;
  }
}

function sectionId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
}

function pagePath(slug: string): string {
  return slug === 'home' ? '/' : `/${slug}/`;
}

function createAssetLookup(assets: WebsiteStaticImageAsset[]) {
  return new Map(assets.map((asset) => [asset.id, asset]));
}

function imageSource(asset: WebsiteStaticImageAsset, files: Map<string, WebsiteStaticFile>): string | null {
  if (asset.source === 'pexels' || asset.source === 'unsplash') {
    const remoteUrl = safeImageUrl(asset.remoteUrl);
    if (!remoteUrl) throw new Error(`Website image "${asset.id}" has an unsupported stock-photo URL.`);
    return remoteUrl;
  }
  if (
    !['pixabay', 'user_upload', 'imagen_generated', 'gemini_generated'].includes(asset.source)
    || asset.mimeType !== 'image/jpeg'
    || !asset.bytes?.byteLength
    || !/^[A-Za-z0-9_-]{1,80}$/.test(asset.id)
  ) throw new Error(`Uploaded website image "${asset.id}" is invalid for publishing.`);
  const path = `assets/images/${asset.id}.jpg`;
  files.set(path, {
    body: asset.bytes,
    contentType: 'image/jpeg',
    cacheControl: 'public, max-age=31536000, immutable',
  });
  return `/${path}`;
}

function renderPhotoCredit(asset: WebsiteStaticImageAsset): string {
  if (!['pexels', 'pixabay', 'unsplash'].includes(asset.source) || !asset.creatorName) return '';
  const safeProviderUrl = asset.source === 'pixabay'
    ? safePixabayUrl
    : asset.source === 'unsplash' ? safeUnsplashUrl : safePexelsUrl;
  const profile = safeProviderUrl(asset.creatorProfileUrl);
  const photoPage = safeProviderUrl(asset.sourcePageUrl);
  const creator = profile
    ? `<a href="${escapeHtml(profile)}" target="_blank" rel="noopener noreferrer">${escapeHtml(asset.creatorName)}</a>`
    : escapeHtml(asset.creatorName);
  const provider = photoPage
    ? `<a href="${escapeHtml(photoPage)}" target="_blank" rel="noopener noreferrer">${asset.source === 'pixabay' ? 'Pixabay' : 'Pexels'}</a>`
    : asset.source === 'pixabay' ? 'Pixabay' : asset.source === 'unsplash' ? 'Unsplash' : 'Pexels';
  return `<small class="photo-credit">Photo by ${creator} on ${provider}</small>`;
}

function renderImage(asset: WebsiteStaticImageAsset | undefined, files: Map<string, WebsiteStaticFile>, className: string, fallbackAlt: string): string {
  if (!asset) return '';
  const src = imageSource(asset, files);
  if (!src) return '';
  const srcset = responsiveImageAttributes(src, className);
  const priority = className === 'hero-image' ? ' loading="eager" fetchpriority="high"' : ' loading="lazy"';
  return `<figure class="asset-figure"><img class="${className}" src="${escapeHtml(src)}"${srcset} alt="${escapeHtml(asset.alt || fallbackAlt)}"${priority} decoding="async">${renderPhotoCredit(asset)}</figure>`;
}

function getSlotAsset(
  assetsById: Map<string, WebsiteStaticImageAsset>,
  slots: WebsiteImageSlot[],
  slotId: string | null,
): WebsiteStaticImageAsset | undefined {
  const slot = slotId ? slots.find((candidate) => candidate.id === slotId) : undefined;
  return slot?.assetId ? assetsById.get(slot.assetId) : undefined;
}

interface HeroAction {
  label: string;
  href: string;
}

function getHeroAction(content: WebsiteContent): HeroAction | null {
  const home = content.pages[0];
  if (!home) return null;
  const supported = (type: WebsiteSection['type']) => content.pages
    .flatMap((page) => page.sections.map((section) => ({ page, section })))
    .find(({ section }) => section.type === type);
  const linkTo = (target: NonNullable<ReturnType<typeof supported>>, label: string): HeroAction => ({
    label,
    href: `${pagePath(target.page.slug)}#${sectionId(target.section.title)}`,
  });
  const whatsAppNumber = content.contact.whatsappNumber.replace(/[^0-9]/g, '');
  if (content.contact.bookingUrl) return { label: 'Book or enquire', href: content.contact.bookingUrl };
  if (content.type === 'restaurant') {
    const menu = supported('menu');
    if (menu && content.menuCategories.some((category) => category.items.some((item) => item.available))) {
      return linkTo(menu, 'View the menu');
    }
    if (whatsAppNumber && supported('whatsapp')) return { label: 'Chat on WhatsApp', href: `https://wa.me/${whatsAppNumber}` };
  }
  if (content.type === 'portfolio') {
    const work = supported('gallery') ?? supported('services') ?? supported('about');
    if (work) return linkTo(work, work.section.type === 'gallery' ? 'View our work' : 'Explore our work');
  }
  const services = supported('services');
  if (services) return linkTo(services, content.type === 'professional' ? 'Explore our services' : 'See what we offer');
  if (whatsAppNumber && supported('whatsapp')) return { label: 'Chat on WhatsApp', href: `https://wa.me/${whatsAppNumber}` };
  const contact = supported('contact');
  if (contact && (content.contact.phone || content.contact.address || content.contact.email || content.contact.whatsappNumber)) return linkTo(contact, 'Contact us');
  const menu = supported('menu');
  if (menu && content.menuCategories.some((category) => category.items.some((item) => item.available))) return linkTo(menu, 'View the menu');
  const gallery = supported('gallery');
  if (gallery) return linkTo(gallery, 'Explore our work');
  const about = supported('about');
  return about ? linkTo(about, 'Learn more') : null;
}

function renderMenu(content: WebsiteContent, assetsById: Map<string, WebsiteStaticImageAsset>, files: Map<string, WebsiteStaticFile>): string {
  const linkedMenuSlotIds = new Set(content.menuCategories.flatMap((category) => category.items.map((item) => item.imageSlotId).filter((id): id is string => Boolean(id))));
  const unlinkedImages = content.imageSlots
    .filter((slot) => slot.role === 'menu_item' && slot.assetId && !linkedMenuSlotIds.has(slot.id))
    .map((slot) => renderImage(assetsById.get(slot.assetId!), files, 'menu-feature-image', slot.alt))
    .join('');
  if (!content.menuCategories.some((category) => category.items.some((item) => item.available))) {
    return unlinkedImages ? `<div class="menu-feature-grid">${unlinkedImages}</div>` : '';
  }
  const activeCategories = content.menuCategories
    .map((category) => ({ ...category, items: category.items.filter((item) => item.available) }))
    .filter((category) => category.items.length > 0);
  const categoryNavigation = activeCategories.length > 1
    ? `<nav class="menu-nav" aria-label="Menu categories">${activeCategories.map((category, index) => `<a href="#menu-${sectionId(category.name)}-${index + 1}">${escapeHtml(category.name)}</a>`).join('')}</nav>`
    : '';
  const categories = activeCategories.map((category, index) => {
    const items = category.items;
    return `<div class="menu-category" id="menu-${sectionId(category.name)}-${index + 1}"><h3>${escapeHtml(category.name)}</h3>${items.map((item) => {
      const asset = getSlotAsset(assetsById, content.imageSlots, item.imageSlotId);
      const image = renderImage(asset, files, 'menu-image', item.name);
      return `<article class="menu-item${image ? ' has-image' : ''}">${image}<div class="menu-copy"><h4>${escapeHtml(item.name)}</h4><p>${escapeHtml(item.description)}</p></div><strong class="price">${escapeHtml(item.currency)} ${escapeHtml(item.price)}</strong></article>`;
    }).join('')}</div>`;
  }).join('');
  return `${categoryNavigation}<div class="menu-categories">${categories}</div>${unlinkedImages ? `<div class="menu-feature-grid">${unlinkedImages}</div>` : ''}`;
}

function renderGallery(content: WebsiteContent, assetsById: Map<string, WebsiteStaticImageAsset>, files: Map<string, WebsiteStaticFile>): string {
  const slotImages = content.imageSlots
    .filter((slot) => slot.role === 'gallery' && slot.assetId)
    .map((slot) => renderImage(assetsById.get(slot.assetId!), files, 'gallery-image', slot.alt))
    .join('');
  const legacyImages = content.galleryImageUrls.map((url) => {
    const safeUrl = safeImageUrl(url);
    return safeUrl ? `<img class="gallery-image" src="${escapeHtml(safeUrl)}"${responsiveImageAttributes(safeUrl, 'gallery-image')} alt="" loading="lazy" decoding="async">` : '';
  }).join('');
  const images = slotImages || legacyImages;
  return images ? `<div class="gallery">${images}</div>` : '';
}

function renderContactDetails(content: WebsiteContent, includeLocation: boolean): string {
  const { contact } = content;
  const hasServicesSection = content.pages.some((page) => page.sections.some((section) => section.type === 'services' || section.type === 'menu'));
  const whatsappNumber = contact.whatsappNumber.replace(/[^0-9]/g, '');
  const details = [
    contact.phone ? `<p class="trust-item"><strong>Phone:</strong> <a href="tel:${escapeHtml(contact.phone)}">${escapeHtml(contact.phone)}</a></p>` : '',
    contact.email ? `<p class="trust-item"><strong>Email:</strong> <a href="mailto:${escapeHtml(contact.email)}">${escapeHtml(contact.email)}</a></p>` : '',
    whatsappNumber ? `<p class="trust-item"><strong>WhatsApp:</strong> <a href="https://wa.me/${whatsappNumber}">${escapeHtml(contact.whatsappNumber)}</a></p>` : '',
    contact.bookingUrl ? `<p class="trust-item"><a class="button" href="${escapeHtml(contact.bookingUrl)}" target="_blank" rel="noopener noreferrer">Book or enquire</a></p>` : '',
    includeLocation && contact.address ? `<p class="trust-item"><strong>Address:</strong> ${escapeHtml(contact.address)}</p>` : '',
    includeLocation && contact.serviceArea ? `<p class="trust-item"><strong>Service area:</strong> ${escapeHtml(contact.serviceArea)}</p>` : '',
    includeLocation && contact.openingHours ? `<p class="trust-copy"><strong>Opening hours</strong><br>${escapeHtml(contact.openingHours).replace(/\n/g, '<br>')}</p>` : '',
    !hasServicesSection
      && contact.servicesAndPricing
      ? `<div class="trust-copy"><h3>Services and pricing</h3><p>${escapeHtml(contact.servicesAndPricing).replace(/\n/g, '<br>')}</p></div>`
      : '',
    contact.testimonials ? `<blockquote class="trust-quote">${escapeHtml(contact.testimonials).replace(/\n/g, '<br>')}</blockquote>` : '',
  ].filter(Boolean);
  return details.length ? `<div class="trust-details">${details.join('')}</div>` : '';
}

function renderSection(
  content: WebsiteContent,
  section: WebsiteSection,
  assetsById: Map<string, WebsiteStaticImageAsset>,
  files: Map<string, WebsiteStaticFile>,
  primaryHeading = false,
): string {
  const id = sectionId(section.title);
  const title = `<${primaryHeading ? 'h1' : 'h2'}>${escapeHtml(section.title)}</${primaryHeading ? 'h1' : 'h2'}>`;
  const body = section.body ? `<p>${escapeHtml(section.body)}</p>` : '';
  if (section.type === 'menu') {
    const menuContent = renderMenu(content, assetsById, files);
    const servicesAndPricing = content.contact.servicesAndPricing
      ? `<div class="trust-copy"><h3>More services and pricing</h3><p>${escapeHtml(content.contact.servicesAndPricing).replace(/\n/g, '<br>')}</p></div>`
      : '';
    if (!body && !menuContent && !servicesAndPricing) return '';
    return `<section class="section menu-section" id="${id}">${title}${body}${menuContent}${servicesAndPricing}</section>`;
  }
  if (section.type === 'gallery') {
    return `<section class="section" id="${id}">${title}${body}${renderGallery(content, assetsById, files)}</section>`;
  }
  if (section.type === 'whatsapp') {
    const phone = content.contact.whatsappNumber.replace(/[^0-9]/g, '');
    if (!phone && !body) return '';
    return `<section class="section whatsapp" id="${id}">${title}${body}${phone ? `<a class="button" href="https://wa.me/${phone}">Chat on WhatsApp</a>` : ''}</section>`;
  }
  if (section.type === 'location') {
    const mapsUrl = safeExternalUrl(content.contact.mapsUrl)
      ?? (content.contact.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(content.contact.address)}` : null);
    const locationDetails = [
      content.contact.address ? `<p class="trust-item"><strong>Address:</strong> ${escapeHtml(content.contact.address)}</p>` : '',
      content.contact.serviceArea ? `<p class="trust-item"><strong>Service area:</strong> ${escapeHtml(content.contact.serviceArea)}</p>` : '',
      content.contact.openingHours ? `<p class="trust-copy"><strong>Opening hours</strong><br>${escapeHtml(content.contact.openingHours).replace(/\n/g, '<br>')}</p>` : '',
    ].filter(Boolean).join('');
    if (!body && !locationDetails && !mapsUrl) return '';
    return `<section class="section" id="${id}">${title}${body}${locationDetails ? `<div class="trust-details">${locationDetails}</div>` : ''}${mapsUrl ? `<a class="button" href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener noreferrer">Get directions</a>` : ''}</section>`;
  }
  if (section.type === 'contact') {
    const hasLocation = content.pages.some((page) => page.sections.some((item) => item.type === 'location'));
    const details = renderContactDetails(content, !hasLocation);
    const mapsUrl = !hasLocation
      ? safeExternalUrl(content.contact.mapsUrl)
        ?? (content.contact.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(content.contact.address)}` : null)
      : null;
    if (!body && !details && !mapsUrl) return '';
    return `<section class="section" id="${id}">${title}${body}${details}${mapsUrl ? `<a class="button" href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener noreferrer">Get directions</a>` : ''}</section>`;
  }
  const hero = section.type === 'hero';
  const image = section.imageSlotId
    ? renderImage(getSlotAsset(assetsById, content.imageSlots, section.imageSlotId), files, hero ? 'hero-image' : 'section-image', section.title)
    : '';
  const servicesAndPricing = section.type === 'services' && content.contact.servicesAndPricing
    ? `<div class="trust-copy"><h3>Services and pricing</h3><p>${escapeHtml(content.contact.servicesAndPricing).replace(/\n/g, '<br>')}</p></div>`
    : '';
  const copy = `<div class="section-copy">${hero ? `<p class="eyebrow">${escapeHtml(content.type)}</p>` : ''}${title}${body}${servicesAndPricing}</div>`;
  const heroImageClass = hero
    ? image
      ? section.layoutVariant && section.layoutVariant !== 'cinematic' ? ' hero-image-inline' : ' hero-image-background'
      : ' hero-no-image'
    : '';
  const heroLayoutClass = hero && section.layoutVariant ? ` hero-layout-${section.layoutVariant}` : '';
  const heroClass = hero ? ` hero${heroImageClass}${heroLayoutClass}` : '';
  const heroStyle = hero && !image ? ' style="grid-template-columns:minmax(0,1fr)"' : '';
  const action = hero && content.pages[0]?.sections.some((candidate) => candidate.id === section.id)
    ? getHeroAction(content)
    : null;
  const actionMarkup = action
    ? `<a class="button hero-action" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`
    : '';
  const heroCopy = hero && actionMarkup ? copy.replace('</div>', `${actionMarkup}</div>`) : copy;
  return `<section class="section${heroClass}"${heroStyle} id="${id}">${heroCopy}${image}</section>`;
}

function renderPage(
  content: WebsiteContent,
  pageIndex: number,
  assetsById: Map<string, WebsiteStaticImageAsset>,
  files: Map<string, WebsiteStaticFile>,
): string {
  const page = content.pages[pageIndex];
  const navigation = content.pages.map((item) => `<a href="${escapeHtml(pagePath(item.slug))}">${escapeHtml(item.title)}</a>`).join('');
  const heroIndex = page.sections.findIndex((section) => section.type === 'hero');
  const primaryHeadingIndex = heroIndex >= 0 ? heroIndex : 0;
  const sections = page.sections.map((section, index) => renderSection(content, section, assetsById, files, index === primaryHeadingIndex)).join('');
  const placedSectionSlotIds = new Set(content.pages.flatMap((candidate) => candidate.sections
    .filter((section) => section.type === 'about' || section.type === 'services')
    .map((section) => section.imageSlotId)
    .filter((slotId): slotId is string => Boolean(slotId))));
  const supplementalSections = pageIndex === 0
    ? [
        content.imageSlots.some((slot) => slot.role === 'hero' && slot.assetId)
          && !content.pages.some((candidate) => candidate.sections.some((section) => section.type === 'hero'))
          ? content.imageSlots.filter((slot) => slot.role === 'hero' && slot.assetId).map((slot) => {
              const image = renderImage(assetsById.get(slot.assetId!), files, 'hero-image', slot.alt);
              const heroClass = image ? 'section hero hero-image-background' : 'section hero hero-no-image';
              const heroStyle = image ? '' : ' style="grid-template-columns:minmax(0,1fr)"';
              const action = getHeroAction(content);
              const actionMarkup = action
                ? `<a class="button hero-action" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`
                : '';
              return `<section class="${heroClass}"${heroStyle}><div class="section-copy"><p class="eyebrow">${escapeHtml(content.type)}</p><h1>${escapeHtml(content.title)}</h1><p>${escapeHtml(content.description)}</p>${actionMarkup}</div>${image}</section>`;
            }).join('')
          : '',
        content.imageSlots.some((slot) => slot.role === 'section' && slot.assetId && !placedSectionSlotIds.has(slot.id))
          ? `<section class="section"><h2>More photos</h2><div class="menu-feature-grid">${content.imageSlots.filter((slot) => slot.role === 'section' && slot.assetId && !placedSectionSlotIds.has(slot.id)).map((slot) => renderImage(assetsById.get(slot.assetId!), files, 'section-image', slot.alt)).join('')}</div></section>`
          : '',
        !content.pages.some((candidate) => candidate.sections.some((section) => section.type === 'menu'))
          && (content.menuCategories.length > 0 || content.imageSlots.some((slot) => slot.role === 'menu_item' && slot.assetId))
          ? `<section class="section menu-section" id="menu"><h2>Menu</h2>${renderMenu(content, assetsById, files)}</section>`
          : '',
        !content.pages.some((candidate) => candidate.sections.some((section) => section.type === 'gallery'))
          && (content.galleryImageUrls.length > 0 || content.imageSlots.some((slot) => slot.role === 'gallery' && slot.assetId))
          ? `<section class="section" id="gallery"><h2>Gallery</h2>${renderGallery(content, assetsById, files)}</section>`
          : '',
        !content.pages.some((candidate) => candidate.sections.some((section) => section.type === 'contact'))
          && Object.values(content.contact).some(Boolean)
          ? renderSection(content, { id: 'contact', type: 'contact', title: 'Contact', body: '', imageSlotId: null }, assetsById, files)
          : '',
      ].join('')
    : '';
  const mainContent = sections + supplementalSections;
  const accessibleMainContent = mainContent.includes('<h1>')
    ? mainContent
    : `<h1 class="visually-hidden">${escapeHtml(page.title || content.title)}</h1>${mainContent}`;
  const socialLinks = Object.entries(content.socialLinks)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([network, url]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(network[0].toUpperCase() + network.slice(1))}</a>`)
    .join(' · ');
  const brand = escapeHtml(content.title);
  const pageTitle = pageIndex === 0 && content.seo.title
    ? content.seo.title
    : `${page.title} | ${content.title}`;
  const pageDescription = pageIndex === 0 && content.seo.description
    ? content.seo.description
    : page.sections.map((section) => section.body).filter(Boolean).join(' ').slice(0, 320) || content.description;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="robots" content="index,follow">
<meta name="description" content="${escapeHtml(pageDescription)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(pageTitle)}">
<meta property="og:description" content="${escapeHtml(pageDescription)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtml(pageTitle)}">
<meta name="twitter:description" content="${escapeHtml(pageDescription)}">
<title>${escapeHtml(pageTitle)}</title>
<link rel="stylesheet" href="/assets/site.css">
</head>
<body class="preset-${escapeHtml(content.designPreset)}">
<header class="topbar"><a class="brand" href="/">${brand}</a><nav aria-label="Page navigation">${navigation}</nav></header>
<main>${accessibleMainContent}</main>
<footer class="footer">${brand} · Published with Mento${socialLinks ? `<nav aria-label="Social links">${socialLinks}</nav>` : ''}</footer>
</body>
</html>`;
}

function validateGeneratedSite(files: Map<string, WebsiteStaticFile>): void {
  for (const [filePath, file] of files) {
    if (!filePath.endsWith('.html') || typeof file.body !== 'string') continue;
    const html = file.body;
    if (!/<title>[^<]+<\/title>/.test(html) || !/<meta name="description" content="[^"]+"/.test(html) || !/<h1(?:\s|>)/.test(html)) {
      throw new Error(`Generated website page "${filePath}" is missing required SEO metadata or a primary heading.`);
    }
    const links = [...html.matchAll(/\bhref="([^"]+)"/g)].map((match) => match[1]);
    const sources = [...html.matchAll(/\bsrc="([^"]+)"/g)].map((match) => match[1]);
    for (const reference of [...links, ...sources]) {
      if (!reference.startsWith('/') && !reference.startsWith('#')) continue;
      const [pathAndQuery, rawHash] = reference.split('#', 2);
      const pathname = pathAndQuery.split('?', 1)[0];
      const normalizedPath = pathname.replace(/^\/+|\/+$/g, '');
      const destination = !normalizedPath
        ? 'index.html'
        : pathname.endsWith('/') ? `${normalizedPath}/index.html` : normalizedPath;
      if (!files.has(destination)) {
        throw new Error(`Generated website contains a broken internal link or image: "${reference}".`);
      }
      if (rawHash) {
        let hash: string;
        try {
          hash = decodeURIComponent(rawHash);
        } catch {
          throw new Error(`Generated website contains an invalid internal link fragment: "${reference}".`);
        }
        const target = files.get(destination)?.body;
        if (typeof target !== 'string' || !new Set([...target.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])).has(hash)) {
          throw new Error(`Generated website contains a broken internal link fragment: "${reference}".`);
        }
      }
    }
  }
}

export function buildWebsiteStaticFiles(
  input: unknown,
  websiteId: string,
  deploymentId: string,
  assets: WebsiteStaticImageAsset[] = [],
): { files: Map<string, WebsiteStaticFile> } {
  const content = normalizeWebsiteContent(input);
  if (!content) throw new Error('Website content is not valid for static publishing.');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(websiteId) || !/^[A-Za-z0-9_-]{1,80}$/.test(deploymentId)) {
    throw new Error('Website deployment identifiers are invalid.');
  }
  for (const slot of content.imageSlots) {
    if (slot.assetId && !assets.some((asset) => asset.id === slot.assetId && asset.slotId === slot.id)) {
      throw new Error(`Website image asset for slot "${slot.id}" is missing; publishing cannot continue.`);
    }
  }

  const files = new Map<string, WebsiteStaticFile>();
  const assetsById = createAssetLookup(assets);
  files.set('assets/site.css', {
    body: `:root{--accent:${content.theme.primaryColor};--ink:#222620;--muted:#666b64;--paper:#fbfaf7;--line:#e8e5dc;--display:Georgia,'Times New Roman',serif;--body:Arial,sans-serif;color:var(--ink);background:var(--paper)}*{box-sizing:border-box}body{margin:0;background:var(--paper);font-family:var(--body)}body.preset-trustworthy-professional,body.preset-modern-business{--display:Arial,sans-serif;--body:Arial,sans-serif;--paper:#fff}body.preset-creative-portfolio{--paper:#f4f2ed;--line:#d8d5ce}body.preset-local-service{--paper:#f7f9f7}a{color:inherit;text-decoration:none}.topbar{min-height:68px;padding:0 7vw;display:flex;align-items:center;gap:28px;border-bottom:1px solid var(--line);font:600 14px var(--body)}.brand{font-size:18px;font-weight:700;margin-right:auto;color:var(--accent);max-width:35vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.topbar nav{display:flex;gap:22px;overflow:hidden}.topbar nav a{white-space:nowrap}.section{padding:52px max(7vw,24px);border-bottom:1px solid var(--line)}.hero{padding-top:86px;padding-bottom:82px;background:#f1eee7;display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,.8fr);align-items:center;gap:38px}.section-copy{min-width:0}.eyebrow{font:700 11px var(--body);text-transform:uppercase;letter-spacing:1px;color:var(--accent)}h2{font:700 32px/1.15 var(--display);margin:0 0 12px}.section p{max-width:680px;color:var(--muted);font:16px/1.7 var(--body)}.hero p:not(.eyebrow){font-size:18px}.menu-category{max-width:780px}.menu-item{min-height:88px;padding:14px 0;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:16px;font-family:var(--body)}.menu-copy{flex:1}.menu-copy p{font-size:13px;margin:0}.price{color:var(--accent);white-space:nowrap}.asset-figure{margin:0}.menu-image{width:60px;height:60px;border-radius:8px;object-fit:cover}.hero-image{width:100%;aspect-ratio:4/3;max-height:460px;object-fit:cover;border-radius:5px}.section-image{width:min(100%,580px);aspect-ratio:16/9;max-height:360px;object-fit:cover;border-radius:5px;margin-top:18px}.menu-feature-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:16px}.menu-feature-image{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:5px}.gallery{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.gallery-image{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:5px}.photo-credit{display:block;color:var(--muted);font:10px/1.4 var(--body);margin-top:4px}.photo-credit a,.footer a{text-decoration:underline;text-underline-offset:2px}.button{display:inline-flex;padding:13px 18px;border-radius:5px;background:var(--accent);color:white;font:700 14px var(--body)}.whatsapp{background:#f3f5ef}.muted{color:var(--muted);font:14px var(--body)}.footer{padding:28px 7vw;background:#eae8e0;font:13px var(--body);color:var(--muted)}.footer nav{margin-top:10px;display:flex;gap:16px}.menu-section,.gallery{scroll-margin-top:16px}body.preset-coastal-editorial .hero{background:#f4eee5}body.preset-trustworthy-professional .hero{background:#f1f4f4}body.preset-creative-portfolio .hero{grid-template-columns:minmax(0,1fr) minmax(340px,1fr);background:#e9e6df}body.preset-local-service .hero{background:#eef3ee}body.preset-modern-business .hero{background:#f0f3f4}@media(max-width:640px){.topbar{height:58px;padding:0 20px}.topbar nav{display:none}.brand{max-width:80vw}.section{padding:38px 22px}.hero{padding-top:60px;padding-bottom:58px;grid-template-columns:1fr;gap:22px}h2{font-size:27px}.gallery{grid-template-columns:repeat(2,minmax(0,1fr))}.menu-item{gap:10px}.menu-image{width:48px;height:48px}.price{font-size:13px}}`,
    contentType: 'text/css; charset=utf-8',
    cacheControl: 'public, max-age=31536000, immutable',
  });
  const stylesheet = files.get('assets/site.css');
  if (!stylesheet || typeof stylesheet.body !== 'string') {
    throw new Error('Generated website stylesheet is unavailable.');
  }
  stylesheet.body += '.menu-nav{display:flex;gap:8px;overflow-x:auto;padding:0 0 12px;scrollbar-width:thin}.menu-nav a{flex:0 0 auto;padding:8px 12px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:13px;font-weight:600;white-space:nowrap}.menu-category{scroll-margin-top:16px}' + buildWebsitePaletteCss(content) + websiteTypographyCss + websitePhoneCss + websiteBackgroundCss + websiteEditorialCss + websiteHeroLayoutCss;

  content.pages.forEach((page, index) => {
    const path = page.slug === 'home' ? 'index.html' : `${page.slug}/index.html`;
    files.set(path, {
      body: renderPage(content, index, assetsById, files),
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-store',
    });
  });

  validateGeneratedSite(files);
  return { files };
}
