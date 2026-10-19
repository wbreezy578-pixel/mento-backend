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
    const { files } = buildWebsiteStaticFiles({
      ...content,
      theme: {
        primaryColor: '#204060',
        secondaryColor: '#305040',
        backgroundColor: '#FAFAF8',
        surfaceColor: '#F0F1EE',
      },
    }, 'website-1', 'deployment-1');

    expect([...files.keys()]).toEqual(['assets/site.css', 'index.html', 'about/index.html']);
    expect(files.get('index.html')?.contentType).toBe('text/html; charset=utf-8');
    const homeHtml = files.get('index.html')?.body as string;
    const aboutHtml = files.get('about/index.html')?.body as string;
    expect(aboutHtml).toContain('Our story');
    expect(aboutHtml).toContain('<title>About | Example &lt;Company&gt;</title>');
    expect(aboutHtml).toContain('<h1>Our story</h1>');
    expect(homeHtml).toContain('<a href="/about/">About</a>');
    expect(homeHtml).toContain('<h1>Welcome</h1>');
    expect(homeHtml).toContain('<meta name="description" content="A safe &lt;description&gt;">');
    expect(files.get('assets/site.css')?.cacheControl).toContain('immutable');
    const stylesheet = files.get('assets/site.css')?.body as string;
    expect(stylesheet).toContain('--space-8:4rem');
    expect(stylesheet).toContain('--text-h1:clamp');
    expect(stylesheet).toContain('h2{font-size:var(--text-h2)');
    expect(stylesheet).toContain('.hero h1,.hero h2{font-size:var(--text-h1)');
    expect(stylesheet).toContain('body{font-size:var(--text-body);line-height:1.65}');
    expect(stylesheet).toContain('--accent:#204060;--secondary:#305040;--paper:#FAFAF8;--surface:#F0F1EE');
    expect(stylesheet).toContain('.eyebrow,.price{color:var(--secondary)}');
    expect(stylesheet).toContain('.topbar nav{display:flex;order:2;width:100%;gap:var(--space-2);overflow-x:auto');
    expect(stylesheet).toContain('.topbar nav a{flex:0 0 auto;min-height:44px');
    expect(stylesheet).toContain('.topbar nav a:focus-visible{outline:2px solid var(--secondary)');
    expect(stylesheet).toContain('a:focus-visible{outline:3px solid var(--secondary)');
    expect(stylesheet).toContain('.button{min-height:48px;max-width:100%;white-space:normal');
    expect(stylesheet).toContain('.menu-item.has-image{grid-template-columns:52px minmax(0,1fr) auto}');
    expect(stylesheet).toContain('white-space:normal;min-width:0;text-align:right');
    expect(stylesheet).toContain('overflow-x:clip');
  });

  it('bundles generated Imagen assets into the published site without stock-photo credit', () => {
    const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const { files } = buildWebsiteStaticFiles({
      ...content,
      pages: [{
        title: 'Home',
        slug: 'home',
        sections: [{ type: 'hero', title: 'Welcome', body: 'A polished local business.', imageSlotId: 'imagen-slot' }],
      }],
      imageSlots: [{
        id: 'imagen-slot',
        role: 'hero',
        targetId: null,
        query: 'local business storefront',
        alt: 'Illustrative storefront at golden hour',
        assetId: 'imagen-asset',
      }],
    }, 'website-1', 'deployment-1', [{
      id: 'imagen-asset',
      slotId: 'imagen-slot',
      source: 'imagen_generated',
      remoteUrl: null,
      sourcePageUrl: null,
      creatorName: null,
      creatorProfileUrl: null,
      alt: 'Illustrative storefront at golden hour',
      mimeType: 'image/jpeg',
      bytes: imageBytes,
    }]);
    const html = files.get('index.html')!.body as string;

    expect(files.get('assets/images/imagen-asset.jpg')?.body).toEqual(imageBytes);
    expect(html).toContain('src="/assets/images/imagen-asset.jpg"');
    expect(html).toContain('alt="Illustrative storefront at golden hour"');
    expect(html).not.toContain('Photo by <a');
  });

  it('omits empty gallery placeholders and gives an image-free hero a single-column layout', () => {
    const { files } = buildWebsiteStaticFiles({
      ...content,
      pages: [{
        title: 'Home',
        slug: 'home',
        sections: [
          { id: 'hero', type: 'hero', title: 'Welcome', body: 'A clear introduction.' },
          { id: 'gallery', type: 'gallery', title: 'Our work', body: 'A little about our projects.' },
          { id: 'menu', type: 'menu', title: 'Menu', body: '' },
          { id: 'location', type: 'location', title: 'Find us', body: '' },
          { id: 'contact', type: 'contact', title: 'Contact', body: '' },
          { id: 'whatsapp', type: 'whatsapp', title: 'WhatsApp', body: '' },
        ],
      }],
      galleryImageUrls: [],
    }, 'website-1', 'deployment-1');
    const html = files.get('index.html')!.body as string;

    expect(html).not.toContain('Gallery images will appear here');
    expect(html).not.toContain('<div class="gallery"></div>');
    expect(html).not.toContain('Menu coming soon');
    expect(html).not.toContain('id="find-us"');
    expect(html).not.toContain('id="contact"');
    expect(html).not.toContain('id="whatsapp"');
    expect(html).toContain('class="section hero hero-no-image" style="grid-template-columns:minmax(0,1fr)"');
    expect(html).toContain('A little about our projects.');
  });

  it('renders supported hero layouts with assigned images and safe image-free fallbacks', () => {
    for (const layoutVariant of ['cinematic', 'split', 'centered-editorial'] as const) {
      const { files } = buildWebsiteStaticFiles({
        ...content,
        pages: [{
          title: 'Home',
          slug: 'home',
          sections: [{
            id: 'hero-section',
            type: 'hero',
            title: 'A clear introduction',
            body: 'Useful details for visitors.',
            imageSlotId: 'hero-slot',
            layoutVariant,
          }],
        }],
        imageSlots: [{
          id: 'hero-slot',
          role: 'hero',
          targetId: 'hero-section',
          query: 'business hero photo',
          alt: 'The business team',
          assetId: 'hero-asset',
        }],
      }, 'website-1', 'deployment-1', [{
        id: 'hero-asset',
        slotId: 'hero-slot',
        source: 'user_upload',
        remoteUrl: null,
        sourcePageUrl: null,
        creatorName: null,
        creatorProfileUrl: null,
        alt: 'The business team',
        mimeType: 'image/jpeg',
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      }]);
      const html = files.get('index.html')?.body as string;
      const imagePath = '/assets/images/hero-asset.jpg';

      expect(html).toContain(`hero-layout-${layoutVariant}`);
      expect(html).toContain(`src="${imagePath}"`);
      expect((html.match(new RegExp(imagePath, 'g')) ?? []).length).toBe(1);
      expect(html).toContain(layoutVariant === 'cinematic' ? 'hero-image-background' : 'hero-image-inline');

      const imageFree = buildWebsiteStaticFiles({
        ...content,
        pages: [{
          title: 'Home',
          slug: 'home',
          sections: [{
            id: 'hero-section',
            type: 'hero',
            title: 'A clear introduction',
            body: 'Useful details for visitors.',
            imageSlotId: null,
            layoutVariant,
          }],
        }],
        imageSlots: [],
      }, 'website-1', 'deployment-2');
      const imageFreeHtml = imageFree.files.get('index.html')?.body as string;
      expect(imageFreeHtml).toContain(`hero-no-image hero-layout-${layoutVariant}`);
      expect(imageFreeHtml).not.toContain('<figure class="asset-figure">');
    }
  });

  it('renders one supported restaurant action in the hero and links to the menu', () => {
    const restaurant = {
      ...content,
      type: 'restaurant',
      title: 'Coastline Kitchen',
      description: 'Fresh Swahili seafood prepared with local coastal ingredients.',
      pages: [{
        title: 'Home',
        slug: 'home',
        sections: [
          { id: 'hero', type: 'hero', title: 'Coastal seafood, made with care', body: 'Fresh Swahili seafood prepared with local coastal ingredients.' },
          { id: 'menu', type: 'menu', title: 'From our kitchen', body: 'A menu of local favorites.' },
        ],
      }],
      menuCategories: [{
        id: 'mains',
        name: 'Mains',
        items: [{ id: 'fish', name: 'Grilled fish', description: 'Fresh catch', price: '1200', currency: 'KSh', imageUrl: null, imageSlotId: null, available: true }],
      }],
    };
    const { files } = buildWebsiteStaticFiles(restaurant, 'website-1', 'deployment-1');
    const html = files.get('index.html')!.body as string;
    const hero = html.match(/<section class="section hero[^"]*"[^>]*>[\s\S]*?<\/section>/)?.[0] ?? '';

    expect(hero).toContain('<a class="button hero-action" href="/#from-our-kitchen">View the menu</a>');
    expect((hero.match(/class="button hero-action"/g) ?? [])).toHaveLength(1);
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

  it('publishes only owner-provided trust details with working contact and booking links', () => {
    const { files } = buildWebsiteStaticFiles({
      ...content,
      pages: [{
        title: 'Home',
        slug: 'home',
        sections: [
          { id: 'hero', type: 'hero', title: 'Seafood by the coast', body: 'Fresh coastal food.' },
          { id: 'location', type: 'location', title: 'Find us', body: '' },
          { id: 'contact', type: 'contact', title: 'Contact', body: '' },
        ],
      }],
      contact: {
        address: 'Mombasa, Kenya',
        phone: '+254 700 000 000',
        whatsappNumber: '+254 711 111 111',
        mapsUrl: 'https://maps.google.com/?q=Mombasa',
        email: 'hello@bella.example',
        openingHours: 'Monday-Friday: 9:00-17:00',
        serviceArea: 'Mombasa County',
        servicesAndPricing: 'Private events — KSh 2,500 per guest',
        testimonials: '“A lovely evening.” — A. Customer',
        bookingUrl: 'https://bella.example/book',
      },
    }, 'website-1', 'deployment-1');
    const html = files.get('index.html')!.body as string;

    expect(html).toContain('tel:+254 700 000 000');
    expect(html).toContain('mailto:hello@bella.example');
    expect(html).toContain('href="https://wa.me/254711111111"');
    expect(html).toContain('href="https://bella.example/book"');
    expect(html).toContain('class="button hero-action" href="https://bella.example/book">Book or enquire</a>');
    expect(html).toContain('Monday-Friday: 9:00-17:00');
    expect(html).toContain('Mombasa County');
    expect(html).toContain('Private events — KSh 2,500 per guest');
    expect(html).toContain('“A lovely evening.” — A. Customer');
    expect(html).not.toContain('Add a location to show directions');
    expect(html).not.toContain('Add contact details to this website');
    expect(html).not.toContain('Add a WhatsApp number to show this action');
  });

  it('renders selected image slots and bundles uploaded image bytes with Pexels credit', () => {
    const imageContent = {
      ...content,
      pages: [{
        title: 'Home',
        slug: 'home',
        sections: [
          { id: 'hero-section', type: 'hero', title: 'Welcome', body: 'A warm welcome', imageSlotId: 'hero-slot' },
          { id: 'menu-section', type: 'menu', title: 'Menu', body: '', imageSlotId: null },
          { id: 'gallery-section', type: 'gallery', title: 'Gallery', body: '', imageSlotId: 'gallery-slot' },
        ],
      }],
      imageSlots: [
        { id: 'hero-slot', role: 'hero', targetId: 'hero-section', query: 'restaurant', alt: 'Dining room', assetId: 'upload-1' },
        { id: 'menu-slot', role: 'menu_item', targetId: 'item-1', query: 'dish', alt: 'Local dish', assetId: 'pexels-1' },
        { id: 'gallery-slot', role: 'gallery', targetId: 'gallery-section', query: 'restaurant', alt: 'Dining room', assetId: null },
      ],
      menuCategories: [{
        id: 'category-1',
        name: 'Dinner',
        items: [{
          id: 'item-1',
          name: 'Local dish',
          description: 'Fresh and seasonal',
          price: '1200',
          currency: 'KSh',
          imageUrl: null,
          imageSlotId: 'menu-slot',
          available: true,
        }],
      }],
    };
    const { files } = buildWebsiteStaticFiles(imageContent, 'website-1', 'deployment-1', [
      {
        id: 'upload-1',
        slotId: 'hero-slot',
        source: 'user_upload',
        remoteUrl: null,
        sourcePageUrl: null,
        creatorName: null,
        creatorProfileUrl: null,
        alt: 'Dining room',
        mimeType: 'image/jpeg',
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      },
      {
        id: 'pexels-1',
        slotId: 'menu-slot',
        source: 'pexels',
        remoteUrl: 'https://images.pexels.com/photos/example.jpg',
        sourcePageUrl: 'https://www.pexels.com/photo/example',
        creatorName: 'Photographer',
        creatorProfileUrl: 'https://www.pexels.com/@photographer',
        alt: 'Local dish',
        mimeType: null,
      },
    ]);
    const html = files.get('index.html')!.body as string;

    expect(files.get('assets/images/upload-1.jpg')?.body).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    expect(html).toContain('src="/assets/images/upload-1.jpg"');
    expect(html).toContain('alt="Dining room" loading="eager" fetchpriority="high" decoding="async"');
    expect(html).toContain('src="https://images.pexels.com/photos/example.jpg"');
    expect(html).toContain('w=96');
    expect(html).toContain('sizes="(max-width: 640px) 52px, 76px"');
    expect(html).toContain('Photo by <a href="https://www.pexels.com/@photographer"');
    expect(html).toContain('on <a href="https://www.pexels.com/photo/example"');
  });

  it('bundles selected Pixabay images instead of hotlinking and renders creator credit', () => {
    const imageContent = {
      ...content,
      pages: [{
        title: 'Home',
        slug: 'home',
        sections: [
          { id: 'hero-section', type: 'hero', title: 'Welcome', body: 'A warm welcome', imageSlotId: 'hero-slot' },
        ],
      }],
      imageSlots: [
        { id: 'hero-slot', role: 'hero', targetId: 'hero-section', query: 'restaurant', alt: 'Dining room', assetId: 'pixabay-1' },
      ],
    };
    const { files } = buildWebsiteStaticFiles(imageContent, 'website-1', 'deployment-1', [{
      id: 'pixabay-1',
      slotId: 'hero-slot',
      source: 'pixabay',
      remoteUrl: null,
      sourcePageUrl: 'https://pixabay.com/photos/restaurant-123/',
      creatorName: 'Photo Creator',
      creatorProfileUrl: 'https://pixabay.com/users/photo-creator-42/',
      alt: 'Dining room',
      mimeType: 'image/jpeg',
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    }]);
    const html = files.get('index.html')!.body as string;

    expect(files.get('assets/images/pixabay-1.jpg')?.body).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    expect(html).toContain('src="/assets/images/pixabay-1.jpg"');
    expect(html).not.toContain('pixabay.com/get/');
    expect(html).toContain('Photo by <a href="https://pixabay.com/users/photo-creator-42/"');
    expect(html).toContain('on <a href="https://pixabay.com/photos/restaurant-123/"');
  });

  it('hotlinks verified Unsplash images and renders photographer attribution', () => {
    const imageContent = {
      ...content,
      pages: [{
        title: 'Home',
        slug: 'home',
        sections: [
          { id: 'hero-section', type: 'hero', title: 'Welcome', body: 'A warm welcome', imageSlotId: 'hero-slot' },
        ],
      }],
      imageSlots: [
        { id: 'hero-slot', role: 'hero', targetId: 'hero-section', query: 'restaurant', alt: 'Dining room', assetId: 'unsplash-1' },
      ],
    };
    const { files } = buildWebsiteStaticFiles(imageContent, 'website-1', 'deployment-1', [{
      id: 'unsplash-1',
      slotId: 'hero-slot',
      source: 'unsplash',
      remoteUrl: 'https://images.unsplash.com/photo-1?auto=format&ixid=demo',
      sourcePageUrl: 'https://unsplash.com/photos/photo-1?utm_source=mento&utm_medium=referral',
      creatorName: 'Photographer',
      creatorProfileUrl: 'https://unsplash.com/@photographer?utm_source=mento&utm_medium=referral',
      alt: 'Restaurant dining room',
      mimeType: 'image/jpeg',
    }]);
    const html = files.get('index.html')!.body as string;
    expect(html).toContain('src="https://images.unsplash.com/photo-1?auto=format&amp;ixid=demo"');
    expect(html).toContain('Photo by <a href="https://unsplash.com/@photographer?utm_source=mento&amp;utm_medium=referral"');
    expect(html).toContain('on <a href="https://unsplash.com/photos/photo-1?utm_source=mento&amp;utm_medium=referral"');
  });

  it('renders selected menu and section photos even when Gemini leaves them unattached', () => {
    const imageContent = {
      ...content,
      pages: [{
        title: 'Home',
        slug: 'home',
        sections: [
          { id: 'about-section', type: 'about', title: 'Our story', body: 'A local favorite.', imageSlotId: 'section-slot' },
          { id: 'menu-section', type: 'menu', title: 'Featured', body: '', imageSlotId: null },
        ],
      }],
      imageSlots: [
        { id: 'section-slot', role: 'section', targetId: 'about-section', query: 'restaurant interior', alt: 'Warm restaurant interior', assetId: 'section-image' },
        { id: 'menu-slot', role: 'menu_item', targetId: null, query: 'grilled fish', alt: 'Grilled fish', assetId: 'menu-image' },
      ],
    };
    const { files } = buildWebsiteStaticFiles(imageContent, 'website-1', 'deployment-1', [
      {
        id: 'section-image',
        slotId: 'section-slot',
        source: 'user_upload',
        remoteUrl: null,
        sourcePageUrl: null,
        creatorName: null,
        creatorProfileUrl: null,
        alt: 'Warm restaurant interior',
        mimeType: 'image/jpeg',
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      },
      {
        id: 'menu-image',
        slotId: 'menu-slot',
        source: 'user_upload',
        remoteUrl: null,
        sourcePageUrl: null,
        creatorName: null,
        creatorProfileUrl: null,
        alt: 'Grilled fish',
        mimeType: 'image/jpeg',
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      },
    ]);
    const html = files.get('index.html')!.body as string;

    expect(html).toContain('id="our-story"');
    expect(html).toContain('src="/assets/images/section-image.jpg"');
    expect(html).toContain('class="menu-feature-grid"');
    expect(html).toContain('src="/assets/images/menu-image.jpg"');
  });

  it('refuses to publish when content references an image missing from the asset records', () => {
    const imageContent = {
      ...content,
      pages: [{
        title: 'Home',
        slug: 'home',
        sections: [{ id: 'hero-section', type: 'hero', title: 'Welcome', body: 'A warm welcome', imageSlotId: 'hero-slot' }],
      }],
      imageSlots: [
        { id: 'hero-slot', role: 'hero', targetId: 'hero-section', query: 'restaurant', alt: 'Dining room', assetId: 'missing-asset' },
      ],
    };

    expect(() => buildWebsiteStaticFiles(imageContent, 'website-1', 'deployment-1')).toThrow(/asset.*missing/i);
  });

  it('rejects invalid website data and unsafe deployment identifiers', () => {
    expect(() => buildWebsiteStaticFiles({ title: '<script>' }, 'website-1', 'deployment-1')).toThrow(/not valid/);
    expect(() => buildWebsiteStaticFiles(content, '../website', 'deployment-1')).toThrow(/identifiers are invalid/);
  });
});
