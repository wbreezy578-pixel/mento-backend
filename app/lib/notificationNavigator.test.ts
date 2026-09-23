import { describe, it, expect } from 'vitest';
import { getNotificationDestination } from '../../../mento-mobile/src/navigation/notificationNavigator';
import type { NotificationItem } from '../../../mento-mobile/src/services/notificationService';

describe('getNotificationDestination', () => {
  it('routes password/security notifications to ChangePassword', () => {
    const payload: NotificationItem = {
      id: '1', userId: 'u', title: 'Pwd changed', body: '', type: 'password_changed', icon: null, actionUrl: null, isRead: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} as unknown
    };
    const dest = getNotificationDestination(payload);
    expect(dest.kind).toBe('screen');
    expect(dest.kind === 'screen' && dest.name).toBe('ChangePassword');
  });

  it('routes billing/payment notifications to Wallet', () => {
    const payload2: NotificationItem = {
      id: '2', userId: 'u', title: 'Payment received', body: '', type: 'payment_succeeded', icon: null, actionUrl: null, isRead: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} as unknown
    };
    const dest = getNotificationDestination(payload2);
    expect(dest.kind === 'screen' && dest.name).toBe('Wallet');
  });

  it('routes tutor/chat notifications with conversation id to Chat and includes param', () => {
    const payload3: NotificationItem = {
      id: '3', userId: 'u', title: 'New reply', body: '', type: 'chat_message', icon: null, actionUrl: null, isRead: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: { conversationId: 'conv-123' } as unknown
    };
    const dest = getNotificationDestination(payload3);
    expect(dest.kind === 'screen' && dest.name).toBe('Chat');
    if (dest.kind === 'screen') {
      expect(dest.params?.conversationId).toBe('conv-123');
    } else {
      throw new Error('expected screen destination');
    }
  });

  it('routes actionUrl to url kind', () => {
    const payload4: NotificationItem = {
      id: '4', userId: 'u', title: 'Read this', body: '', type: 'update', icon: null, actionUrl: 'https://example.com', isRead: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} as unknown
    };
    const dest = getNotificationDestination(payload4);
    expect(dest.kind).toBe('url');
    expect(dest.kind === 'url' && dest.url).toBe('https://example.com');
  });

  it('falls back to fallback for unsafe actionUrl values', () => {
    const payload6: NotificationItem = {
      id: '6', userId: 'u', title: 'Suspicious link', body: '', type: 'update', icon: null, actionUrl: 'javascript:alert(1)', isRead: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} as unknown
    };
    const dest = getNotificationDestination(payload6);
    expect(dest.kind).toBe('fallback');
  });

  it('falls back to fallback for unknown notifications', () => {
    const payload5: NotificationItem = {
      id: '5', userId: 'u', title: 'Hello', body: '', type: 'unknown_type', icon: null, actionUrl: null, isRead: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} as unknown
    };
    const dest = getNotificationDestination(payload5);
    expect(dest.kind).toBe('fallback');
  });
});
