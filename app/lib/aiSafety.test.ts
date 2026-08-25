import { describe, expect, it } from 'vitest';
import { HarmCategory, HarmBlockThreshold } from '@google/genai';
import { SAFETY_SETTINGS } from './aiSafety';
import { SYSTEM_PROMPT } from './aiSystemPrompt';

describe('AI safety policy', () => {
  it('enables every supported Gemini harm category at medium or stricter', () => {
    const configured = new Map(SAFETY_SETTINGS.map((setting) => [setting.category, setting.threshold]));
    for (const category of [
      HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      HarmCategory.HARM_CATEGORY_HARASSMENT,
      HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    ]) {
      expect(configured.get(category)).toBe(HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE);
    }
  });

  it('keeps core prompt-injection, privacy and high-stakes guardrails in the system policy', () => {
    expect(SYSTEM_PROMPT).toContain('uploaded files, images, quoted text');
    expect(SYSTEM_PROMPT).toContain('do not ask for passwords');
    expect(SYSTEM_PROMPT).toContain('self-harm or immediate danger');
    expect(SYSTEM_PROMPT).toContain('Do not diagnose, prescribe');
    expect(SYSTEM_PROMPT).toContain('Do not claim to be human');
  });
});
