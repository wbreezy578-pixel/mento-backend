import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
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
import { buildTutorLanguageInstruction, getTutorLanguage } from '../../../../lib/userSettings';
import { applyWebsiteDesignPreferences, buildWebsiteTrustInstruction, isWebsiteType, parseWebsiteContact, parseWebsiteContent, WebsiteContentParseError, type WebsiteContent, type WebsiteType } from '../../../../services/websiteContent';
import { buildCompactWebsiteGenerationInstruction, buildWebsiteGenerationResponseSchema, buildWebsiteGenerationSchemaInstruction } from '../../../../services/websiteDesignSystem';
import { parseWebsiteDesignPreferences, type WebsiteDesignPreferences } from '../../../../services/websiteDesignPreferences';
import type { WebsiteAssetCreateData } from '../../../../services/websiteAssetService';
import { buildWebsiteApiView } from '../../../../services/websiteAssetApi';
import { createDraftWebsiteSlug, slugifyWebsiteName } from '../../../../services/websiteDeploymentService';
import { assertWebsiteFeatureAccess, createWebsiteWithinProLimit, WebsiteAccessError } from '../../../../services/websiteBillingService';
import { getVerifiedUnsplashPhoto, trackUnsplashPhotoDownload, UnsplashSearchError, type VerifiedUnsplashPhoto } from '../../../../services/unsplashService';
import { isWebsTestingMode } from '../../../../services/websiteTestingMode';

const CORS_METHODS = 'POST, OPTIONS';
const MAX_BODY_BYTES = 32 * 1024;
const MAX_PROMPT_LENGTH = 7000;
const MAX_RESTAURANT_MENU_ITEMS = 24;
const MAX_MENU_CATEGORIES = 12;

interface GeneratedWebsite {
  content: WebsiteContent;
  assets: WebsiteAssetCreateData[];
}

interface SelectedImageInput {
  requirementId: string;
  role: 'hero' | 'gallery' | 'menu_item' | 'section';
  query: string;
  alt: string;
  source: 'user_upload' | 'unsplash';
  photoId?: string;
  targetId?: string;
}

interface RequestedMenuItem {
  id: string;
  category: string;
  name: string;
  description: string;
  price: string;
  currency: string;
}

function parseRequestedMenuItems(value: unknown): RequestedMenuItem[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RESTAURANT_MENU_ITEMS) return null;
  const ids = new Set<string>();
  const items: RequestedMenuItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const category = typeof item.category === 'string' && item.category.trim() ? item.category.trim() : 'Main Dishes';
    const description = typeof item.description === 'string' ? item.description.trim() : '';
    const price = typeof item.price === 'string' ? item.price.trim() : '';
    const currency = typeof item.currency === 'string' && item.currency.trim() ? item.currency.trim() : 'KSh';
    if (
      !/^[A-Za-z0-9_-]{1,80}$/.test(id) || ids.has(id)
      || !name || name.length > 100 || category.length > 60 || description.length > 240
      || price.length > 16 || (price && !/^\d{1,9}(?:[.,]\d{1,2})?$/.test(price))
      || !/^[\p{L}]{1,8}$/u.test(currency)
    ) return null;
    ids.add(id);
    items.push({ id, category, name, description, price, currency });
  }
  if (new Set(items.map((item) => item.category)).size > MAX_MENU_CATEGORIES) return null;
  return items;
}

