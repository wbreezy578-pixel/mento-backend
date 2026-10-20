import { describe, expect, it } from 'vitest';
import { buildWebsiteStaticFiles } from './websiteStaticSite';
import { normalizeWebsiteContent } from './websiteContent';
import { defaultWebsiteDesignPreferences } from './websiteDesignPreferences';

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

const parityImages = [
  { slotId: 'hero-slot', assetId: 'hero-photo', url: 'https://images.unsplash.com/mento-parity/hero.jpg', alt: 'Sunlit dining room overlooking the Mombasa coast' },
  { slotId: 'fish-slot', assetId: 'fish-photo', url: 'https://images.unsplash.com/mento-parity/fish.jpg', alt: 'Swahili coconut fish with fresh herbs' },
  { slotId: 'karai-slot', assetId: 'karai-photo', url: 'https://images.unsplash.com/mento-parity/karai.jpg', alt: 'Golden viazi karai with tamarind dip' },
  { slotId: 'gallery-one-slot', assetId: 'gallery-one-photo', url: 'https://images.unsplash.com/mento-parity/gallery-one.jpg', alt: 'Guests sharing a coastal meal' },
  { slotId: 'gallery-two-slot', assetId: 'gallery-two-photo', url: 'https://images.unsplash.com/mento-parity/gallery-two.jpg', alt: 'Fresh ingredients from a Mombasa market' },
];

// Mirrored in the mobile renderer tests because the projects have independent test setups and image models.
function createParityContent(options: { heroImage?: boolean; heroLayout?: boolean } = {}) {
  const heroImage = options.heroImage ?? true;
  return {
    schemaVersion: 1,
    type: 'restaurant',
    title: 'Bahari Table',
    description: 'Swahili coastal cooking, made with fresh ingredients in the heart of Mombasa.',
    designPreset: 'coastal-editorial',
    theme: {
      primaryColor: '#A84D35',
      secondaryColor: '#526248',
      backgroundColor: '#FBF8F1',
      surfaceColor: '#F1E9DB',
    },
    pages: [
      {
        id: 'home-page',
        title: 'Home',
        slug: 'home',
        sections: [
          { id: 'hero-section', type: 'hero', title: 'Fresh from the Swahili Coast', body: 'Local seafood, fragrant spices, and a warm Mombasa welcome.', imageSlotId: heroImage ? 'hero-slot' : null, ...(options.heroLayout === false ? {} : { layoutVariant: 'split' }) },
          { id: 'about-section', type: 'about', title: 'Rooted in Mombasa', body: 'We bring coastal recipes and seasonal produce together around one welcoming table.', imageSlotId: null },
          { id: 'menu-section', type: 'menu', title: 'Our menu', body: 'A few favourites from our kitchen.', imageSlotId: null },
          { id: 'gallery-section', type: 'gallery', title: 'A taste of the coast', body: 'Good food is best shared.', imageSlotId: null },
          { id: 'contact-section', type: 'contact', title: 'Visit us', body: 'Find us in Old Town, Mombasa.', imageSlotId: null },
          { id: 'whatsapp-section', type: 'whatsapp', title: 'Chat with us', body: 'Message us to ask about today’s menu.', imageSlotId: null },
        ],
      },
      {
        id: 'story-page',
        title: 'Our Story',
        slug: 'our-story',
        sections: [
          { id: 'story-section', type: 'about', title: 'A table by the Indian Ocean', body: 'Family recipes, local ingredients, and generous hospitality.', imageSlotId: null },
        ],
      },
    ],
    menuCategories: [
      {
        id: 'mains-category',
        name: 'Mains',
        items: [
          { id: 'coconut-fish', name: 'Swahili Coconut Fish', description: 'Fresh catch simmered in coconut and lime.', price: '1450', currency: 'KSh', imageUrl: null, imageSlotId: 'fish-slot', available: true },
          { id: 'viazi-karai', name: 'Viazi Karai', description: 'Crisp spiced potatoes with tamarind dip.', price: '450', currency: 'KSh', imageUrl: null, imageSlotId: 'karai-slot', available: true },
        ],
      },
    ],
    imageSlots: [
      ...(heroImage ? [{ id: 'hero-slot', role: 'hero', targetId: 'hero-section', query: 'Mombasa coastal restaurant', alt: parityImages[0].alt, assetId: 'hero-photo' }] : []),
      { id: 'fish-slot', role: 'menu_item', targetId: 'coconut-fish', query: 'Swahili coconut fish', alt: parityImages[1].alt, assetId: 'fish-photo' },
      { id: 'karai-slot', role: 'menu_item', targetId: 'viazi-karai', query: 'viazi karai', alt: parityImages[2].alt, assetId: 'karai-photo' },
      { id: 'gallery-one-slot', role: 'gallery', targetId: 'gallery-section', query: 'coastal meal', alt: parityImages[3].alt, assetId: 'gallery-one-photo' },
      { id: 'gallery-two-slot', role: 'gallery', targetId: 'gallery-section', query: 'Mombasa market ingredients', alt: parityImages[4].alt, assetId: 'gallery-two-photo' },
    ],
    galleryImageUrls: [],
    contact: {
      address: 'Old Town, Mombasa, Kenya',
      phone: '+254 700 111 222',
      whatsappNumber: '+254 711 222 333',
      mapsUrl: '',
      email: 'hello@baharitable.example',
      openingHours: 'Tuesday-Sunday, 12:00-22:00',
      serviceArea: '',
      servicesAndPricing: '',
      testimonials: '',
      bookingUrl: '',
    },
    socialLinks: { instagram: '', facebook: '', tiktok: '' },
    seo: { title: 'Bahari Table | Mombasa', description: 'Swahili coastal cooking in Mombasa.' },
  };
}

