export const NORMAL_CHAT_HISTORY_STATUS = 'completed' as const;
export const NORMAL_CHAT_HISTORY_ROLES = ['user', 'assistant'] as const;

export const NORMAL_CHAT_HISTORY_WHERE: {
  status: typeof NORMAL_CHAT_HISTORY_STATUS;
  role: { in: string[] };
} = {
  status: NORMAL_CHAT_HISTORY_STATUS,
  role: { in: [...NORMAL_CHAT_HISTORY_ROLES] },
};

export interface NormalChatHistoryRow {
  id: string;
  conversationId: string;
  role: string;
  status: string;
  text: string | null;
  content: string;
  createdAt: Date;
}

export function serializeNormalChatHistoryMessage(row: NormalChatHistoryRow) {
  if (row.status !== NORMAL_CHAT_HISTORY_STATUS) return null;
  if (row.role !== 'user' && row.role !== 'assistant') return null;

  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    status: NORMAL_CHAT_HISTORY_STATUS,
    text: row.text ?? row.content,
    content: row.content,
    createdAt: row.createdAt,
  };
}
