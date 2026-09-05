import { Prisma, type Notification, type NotificationCategory } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export interface NotificationPageResult {
  notifications: Notification[];
  total: number;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

function normalizePage(value?: number): number {
  const page = Number(value ?? DEFAULT_PAGE_SIZE);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function normalizePageSize(value?: number): number {
  const pageSize = Number(value ?? DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(pageSize) || pageSize < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(MAX_PAGE_SIZE, Math.floor(pageSize));
}

export async function getNotificationsForUser(
  userId: string,
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<NotificationPageResult> {
  const normalizedPage = normalizePage(page);
  const normalizedPageSize = normalizePageSize(pageSize);
  const offset = (normalizedPage - 1) * normalizedPageSize;

  const [total, notifications] = await prisma.$transaction([
    prisma.notification.count({ where: { userId } }),
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: normalizedPageSize,
    }),
  ]);

  return {
    notifications,
    total,
    page: normalizedPage,
    pageSize: normalizedPageSize,
  };
}

export async function countUnreadNotifications(userId: string): Promise<number> {
  return prisma.notification.count({
    where: { userId, isRead: false },
  });
}

export async function markNotificationAsRead(userId: string, notificationId: string): Promise<boolean> {
  const result = await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { isRead: true },
  });
  return result.count > 0;
}

export async function markAllNotificationsAsRead(userId: string): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true },
  });
  return result.count;
}

export async function removeNotification(userId: string, notificationId: string): Promise<boolean> {
  const result = await prisma.notification.deleteMany({
    where: { id: notificationId, userId },
  });
  return result.count > 0;
}

export async function removeAllNotifications(userId: string): Promise<number> {
  const result = await prisma.notification.deleteMany({
    where: { userId },
  });
  return result.count;
}

export interface CreateNotificationData {
  title: string;
  body: string;
  type: string;
  category: NotificationCategory;
  externalId?: string;
  icon?: string | null;
  actionUrl?: string | null;
  metadata?: Prisma.JsonValue | null;
}

export async function upsertNotification(userId: string, data: CreateNotificationData): Promise<Notification> {
  const normalizedData = {
    title: data.title,
    body: data.body,
    type: data.type,
    category: data.category,
    externalId: data.externalId?.trim() || undefined,
    icon: data.icon ?? null,
    actionUrl: data.actionUrl ?? null,
    metadata: data.metadata === undefined ? undefined : data.metadata === null ? Prisma.JsonNull : data.metadata,
  };

  if (normalizedData.externalId) {
    return prisma.notification.upsert({
      where: {
        userId_externalId: {
          userId,
          externalId: normalizedData.externalId,
        },
      },
      update: {
        title: normalizedData.title,
        body: normalizedData.body,
        type: normalizedData.type,
        category: normalizedData.category,
        icon: normalizedData.icon,
        actionUrl: normalizedData.actionUrl,
        metadata: normalizedData.metadata,
        updatedAt: new Date(),
      },
      create: {
        userId,
        title: normalizedData.title,
        body: normalizedData.body,
        type: normalizedData.type,
        category: normalizedData.category,
        externalId: normalizedData.externalId,
        icon: normalizedData.icon,
        actionUrl: normalizedData.actionUrl,
        metadata: normalizedData.metadata,
      },
    });
  }

  return prisma.notification.create({
    data: {
      userId,
      title: normalizedData.title,
      body: normalizedData.body,
      type: normalizedData.type,
      category: normalizedData.category,
      icon: normalizedData.icon,
      actionUrl: normalizedData.actionUrl,
      metadata: normalizedData.metadata,
    },
  });
}
