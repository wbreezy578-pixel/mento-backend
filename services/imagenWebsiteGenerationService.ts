import { GoogleGenAI } from '@google/genai';
import { validateImageBuffer } from '../lib/imageValidator';

export const WEBSITE_IMAGE_GENERATION_MODEL = 'gemini-3.1-flash-lite-image';

export class WebsiteImageGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebsiteImageGenerationError';
  }
}

export function buildWebsiteImagePrompt(input: {
  businessName: string;
  businessType: string;
  imageDescription: string;
  designStyle: string;
  userPrompt: string;
}): string {
  const details = [
    `Create one polished website photograph for ${input.businessName}, a ${input.businessType}.`,
    `Image subject and purpose: ${input.imageDescription}.`,
    `Visual direction: ${input.designStyle}.`,
    input.userPrompt ? `Additional owner direction: ${input.userPrompt}.` : '',
    'Use realistic materials, natural lighting, thoughtful composition, and a professional commercial-photography style.',
    'Do not add visible text, lettering, logos, captions, borders, or fabricated claims.',
    'If the scene depicts a real business, product, premises, menu item, or identifiable person, keep the image clearly illustrative and do not imply it is an actual photograph of that business or item.',
  ].filter(Boolean);
  return details.join('\n');
}

export async function generateWebsiteImage(input: {
  prompt: string;
  aspectRatio: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
}): Promise<{ buffer: Buffer; mimeType: string }> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new WebsiteImageGenerationError('AI image generation is not configured. Set GEMINI_API_KEY on the backend.');
  }

  const client = new GoogleGenAI({ apiKey });
  const response = await client.interactions.create({
    model: WEBSITE_IMAGE_GENERATION_MODEL,
    input: input.prompt,
    store: false,
    response_modalities: ['image'],
    generation_config: {
      image_config: {
        aspect_ratio: input.aspectRatio,
        image_size: '1K',
      },
    },
  }, { timeout: 120_000, maxRetries: 0 });
  const image = response.output_image;
  const encoded = image?.data;
  const mimeType = image?.mime_type;
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || !mimeType?.startsWith('image/')) {
    throw new WebsiteImageGenerationError('The image model did not return a usable image. Try changing the image description.');
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
    throw new WebsiteImageGenerationError('The image model returned an unsupported image format. Please try again.');
  }

  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) {
    throw new WebsiteImageGenerationError('The image model returned an image that could not be saved. Please try again.');
  }
  try {
    return { buffer: validateImageBuffer(bytes, mimeType).buffer, mimeType };
  } catch {
    throw new WebsiteImageGenerationError('The image model returned an invalid image. Please try again.');
  }
}
