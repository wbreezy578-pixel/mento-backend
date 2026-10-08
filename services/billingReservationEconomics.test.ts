import { describe, expect, it } from 'vitest';
import { isZeroCostPendingGeminiChatReservation } from './billingReservationEconomics';

const pendingChat = {
  feature: 'chat',
  provider: 'Gemini',
  pending: true,
  tokensInput: 0,
  tokensOutput: 0,
  tokensCached: 0,
  tokensThinking: 0,
  tokensTotal: 0,
  secondsUsed: 0,
};

describe('zero-cost pending Gemini text reservation', () => {
  it('skips a pricing lookup before measured chat or spreadsheet usage exists', () => {
    expect(isZeroCostPendingGeminiChatReservation(pendingChat)).toBe(true);
    expect(isZeroCostPendingGeminiChatReservation({ ...pendingChat, tokensInput: 1 })).toBe(false);
    expect(isZeroCostPendingGeminiChatReservation({ ...pendingChat, tokensOutput: 1 })).toBe(false);
    expect(isZeroCostPendingGeminiChatReservation({ ...pendingChat, tokensThinking: 1 })).toBe(false);
    expect(isZeroCostPendingGeminiChatReservation({ ...pendingChat, tokensTotal: 1 })).toBe(false);
  });

  it('keeps priced and non-chat operations on the existing path', () => {
    expect(isZeroCostPendingGeminiChatReservation({ ...pendingChat, pending: false })).toBe(false);
    expect(isZeroCostPendingGeminiChatReservation({ ...pendingChat, feature: 'image' })).toBe(false);
    expect(isZeroCostPendingGeminiChatReservation({ ...pendingChat, feature: 'live_tutor' })).toBe(false);
    expect(isZeroCostPendingGeminiChatReservation({ ...pendingChat, provider: 'OpenAI' })).toBe(false);
  });
});
