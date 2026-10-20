import { describe, expect, it } from 'vitest';
import { defaultWebsiteDesignPreferences } from './websiteDesignPreferences';
import { buildWebsitePhotoSearchQuery } from './websitePhotoSearch';

describe('website photo search brief', () => {
  it('adds the same structured visual direction to the subject query', () => {
    const preferences = {
      ...defaultWebsiteDesignPreferences('restaurant'),
      heroImageMode: 'beside' as const,
      backgroundStyle: 'warm' as const,
      imageMood: 'natural morning light, candid local details',
    };
    const query = buildWebsitePhotoSearchQuery('Nairobi bakery sourdough bread', preferences);

    expect(query).toContain('Nairobi bakery sourdough bread');
    expect(query).toContain('coastal');
    expect(query).toContain('warm');
    expect(query).toContain('copy space');
    expect(query).toContain('natural morning light');
    expect(query.length).toBeLessThanOrEqual(100);
  });

  it('keeps legacy searches unchanged when no design brief is provided', () => {
    expect(buildWebsitePhotoSearchQuery('  fresh sourdough bread  ')).toBe('fresh sourdough bread');
  });

  it('does not let a long mood overwhelm the actual image subject', () => {
    const preferences = {
      ...defaultWebsiteDesignPreferences('business'),
      imageMood: 'soft '.repeat(100),
    };
    const query = buildWebsitePhotoSearchQuery('a very specific image subject from the owner', preferences);

    expect(query).toContain('a very specific image subject');
    expect(query.length).toBeLessThanOrEqual(100);
  });
});
