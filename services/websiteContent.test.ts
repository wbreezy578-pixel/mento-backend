import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWebsiteTrustInstruction, normalizeWebsiteContent, parseWebsiteContact, parseWebsiteContent, preserveWebsiteContentExceptHeroLayout, preserveWebsiteHeroLayout, preserveWebsiteImageSlots, requestsWebsiteHeroLayoutChange } from './websiteContent';
import { buildWebsiteGenerationInstruction, DEFAULT_WEBSITE_PALETTE, normalizeWebsitePalette } from './websiteDesignSystem';

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
    assert.match(instruction, /Include one prominent, concise primary action in the hero/);
    assert.match(instruction, /Do not invent bookings, ordering, discounts, guarantees, or contact details/);
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
});

test('parses only valid JSON structures', () => {
  assert.equal(parseWebsiteContent(JSON.stringify(website)).title, 'Bella Restaurant');
  assert.throws(() => parseWebsiteContent('not json'), /valid website JSON/);
});