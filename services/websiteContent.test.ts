import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWebsiteDesignPreferences, buildWebsiteTrustInstruction, normalizeWebsiteContent, parseWebsiteContact, parseWebsiteContent, preserveWebsiteContentExceptHeroLayout, preserveWebsiteHeroLayout, preserveWebsiteImageSlots, requestsWebsiteHeroLayoutChange, WebsiteContentParseError } from './websiteContent';
import { defaultWebsiteDesignPreferences, parseWebsiteDesignPreferences } from './websiteDesignPreferences';
import { buildCompactWebsiteGenerationInstruction, buildWebsiteGenerationInstruction, buildWebsiteGenerationSchemaInstruction, DEFAULT_WEBSITE_PALETTE, normalizeWebsitePalette } from './websiteDesignSystem';

const website = {
  title: 'Bella Restaurant',
  description: 'Coastal Swahili cooking and fresh seafood in Mombasa.',
  theme: { primaryColor: '#a84d35' },
  pages: [{
    title: 'Home',
    slug: 'home',
    sections: [{ type: 'hero', title: 'A taste of the coast', body: 'Fresh from the Indian Ocean.' }],
  }],
  menuCategories: [{
    name: 'Main Dishes',
    items: [{ name: 'Chicken Biryani', description: 'Spiced rice with tender chicken', price: '650', currency: 'KSh', available: true }],
  }],
  galleryImageUrls: ['https://images.unsplash.com/photo-123'],
  contact: { address: 'Mombasa, Kenya', phone: '+254700000000', whatsappNumber: '+254700000000' },
};

test('normalizes structured pages, menu, contact, and safe image URLs', () => {
  const content = normalizeWebsiteContent({
    ...website,
    contact: {
      ...website.contact,
      mapsUrl: 'https://maps.google.com/?q=Mombasa',
      openingHours: 'Mon-Fri, 9am-5pm',
      email: 'hello@bella.example',
      bookingUrl: 'https://bella.example/book',
      testimonials: '“A lovely evening.” — Customer',
    },
    socialLinks: { instagram: 'https://instagram.com/bella', facebook: '', tiktok: '' },
    seo: { title: 'Bella Restaurant | Menu', description: 'Fresh Swahili food by the coast.' },
  });
  assert.ok(content);
  assert.equal(content.schemaVersion, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(content.pages[0].sections[0], 'layoutVariant'), false);
  assert.deepEqual(
    { name: content.menuCategories[0].items[0].name, price: content.menuCategories[0].items[0].price, currency: content.menuCategories[0].items[0].currency, available: content.menuCategories[0].items[0].available },
    { name: 'Chicken Biryani', price: '650', currency: 'KSh', available: true },
  );
  assert.equal(content.theme.primaryColor, '#A84D35');
  assert.deepEqual(content.theme, {
    ...DEFAULT_WEBSITE_PALETTE['modern-business'],
    primaryColor: '#A84D35',
  });
  assert.equal(content.contact.mapsUrl, 'https://maps.google.com/?q=Mombasa');
  assert.equal(content.contact.openingHours, 'Mon-Fri, 9am-5pm');
  assert.equal(content.contact.email, 'hello@bella.example');
  assert.equal(content.contact.bookingUrl, 'https://bella.example/book');
  assert.equal(content.contact.testimonials, '“A lovely evening.” — Customer');
  assert.equal(content.socialLinks.instagram, 'https://instagram.com/bella');
  assert.equal(content.seo.title, 'Bella Restaurant | Menu');
});

test('validates safe design preferences and applies the same hero layout and background palette', () => {
  const normalized = normalizeWebsiteContent({ ...website, type: 'restaurant' });
  assert.ok(normalized);
  const preferences = {
    ...defaultWebsiteDesignPreferences('restaurant'),
    heroImageMode: 'beside' as const,
    backgroundStyle: 'sage' as const,
    overlayStrength: 'strong' as const,
    imageCrop: 'top' as const,
    imageMood: 'soft morning light',
  };
  const updated = applyWebsiteDesignPreferences(normalized, preferences);

  assert.equal(updated.pages[0].sections[0].layoutVariant, 'split');
  assert.equal(updated.pages[0].sections[0].overlayStrength, 'strong');
  assert.equal(updated.pages[0].sections[0].imageCrop, 'top');
  assert.equal(updated.theme.backgroundColor, '#F6F8F3');
  assert.equal(updated.designPreferences.imageMood, 'soft morning light');
  assert.equal(parseWebsiteDesignPreferences({ ...preferences, heroImageMode: 'arbitrary-css' }, 'restaurant'), null);

  const legacyWithPreset = normalizeWebsiteContent({ ...website, type: 'restaurant', designPreset: 'creative-portfolio' });
  assert.equal(legacyWithPreset?.designPreferences.designPreset, 'creative-portfolio');
});

