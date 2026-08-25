import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "app/lib/chatScroll.test.ts",
      "app/lib/notificationNavigator.test.ts",
      "app/lib/aiSafety.test.ts",
      "lib/supportReport.test.ts",
      "app/api/payments/paymentSecurity.test.ts",
      "lib/authSession.test.ts",
      "services/liveTutorGeminiLiveService.test.ts",
      "services/liveTutorAudioProtocol.test.ts",
      "services/liveTutorVoiceFoundation.test.ts",
      "services/liveTutorVoiceGateway.test.ts",
      "services/liveTutorVoiceProfiles.test.ts",
      "services/dataRetentionService.test.ts",
      "lib/legalConsent.test.ts",
    ],
    exclude: [
      "node_modules/**",
      "scripts/**",
    ],
  },
});
