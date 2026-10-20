import { describe, expect, it } from 'vitest';
import { parseWebsiteImageRequirements } from './websiteImageRequirements';

describe('website image requirements', () => {
  it('validates Gemini-generated visual requirements and search orientations', () => {
    expect(parseWebsiteImageRequirements(JSON.stringify({
      type: 'restaurant',
      visualStyle: 'premium coastal',
      imageRequirements: [
        { id: 'hero-1', role: 'hero', label: 'Hero', query: 'premium seafood dish', alt: 'Fresh seafood on a restaurant table', orientation: 'landscape' },
        { id: 'menu-1', role: 'menu_item', label: 'Food / menu', query: 'grilled fish plate', alt: 'Grilled fish served with greens', orientation: 'square' },
      ],
    }))).toEqual({
      type: 'restaurant',
      visualStyle: 'premium coastal',
      imageRequirements: [
        { id: 'hero-1', role: 'hero', label: 'Hero', query: 'premium seafood dish', alt: 'Fresh seafood on a restaurant table', orientation: 'landscape' },
        { id: 'menu-1', role: 'menu_item', label: 'Food / menu', query: 'grilled fish plate', alt: 'Grilled fish served with greens', orientation: 'square' },
      ],
    });
  });

  it('preserves validated menu targets on requirements', () => {
    expect(parseWebsiteImageRequirements({
      type: 'restaurant',
      visualStyle: 'coastal',
      imageRequirements: [{
        id: 'menu-item-1',
        targetId: 'menu-1',
        role: 'menu_item',
        label: 'Grilled fish',
        query: 'grilled fish plate',
        alt: 'Grilled fish served with greens',
        orientation: 'square',
      }],
    }).imageRequirements[0].targetId).toBe('menu-1');

    expect(() => parseWebsiteImageRequirements({
      type: 'restaurant',
      visualStyle: 'coastal',
      imageRequirements: [{
        id: 'menu-item-1',
        targetId: 'invalid id',
        role: 'menu_item',
        label: 'Grilled fish',
        query: 'grilled fish plate',
        alt: 'Grilled fish served with greens',
        orientation: 'square',
      }],
    })).toThrow(/invalid image requirement/);
  });

  it('rejects invalid roles, duplicate IDs, and provider URLs in place of requirements', () => {
    expect(() => parseWebsiteImageRequirements({
      type: 'restaurant',
      visualStyle: 'coastal',
      imageRequirements: [{ id: 'hero-1', role: 'hero', label: 'Hero', query: 'seafood', alt: 'Seafood', orientation: 'landscape' }, {
        id: 'hero-1', role: 'gallery', label: 'Gallery', query: 'coast', alt: 'Coast', orientation: 'landscape',
      }],
    })).toThrow(/invalid image requirement/);

    expect(() => parseWebsiteImageRequirements({
      type: 'restaurant',
      visualStyle: 'coastal',
      imageRequirements: [{ id: 'hero-1', role: 'unknown', label: 'Hero', query: 'unsupported image source', alt: 'Photo', orientation: 'landscape' }],
    })).toThrow(/invalid image requirement/);
  });
});