function parseSelectedImages(value: unknown): SelectedImageInput[] | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const ids = new Set<string>();
  const selections: SelectedImageInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.requirementId !== 'string'
      || !/^[a-z0-9][a-z0-9_-]{0,59}$/.test(entry.requirementId)
      || ids.has(entry.requirementId)
      || !['hero', 'gallery', 'menu_item', 'section'].includes(String(entry.role))
      || typeof entry.query !== 'string' || !entry.query.trim() || entry.query.length > 120
      || typeof entry.alt !== 'string' || !entry.alt.trim() || entry.alt.length > 180
      || !['user_upload', 'unsplash'].includes(String(entry.source))
      || (entry.source === 'unsplash' && (
        typeof entry.photoId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(entry.photoId)
      ))
      || (entry.source === 'user_upload' && entry.photoId !== undefined)
      || (entry.targetId !== undefined && (
        typeof entry.targetId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(entry.targetId)
        || entry.role !== 'menu_item'
      ))
    ) return null;
    ids.add(entry.requirementId);
    selections.push({
      requirementId: entry.requirementId,
      role: entry.role as SelectedImageInput['role'],
      query: entry.query.trim(),
      alt: entry.alt.trim(),
      source: entry.source as SelectedImageInput['source'],
      ...(entry.source === 'unsplash' ? { photoId: entry.photoId as string } : {}),
      ...(typeof entry.targetId === 'string' ? { targetId: entry.targetId } : {}),
    });
  }
  return selections;
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
  let persistedWebsite: { id: string; content: unknown } | null = null;
  try {
    const user = await authenticateAIRequest(req);
    const userId = user.id;
    const clientIp = getClientIp(req);
    await enforceAIGatewayRateLimit(userId, clientIp);

    let body: { title?: unknown; type?: unknown; brief?: unknown; fullPrompt?: unknown; selectedImages?: unknown; menuItems?: unknown; businessDetails?: unknown; designPreferences?: unknown; requestId?: unknown };
    try {
      body = await readJsonBodyWithLimit(req, MAX_BODY_BYTES);
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : new RequestBodyError('Invalid JSON body.', 400, 'invalid_json');
      return NextResponse.json({ error: bodyError.message, code: bodyError.code }, { status: bodyError.status, headers: jsonHeaders(req) });
    }

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
    const fullPrompt = typeof body.fullPrompt === 'string' ? body.fullPrompt.trim() : '';
    const selectedImages = parseSelectedImages(body.selectedImages);
    const requestedMenuItems = parseRequestedMenuItems(body.menuItems);
    const validType = isWebsiteType(body.type);
    const designPreferences = isWebsiteType(body.type) ? parseWebsiteDesignPreferences(body.designPreferences, body.type) : null;
    const businessDetails = parseWebsiteContact(body.businessDetails ?? {
      address: '', phone: '', whatsappNumber: '', mapsUrl: '', email: '',
      openingHours: '', serviceArea: '', servicesAndPricing: '', testimonials: '', bookingUrl: '',
    });
    if (!title || title.length > 100 || !brief || brief.length > 600 || !fullPrompt || fullPrompt.length > MAX_PROMPT_LENGTH || !validType || !selectedImages || !requestedMenuItems || !businessDetails || !designPreferences || (body.type !== 'restaurant' && requestedMenuItems.length > 0)) {
      logger.warn('Website generation request rejected', {
        category: 'website_generation_request_rejected',
        reasonCode: 'invalid_website_request',
      });
      return NextResponse.json({ error: 'Add a website name, supported type, short description, full website prompt, valid business details, and image selections.', code: 'invalid_website_request' }, { status: 400, headers: jsonHeaders(req) });
    }
    if (body.designPreferences !== undefined && (
      (designPreferences.heroImageMode === 'none' && selectedImages.some((selection) => selection.role === 'hero'))
      || (designPreferences.heroImageMode !== 'none' && !selectedImages.some((selection) => selection.role === 'hero'))
    )) {
      logger.warn('Website generation request rejected', {
        category: 'website_generation_request_rejected',
        reasonCode: 'hero_image_mode_mismatch',
      });
      return NextResponse.json({ error: 'Choose a hero photo when using it as a background or beside the text, or choose “No hero photo”.', code: 'hero_image_mode_mismatch' }, { status: 400, headers: jsonHeaders(req) });
    }
    const requestedMenuIds = new Set(requestedMenuItems.map((item) => item.id));
    if (selectedImages.some((selection) => selection.role === 'menu_item' && selection.targetId && !requestedMenuIds.has(selection.targetId))) {
      logger.warn('Website generation request rejected', {
        category: 'website_generation_request_rejected',
        reasonCode: 'invalid_menu_image_target',
      });
      return NextResponse.json({ error: 'A selected menu photo does not match a menu item in this request.', code: 'invalid_menu_image_target' }, { status: 400, headers: jsonHeaders(req) });
    }
    if (!slugifyWebsiteName(title)) {
      logger.warn('Website generation request rejected', {
        category: 'website_generation_request_rejected',
        reasonCode: 'invalid_website_slug',
      });
      return NextResponse.json({ error: 'Choose a website name that can be used in a website address.', code: 'invalid_website_slug' }, { status: 400, headers: jsonHeaders(req) });
    }
    const draftSlug = createDraftWebsiteSlug(title);
    const websiteId = randomUUID();

    try {
      await assertWebsiteFeatureAccess(userId, 'create');
    } catch (error) {
      if (error instanceof WebsiteAccessError) {
        return NextResponse.json({ error: error.message }, { status: error.status, headers: jsonHeaders(req) });
      }
      throw error;
    }

    const unsplashSelections = selectedImages.filter((selection) => selection.source === 'unsplash');
    if (unsplashSelections.length && !isWebsTestingMode()) {
      return NextResponse.json({ error: 'Mento photos are unavailable.', code: 'photo_source_unavailable' }, { status: 404, headers: jsonHeaders(req) });
    }
    const verifiedPhotos = new Map<string, VerifiedUnsplashPhoto>();
    try {
      const verified = await Promise.all(unsplashSelections.map((selection) => getVerifiedUnsplashPhoto(selection.photoId!)));
      unsplashSelections.forEach((selection, index) => verifiedPhotos.set(selection.requirementId, verified[index]));
    } catch (error) {
      logger.warn('Selected Unsplash photo could not be verified', {
        category: 'unsplash_photo_verification_failed',
        reasonCode: error instanceof UnsplashSearchError ? error.kind : 'verification_failed',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      if (error instanceof UnsplashSearchError && error.kind !== 'invalid_response') {
        const status = error.kind === 'rate_limited' || error.kind === 'demo_rate_limited' ? 429 : 503;
        return NextResponse.json({
          error: 'Mento photos are temporarily unavailable. Try again shortly.',
          code: 'photo_provider_unavailable',
          retryable: true,
        }, {
          status,
          headers: {
            ...jsonHeaders(req),
            ...(error.retryAfterSec ? { 'Retry-After': String(Math.ceil(error.retryAfterSec)) } : {}),
          },
        });
      }
      return NextResponse.json({
        error: 'One of the selected photos is no longer available. Search again and choose another photo.',
        code: 'unsplash_photo_unavailable',
      }, { status: 422, headers: jsonHeaders(req) });
    }

    const requestId = requireClientAIRequestId(req, body.requestId);
    const prompt = JSON.stringify({ type: body.type, title, brief, fullPrompt, designPreferences: body.designPreferences, businessDetails, menuItems: requestedMenuItems, selectedImages });
    const securityDecision = await secureAITextInput({ userId, requestId, ip: clientIp, input: prompt });

    const { billingDecision } = await executeAIRequest<GeneratedWebsite>({
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
        const selectedImageInstructions = selectedImages.map((selection) => ({
            requirementId: selection.requirementId,
            role: selection.role,
            ...(selection.targetId ? { targetId: selection.targetId } : {}),
            query: selection.query,
            alt: selection.alt,
            provider: selection.source,
          }));
        const menuInstructions = requestedMenuItems.length
          ? `\n\nPreserve these user-provided menu names and prices exactly:\n${JSON.stringify(requestedMenuItems)}`
          : '';
        const userPrompt = `${brief}\n\n${fullPrompt}\n\nStructured design direction (honor these exact safe options):\n${JSON.stringify(designPreferences)}\n\nOwner-provided trust details (preserve exactly; omit empty values):\n${JSON.stringify(businessDetails)}${menuInstructions}\n\nSelected image assets (use these exact requirement IDs, roles, and menu targets; do not substitute or invent image URLs):\n${JSON.stringify(selectedImageInstructions)}`;
        const language = await getTutorLanguage(userId);
        const generationContents: GeminiMessage[] = [
          {
            role: 'system',
            parts: [{
              text: `${buildTutorLanguageInstruction(language)}\nCreate Mento Webs structured content. Follow the output schema and safety requirements in the request. Return JSON only; never emit HTML, CSS, JavaScript, or executable code.`,
            }],
          },
          {
            role: 'user',
            parts: [{
              text: `${sanitizedInput ?? userPrompt}\n\n${buildCompactWebsiteGenerationInstruction(body.type as WebsiteType)}\n${buildWebsiteTrustInstruction()}\n\n${buildWebsiteGenerationSchemaInstruction()}`,
            }],
          },
        ];
        let attemptedModel: string | null = null;
        const reportModelAttempt = async (model: string) => {
          attemptedModel = model;
          return reportProviderAttempt(model);
        };
        const model = decision.modelUsed ?? undefined;
        const generationOptions = {
          responseMimeType: 'application/json',
          responseJsonSchema: buildWebsiteGenerationResponseSchema(selectedImages),
          maxOutputTokens: 8192,
        };
        const response = await askGemini(generationContents, model, reportUsage, reportModelAttempt, req.signal, generationOptions);
        let parsed: WebsiteContent;
        try {
          parsed = parseWebsiteContent(response, body.type as WebsiteType);
        } catch (error) {
          logger.warn('Website generation response rejected', {
            category: 'website_generation_output_rejected',
            stage: 'initial',
            reasonCode: error instanceof WebsiteContentParseError ? error.code : 'unknown_validation_error',
            providerModel: attemptedModel ?? 'unknown',
            responseBytes: Buffer.byteLength(response, 'utf8'),
          });
          const repairedResponse = await askGemini([
            ...generationContents,
            { role: 'model', parts: [{ text: response }] },
            { role: 'user', parts: [{ text: `The previous website response failed validation (${error instanceof WebsiteContentParseError ? error.code : 'unknown_validation_error'}). Return a complete corrected JSON object that matches the supplied schema. Preserve the requested content and selected image-slot assignments. Do not return HTML, CSS, JavaScript, or explanations.` }] },
          ], model, reportUsage, reportModelAttempt, req.signal, generationOptions);
          try {
            parsed = parseWebsiteContent(repairedResponse, body.type as WebsiteType);
          } catch (repairError) {
            logger.warn('Website generation repair response rejected', {
              category: 'website_generation_output_rejected',
              stage: 'repair',
              reasonCode: repairError instanceof WebsiteContentParseError ? repairError.code : 'unknown_validation_error',
              providerModel: attemptedModel ?? 'unknown',
              responseBytes: Buffer.byteLength(repairedResponse, 'utf8'),
            });
            throw repairError;
          }
        }
        parsed = body.designPreferences !== undefined
          ? applyWebsiteDesignPreferences(parsed, designPreferences as WebsiteDesignPreferences)
          : parsed;
        parsed = { ...parsed, contact: businessDetails };
        const parsedSlots = new Map(parsed.imageSlots.map((slot) => [slot.id, slot]));
        if (parsed.imageSlots.length !== selectedImages.length) {
          throw new Error('Gemini did not preserve your image choices. Please try generating again.');
        }
        for (const selection of selectedImages) {
          const slot = parsedSlots.get(selection.requirementId);
          if (!slot || slot.role !== selection.role) {
            throw new Error(`Gemini could not attach the selected ${selection.role} image to its required website section. Please try generating again.`);
          }
        }

        const menuItemIdByRequestId = new Map<string, string>();
        if (requestedMenuItems.length) {
          const selectedMenuSlotByTarget = new Map(
            selectedImages
              .filter((selection) => selection.role === 'menu_item' && selection.targetId)
              .map((selection) => [selection.targetId!, selection.requirementId]),
          );
          const groupedItems = new Map<string, RequestedMenuItem[]>();
          for (const item of requestedMenuItems) {
            const group = groupedItems.get(item.category) ?? [];
            group.push(item);
            groupedItems.set(item.category, group);
          }
          const menuCategories = [...groupedItems.entries()].map(([category, items]) => ({
            id: `category-${randomUUID()}`,
            name: category,
            items: items.map((item) => {
              const id = `menu-${randomUUID()}`;
              menuItemIdByRequestId.set(item.id, id);
              return {
                id,
                name: item.name,
                description: item.description,
                price: item.price,
                currency: item.currency,
                imageUrl: null,
                imageSlotId: selectedMenuSlotByTarget.get(item.id) ?? null,
                available: true,
              };
            }),
          }));
          parsed = { ...parsed, menuCategories };
        }

        const assets: WebsiteAssetCreateData[] = selectedImages.flatMap((selection): WebsiteAssetCreateData[] => {
          const photo = verifiedPhotos.get(selection.requirementId);
          if (!photo) return [];
          return [{
            id: randomUUID(),
            slotId: selection.requirementId,
            source: 'unsplash',
            providerAssetId: photo.id,
            objectKey: null,
            remoteUrl: photo.imageUrl,
            providerImageUrl: photo.imageUrl,
            providerTags: [],
            searchQuery: selection.query,
            retrievedAt: new Date(),
            licenseName: 'Unsplash License',
            licenseUrl: 'https://unsplash.com/license',
            attributionRequired: true,
            version: 1,
            sourcePageUrl: photo.sourcePageUrl,
            creatorName: photo.creatorName,
            creatorProfileUrl: photo.creatorProfileUrl,
            alt: selection.alt || photo.alt,
            mimeType: 'image/jpeg',
            width: photo.width || null,
            height: photo.height || null,
          }];
        });
        const heroSelection = selectedImages.find((selection) => selection.role === 'hero');
        const sectionSelections = selectedImages.filter((selection) => selection.role === 'section');
        const assignedSectionIds = new Set<string>();
        const nextPages = parsed.pages.map((page) => ({
          ...page,
          sections: page.sections.map((section) => {
            if (heroSelection && section.type === 'hero') {
              return { ...section, imageSlotId: heroSelection.requirementId };
            }
            const explicitSelection = ['about', 'services'].includes(section.type)
              ? sectionSelections.find((selection) => selection.requirementId === section.imageSlotId)
              : undefined;
            if (explicitSelection) {
              assignedSectionIds.add(explicitSelection.requirementId);
              return { ...section, imageSlotId: explicitSelection.requirementId };
            }
            if (section.type === 'about' || section.type === 'services') {
              const nextSelection = sectionSelections.find((selection) => !assignedSectionIds.has(selection.requirementId));
              if (nextSelection) {
                assignedSectionIds.add(nextSelection.requirementId);
                return { ...section, imageSlotId: nextSelection.requirementId };
              }
            }
            return section;
          }),
        }));
        const homePage = nextPages[0];
        const appendHomeSection = (section: typeof homePage.sections[number]) => {
          if (homePage.sections.length >= 12) return false;
          homePage.sections.push(section);
          return true;
        };
        const usedSectionIds = new Set(nextPages.flatMap((page) => page.sections.map((section) => section.id)));
        const createSectionId = (base: string) => {
          const stem = base.slice(0, 70);
          let candidate = stem;
          let suffix = 2;
          while (usedSectionIds.has(candidate)) {
            candidate = `${stem}-${suffix}`.slice(0, 80);
            suffix += 1;
          }
          usedSectionIds.add(candidate);
          return candidate;
        };
        if (heroSelection && !nextPages.some((page) => page.sections.some((section) => section.type === 'hero'))) {
          if (homePage.sections.length < 12) {
            homePage.sections.unshift({
              id: createSectionId(`hero-${heroSelection.requirementId}`),
              type: 'hero',
              title: parsed.title,
              body: parsed.description,
              imageSlotId: heroSelection.requirementId,
            });
          } else {
            homePage.sections[0] = { ...homePage.sections[0], imageSlotId: heroSelection.requirementId };
          }
        }
        for (const selection of sectionSelections.filter((item) => !assignedSectionIds.has(item.requirementId))) {
          if (appendHomeSection({
            id: createSectionId(`about-${selection.requirementId}`),
            type: 'about',
            title: selection.alt,
            body: '',
            imageSlotId: selection.requirementId,
          })) assignedSectionIds.add(selection.requirementId);
        }
        if (selectedImages.some((selection) => selection.role === 'gallery') && !nextPages.some((page) => page.sections.some((section) => section.type === 'gallery'))) {
          appendHomeSection({
            id: createSectionId('selected-image-gallery'),
            type: 'gallery',
            title: 'Gallery',
            body: '',
            imageSlotId: null,
          });
        }
        if (selectedImages.some((selection) => selection.role === 'menu_item') && !nextPages.some((page) => page.sections.some((section) => section.type === 'menu'))) {
          appendHomeSection({
            id: createSectionId('selected-image-menu'),
            type: 'menu',
            title: 'Featured',
            body: '',
            imageSlotId: null,
          });
        }
        const nextSlots = parsed.imageSlots.map((slot) => {
          const selection = selectedImages.find((item) => item.requirementId === slot.id);
          if (!selection) return slot;
          const targetSection = nextPages.flatMap((page) => page.sections).find((section) =>
            section.imageSlotId === selection.requirementId
            && ['hero', 'about', 'services'].includes(section.type),
          );
          const targetGallery = selection.role === 'gallery'
            ? nextPages.flatMap((page) => page.sections).find((section) => section.type === 'gallery')
            : undefined;
          return {
            ...slot,
            query: selection.query,
            alt: selection.alt,
            role: selection.role,
            targetId: selection.role === 'menu_item' && selection.targetId
              ? menuItemIdByRequestId.get(selection.targetId) ?? slot.targetId
              : targetSection?.id ?? targetGallery?.id ?? slot.targetId,
          };
        });
        const nextMenuCategories = parsed.menuCategories.map((category) => ({
          ...category,
          items: category.items.map((item) => {
            const menuSelection = selectedImages.find((selection) =>
              selection.role === 'menu_item'
              && (selection.targetId ? menuItemIdByRequestId.get(selection.targetId) === item.id : selection.requirementId === item.imageSlotId),
            );
            return menuSelection ? { ...item, imageSlotId: menuSelection.requirementId } : item;
          }),
        }));
        const contentWithAssets = {
          ...parsed,
          pages: nextPages,
          menuCategories: nextMenuCategories,
          imageSlots: nextSlots.map((slot) => {
            const asset = assets.find((candidate) => candidate.slotId === slot.id);
            return asset ? { ...slot, assetId: asset.id } : slot;
          }),
        };
        return { content: contentWithAssets, assets };
      },
      beforeFinalize: async ({ content: generatedContent, assets }) => {
        persistedWebsite = await createWebsiteWithinProLimit(userId, async (tx) => tx.website.create({
          data: {
            id: websiteId,
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
    const trackedPhotos = [...verifiedPhotos.values()];
    const trackingResults = await Promise.allSettled(trackedPhotos.map((photo) => trackUnsplashPhotoDownload(photo.downloadLocation)));
    const trackingFailures = trackingResults.filter((result) => result.status === 'rejected').length;
    if (trackingFailures) {
      logger.error('Unsplash download tracking failed after website image selection', {
        category: 'unsplash_download_tracking_failed',
        failureCount: trackingFailures,
      });
    }
    return NextResponse.json({
      website: await buildWebsiteApiView(persistedWebsite),
      billing: billingDecision,
    }, { status: 201, headers: jsonHeaders(req) });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: jsonHeaders(req) });
    }
    if (error instanceof AIRequestGatewayError) {
      const body = error.body && typeof error.body === 'object' && !Array.isArray(error.body)
        ? error.body as Record<string, unknown>
        : null;
      const reasonCode = typeof body?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(body.code)
        ? body.code
        : 'gateway_rejected';
      logger.warn('Website generation blocked by AI gateway', {
        category: 'website_generation_gateway_rejected',
        status: error.status,
        reasonCode,
      });
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
