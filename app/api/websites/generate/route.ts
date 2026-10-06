import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { askGemini, type GeminiMessage } from '../../../../services/geminiService';
import { prisma } from '../../../../lib/prisma';
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
import { buildTutorLanguageInstruction, getTutorLanguage } from '../../../../lib/userSettings';
import { isWebsiteType, parseWebsiteContent, type WebsiteContent, type WebsiteType } from '../../../../services/websiteContent';
import { buildWebsiteGenerationInstruction } from '../../../../services/websiteDesignSystem';
import { fillWebsiteImageSlots, type WebsiteAssetCreateData } from '../../../../services/websiteAssetService';
import { createDraftWebsiteSlug, slugifyWebsiteName } from '../../../../services/websiteDeploymentService';
import { assertWebsiteFeatureAccess, createWebsiteWithinProLimit, WebsiteAccessError } from '../../../../services/websiteBillingService';

const CORS_METHODS = 'POST, OPTIONS';
const MAX_BODY_BYTES = 12 * 1024;
const MAX_PROMPT_LENGTH = 7000;

interface GeneratedWebsite {
  content: WebsiteContent;
  assets: WebsiteAssetCreateData[];
}

function jsonHeaders(request: Request) {
  return { ...buildCorsHeaders(request.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': CORS_METHODS },
  });
}

export async function POST(req: Request) {
  try {
    const user = await authenticateAIRequest(req);
    const userId = user.id;
    const clientIp = getClientIp(req);
    await enforceAIGatewayRateLimit(userId, clientIp);

    let body: { title?: unknown; type?: unknown; brief?: unknown; requestId?: unknown };
    try {
      body = await readJsonBodyWithLimit(req, MAX_BODY_BYTES);
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
      return NextResponse.json({ error: bodyError.message, code: bodyError.code }, { status: bodyError.status, headers: jsonHeaders(req) });
    }

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
    if (!title || title.length > 100 || !brief || brief.length > MAX_PROMPT_LENGTH || !isWebsiteType(body.type)) {
      return NextResponse.json({ error: 'Add a website name, a supported type, and a brief under 7,000 characters.', code: 'invalid_website_request' }, { status: 400, headers: jsonHeaders(req) });
    }
    if (!slugifyWebsiteName(title)) {
      return NextResponse.json({ error: 'Choose a website name that can be used in a website address.', code: 'invalid_website_slug' }, { status: 400, headers: jsonHeaders(req) });
    }
    const draftSlug = createDraftWebsiteSlug(title);

    try {
      await assertWebsiteFeatureAccess(userId, 'create');
    } catch (error) {
      if (error instanceof WebsiteAccessError) {
        return NextResponse.json({ error: error.message }, { status: error.status, headers: jsonHeaders(req) });
      }
      throw error;
    }

    const requestId = requireClientAIRequestId(req, body.requestId);
    const prompt = JSON.stringify({ type: body.type, title, brief });
    const securityDecision = await secureAITextInput({ userId, requestId, ip: clientIp, input: prompt });
    let persistedWebsite: unknown = null;

    const { result: generated, billingDecision } = await executeAIRequest<GeneratedWebsite>({
      user,
      clientIp,
      feature: 'website',
      provider: 'Gemini',
      amount: 1,
      requestId,
      metadata: { source: 'websites', operationType: 'website.generate', websiteType: body.type },
      securityInput: prompt,
      securityDecision,
      callback: async ({ billingDecision: decision, sanitizedInput, reportUsage, reportProviderAttempt }) => {
        const language = await getTutorLanguage(userId);
        const contents: GeminiMessage[] = [
          {
            role: 'system',
            parts: [{ text: `${buildTutorLanguageInstruction(language)}\n${buildWebsiteGenerationInstruction(body.type as WebsiteType)}\n\nReturn JSON with this exact shape: {"type":"business|restaurant|portfolio|professional|other","title":"...","description":"...","designPreset":"coastal-editorial|trustworthy-professional|creative-portfolio|local-service|modern-business","theme":{"primaryColor":"#123456"},"pages":[{"id":"stable-id","title":"...","slug":"...","sections":[{"id":"stable-id","type":"hero|about|services|menu|gallery|location|contact|whatsapp","title":"...","body":"...","imageSlotId":null}]}],"menuCategories":[{"id":"stable-id","name":"...","items":[{"id":"stable-id","name":"...","description":"...","price":"650","currency":"KSh","imageUrl":null,"imageSlotId":null,"available":true}]}],"imageSlots":[{"id":"stable-id","role":"hero|gallery|menu_item|section","targetId":"existing section or item id, or null","query":"specific stock photo search query","alt":"descriptive alt text","assetId":null}],"galleryImageUrls":[],"contact":{"address":"...","phone":"...","whatsappNumber":"..."}}. Use 2 to 6 pages, no more than 3 imageSlots, and do not invent contact details, menu prices, or factual claims. The imageSlots request imagery only; never return image URLs. Image slot targets must refer to an existing section or menu item. For restaurants, create menu categories/items only when requested. Return JSON only.` }],
          },
          { role: 'user', parts: [{ text: sanitizedInput ?? prompt }] },
        ];
        const model = decision.modelUsed ?? undefined;
        const generationOptions = { responseMimeType: 'application/json', maxOutputTokens: 8192 };
        const response = await askGemini(contents, model, reportUsage, reportProviderAttempt, req.signal, generationOptions);
        try {
          const parsed = parseWebsiteContent(response, body.type as WebsiteType);
          return await fillWebsiteImageSlots(parsed);
        } catch {
          const repairedResponse = await askGemini([
            ...contents,
            { role: 'model', parts: [{ text: response }] },
            { role: 'user', parts: [{ text: 'The previous response did not match the required website JSON shape. Return a corrected complete JSON object only. Preserve the requested website content and do not include code.' }] },
          ], model, reportUsage, reportProviderAttempt, req.signal, generationOptions);
          const parsed = parseWebsiteContent(repairedResponse, body.type as WebsiteType);
          return await fillWebsiteImageSlots(parsed);
        }
      },
      beforeFinalize: async ({ content: generatedContent, assets }) => {
        persistedWebsite = await createWebsiteWithinProLimit(userId, async (tx) => tx.website.create({
          data: {
            userId,
            type: body.type as string,
            title: generatedContent.title,
            slug: draftSlug,
            content: generatedContent as unknown as Prisma.InputJsonValue,
            revision: 0,
            currentVersion: 1,
            versions: {
              create: {
                version: 1,
                source: 'initial',
                summary: 'Initial website',
                content: generatedContent as unknown as Prisma.InputJsonValue,
              },
            },
            assets: { create: assets },
          },
          include: { versions: true, assets: true },
        }), requestId);
      },
    });

    if (!persistedWebsite) {
      throw new Error('Website persistence did not complete.');
    }
    return NextResponse.json({ website: persistedWebsite, billing: billingDecision }, { status: 201, headers: jsonHeaders(req) });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: jsonHeaders(req) });
    }
    if (error instanceof AIRequestGatewayError) {
      return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...jsonHeaders(req) } });
    }
    if (error instanceof WebsiteAccessError) return NextResponse.json({ error: error.message }, { status: error.status, headers: jsonHeaders(req) });
    logger.error('Website generation failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    });
    return NextResponse.json({ error: 'Website generation is unavailable. Please try again shortly.' }, { status: 500, headers: jsonHeaders(req) });
  }
}

export const runtime = 'nodejs';