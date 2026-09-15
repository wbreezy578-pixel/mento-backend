// =======================================
// MENTO AI CONFIGURATION
// =======================================

export const AI_CONFIG = {
  CHAT_MODEL: "gemini-3.5-flash-lite",
  IMAGE_MODEL: "gemini-3.5-flash",
  LIVE_TUTOR_MODEL: "gemini-3.5-flash",
  TITLE_MODEL: "gemini-3.5-flash",
  SUMMARY_MODEL: "gemini-3.5-flash",

  // Generation Settings
  TEMPERATURE: 0.7,

  TOP_P: 0.95,

  TOP_K: 40,

  MAX_OUTPUT_TOKENS: 1024,
  CHAT_MAX_OUTPUT_TOKENS: 1024,
  LIVE_TUTOR_MAX_OUTPUT_TOKENS: 512,
  IMAGE_MAX_OUTPUT_TOKENS: 4096,

  // Retry
  MAX_RETRIES: 2,

  RETRY_DELAY_MS: 800,

  GEMINI_TIMEOUT_MS: 30000,

  // Safety

  BLOCK_DANGEROUS_CONTENT: true,

  BLOCK_HATE_SPEECH: true,

  BLOCK_HARASSMENT: true,

  BLOCK_SEXUAL_CONTENT: true,

  BLOCK_SELF_HARM: true,

  // Streaming

  ENABLE_STREAMING: true,

  // Images

  MAX_FREE_IMAGES_PER_DAY: 3,

  MAX_PREMIUM_IMAGES_PER_DAY: 100,

  MAX_IMAGE_SIZE_MB: 10,

  ALLOWED_IMAGE_TYPES: [
    "image/jpeg",
    "image/png",
    "image/webp"
  ]
};