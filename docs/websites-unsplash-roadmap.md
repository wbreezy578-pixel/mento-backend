# Mento Webs Unsplash roadmap

## Readiness assessment

The three primary Webs screens are a suitable home for this workflow; a separate photo-search app or fourth screen is not necessary:

- **Webs home** remains the website list and entry point. It does not need to own photo search.
- **Website creation** has a details → image selection → website prompt flow. The image step now supports uploads, Unsplash search, and mixing sources per requirement.
- **Website editor** supports adding, replacing, and removing photos on hero, gallery, section, and menu-item slots. Preview and publish are modes within this screen; photo controls offer uploads, Unsplash search, and Imagen generation.

The core Unsplash selection path is implemented across creation, editor replacement, preview, persistence, and static publishing. It is deployed to the isolated Blue test tag (revision `mento-backend-blue-00015-bul`) without shifting ordinary Blue traffic. Public/commercial use remains gated on testing and production API approval/terms review.

## Roadmap

### 0. Confirm launch and credential constraints

- Use the demo application only for development and controlled internal testing on the isolated Blue backend.
- Keep the Access Key in backend-only configuration under `UNSPLASH_ACCESS_KEY`; inject the demo key from Blue's Secret Manager reference. Never put it in the mobile app, website HTML, or published site.
- Do not configure or use the Secret Key for public photo search unless an explicitly required OAuth flow is designed.
- Confirm Unsplash's current API, attribution, download-tracking, rate-limit, and commercial-use requirements before public release of the paid website builder.
- Do not enable this demo-key setup on Canary or production. Public/commercial use remains a separate release decision.

**Exit criteria:** credentials are stored outside source control and the team has an approved understanding of production/commercial use and current limits.

### Blue-only payment-free website testing

- The internal Blue APK is the only non-development build with Webs enabled. Blue Play-testing AAB, Canary, and production builds keep Webs disabled.
- To enable payment-free testing, configure only the isolated Blue backend with `MENTO_BACKEND_ENV=blue` and `WEBS_TEST_MODE=true`. The service rejects the test-mode flag if the backend environment is not Blue.
- Blue test mode bypasses Webs Pro/hosting checks and user AI usage charges for Webs operations; it still keeps authenticated access, abuse rate limits, AI safety checks, provider budget controls, image/publish validation, and usage telemetry.
- This mode waives Webs AI usage charges for draft generation/testing. Publishing remains disabled because the current website host provisions production `trymentoapp.com` domains; do not use that path for staging.
- Do not set `WEBS_TEST_MODE=true` on Canary or production.

### 1. Add a protected backend search service

- Implemented locally: an authenticated, Blue-test-only `/api/websites/images/search` endpoint calls Unsplash `GET /search/photos`; the mobile client does not call Unsplash directly.
- Implemented locally: query length is limited to 100 characters, page to 1-100, results per page to 1-20, and orientation is validated. Results are restricted to HTTPS Unsplash image and attribution URLs.
- Implemented locally: searches are limited to 10 per user per minute using the existing Redis-backed limiter in strict distributed mode. Provider cache misses also use a shared 45-requests-per-hour ceiling to leave headroom under Unsplash's demo limit of 50 requests per hour. Successful responses are cached in shared Redis for 30 minutes using a hashed key containing the normalized query, page, result count, and orientation.
- Implemented and deployed to Blue test revision `mento-backend-blue-00015-bul`: provider errors map to safe retryable responses; the key and raw provider errors are not returned or logged. Download tracking remains server-side and is called only after image persistence.
- Blue has an `UNSPLASH_ACCESS_KEY` Secret Manager binding. The endpoint is hidden outside Blue Webs test mode; do not configure the demo key on Canary or production. Ordinary Blue traffic remains on its prior revision.
- Keep upload-only creation usable when Unsplash is unavailable or the demo limit is reached.

**Exit criteria:** focused search, provider, caching, and static-publish tests pass locally. A credential-backed authenticated smoke test still remains an operational check.

### 2. Add source selection to the creation flow — implemented and deployed to Blue

