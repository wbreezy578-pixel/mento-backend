import { describe, expect, it } from 'vitest';
import { validateSupportReportPayload } from './supportReport';

describe('support report validation', () => {
  it('accepts a bounded report without sensitive transport metadata', () => {
    expect(validateSupportReportPayload({
      category: 'AI Response',
      description: 'The response contained unsafe instructions.',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      appVersion: '1.0.0',
    })).toEqual({
      category: 'AI Response',
      description: 'The response contained unsafe instructions.',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      appVersion: '1.0.0',
    });
  });

  it('rejects unknown categories and undersized descriptions', () => {
    expect(() => validateSupportReportPayload({ category: 'Anything', description: 'A valid description' })).toThrow('valid report category');
    expect(() => validateSupportReportPayload({ category: 'Bug', description: 'short' })).toThrow('between 10 and 4,000');
  });
});
