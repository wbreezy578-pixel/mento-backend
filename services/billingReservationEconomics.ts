/** A pending text reply has no measured usage; actual pricing happens at finalization. */
export function isZeroCostPendingGeminiChatReservation(input: {
  feature: string;
  provider: string;
  pending: boolean;
  tokensInput: number;
  tokensOutput: number;
  tokensCached: number;
  tokensThinking: number;
  tokensTotal: number;
  secondsUsed: number;
}): boolean {
  return (input.feature === 'chat' || input.feature === 'spreadsheet')
    && input.provider === 'Gemini'
    && input.pending
    && input.tokensInput === 0
    && input.tokensOutput === 0
    && input.tokensCached === 0
    && input.tokensThinking === 0
    && input.tokensTotal === 0
    && input.secondsUsed === 0;
}
