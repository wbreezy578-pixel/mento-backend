# Mento Webs quality checklist

Scope: website creation, image selection, safe visual controls, editing, preview, and quality checks. Test changes on `mento-backend-blue` only. Production canary is out of scope.

- [x] Capture the design brief before photo suggestions; pass the same structured style, background palette, hero layout, crop/overlay, and image mood to photo search and website/image generation.
- [x] Provide safe, structured controls for hero image placement, background style, overlay strength, and image crop; never generate arbitrary CSS. Preview and published renderer now share those settings.
- [x] Keep owner uploads first, Unsplash suggestions second, and Gemini image generation an explicit last resort or user-requested option. Suggested Unsplash images now require a large preview and explicit approval; removed silent restaurant photo selection.
- [x] Simplify creation to one guided prompt with optional business details; the generated draft opens the existing live website preview and section editor.
- [x] Add a quality gate for design-preset consistency, readable text/button contrast, mobile layout, missing business information, duplicate/crop review, and explicit manual image-relevance review. Photo labels cannot prove what the pixels depict, so users must confirm the image in preview.
- [ ] Run representative restaurant, service-business, portfolio, and event briefs on `mento-backend-blue`; verify upload → Unsplash approval → explicit AI generation and confirm the production canary is unchanged.

Implementation notes:
- The current website-generation and photo-planning endpoints have separate contracts. The new shared `WebsiteDesignPreferences` contract is intended to keep those stages aligned.
- The implemented items above have focused local tests/typechecks. The Blue-only device/API validation is still pending. Deployment is not part of this checklist.
- The quality check does not use a vision model to judge image pixels; it prompts the owner to confirm each selected image in the live preview.