test('AI edits retain existing image slots and asset assignments for unchanged sections', () => {
  const existing = normalizeWebsiteContent({
    ...website,
    type: 'restaurant',
    pages: [{
      id: 'home',
      title: 'Home',
      slug: 'home',
      sections: [
        { id: 'hero-section', type: 'hero', title: 'Taste the coast', body: 'Fresh seafood.', imageSlotId: 'hero-slot' },
        { id: 'gallery-section', type: 'gallery', title: 'Gallery', body: '', imageSlotId: 'gallery-slot' },
      ],
    }],
    menuCategories: [{
      id: 'mains',
      name: 'Mains',
      items: [{ id: 'fish', name: 'Grilled fish', description: '', price: '1200', currency: 'KSh', imageSlotId: 'menu-slot', available: true }],
    }],
    imageSlots: [
      { id: 'hero-slot', role: 'hero', targetId: 'hero-section', query: 'coastal food', alt: 'Coastal food', assetId: 'hero-asset' },
      { id: 'gallery-slot', role: 'gallery', targetId: 'gallery-section', query: 'restaurant', alt: 'Dining room', assetId: 'gallery-asset' },
      { id: 'menu-slot', role: 'menu_item', targetId: 'fish', query: 'grilled fish', alt: 'Grilled fish', assetId: 'menu-asset' },
    ],
  });
  assert.ok(existing);
  const edited = normalizeWebsiteContent({
    ...existing,
    pages: [{
      ...existing.pages[0],
      sections: existing.pages[0].sections.map((section) => ({ ...section, imageSlotId: null })),
    }],
    menuCategories: [{
      ...existing.menuCategories[0],
      items: existing.menuCategories[0].items.map((item) => ({ ...item, imageSlotId: null })),
    }],
    imageSlots: [],
  });
  assert.ok(edited);

  const result = preserveWebsiteImageSlots(existing, edited);

  assert.deepEqual(result.imageSlots.map((slot) => [slot.id, slot.assetId]), [
    ['hero-slot', 'hero-asset'],
    ['gallery-slot', 'gallery-asset'],
    ['menu-slot', 'menu-asset'],
  ]);
  assert.equal(result.pages[0].sections[0].imageSlotId, 'hero-slot');
  assert.equal(result.pages[0].sections[1].imageSlotId, 'gallery-slot');
  assert.equal(result.menuCategories[0].items[0].imageSlotId, 'menu-slot');
});

test('validates optional hero layout variants and rejects invalid or non-hero values', () => {
  const legacy = normalizeWebsiteContent(website);
  assert.ok(legacy);
  assert.equal(Object.prototype.hasOwnProperty.call(legacy.pages[0].sections[0], 'layoutVariant'), false);

  for (const layoutVariant of ['cinematic', 'split', 'centered-editorial']) {
    const content = normalizeWebsiteContent({
      ...website,
      pages: [{
        ...website.pages[0],
        sections: [{ ...website.pages[0].sections[0], layoutVariant }],
      }],
    });
    assert.equal(content?.pages[0].sections[0].layoutVariant, layoutVariant);
  }

  for (const layoutVariant of ['diagonal', 'url(https://example.com/style.css)', null, 42]) {
    assert.equal(normalizeWebsiteContent({
      ...website,
      pages: [{
        ...website.pages[0],
        sections: [{ ...website.pages[0].sections[0], layoutVariant }],
      }],
    }), null);
  }
  assert.equal(normalizeWebsiteContent({
    ...website,
    pages: [{
      ...website.pages[0],
      sections: [{ type: 'about', title: 'About', layoutVariant: 'split' }],
    }],
  }), null);
});

