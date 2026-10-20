import { describe, expect, it } from 'vitest';
import { buildWebsiteImagePrompt, WEBSITE_IMAGE_GENERATION_MODEL } from './imagenWebsiteGenerationService';

describe('website image generation prompts', () => {
  it('uses Nano Banana 2 Lite and describes a business-specific, illustrative photo', () => {
    const prompt = buildWebsiteImagePrompt({
      businessName: 'Harbour Table',
      businessType: 'restaurant',
      imageDescription: 'charcoal-grilled snapper served with seasonal vegetables',
      designStyle: 'coastal editorial',
      userPrompt: 'warm evening light, no people',
    });

    expect(WEBSITE_IMAGE_GENERATION_MODEL).toBe('gemini-3.1-flash-lite-image');
    expect(prompt).toContain('Harbour Table');
    expect(prompt).toContain('charcoal-grilled snapper served with seasonal vegetables');
    expect(prompt).toContain('coastal editorial');
    expect(prompt).toContain('warm evening light, no people');
    expect(prompt).toContain('do not imply it is an actual photograph');
    expect(prompt).toContain('Do not add visible text');
  });
});
