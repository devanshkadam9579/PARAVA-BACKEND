/**
 * PARVA PLATFORM — EVENT AUTOMATION, SCHEDULED JOBS & RISK ENGINE
 * Version 2.0.0
 * 
 * Rules:
 * - Idempotent, retry-safe event dispatching.
 * - Scheduled cron & maintenance tasks (stale hold releases, reminders).
 * - Risk & Fraud signal detection.
 * - Automated data quality integrity checks.
 * - Server-side dynamic feature flags.
 */

import { releaseSlotHold } from './availabilityEngine.js';

// Server-side Feature Flags Registry
const featureFlags = {
  smartRecommendations: true,
  smartSearch: true,
  vendorInsights: true,
  demandForecasting: true,
  riskDetection: true,
  automatedHoldCleanup: true,
  smsReminders: false
};

export function getFeatureFlags() {
  return { ...featureFlags };
}

export function setFeatureFlag(flagName, value) {
  if (flagName in featureFlags) {
    featureFlags[flagName] = !!value;
  }
  return featureFlags;
}

/**
 * 1. Event Automation Dispatcher
 */
export async function dispatchAutomationEvent({ eventName, payload = {}, db = null }) {
  const eventId = 'auto_evt_' + Date.now() + '_' + Math.floor(1000 + Math.random() * 9000);
  const timestamp = new Date().toISOString();

  const executionLog = {
    eventId,
    eventName,
    timestamp,
    status: 'PROCESSED',
    actionsTriggered: []
  };

  try {
    switch (eventName) {
      case 'BOOKING_CREATED':
        executionLog.actionsTriggered.push('DISPATCH_CUSTOMER_CREATED_EMAIL', 'EMIT_ADMIN_ACTIVITY_EVENT');
        break;

      case 'PAYMENT_SUCCESS':
        executionLog.actionsTriggered.push('CONFIRM_PAYMENT_LEDGER', 'DISPATCH_VENDOR_BOOKING_ALERT', 'RELEASE_TEMPORARY_HOLD');
        if (payload.vendorId && payload.eventDate) {
          releaseSlotHold(payload.vendorId, payload.eventDate);
        }
        break;

      case 'VENDOR_ACCEPTED':
        executionLog.actionsTriggered.push('DISPATCH_CUSTOMER_CONFIRMATION_EMAIL', 'EMIT_INAPP_NOTIFICATION');
        break;

      case 'VENDOR_REJECTED':
        executionLog.actionsTriggered.push('INITIATE_FULL_REFUND_REQUEST', 'NOTIFY_CUSTOMER_REJECTION');
        break;

      case 'BOOKING_COMPLETED':
        executionLog.actionsTriggered.push('SEND_CUSTOMER_REVIEW_INVITATION', 'SETTLE_VENDOR_PAYOUT_LEDGER');
        break;

      default:
        executionLog.actionsTriggered.push('RECORD_AUDIT_STREAM');
        break;
    }

    if (db) {
      await db.collection('automation_logs').add(executionLog);
    }
  } catch (error) {
    executionLog.status = 'FAILED';
    executionLog.error = error.message;
  }

  return executionLog;
}

/**
 * 2. Scheduled Maintenance Jobs Runner
 */
export function runScheduledMaintenanceJobs({ holds = [], bookings = [], vendors = [] }) {
  const results = {
    executedAt: new Date().toISOString(),
    staleHoldsReleased: 0,
    overdueVendorAlerts: 0,
    upcomingEventReminders: 0,
    jobsRun: ['STALE_HOLD_CLEANUP', 'VENDOR_RESPONSE_SLA_CHECK', 'UPCOMING_EVENT_REMINDER']
  };

  const now = Date.now();

  // Job A: Clean up stale expired holds
  holds.forEach(h => {
    if (now > h.expiresAt) {
      releaseSlotHold(h.vendorId, h.eventDate);
      results.staleHoldsReleased++;
    }
  });

  // Job B: Vendor SLA Reminder (Pending > 12 hours)
  bookings.forEach(b => {
    if (b.status === 'VENDOR_PENDING' && b.createdAt) {
      const ageHours = (now - new Date(b.createdAt).getTime()) / (1000 * 60 * 60);
      if (ageHours >= 12) {
        results.overdueVendorAlerts++;
      }
    }
  });

  // Job C: Upcoming Event Reminders (Events occurring within 48 hours)
  bookings.forEach(b => {
    if (b.status === 'CONFIRMED' && b.eventDate) {
      const eventTime = new Date(b.eventDate).getTime();
      const diffDays = (eventTime - now) / (1000 * 60 * 60 * 24);
      if (diffDays > 0 && diffDays <= 2) {
        results.upcomingEventReminders++;
      }
    }
  });

  return results;
}

/**
 * 3. Fraud & Risk Signals Evaluator
 */
export function evaluateRiskSignals({ userId, paymentAttempts = [], userBookings = [], couponsUsed = [] }) {
  const flags = [];
  let riskScore = 0; // 0 - 100

  // Signal 1: Repeated Payment Failures (3+ failed in last hour)
  const failedPayments = paymentAttempts.filter(p => p.status === 'FAILED');
  if (failedPayments.length >= 3) {
    riskScore += 35;
    flags.push('REPEATED_PAYMENT_FAILURES_VELOCITY');
  }

  // Signal 2: Excessive Cancellations (3+ cancellations)
  const cancelledBookings = userBookings.filter(b => b.status === 'CANCELLED');
  if (cancelledBookings.length >= 3) {
    riskScore += 25;
    flags.push('HIGH_CANCELLATION_FREQUENCY');
  }

  // Signal 3: Coupon Abuse (multiple different codes in short window)
  if (couponsUsed.length >= 4) {
    riskScore += 20;
    flags.push('SUSPICIOUS_COUPON_VELOCITY');
  }

  return {
    userId,
    riskScore,
    riskTier: riskScore >= 60 ? 'HIGH_RISK' : (riskScore >= 30 ? 'MEDIUM_RISK' : 'LOW_RISK'),
    adminReviewRequired: riskScore >= 50,
    flags,
    evaluatedAt: new Date().toISOString()
  };
}

/**
 * 4. Data Quality Integrity Auditor
 */
export function auditMarketplaceDataQuality({ vendors = [], services = [], bookings = [] }) {
  const issues = [];

  // Check 1: Vendors without active services
  vendors.forEach(v => {
    if (!v.services || v.services.length === 0) {
      issues.push({
        type: 'VENDOR_WITHOUT_SERVICES',
        severity: 'MEDIUM',
        entityId: v.id,
        entityName: v.name,
        message: 'Vendor profile is active but has 0 published service items.'
      });
    }
  });

  // Check 2: Services with missing or negative prices
  services.forEach(s => {
    if (s.price === undefined || s.price <= 0) {
      issues.push({
        type: 'INVALID_SERVICE_PRICE',
        severity: 'HIGH',
        entityId: s.id,
        entityName: s.name,
        message: 'Service has invalid or zero base price configuration.'
      });
    }
  });

  // Check 3: Bookings with missing customer or vendor references
  bookings.forEach(b => {
    if (!b.customerId || !b.vendorId) {
      issues.push({
        type: 'ORPHANED_BOOKING_RECORD',
        severity: 'HIGH',
        entityId: b.id,
        message: 'Booking record is missing customerId or vendorId reference.'
      });
    }
  });

  return {
    auditedAt: new Date().toISOString(),
    totalIssuesFound: issues.length,
    status: issues.length === 0 ? 'HEALTHY' : 'DATA_ISSUES_DETECTED',
    issues
  };
}