- The existing image step now offers upload and **Search Mento photos** per requirement; users can combine sources across requirements or leave images unset.
- Search uses the requirement query and orientation, shows bounded results, photographer names, loading/error/empty states, and allows replacing or clearing a selection.
- Images remain optional.
- Restaurant creation accepts up to 24 named, priced menu items and can map a separate image to each item. When no image is selected, automatic photo selection uses each dish's own name and description, prefers distinct photos with a matching orientation and searches for up to 8 dishes plus a hero and another website section. Remaining dish photos can be chosen manually; the creation flow explains this limit.
- The search cap keeps automatic selection within the existing 10-search-per-user-per-minute limit. Successful searches still benefit from shared cache, and a failed or unsuitable result leaves that image slot available for manual selection.
- The current visual-quality pass is implemented locally and still needs an isolated Blue test deployment before device-level verification.

**Exit criteria:** targeted route/mobile tests, typechecks, and the Blue backend deployment smoke checks pass. Device-level authenticated end-to-end verification remains.

### 3. Establish stronger typography and spacing — implemented locally

- Preview and published-site styles use a shared 4px-based spacing scale for section padding, component gaps, and vertical rhythm.
- Both renderers use one consistent display-font stack and one body-font stack per design preset, with a responsive heading scale, comfortable body line-height, and balanced heading wraps.
- Hero headings are prominent, section headings are distinct from subheadings, and mobile spacing and heading sizes adjust without changing the design preset.
- Generation guidance now asks for the same font pairing, responsive hierarchy, readable line length, and spacing rhythm rather than arbitrary margins.

**Exit criteria:** preview and published CSS tests plus both project typechecks pass; visual confirmation on a device/browser remains part of Blue testing.

### 4. Create a coherent brand palette — implemented locally

- Website themes now persist a primary brand color, secondary accent, page background, and surface neutral, while older drafts receive a preset-matched default palette.
- Generation guidance establishes the palette from the business and audience before page/component generation; normalization rejects invalid colors and falls back when text contrast would be poor.
- The preview and published-site renderers use those same color roles for brand actions, restrained accents, and neutral surfaces.

**Exit criteria:** palette normalization, preview CSS, and published CSS tests plus both project typechecks pass; visual confirmation across business types remains part of Blue testing.

### 5. Make the website purpose immediately clear — implemented locally

- Generation guidance requires a business-specific hero headline, a concise supporting sentence explaining the value, and one prominent action supported by the supplied business facts.
- Generic welcome/discovery headlines and invented booking, ordering, offer, or contact claims are explicitly disallowed.
- Preview and publishing render one contextual hero action linking to an existing menu, service, portfolio, contact, or WhatsApp destination when that action is supported by the site content.

**Exit criteria:** generation-guidance, preview, and published-output tests plus both project typechecks pass; review generated sites across business types during Blue testing.

### 6. Design generated websites for phones first — implemented locally

- The preview and published site keep all page links reachable in a swipeable mobile navigation row instead of hiding navigation on narrow screens.
- Mobile layouts stack hero content, tune heading and section spacing, preserve intentional image crops, and use separate menu layouts for items with and without photos. Long copy and prices can wrap without forcing page-wide horizontal scrolling.
- Navigation links have 44px touch targets, primary actions have 48px touch targets, and image credits and text remain readable on narrow screens.
- Generation guidance requires layouts to be considered separately for phones and desktop rather than squeezing the desktop composition into a small viewport.
- Preview and published-renderer tests check the mobile rules and accessible navigation; both project typechecks pass. Device/browser visual confirmation remains part of Blue testing.

### Trust-building business details — implemented locally

- Creation collects optional verified contact details, opening hours, service area, services/prices, booking or enquiry links, and exact owner-approved testimonials. Unknown fields are explicitly left blank and can be completed in the editor.
- The website content JSON carries these fields through server generation, local draft persistence, editor updates, preview, and static publishing; no additional database model or migration is needed.
- Generation guidance forbids invented details and testimonials. API validation rejects malformed email addresses and unsafe booking/map URLs; renderers omit empty contact, location, WhatsApp, and menu sections rather than publishing “add this later” or “coming soon” placeholders.
- Restaurant menu items now start empty instead of pre-populating fictional dish names and prices. User-entered trust details render as supplied, with working phone, email, WhatsApp, map, and booking links.
- Focused route, content-normalization, persistence, and renderer tests plus project typechecks cover the new fields. Device-level review remains before Blue rollout.

