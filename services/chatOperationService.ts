import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

// Match conversation retention so a replay cannot forget its identity while
// the authoritative conversation is still recoverable.
export const CHAT_OPERATION_RETENTION_DAYS = 365;
const CHAT_OPERATION_STALE_MS = 5 * 60 * 1000;
const INITIAL_CHAT_OPERATION_TYPE = 'chat.send';

export class ChatOperationConflictError extends Error {
  readonly code = 'idempotency_conflict';
  constructor() {
    super('This operation ID was already used for different content.');
    this.name = 'ChatOperationConflictError';
  }
}

export type InitialChatOperationResult = {
  kind: 'claimed' | 'in_progress' | 'completed' | 'failed';
  operationId: string;
  conversationId: string;
  userMessageId: string | null;
  responseText: string | null;
  errorCode: string | null;
};

function expiresAt(now = new Date()) {
  return new Date(now.getTime() + CHAT_OPERATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

async function recoverExistingInitialOperation(
  userId: string,
  clientRequestId: string,
  payloadHash: string,
): Promise<InitialChatOperationResult> {
  const existing = await prisma.chatOperation.findUnique({
    where: { userId_clientRequestId_operationType: { userId, clientRequestId, operationType: INITIAL_CHAT_OPERATION_TYPE } },
  });
  if (!existing?.conversationId) throw new Error('Initial chat operation claim was not recoverable.');
  if (existing.payloadHash !== payloadHash) throw new ChatOperationConflictError();

  const messages = await prisma.conversationMessage.findMany({
    where: { conversationId: existing.conversationId, requestId: clientRequestId },
    select: { id: true, role: true, status: true, content: true },
  });
  const userMessageId = messages.find((message) => message.role === 'user')?.id ?? null;
  const completedAssistant = messages.find((message) => message.role === 'assistant' && message.status === 'completed');
  if (completedAssistant) {
    if (existing.status !== 'COMPLETED' || existing.responseText !== completedAssistant.content) {
      await prisma.chatOperation.update({
        where: { id: existing.id },
        data: { status: 'COMPLETED', responseText: completedAssistant.content, errorCode: null, expiresAt: expiresAt() },
      });
    }
    return {
      kind: 'completed', operationId: existing.id, conversationId: existing.conversationId,
      userMessageId, responseText: completedAssistant.content, errorCode: null,
    };
  }

  if (existing.status === 'IN_PROGRESS' && Date.now() - existing.updatedAt.getTime() > CHAT_OPERATION_STALE_MS) {
    await prisma.chatOperation.updateMany({
      where: { id: existing.id, status: 'IN_PROGRESS', updatedAt: existing.updatedAt },
      data: { status: 'FAILED', errorCode: 'operation_interrupted', expiresAt: expiresAt() },
    });
    return {
      kind: 'failed', operationId: existing.id, conversationId: existing.conversationId,
      userMessageId, responseText: null, errorCode: 'operation_interrupted',
    };
  }

  return {
    kind: existing.status === 'IN_PROGRESS' ? 'in_progress' : 'failed',
    operationId: existing.id,
    conversationId: existing.conversationId,
    userMessageId,
    responseText: existing.responseText,
    errorCode: existing.errorCode,
  };
}

export async function claimInitialChatOperation(input: {
  userId: string;
  clientRequestId: string;
  payloadHash: string;
  initialMessage: string;
}): Promise<InitialChatOperationResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      // The unique operation claim is inserted before allocating a conversation.
      // PostgreSQL serializes concurrent claims on the composite unique index.
      const operation = await tx.chatOperation.create({
        data: {
          userId: input.userId,
          clientRequestId: input.clientRequestId,
          operationType: INITIAL_CHAT_OPERATION_TYPE,
          payloadHash: input.payloadHash,
          expiresAt: expiresAt(),
        },
      });
      const conversation = await tx.conversation.create({ data: { userId: input.userId, source: 'chat' } });
      const userMessage = await tx.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          userId: input.userId,
          role: 'user',
          status: 'completed',
          content: input.initialMessage,
          text: input.initialMessage,
          requestId: input.clientRequestId,
        },
      });
      await tx.chatOperation.update({ where: { id: operation.id }, data: { conversationId: conversation.id } });
      return {
        kind: 'claimed' as const,
        operationId: operation.id,
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        responseText: null,
        errorCode: null,
      };
    });
  } catch (error) {
    if ((error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      || (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')) {
      return recoverExistingInitialOperation(input.userId, input.clientRequestId, input.payloadHash);
    }
    throw error;
  }
}

export async function completeInitialChatOperation(input: {
  operationId: string;
  userId: string;
  conversationId: string;
  responseText: string;
}) {
  await prisma.chatOperation.updateMany({
    where: { id: input.operationId, userId: input.userId, conversationId: input.conversationId, status: 'IN_PROGRESS' },
    data: { status: 'COMPLETED', responseText: input.responseText, errorCode: null, expiresAt: expiresAt() },
  });
}

export async function failInitialChatOperation(input: {
  operationId: string;
  userId: string;
  conversationId: string;
  errorCode: string;
}) {
  await prisma.chatOperation.updateMany({
    where: { id: input.operationId, userId: input.userId, conversationId: input.conversationId, status: 'IN_PROGRESS' },
    data: { status: 'FAILED', errorCode: input.errorCode, expiresAt: expiresAt() },
  });
}

export async function deleteExpiredChatOperations(now = new Date()) {
  return prisma.chatOperation.deleteMany({ where: { expiresAt: { lt: now }, status: { not: 'IN_PROGRESS' } } });
}