test('AI edits preserve hero IDs, layout, and assigned images unless the hero layout is explicitly requested', () => {
  const existing = normalizeWebsiteContent({
    ...website,
    type: 'restaurant',
    pages: [{
      id: 'home',
      title: 'Home',
      slug: 'home',
      sections: [
        { id: 'hero-section', type: 'hero', title: 'Taste the coast', body: 'Fresh seafood.', imageSlotId: 'hero-slot', layoutVariant: 'split' },
        { id: 'about-section', type: 'about', title: 'Our story', body: 'Locally owned.' },
      ],
    }],
    imageSlots: [{
      id: 'hero-slot',
      role: 'hero',
      targetId: 'hero-section',
      query: 'coastal food',
      alt: 'Coastal food',
      assetId: 'hero-asset',
    }],
  });
  assert.ok(existing);

  const edited = normalizeWebsiteContent({
    ...existing,
    pages: [{
      ...existing.pages[0],
      sections: [
        { ...existing.pages[0].sections[0], id: 'model-generated-hero-id', imageSlotId: null, layoutVariant: 'cinematic' },
        { ...existing.pages[0].sections[1], body: 'Locally owned and operated.' },
      ],
    }],
    imageSlots: [{
      ...existing.imageSlots[0],
      targetId: 'model-generated-hero-id',
      assetId: null,
    }],
  });
  assert.ok(edited);

  const preservedHero = preserveWebsiteHeroLayout(existing, edited);
  const preserved = preserveWebsiteImageSlots(existing, preservedHero);
  assert.equal(preserved.pages[0].sections[0].id, 'hero-section');
  assert.equal(preserved.pages[0].sections[0].layoutVariant, 'split');
  assert.equal(preserved.pages[0].sections[0].imageSlotId, 'hero-slot');
  assert.equal(preserved.imageSlots.length, 1);
  assert.equal(preserved.imageSlots[0].assetId, 'hero-asset');
  assert.equal(preserved.pages[0].sections[1].body, 'Locally owned and operated.');

  const requestedChange = preserveWebsiteHeroLayout(existing, edited, true);
  assert.equal(requestedChange.pages[0].sections[0].id, 'hero-section');
  assert.equal(requestedChange.pages[0].sections[0].layoutVariant, 'cinematic');
  const designOnlyChange = preserveWebsiteContentExceptHeroLayout(existing, requestedChange);
  assert.equal(designOnlyChange.title, existing.title);
  assert.equal(designOnlyChange.pages[0].sections[0].body, existing.pages[0].sections[0].body);
  assert.equal(designOnlyChange.pages[0].sections[1].body, existing.pages[0].sections[1].body);
  assert.equal(designOnlyChange.pages[0].sections[0].layoutVariant, 'cinematic');
  assert.equal(requestsWebsiteHeroLayoutChange('Change the hero layout to split.'), true);
  assert.equal(requestsWebsiteHeroLayoutChange('Make the hero centered editorial.'), true);
  assert.equal(requestsWebsiteHeroLayoutChange('Make the homepage feel more premium.'), false);
});

test('validates owner-provided trust details and rejects unsafe links or malformed contacts', () => {
  const details = {
    address: 'Mombasa',
    phone: '+254 700 000 000',
    whatsappNumber: '+254 711 111 111',
    mapsUrl: 'https://maps.google.com/?q=Mombasa',
    email: 'hello@example.com',
    openingHours: 'Monday-Friday: 9:00-17:00',
    serviceArea: 'Mombasa County',
    servicesAndPricing: 'Repairs — KSh 500',
    testimonials: '“Excellent service.” — A. Customer',
    bookingUrl: 'https://example.com/book',
  };
  assert.deepEqual(parseWebsiteContact(details), { ...details, whatsappNumber: '+254711111111' });
  assert.equal(parseWebsiteContact({ ...details, bookingUrl: 'javascript:alert(1)' }), null);
  assert.equal(parseWebsiteContact({ ...details, email: 'not-an-email' }), null);
  assert.equal(parseWebsiteContact({ ...details, testimonials: 'x'.repeat(1201) }), null);
});

test('normalizes brand colors by role and rejects invalid or low-contrast palette values', () => {
  const custom = normalizeWebsitePalette({
    primaryColor: '#204060',
    secondaryColor: '#305040',
    backgroundColor: '#FAFAF8',
    surfaceColor: '#F0F1EE',
  }, 'trustworthy-professional');
  assert.deepEqual(custom, {
    primaryColor: '#204060',
    secondaryColor: '#305040',
    backgroundColor: '#FAFAF8',
    surfaceColor: '#F0F1EE',
  });

  test('generation guidance requires specific hero value and one fact-supported primary action', () => {
    const instruction = buildWebsiteGenerationInstruction('restaurant');
    assert.match(instruction, /headline that names the actual offer, audience, or useful outcome/);
    assert.match(instruction, /Never use generic openers/);
    assert.match(instruction, /shared Mento standard photo-led and polished/);
    assert.match(instruction, /Organize real menu items into distinct categories with clear navigation and aligned prices/);
    assert.match(instruction, /Include one prominent, concise primary action in the hero/);
    assert.match(instruction, /Do not invent bookings, ordering, discounts, guarantees, or contact details/);
    assert.match(instruction, /image-led backdrop with a calm, high-contrast overlay/);
    assert.match(instruction, /Use food photography for restaurant menu items/);
    assert.match(instruction, /Keep photo crops intentional on phone screens/);
    assert.match(instruction, /layoutVariant to exactly one of: cinematic, split, centered-editorial/);
  });

  test('trust guidance uses owner-provided details and requires exact testimonials', () => {
    const instruction = buildWebsiteTrustInstruction();
    assert.match(instruction, /verified information only/);
    assert.match(instruction, /exact owner-approved testimonials/);
    assert.match(instruction, /omit missing details without placeholders/i);
    assert.match(instruction, /preserve.*exactly/i);
  });

  const repaired = normalizeWebsitePalette({
    primaryColor: 'red',
    secondaryColor: '#FFFF00',
    backgroundColor: '#222222',
    surfaceColor: 'transparent',
  }, 'coastal-editorial');
  assert.equal(repaired.primaryColor, DEFAULT_WEBSITE_PALETTE['coastal-editorial'].primaryColor);
  assert.equal(repaired.secondaryColor, DEFAULT_WEBSITE_PALETTE['coastal-editorial'].secondaryColor);
  assert.equal(repaired.backgroundColor, DEFAULT_WEBSITE_PALETTE['coastal-editorial'].backgroundColor);
  assert.equal(repaired.surfaceColor, DEFAULT_WEBSITE_PALETTE['coastal-editorial'].surfaceColor);
});