### 7. Persist provider assets and map them to website slots — implemented locally

- Unsplash is represented as a remote, hotlinked `WebsiteAsset`. The metadata migration `20261006160000_add_website_asset_source_metadata` is required and has been confirmed applied to Blue.
- The server verifies the provider photo ID and records the exact API image URL, photographer/attribution metadata, search query, license metadata, and image-slot association.
- Generation and editor selection persist verified assets without converting them into uploads. The editor selection route checks ownership, slot/target validity, and revision conflicts; it does not invoke AI edit billing.
- Server-side download tracking runs after successful persistence, never when search results are only displayed. Tracking failures are logged and do not undo the saved website.

**Exit criteria:** creation and editor route coverage validates provider verification, metadata persistence, menu-photo mapping, and post-persistence tracking.

### 8. Add editor replacement and preview behavior — implemented locally

- Existing hero, gallery, section, and menu-item photo controls now offer upload, Unsplash search, or Imagen generation/replacement.
- Imagen uses the backend-only Vertex AI `imagen-4.0-fast-generate-001` model and has a shared 15-image per-user UTC calendar-month allowance. Its migration, Vertex project/location, service credentials, and billing must be configured through the normal release process before generation is available in a deployed environment.
- The editor previews the persisted image immediately and displays Unsplash attribution in the local preview; failed searches/selections leave the existing image unchanged.
- Static publishing hotlinks verified Unsplash URLs and includes photographer/source attribution. The mobile draft contract and HTML renderer also recognize Unsplash assets.
- Empty gallery sections no longer render image placeholders, and hero sections without an image use a single-column text layout. Image styles continue using fixed aspect ratios and `object-fit: cover` to crop rather than stretch.

**Exit criteria:** route and renderer tests pass. Device-level editing verification remains; publishing stays disabled during Blue payment-free testing.

### 9. Publish, compliance, and release gate

- The publish asset serializer and static-site renderer accept verified Unsplash assets as remote images. Do not download or proxy these images into Mento storage if Unsplash's current hotlinking rules require direct use of its image URL.
- Required attribution is rendered on published pages and the API-returned image URL is preserved. Confirm the deployment CSP continues to allow the required image host before publishing is enabled.
- Test live published pages on mobile and desktop, including image failure, removed/ unavailable assets, attribution links, and older websites. Verify that user uploads and legacy Pixabay-backed sites still work.
- Before public release, use approved production credentials if required, set operational rate limits, and confirm the paid-builder use is permitted with Unsplash. Keep the feature disabled or fall back to uploads if approval or quota is unavailable.

**Exit criteria:** production-like publish tests pass, attribution and tracking are verified, rate-limit behavior is measured, and the commercial-use/production-approval decision is documented.

## End-to-end acceptance checklist

- No Unsplash credential is present in the APK, API response, logs, generated HTML, or published website.
- Search results are bounded and attributable; users can select, replace, retry, and fall back to uploads.
- A selected image is associated with the intended website slot and its source/credit survive all save and publish paths.
- The official tracking request is made only for qualifying user actions and never blocks upload-only creation.
- Existing upload workflows and previously saved websites remain functional.
- Demo quotas and provider errors do not prevent users from creating drafts with their own photos. Publishing remains disabled in Blue test mode.

### 10. Optimize published websites for speed and search — implemented locally

- Published pages receive a distinct title and description, Open Graph/Twitter metadata, index/follow directives, one primary heading, and hostname-specific canonical URLs.
- Verified Pexels and Unsplash images use width-based `srcset` candidates with responsive `sizes`; hero images load eagerly at high priority and supporting images load lazily. Owner uploads are normalized to optimized JPEGs capped at 2,200 pixels on the longest edge.
- The website router generates a sitemap from published page files and a matching `robots.txt` per published hostname.
- Static publishing validates that every local page/section link and image path resolves and that each page has a title, description, and primary heading. External URL availability still needs live-site monitoring because it cannot be safely guaranteed during static generation.
- Renderer, router, publishing, storage, and mobile preview tests plus project typechecks cover the changes; a live published-site speed and indexing review remains part of release testing.
