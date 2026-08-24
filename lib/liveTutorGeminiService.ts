import { fetchWithTimeout } from './resilience';
import logger from './logger';
import {
  createConversation,
  getOrCreateLatestConversation,
  addMessageToConversation,
  getConversationHistoryForAI,
  setConversationTitleIfMissing,
} from './conversationDb';
import { askGeminiLiveTutor, GeminiMessage } from '../services/geminiService';

export interface LiveTutorGeminiService {
  startConversation(): Promise<string>;
  sendMessage(message: string, conversationId: string): Promise<string>;
}

export class RemoteLiveTutorGeminiService implements LiveTutorGeminiService {
  private readonly userId?: string;

  constructor(userId?: string) {
    this.userId = userId;
  }

  async startConversation(): Promise<string> {
    logger.info('[LiveTutorGemini] startConversation started');

    // Browser flow: call the client-facing API routes
    if (typeof window !== 'undefined') {
      const response = await fetchWithTimeout('/api/chat/start', { method: 'POST' }, 15000, 'simli');
      const payload = await response.json();
      if (!response.ok) {
        logger.error('[LiveTutorGemini] startConversation failed (browser)', { status: response.status, error: payload?.error ?? null });
        throw new Error(payload?.error || 'Unable to start a tutor conversation.');
      }
      logger.info('[LiveTutorGemini] startConversation completed (browser)', { conversationId: payload.conversationId });
      return payload.conversationId as string;
    }

    // Server flow: create conversation directly using server-side utilities
    if (!this.userId) {
      throw new Error('Missing user context for server-side conversation creation');
    }

    try {
      const conv = await createConversation(this.userId);
      logger.info('[LiveTutorGemini] startConversation completed', { conversationId: conv.id });
      return conv.id;
    } catch (err) {
      logger.error('[LiveTutorGemini] startConversation failed', { error: String(err) });
      throw err;
    }
  }

  async sendMessage(message: string, conversationId: string): Promise<string> {
    logger.info('[LiveTutorGemini] sendMessage started');

    const activeConversationId = conversationId && conversationId.trim()
      ? conversationId
      : undefined;

    // Browser flow: call the client-facing API route. If no conversationId was
    // established yet, the backend route lazily creates one from the first message.
    if (typeof window !== 'undefined') {
      const response = await fetchWithTimeout('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, ...(activeConversationId ? { conversationId: activeConversationId } : {}) }),
      }, 15000, 'gemini');
      const payload = await response.json();
      if (!response.ok) {
        logger.error('[LiveTutorGemini] sendMessage failed (browser)', { status: response.status, error: payload?.error ?? null });
        throw new Error(payload?.error || 'Failed to get a response.');
      }
      logger.info('[LiveTutorGemini] sendMessage completed (browser)', { responseLength: (payload?.result ?? '').length ?? 0 });
      return payload.result as string;
    }

    // Server flow: use existing Gemini service and conversation DB directly.
    // New Live Tutor conversations are created lazily on the first message when
    // no conversationId was assigned yet, instead of forcing a separate startup call.
    if (!this.userId) {
      throw new Error('Missing user context for server-side sendMessage');
    }

    try {
      const resolvedConversationId = activeConversationId ?? await createConversation(this.userId).then((conv) => conv.id);
      if (!resolvedConversationId || !resolvedConversationId.trim()) {
        throw new Error('Live Tutor conversation ID is missing after lazy creation');
      }

      // Persist the user's message while keeping a safe server-side history source of truth.
      await addMessageToConversation(resolvedConversationId, 'user', message, this.userId);

      // Build conversation contents for Gemini without re-adding the current user message.
      const historyForAI = await getConversationHistoryForAI(resolvedConversationId);
      const latestMessage = historyForAI[historyForAI.length - 1];
      const contents = latestMessage?.role === 'user' && latestMessage.parts[0]?.text === message
        ? historyForAI
        : [...historyForAI, { role: 'user', parts: [{ text: message }] } as GeminiMessage];

      const responseText = await askGeminiLiveTutor(contents);

      // Save assistant reply and update title if needed
      try {
        await addMessageToConversation(resolvedConversationId, 'assistant', responseText, this.userId);
        await setConversationTitleIfMissing(resolvedConversationId, message);
      } catch (dbErr) {
        logger.error('[LiveTutorGemini] Failed to save conversation messages', { conversationId: resolvedConversationId, error: String(dbErr) });
      }

      return responseText;
    } catch (err) {
      logger.error('[LiveTutorGemini] Gemini request failed', { error: String(err) });
      throw err;
    }
  }
}
