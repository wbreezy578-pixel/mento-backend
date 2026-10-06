import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWebsiteContent, parseWebsiteContent } from './websiteContent';

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
    contact: { ...website.contact, mapsUrl: 'https://maps.google.com/?q=Mombasa' },
    socialLinks: { instagram: 'https://instagram.com/bella', facebook: '', tiktok: '' },
    seo: { title: 'Bella Restaurant | Menu', description: 'Fresh Swahili food by the coast.' },
  });
  assert.ok(content);
  assert.equal(content.schemaVersion, 1);
  assert.deepEqual(
    { name: content.menuCategories[0].items[0].name, price: content.menuCategories[0].items[0].price, currency: content.menuCategories[0].items[0].currency, available: content.menuCategories[0].items[0].available },
    { name: 'Chicken Biryani', price: '650', currency: 'KSh', available: true },
  );
  assert.equal(content.theme.primaryColor, '#A84D35');
  assert.equal(content.contact.mapsUrl, 'https://maps.google.com/?q=Mombasa');
  assert.equal(content.socialLinks.instagram, 'https://instagram.com/bella');
  assert.equal(content.seo.title, 'Bella Restaurant | Menu');
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