/**
 * PARVA PLATFORM — UNIFIED MULTI-CHANNEL NOTIFICATION ROUTER
 * Version 1.0.0
 * 
 * Channels:
 * 1. IN-APP: Stored in recipient's notification inbox
 * 2. TRANSACTIONAL EMAIL: Async dispatch via Resend / EmailService
 * 3. TELEGRAM: Operational and Admin alerting via Telegram Bot API
 * 
 * Non-blocking guarantee: Failure in one notification channel never interrupts
 * the remaining channels or core transaction workflows.
 */

import { queueService } from './queueService.js';
import { telegramService, TELEGRAM_ALERT_TYPES } from './telegramService.js';
import { 
  sendBookingCreatedEmail, 
  sendPaymentAndBookingConfirmedEmails, 
  sendBookingCancellationEmail, 
  sendRefundProcessedEmail 
} from './emailService.js';

export const NOTIFICATION_TYPES = {
  BOOKING_CREATED: 'BOOKING_CREATED',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  VENDOR_ACCEPTED: 'VENDOR_ACCEPTED',
  BOOKING_CANCELLED: 'BOOKING_CANCELLED',
  REFUND_PROCESSED: 'REFUND_PROCESSED',
  LOYALTY_EARNED: 'LOYALTY_EARNED',
  REFERRAL_REWARD: 'REFERRAL_REWARD',
  NEW_OFFER: 'NEW_OFFER',
  PROMOTION_AVAILABLE: 'PROMOTION_AVAILABLE',
  VENDOR_PLAN_UPDATED: 'VENDOR_PLAN_UPDATED',
  SYSTEM_ALERT: 'SYSTEM_ALERT'
};

// In-memory recipient inboxes
const inAppNotifications = [];

class NotificationService {
  /**
   * Dispatches multi-channel notification
   */
  async dispatch({
    recipientId,
    recipientRole = 'CUSTOMER', // 'CUSTOMER', 'VENDOR', 'ADMIN'
    type,
    title,
    message,
    metadata = {},
    channels = ['IN_APP', 'EMAIL', 'TELEGRAM']
  }) {
    const notificationId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const result = {
      notificationId,
      type,
      recipientId,
      inApp: false,
      emailQueued: false,
      telegramAlerted: false
    };

    // 1. In-App Notification Channel
    if (channels.includes('IN_APP') && recipientId) {
      const inAppItem = {
        id: notificationId,
        recipientId,
        recipientRole,
        type,
        title,
        message,
        metadata,
        read: false,
        createdAt: new Date().toISOString()
      };
      inAppNotifications.push(inAppItem);
      result.inApp = true;
    }

    // 2. Transactional Email Channel (Queued asynchronously)
    if (channels.includes('EMAIL') && metadata.email) {
      queueService.enqueue('SEND_TRANSACTIONAL_EMAIL', {
        type,
        to: metadata.email,
        metadata
      });
      result.emailQueued = true;
    }

    // 3. Telegram Operational Alert Channel
    if (channels.includes('TELEGRAM') && (recipientRole === 'ADMIN' || type === NOTIFICATION_TYPES.SYSTEM_ALERT)) {
      let tgType = TELEGRAM_ALERT_TYPES.SYSTEM_ERROR;
      if (type === NOTIFICATION_TYPES.BOOKING_CREATED || type === NOTIFICATION_TYPES.PAYMENT_CONFIRMED) {
        tgType = TELEGRAM_ALERT_TYPES.NEW_BOOKING;
      } else if (type === NOTIFICATION_TYPES.REFUND_PROCESSED) {
        tgType = TELEGRAM_ALERT_TYPES.REFUND_FAILURE;
      }
      telegramService.sendAlert(tgType, metadata).catch(() => {});
      result.telegramAlerted = true;
    }

    return result;
  }

  /**
   * Gets in-app notifications for user
   */
  getInbox(recipientId) {
    return inAppNotifications
      .filter(n => n.recipientId === recipientId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /**
   * Marks a notification as read
   */
  markAsRead(notificationId, recipientId) {
    const item = inAppNotifications.find(n => n.id === notificationId && n.recipientId === recipientId);
    if (item) {
      item.read = true;
      return true;
    }
    return false;
  }

  /**
   * Clears state for tests
   */
  clear() {
    inAppNotifications.length = 0;
  }
}

export const notificationService = new NotificationService();
export default notificationService;