test('keeps only HTTPS links and falls back to safe SEO defaults', () => {
  const content = normalizeWebsiteContent({
    ...website,
    contact: { ...website.contact, mapsUrl: 'javascript:alert(1)' },
    socialLinks: {
      instagram: 'http://instagram.com/bella',
      facebook: 'https://user:password@facebook.com/bella',
      tiktok: 'https://www.tiktok.com/@bella',
    },
    seo: { title: ' ', description: ' ' },
  });
  assert.ok(content);
  assert.equal(content.contact.mapsUrl, '');
  assert.deepEqual(content.socialLinks, {
    instagram: '',
    facebook: '',
    tiktok: 'https://www.tiktok.com/@bella',
  });
  assert.equal(content.seo.title, website.title);
  assert.equal(content.seo.description, website.description);
});

test('drops unsupported remote image hosts and javascript URLs', () => {
  const content = normalizeWebsiteContent({
    ...website,
    galleryImageUrls: ['https://tracker.example/image.jpg', 'javascript:alert(1)'],
    menuCategories: [{ name: 'Drinks', items: [{ name: 'Juice', imageUrl: 'https://tracker.example/juice.jpg' }] }],
  });
  assert.ok(content);
  assert.deepEqual(content.galleryImageUrls, []);
  assert.equal(content.menuCategories[0].items[0].imageUrl, null);
});

test('rejects malformed sections, duplicate page slugs, and unsafe prices', () => {
  assert.equal(normalizeWebsiteContent({ ...website, pages: [{ ...website.pages[0], sections: [{ type: 'script', title: 'x' }] }] }), null);
  assert.equal(normalizeWebsiteContent({ ...website, pages: [website.pages[0], { ...website.pages[0], title: 'Another page' }] }), null);
  assert.equal(normalizeWebsiteContent({ ...website, menuCategories: [{ name: 'Mains', items: [{ name: 'Meal', price: '650<script>' }] }] }), null);
  assert.equal(normalizeWebsiteContent({ ...website, menuCategories: [{ name: 'Mains', items: [{ name: 'Meal', price: '10000000' }] }] }), null);
  assert.ok(normalizeWebsiteContent({ ...website, menuCategories: [{ name: 'Mains', items: [{ name: 'Meal', price: '9999999.99' }] }] }));
});

test('parses only valid JSON structures', () => {
  assert.equal(parseWebsiteContent(JSON.stringify(website)).title, 'Bella Restaurant');
  assert.throws(() => parseWebsiteContent('not json'), (error) => (
    error instanceof WebsiteContentParseError && error.code === 'invalid_json'
  ));
  assert.throws(() => parseWebsiteContent(JSON.stringify({ title: 'Missing required pages' })), (error) => (
    error instanceof WebsiteContentParseError && error.code === 'unsupported_structure'
  ));
});

test('compact website generation guidance preserves image, hero, and factuality constraints', () => {
  const instruction = buildCompactWebsiteGenerationInstruction('restaurant');
  assert.match(instruction, /layoutVariant cinematic, split, or centered-editorial/);
  assert.match(instruction, /exactly one imageSlots entry per selected image/);
  assert.match(instruction, /Never invent bookings, ordering, contact details, prices/);
  assert.match(instruction, /prevent horizontal overflow/);
});

test('website generation schema instruction explicitly defines hero variants and exact selected-image assignments', () => {
  const instruction = buildWebsiteGenerationSchemaInstruction();
  assert.match(instruction, /layoutVariant":"cinematic\|split\|centered-editorial \(hero only\)/);
  assert.match(instruction, /exactly one image slot for each selected image/);
  assert.match(instruction, /Do not add unselected images, substitute selected images, or return image URLs/);
  assert.ok(instruction.length < 2_000);
});
