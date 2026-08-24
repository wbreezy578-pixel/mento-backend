import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import logger from '../../lib/logger';
import type { Notification, NotificationCategory } from '@prisma/client';
import {
  countUnreadNotifications,
  getNotificationsForUser,
  markAllNotificationsAsRead,
  markNotificationAsRead,
  removeAllNotifications,
  removeNotification,
  upsertNotification,
  type NotificationPageResult,
} from './notificationRepository';

export interface CreateNotificationInput {
  title: string;
  body: string;
  type: string;
  category?: string;
  externalId?: string;
  icon?: string | null;
  actionUrl?: string | null;
  metadata?: unknown;
}

const ALLOWED_CATEGORIES = new Set([
  'BILLING',
  'TUTOR',
  'SECURITY',
  'SUPPORT',
  'PRODUCT_UPDATES',
]);

const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 1000;
const MAX_TYPE_LENGTH = 60;

function isNotificationsEnabled(): boolean {
  return process.env.NOTIFICATIONS_ENABLED !== 'false' && process.env.ENABLE_NOTIFICATIONS !== 'false';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown notification error';
}

function isMissingTableError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: string }).code) : '';
  return code === 'P2021' || message.includes('does not exist') || message.includes('relation') && message.includes('does not exist');
}

async function checkNotificationTableExists(): Promise<boolean> {
  try {
    const result = await prisma.$queryRaw<Array<{ table_name: string | null }>>`
      SELECT to_regclass('public."Notification"')::text AS table_name;
    `;
    const exists = Boolean(result[0]?.table_name);
    logger.info('Notification table availability check', { exists, tableName: result[0]?.table_name ?? null });
    return exists;
  } catch (error) {
    logger.warn('Unable to verify notification table availability', { error: getErrorMessage(error) });
    return false;
  }
}

function isSafeWebUrl(value: string | null | undefined): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function normalizeNotificationInput(input: CreateNotificationInput) {
  const title = input.title.trim();
  const body = input.body.trim();
  const type = input.type.trim();

  if (!title || !body || !type) {
    throw new Error('Notification title, body, and type are required');
  }

  if (title.length > MAX_TITLE_LENGTH || body.length > MAX_BODY_LENGTH || type.length > MAX_TYPE_LENGTH) {
    throw new Error('Notification payload exceeds supported length');
  }

  if (input.actionUrl != null && input.actionUrl !== '' && !isSafeWebUrl(input.actionUrl)) {
    throw new Error('Notification actionUrl must be a valid http(s) URL.');
  }

  const rawCategory = typeof input.category === 'string' && ALLOWED_CATEGORIES.has(input.category.toUpperCase())
    ? input.category.toUpperCase()
    : 'PRODUCT_UPDATES';

  return {
    title,
    body,
    type,
    category: rawCategory as NotificationCategory,
    externalId: input.externalId?.trim() || undefined,
    icon: input.icon ?? null,
    actionUrl: input.actionUrl ? input.actionUrl.trim() : null,
    metadata: input.metadata === undefined ? undefined : (input.metadata ?? Prisma.JsonNull),
  };
}

async function runNotificationOperation<T>(context: string, operation: () => Promise<T>, fallback: T): Promise<T> {
  if (!isNotificationsEnabled()) {
    logger.info('Notifications are disabled; using fallback value', { context });
    return fallback;
  }

  try {
    const tableExists = await checkNotificationTableExists();
    if (!tableExists) {
      logger.warn('Notification table is unavailable; using fallback value', { context });
      return fallback;
    }

    return await operation();
  } catch (error) {
    const message = getErrorMessage(error);
    if (isMissingTableError(error)) {
      logger.warn('Notification table missing at runtime; using fallback value', { context, error: message });
      return fallback;
    }

    logger.error('Notification operation failed', { context, error: message });
    return fallback;
  }
}

export async function createNotification(userId: string, input: CreateNotificationInput): Promise<Notification | null> {
  return runNotificationOperation(
    'createNotification',
    async () => {
      const normalized = normalizeNotificationInput(input);

      return upsertNotification(userId, {
        title: normalized.title,
        body: normalized.body,
        type: normalized.type,
        category: normalized.category,
        externalId: normalized.externalId,
        icon: normalized.icon,
        actionUrl: normalized.actionUrl,
        metadata: normalized.metadata === undefined ? null : normalized.metadata,
      });
    },
    null,
  );
}

export async function getNotificationPreferences(userId: string) {
  return runNotificationOperation(
    'getNotificationPreferences',
    async () => prisma.notificationPreference.findUnique({ where: { userId } }),
    null,
  );
}

export async function updateNotificationPreferences(userId: string, patch: Partial<{ emailEnabled: boolean; pushEnabled: boolean; marketingEnabled: boolean; weeklyDigestEnabled: boolean; }>) {
  return runNotificationOperation(
    'updateNotificationPreferences',
    async () => prisma.notificationPreference.upsert({
      where: { userId },
      update: {
        emailEnabled: patch.emailEnabled ?? undefined,
        pushEnabled: patch.pushEnabled ?? undefined,
        marketingEnabled: patch.marketingEnabled ?? undefined,
        weeklyDigestEnabled: patch.weeklyDigestEnabled ?? undefined,
      },
      create: {
        user: { connect: { id: userId } },
        emailEnabled: patch.emailEnabled ?? true,
        pushEnabled: patch.pushEnabled ?? true,
        marketingEnabled: patch.marketingEnabled ?? false,
        weeklyDigestEnabled: patch.weeklyDigestEnabled ?? true,
      },
    }),
    null,
  );
}

export async function getNotifications(userId: string, page = 1, pageSize = 20): Promise<NotificationPageResult> {
  return runNotificationOperation(
    'getNotifications',
    async () => getNotificationsForUser(userId, page, pageSize),
    { notifications: [], total: 0, page, pageSize },
  );
}

export async function getUnreadCount(userId: string): Promise<number> {
  return runNotificationOperation(
    'getUnreadCount',
    async () => countUnreadNotifications(userId),
    0,
  );
}

export async function markAsRead(userId: string, notificationId: string): Promise<boolean> {
  return runNotificationOperation(
    'markAsRead',
    async () => markNotificationAsRead(userId, notificationId),
    false,
  );
}

export async function markAllAsRead(userId: string): Promise<number> {
  return runNotificationOperation(
    'markAllAsRead',
    async () => markAllNotificationsAsRead(userId),
    0,
  );
}

export async function deleteNotification(userId: string, notificationId: string): Promise<boolean> {
  return runNotificationOperation(
    'deleteNotification',
    async () => removeNotification(userId, notificationId),
    false,
  );
}

export async function clearNotifications(userId: string): Promise<number> {
  return runNotificationOperation(
    'clearNotifications',
    async () => removeAllNotifications(userId),
    0,
  );
}
