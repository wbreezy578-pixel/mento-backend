export type ConversationSource = 'chat' | 'live_tutor';

export function resolveConversationSource(value: string | null | undefined): ConversationSource {
  return value?.trim() === 'live_tutor' ? 'live_tutor' : 'chat';
}
