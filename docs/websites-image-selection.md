# Website image uploads

The website creator uses a user-led image workflow:

1. Gemini turns the business name and short description into image requirements. It does not generate the website at this stage.
2. For each suggested image requirement, the user can upload a photo, choose a stock photo, generate an image with Imagen, or continue without an image.
3. After the user enters the full website prompt, generation remains behind the existing Pro check. Uploaded photos are added to the generated draft through the authenticated image-upload endpoint.
4. Publishing bundles uploaded image bytes into the immutable R2 deployment.

## Storage and deployment

Uploaded image originals are stored privately in the configured `WEBSITE_ASSETS_BUCKET` and private R2 asset objects are stored under `websites/{websiteId}/assets/{assetId}/image.jpg`. Publishing bundles the saved image bytes under the immutable deployment prefix and references them through the deployment manifest.

Imagen uses the Vertex AI model `imagen-4.0-fast-generate-001` from the backend only; the mobile app never receives Google Cloud credentials. Configure `VERTEX_AI_PROJECT_ID`, `VERTEX_AI_LOCATION`, server-side Google Application Default Credentials with Vertex AI access, and billing in that Google Cloud project before enabling generation. Imagen generation is limited to 15 images per user per UTC calendar month, shared across their websites. Failed provider calls release their reserved quota; a successfully generated image counts even if later storage or website persistence fails.

The `WebsiteAsset` source metadata and private R2 key require the migration `20261006160000_add_website_asset_source_metadata`. Monthly Imagen allowances require `20261016143700_add_website_image_generation_quota`. Image saving also requires the existing private asset bucket and the R2 deployment configuration. Apply migrations and configure these server-side settings through the normal release process; the implementation change alone does not apply migrations or deploy services.

Previously saved Pixabay assets remain readable and publishable for existing websites; new Pixabay searches and selections are no longer supported.
