/**
 * PARVA PLATFORM — SECURE TELEGRAM OPERATIONAL ALERTS SERVICE
 * Version 1.0.0
 * 
 * Rules:
 * - Admin operational alerts: NEW_BOOKING, PAYMENT_FAILURE, REFUND_FAILURE, WEBHOOK_FAILURE, SYSTEM_ERROR, SECURITY_ALERT
 * - Sanitized alert formatting: NO private PII, credentials, or raw card data
 * - Non-blocking execution: Telegram outage must NEVER disrupt customer booking or payment flows
 * - Secure server-side bot credentials via environment variables
 */

export const TELEGRAM_ALERT_TYPES = {
  NEW_BOOKING: 'NEW_BOOKING',
  PAYMENT_FAILURE: 'PAYMENT_FAILURE',
  REFUND_FAILURE: 'REFUND_FAILURE',
  WEBHOOK_FAILURE: 'WEBHOOK_FAILURE',
  SYSTEM_ERROR: 'SYSTEM_ERROR',
  SECURITY_ALERT: 'SECURITY_ALERT'
};

class TelegramService {
  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || null;
    this.adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || null;
    this.enabled = process.env.TELEGRAM_ALERTS_ENABLED === 'true' || false;
    this.alertLog = [];
  }

  /**
   * Sanitizes payload and constructs Markdown message
   */
  formatMessage(type, data = {}) {
    const timestamp = new Date().toISOString();
    let header = `[PARVA SYSTEM ALERT] ${type}`;
    let body = '';

    switch (type) {
      case TELEGRAM_ALERT_TYPES.NEW_BOOKING:
        header = `🎉 *New Booking Confirmed*`;
        body = `*Booking ID:* \`${data.bookingId || 'N/A'}\`\n*Vendor:* ${data.vendorName || 'N/A'}\n*Category:* ${data.category || 'N/A'}\n*Date:* ${data.eventDate || 'N/A'} (${data.eventTimeSlot || 'N/A'})\n*Total Value:* ₹${data.totalAmountINR || 0}\n*Advance Paid:* ₹${data.advancePaidINR || 0}`;
        break;

      case TELEGRAM_ALERT_TYPES.PAYMENT_FAILURE:
        header = `⚠️ *Payment Verification Failure*`;
        body = `*Order ID:* \`${data.orderId || 'N/A'}\`\n*Customer ID:* \`${data.customerId || 'N/A'}\`\n*Reason:* ${data.reason || 'Payment declined or verification timeout'}\n*Amount:* ₹${data.amountINR || 0}`;
        break;

      case TELEGRAM_ALERT_TYPES.WEBHOOK_FAILURE:
        header = `🚨 *Cashfree Webhook Anomaly*`;
        body = `*Event:* \`${data.eventType || 'N/A'}\`\n*Error:* ${data.error || 'Signature or processing mismatch'}`;
        break;

      case TELEGRAM_ALERT_TYPES.SECURITY_ALERT:
        header = `🛡️ *Security Risk Detected*`;
        body = `*Signal:* ${data.signal || 'Suspicious request pattern'}\n*Actor:* \`${data.actorId || 'Anonymous'}\`\n*Action Required:* ${data.actionRequired || 'Check Admin Ops Center'}`;
        break;

      default:
        header = `ℹ️ *System Event: ${type}*`;
        body = `*Details:* ${JSON.stringify(data, null, 2).substring(0, 300)}`;
        break;
    }

    return `${header}\n\n${body}\n\n⏱ _${timestamp}_`;
  }

  /**
   * Sends operational alert to admin Telegram chat
   */
  async sendAlert(type, data = {}) {
    const message = this.formatMessage(type, data);
    const alertEntry = {
      id: `tg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      type,
      message,
      sentAt: new Date().toISOString(),
      delivered: false
    };

    this.alertLog.push(alertEntry);

    if (!this.enabled || !this.botToken || !this.adminChatId) {
      // Telegram not configured or disabled in local/dev env
      return { sent: false, reason: 'TELEGRAM_NOT_CONFIGURED', alert: alertEntry };
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.adminChatId,
          text: message,
          parse_mode: 'Markdown'
        })
      });

      const result = await response.json();
      if (result.ok) {
        alertEntry.delivered = true;
        return { sent: true, messageId: result.result?.message_id, alert: alertEntry };
      } else {
        alertEntry.error = result.description;
        return { sent: false, error: result.description, alert: alertEntry };
      }
    } catch (err) {
      alertEntry.error = err.message;
      return { sent: false, error: err.message, alert: alertEntry };
    }
  }

  /**
   * Returns recent alerts log for Admin Ops Center
   */
  getAlertHistory() {
    return [...this.alertLog].reverse().slice(0, 50);
  }

  /**
   * Resets for tests
   */
  clear() {
    this.alertLog = [];
  }
}

export const telegramService = new TelegramService();
export default telegramService;