function createParityStaticAssets(websiteContent: ReturnType<typeof createParityContent>) {
  return websiteContent.imageSlots.flatMap((slot) => {
    const image = parityImages.find((candidate) => candidate.slotId === slot.id);
    return image ? [{
      id: image.assetId,
      slotId: slot.id,
      source: 'unsplash' as const,
      remoteUrl: image.url,
      sourcePageUrl: null,
      creatorName: null,
      creatorProfileUrl: null,
      alt: image.alt,
      mimeType: 'image/jpeg',
    }] : [];
  });
}

describe('website static deployment bundler', () => {
  it('publishes the representative restaurant content, page links, and correctly assigned images', () => {
    const websiteContent = createParityContent();
    const normalized = normalizeWebsiteContent(websiteContent);
    expect(normalized).not.toBeNull();
    const { files } = buildWebsiteStaticFiles(normalized, 'website-parity', 'deployment-parity', createParityStaticAssets(websiteContent));
    const home = files.get('index.html')?.body as string;
    const story = files.get('our-story/index.html')?.body as string;
    const allHtml = [...files.entries()]
      .filter(([path]) => path.endsWith('.html'))
      .map(([, file]) => file.body as string)
      .join('\n');

    const orderedHeadings = [
      '<h1>Fresh from the Swahili Coast</h1>',
      '<h2>Rooted in Mombasa</h2>',
      '<h2>Our menu</h2>',
      '<h2>A taste of the coast</h2>',
      '<h2>Visit us</h2>',
      '<h2>Chat with us</h2>',
    ].map((heading) => home.indexOf(heading));
    expect(orderedHeadings.every((index) => index >= 0)).toBe(true);
    expect(orderedHeadings).toEqual([...orderedHeadings].sort((a, b) => a - b));
    expect(home).toContain('<title>Bahari Table | Mombasa</title>');
    expect(home).toContain('<a href="/our-story/">Our Story</a>');
    expect(home).toContain('<section class="section menu-section" id="our-menu">');
    expect(home).toContain('<section class="section whatsapp" id="chat-with-us">');
    expect(story).toContain('<title>Our Story | Bahari Table</title>');
    expect(story).toContain('A table by the Indian Ocean');
    expect(home).toContain('href="tel:+254 700 111 222"');
    expect(home).toContain('href="mailto:hello@baharitable.example"');
    expect(home).toContain('href="https://wa.me/254711222333"');
    expect(home).toContain('hero-layout-split');
    expect(home).toContain('hero-image-inline');

    for (const image of parityImages) {
      const src = `src="${image.url}"`;
      expect(allHtml.split(src)).toHaveLength(2);
      expect(allHtml).toContain(`alt="${image.alt}"`);
    }
    for (const [itemName, price, expectedUrl] of [
      ['Swahili Coconut Fish', 'KSh 1450', parityImages[1].url],
      ['Viazi Karai', 'KSh 450', parityImages[2].url],
    ]) {
      const item = [...home.matchAll(/<article class="menu-item[^"]*">[\s\S]*?<\/article>/g)]
        .map(([markup]) => markup)
        .find((markup) => markup.includes(itemName));
      expect(item).toContain(`src="${expectedUrl}"`);
      expect(item).toContain(price);
    }
    const gallery = home.match(/<div class="gallery">([\s\S]*?)<\/div>/)?.[1] ?? '';
    expect(gallery).toContain(`src="${parityImages[3].url}"`);
    expect(gallery).toContain(`src="${parityImages[4].url}"`);
  });

  it('keeps image-free and legacy no-layoutVariant hero content renderable', () => {
    for (const options of [{ heroImage: false }, { heroLayout: false }]) {
      const websiteContent = createParityContent(options);
      const { files } = buildWebsiteStaticFiles(
        normalizeWebsiteContent(websiteContent),
        'website-parity',
        'deployment-legacy',
        createParityStaticAssets(websiteContent),
      );
      const home = files.get('index.html')?.body as string;

      expect(home).toContain('<h1>Fresh from the Swahili Coast</h1>');
      expect(home).toContain('Local seafood, fragrant spices, and a warm Mombasa welcome.');
      if (options.heroImage === false) {
        expect(home).toContain('hero-no-image');
        expect(home).not.toContain('class="hero-image"');
      } else {
        expect(home).toContain('hero-image-background');
        expect(home).not.toContain('hero-layout-split');
        expect(home).toContain(`src="${parityImages[0].url}"`);
      }
    }
  });

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
    expect(stylesheet).toContain('body.preset-coastal-editorial .hero-image-background:before{position:absolute;z-index:1;inset:0');
    expect(stylesheet).toContain('body.preset-coastal-editorial .hero-image-background>.asset-figure{position:absolute;z-index:0;inset:0');
    expect(stylesheet).toContain('body.preset-coastal-editorial .hero-image-background .section-copy{position:relative;z-index:2');
    expect(stylesheet).toContain('body.preset-trustworthy-professional .hero-image-background,body.preset-local-service .hero-image-background');
    expect(stylesheet).toContain('body.preset-modern-business .hero.hero-no-image{background:radial-gradient');
    expect(stylesheet).toContain('body.preset-coastal-editorial .hero.hero-no-image{background:radial-gradient');
    expect(stylesheet).toContain('body.preset-trustworthy-professional .hero.hero-no-image{background:radial-gradient');
    expect(stylesheet).toContain('body.preset-local-service .hero.hero-no-image{background:radial-gradient');
    expect(stylesheet).toContain('body.preset-creative-portfolio .hero.hero-no-image{background:radial-gradient');
    expect(stylesheet).toContain('.page>.section:nth-of-type(even):not(.hero){background:linear-gradient');
    expect(stylesheet).toContain('.topbar{position:sticky;top:0;z-index:20;background:var(--paper)');
    expect(stylesheet).toContain('.menu-categories{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))');
    expect(stylesheet).toContain('.menu-category{max-width:none;padding:var(--space-5);border:1px solid var(--line);border-radius:16px;background:var(--surface)}');
  });

  it('bundles generated Gemini assets into the published site without stock-photo credit', () => {
    const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const { files } = buildWebsiteStaticFiles({
      ...content,
      pages: [{
        title: 'Home',
        slug: 'home',
        sections: [{ type: 'hero', title: 'Welcome', body: 'A polished local business.', imageSlotId: 'gemini-slot' }],
      }],
      imageSlots: [{
        id: 'gemini-slot',
        role: 'hero',
        targetId: null,
        query: 'local business storefront',
        alt: 'Illustrative storefront at golden hour',
        assetId: 'gemini-asset',
      }],
    }, 'website-1', 'deployment-1', [{
      id: 'gemini-asset',
      slotId: 'gemini-slot',
      source: 'gemini_generated',
      remoteUrl: null,
      sourcePageUrl: null,
      creatorName: null,
      creatorProfileUrl: null,
      alt: 'Illustrative storefront at golden hour',
      mimeType: 'image/jpeg',
      bytes: imageBytes,
    }]);
    const html = files.get('index.html')!.body as string;

    expect(files.get('assets/images/gemini-asset.jpg')?.body).toEqual(imageBytes);
    expect(html).toContain('src="/assets/images/gemini-asset.jpg"');
    expect(html).toContain('alt="Illustrative storefront at golden hour"');
    expect(html).toMatch(/class="section hero hero-image-background[^\"]*"/);
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
    expect(html).toMatch(/class="section hero hero-no-image[^\"]*" style="grid-template-columns:minmax\(0,1fr\)"/);
    expect(html).toContain('A little about our projects.');
  });

  it('renders all supported hero layouts with assigned images and safe image-free fallbacks', () => {
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

  it('publishes ordered menu sections with working category jump links and omits empty categories', () => {
    const restaurant = {
      ...content,
      type: 'restaurant',
      pages: [{
        title: 'Home',
        slug: 'home',
        sections: [{ id: 'menu', type: 'menu', title: 'Our menu', body: '' }],
      }],
      menuCategories: [
        { id: 'desserts', name: 'Desserts', items: [{ id: 'cake', name: 'Coconut cake', description: '', price: '450', currency: 'KSh', available: true }] },
        { id: 'empty', name: 'Empty section', items: [] },
        { id: 'food', name: 'Food', items: [{ id: 'pilau', name: 'Pilau', description: '', price: '650', currency: 'KSh', available: true }] },
      ],
    };
    const { files } = buildWebsiteStaticFiles(restaurant, 'website-1', 'deployment-1');
    const html = files.get('index.html')!.body as string;

    expect(html).toContain('<nav class="menu-nav" aria-label="Menu categories"><a href="#menu-desserts-1">Desserts</a><a href="#menu-food-2">Food</a></nav>');
    expect(html).toContain('<div class="menu-category" id="menu-desserts-1">');
    expect(html).toContain('<div class="menu-category" id="menu-food-2">');
    expect(html).toContain('<div class="menu-categories"><div class="menu-category" id="menu-desserts-1">');
    expect(html.indexOf('id="menu-desserts-1"')).toBeLessThan(html.indexOf('id="menu-food-2"'));
    expect(html).not.toContain('Empty section');
    expect(files.get('assets/site.css')?.body).toContain('.menu-nav{display:flex;gap:8px;overflow-x:auto');
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

  it('publishes structured hero crop and overlay settings and hides an opted-out hero photo', () => {
    const imageContent = {
      ...content,
      designPreferences: {
        ...defaultWebsiteDesignPreferences('business'),
        overlayStrength: 'strong',
        imageCrop: 'top',
      },
      pages: [{
        title: 'Home',
        slug: 'home',
        sections: [{ id: 'hero-section', type: 'hero', title: 'Welcome', body: 'A warm welcome', imageSlotId: 'hero-slot', layoutVariant: 'cinematic', overlayStrength: 'strong', imageCrop: 'top' }],
      }],
      imageSlots: [{ id: 'hero-slot', role: 'hero', targetId: 'hero-section', query: 'local studio', alt: 'A welcoming studio', assetId: 'hero-image' }],
    };
    const asset = {
      id: 'hero-image', slotId: 'hero-slot', source: 'user_upload', remoteUrl: null,
      sourcePageUrl: null, creatorName: null, creatorProfileUrl: null, alt: 'A welcoming studio',
      mimeType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    };
    const visibleFiles = buildWebsiteStaticFiles(imageContent, 'website-1', 'deployment-1', [asset]).files;
    const visible = visibleFiles.get('index.html')!.body as string;
    const stylesheet = visibleFiles.get('assets/site.css')!.body as string;
    expect(visible).toContain('hero-overlay-strong hero-crop-top');
    expect(stylesheet).toContain('.hero-crop-top .hero-image{object-position:center top}');
    expect(stylesheet).toContain('.hero-overlay-strong.hero-image-background:before');

    const optedOut = buildWebsiteStaticFiles({
      ...imageContent,
      designPreferences: { ...imageContent.designPreferences, heroImageMode: 'none' },
    }, 'website-1', 'deployment-2', [asset]).files.get('index.html')!.body as string;
    const heroMarkup = optedOut.match(/<section class="section hero[^\"]*"[^>]*>[\s\S]*?<\/section>/)?.[0] ?? '';
    expect(heroMarkup).toContain('hero-no-image');
    expect(heroMarkup).not.toContain('/assets/images/hero-image.jpg');
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
