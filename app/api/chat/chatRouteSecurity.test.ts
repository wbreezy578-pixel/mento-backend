import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function routeSource(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('normal chat route security ordering', () => {
  it.each(['app/api/chat/route.ts', 'app/api/chat/stream/route.ts'])(
    'secures user input before creating or persisting a conversation in %s',
    (relativePath) => {
      const source = routeSource(relativePath);
      const securityIndex = source.indexOf('await secureAITextInput({');
      const persistenceIndex = source.indexOf('claimInitialChatOperation({');
      expect(securityIndex).toBeGreaterThan(-1);
      expect(persistenceIndex).toBeGreaterThan(securityIndex);
    },
  );

  it('uses sanitized input to construct regeneration contents', () => {
    const source = routeSource('app/api/chat/message/regenerate/route.ts');
    expect(source).toContain('callback: async ({ billingDecision, sanitizedInput, reportUsage, reportProviderAttempt })');
    expect(source).toContain('const safePrompt = sanitizedInput ?? regeneratePrompt.trim()');
    expect(source).toContain('text: `${safePrompt}${modeInstruction}`');
  });
});

describe('normal chat source boundaries', () => {
  it.each([
    'app/api/chat/message/edit/route.ts',
    'app/api/chat/message/delete/route.ts',
    'app/api/chat/message/feedback/route.ts',
    'app/api/chat/message/regenerate/route.ts',
  ])('rejects Live Tutor messages in %s', (relativePath) => {
    const source = routeSource(relativePath);
    expect(source).toContain("source !== 'chat'");
  });

  it.each(['app/api/chat/route.ts', 'app/api/chat/stream/route.ts'])(
    'binds existing conversations to normal chat in %s',
    (relativePath) => {
      const source = routeSource(relativePath);
      expect(source).toContain("validateConversationOwnership(conversationId, userId, 'chat')");
    },
  );
});
