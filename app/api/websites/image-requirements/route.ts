import { NextResponse } from 'next/server';
import { askGemini, type GeminiMessage } from '../../../../services/geminiService';
import {
  AIRequestGatewayError,
  authenticateAIRequest,
  enforceAIGatewayRateLimit,
  executeAIRequest,
  getClientIp,
  requireClientAIRequestId,
  secureAITextInput,
} from '../../../../lib/aiSecurityGateway';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../lib/requestBody';
import { buildCorsHeaders } from '../../../../lib/securityHeaders';
import logger from '../../../../lib/logger';
import { parseWebsiteImageRequirements } from '../../../../services/websiteImageRequirements';
import { isWebsiteType } from '../../../../services/websiteContent';
import { parseWebsiteDesignPreferences } from '../../../../services/websiteDesignPreferences';

const MAX_BODY_BYTES = 32 * 1024;
const MAX_BRIEF_LENGTH = 600;
const MAX_FULL_PROMPT_LENGTH = 7000;
const MAX_RESTAURANT_MENU_ITEMS = 24;

interface MenuImageInput {
  id: string;
  name: string;
  description: string;
}

function parseMenuImageInputs(value: unknown): MenuImageInput[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RESTAURANT_MENU_ITEMS) return null;
  const ids = new Set<string>();
  const items: MenuImageInput[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    if (
      typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || item.name.trim().length > 100
      || (item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 240))
    ) return null;
    ids.add(item.id);
    items.push({ id: item.id, name: item.name.trim(), description: typeof item.description === 'string' ? item.description.trim() : '' });
  }
  return items;
}

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': 'POST, OPTIONS' },
  });
}

export async function POST(req: Request) {
  try {
    const user = await authenticateAIRequest(req);
    const userId = user.id;
    const clientIp = getClientIp(req);
    await enforceAIGatewayRateLimit(userId, clientIp);
    const body = await readJsonBodyWithLimit<{ title?: unknown; brief?: unknown; fullPrompt?: unknown; designPreferences?: unknown; type?: unknown; menuItems?: unknown; requestId?: unknown }>(req, MAX_BODY_BYTES);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
    const fullPrompt = typeof body.fullPrompt === 'string' ? body.fullPrompt.trim() : '';
    if (!title || title.length > 100 || !brief || brief.length > MAX_BRIEF_LENGTH || !isWebsiteType(body.type)) {
      return NextResponse.json({ error: 'Choose a website type, add a business name, and provide a short description under 600 characters.', code: 'invalid_image_requirements_request' }, { status: 400, headers: headers(req) });
    }
    if (fullPrompt.length > MAX_FULL_PROMPT_LENGTH) {
      return NextResponse.json({ error: 'Keep the website prompt under 7,000 characters.', code: 'invalid_image_requirements_request' }, { status: 400, headers: headers(req) });
    }
    const websiteType = body.type;
    const designPreferences = parseWebsiteDesignPreferences(body.designPreferences, websiteType);
    if (!designPreferences) {
      return NextResponse.json({ error: 'Choose supported website design options and try again.', code: 'invalid_design_preferences' }, { status: 400, headers: headers(req) });
    }
    const menuItems = parseMenuImageInputs(body.menuItems);
    if (!menuItems || (websiteType !== 'restaurant' && menuItems.length > 0)) {
      return NextResponse.json({ error: 'Provide up to 24 valid restaurant menu items for photo suggestions.', code: 'invalid_menu_image_requirements' }, { status: 400, headers: headers(req) });
    }

    const requestId = requireClientAIRequestId(req, body.requestId);
    const input = JSON.stringify({ type: websiteType, title, brief, fullPrompt, designPreferences, menuItems });
    const securityDecision = await secureAITextInput({ userId, requestId, ip: clientIp, input });
    const { result } = await executeAIRequest({
      user,
      clientIp,
      feature: 'image',
      provider: 'Gemini',
      amount: 1,
      requestId,
      metadata: { source: 'websites', operationType: 'website.image_requirements' },
      securityInput: input,
      securityDecision,
      callback: async ({ billingDecision, sanitizedInput, reportUsage, reportProviderAttempt }) => {
        const messages: GeminiMessage[] = [
          {
            role: 'system',
            parts: [{
              text: `Create image requirements for the selected website type "${websiteType}". Keep the returned type exactly "${websiteType}". Use the supplied full prompt and the structured design preferences—style preset, background palette, hero-image placement, overlay, crop, and image mood—when choosing subjects and search-query composition; the business description alone is not the full creative brief. For a background hero choose a wide composition with calm copy space; for a beside-text hero choose a subject placement that leaves the text side visually clear; for no-hero-photo do not request a hero image. Do not build a website. Return JSON with exactly this shape: {"type":"${websiteType}","visualStyle":"short style direction","imageRequirements":[{"id":"stable-lowercase-id","role":"hero|gallery|menu_item|section","label":"short UI label","query":"concise description of a suitable photo subject","alt":"accessible image description","orientation":"landscape|portrait|square"}]}. Provide 3 to 6 distinct useful image requirements relevant to the selected type and brief. Include a hero image only when heroImageMode is not "none"; when relevant, add food/menu, interior/about, and gallery/lifestyle requirements. Use menu_item for food photos, gallery for gallery/lifestyle, section for interior/about, and hero for the main image. Use landscape for hero and section images, square for menu_item, and suitable orientation for gallery. Each query must name a concrete, business-specific subject and reflect the owner's image mood; never use generic stock-photo phrases or combine unrelated dishes or subjects. Keep all queries concise and IDs unique. Return JSON only.`,
            }],
          },
          { role: 'user', parts: [{ text: sanitizedInput ?? input }] },
        ];
        const response = await askGemini(
          messages,
          billingDecision.modelUsed ?? undefined,
          reportUsage,
          reportProviderAttempt,
          req.signal,
          { responseMimeType: 'application/json', maxOutputTokens: 1800 },
        );
        const requirements = parseWebsiteImageRequirements(response);
        const imageRequirements = menuItems.length
          ? requirements.imageRequirements.filter((item) => item.role !== 'menu_item')
          : requirements.imageRequirements;
        const photoRequirements = designPreferences.heroImageMode === 'none'
          ? imageRequirements.filter((item) => item.role !== 'hero')
          : imageRequirements;
        const usedIds = new Set(imageRequirements.map((item) => item.id));
        const menuRequirements = menuItems.map((item, index) => {
          let id = `menu-item-${index + 1}`;
          while (usedIds.has(id)) id = `menu-${index + 1}-${usedIds.size + 1}`;
          usedIds.add(id);
          const name = item.name.trim().slice(0, 65);
          const suffix = ' professional food photography';
          const descriptionLimit = Math.max(0, 100 - name.length - suffix.length - 1);
          const description = item.description.trim().slice(0, descriptionLimit);
          return {
            id,
            targetId: item.id,
            role: 'menu_item' as const,
            label: item.name,
            query: `${name}${description ? ` ${description}` : ''}${suffix}`,
            alt: `Photo of ${item.name}`,
            orientation: 'square' as const,
          };
        });
        return { ...requirements, type: websiteType, imageRequirements: [...photoRequirements, ...menuRequirements] };
      },
    });
    return NextResponse.json(result, { headers: headers(req) });
  } catch (error) {
    if (error instanceof RequestBodyError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: headers(req) });
    if (error instanceof AIRequestGatewayError) return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    logger.error('Website image requirements failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    });
    return NextResponse.json({ error: 'Image suggestions are unavailable right now. Please try again shortly.' }, { status: 503, headers: headers(req) });
  }
}

export const runtime = 'nodejs';
