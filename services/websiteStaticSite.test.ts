import { describe, expect, it } from 'vitest';
import { buildWebsiteStaticFiles } from './websiteStaticSite';

const content = {
  type: 'business',
  title: 'Example <Company>',
  description: 'A safe <description>',
  theme: { primaryColor: '#123456' },
  pages: [
    { title: 'Home', slug: 'home', sections: [{ type: 'hero', title: 'Welcome', body: '<script>alert(1)</script>' }] },
    { title: 'About', slug: 'about', sections: [{ type: 'about', title: 'Our story', body: 'Built locally.' }] },
  ],
  menuCategories: [],
  imageSlots: [],
  galleryImageUrls: ['https://images.pexels.com/example.jpg'],
  contact: { address: '', phone: '', whatsappNumber: '' },
};

describe('website static deployment bundler', () => {
  it('builds a root page, routes additional pages, and a cacheable stylesheet', () => {
    const { files } = buildWebsiteStaticFiles(content, 'website-1', 'deployment-1');

    expect([...files.keys()]).toEqual(['assets/site.css', 'index.html', 'about/index.html']);
    expect(files.get('index.html')?.contentType).toBe('text/html; charset=utf-8');
    expect(files.get('about/index.html')?.body).toContain('Our story');
    expect(files.get('assets/site.css')?.cacheControl).toContain('immutable');
  });

  it('escapes generated text and only emits validated image URLs', () => {
    const { files } = buildWebsiteStaticFiles(content, 'website-1', 'deployment-1');
    const html = files.get('index.html')!.body;

    expect(html).toContain('Example &lt;Company&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('https://images.pexels.com/example.jpg');
  });

  it('renders escaped SEO metadata, safe social links, and maps directions', () => {
    const { files } = buildWebsiteStaticFiles({
      ...content,
      seo: { title: 'Cafe <Mombasa>', description: 'Fresh food & good company.' },
      socialLinks: {
        instagram: 'https://www.instagram.com/example',
        facebook: 'javascript:alert(1)',
        tiktok: '',
      },
      contact: { address: 'Mombasa, Kenya', phone: '', whatsappNumber: '', mapsUrl: '' },
    }, 'website-1', 'deployment-1');
    const html = files.get('index.html')!.body;
    expect(html).toContain('<title>Cafe &lt;Mombasa&gt;</title>');
    expect(html).toContain('<meta property="og:description" content="Fresh food &amp; good company.">');
    expect(html).toContain('https://www.instagram.com/example');
    expect(html).toContain('https://www.google.com/maps/search/?api=1&amp;query=Mombasa%2C%20Kenya');
    expect(html).not.toContain('javascript:alert(1)');
  });

  it('rejects invalid website data and unsafe deployment identifiers', () => {
    expect(() => buildWebsiteStaticFiles({ title: '<script>' }, 'website-1', 'deployment-1')).toThrow(/not valid/);
    expect(() => buildWebsiteStaticFiles(content, '../website', 'deployment-1')).toThrow(/identifiers are invalid/);
  });
});
