/**
 * PARVA PLATFORM — AUTHORITATIVE RECONCILIATION & ANOMALY DETECTION ENGINE
 * Version 2.0.0
 * 
 * Reconciles Cashfree transactions, Firestore bookings, slot holds, and refunds.
 */

import { BOOKING_STATES } from './bookingStateMachine.js';

export function reconcileMarketplaceData({ bookings = [], payments = [], holds = [], refunds = [] }) {
  const anomalies = [];
  const metrics = {
    totalBookings: bookings.length,
    totalPayments: payments.length,
    totalHolds: holds.length,
    totalRefunds: refunds.length,
    grossBookingValuePaise: 0,
    platformFeePaise: 0,
    discrepancyCount: 0
  };

  const paymentMap = new Map();
  payments.forEach(p => paymentMap.set(p.orderId || p.id, p));

  const bookingMap = new Map();
  bookings.forEach(b => {
    bookingMap.set(b.id, b);
    if (b.priceSnapshot?._paise?.totalEventValuePaise) {
      metrics.grossBookingValuePaise += b.priceSnapshot._paise.totalEventValuePaise;
      metrics.platformFeePaise += b.priceSnapshot._paise.platformFeePaise || 0;
    }
  });

  // 1. Check for Bookings marked Confirmed/Paid without corresponding successful Payment
  bookings.forEach(b => {
    if (['CONFIRMED', 'VENDOR_ACCEPTED', 'EVENT_STARTED', 'COMPLETED'].includes(b.status)) {
      if (b.paymentOrderId && !paymentMap.has(b.paymentOrderId)) {
        anomalies.push({
          type: 'CONFIRMED_WITHOUT_PAYMENT_RECORD',
          severity: 'HIGH',
          bookingId: b.id,
          orderId: b.paymentOrderId,
          message: 'Booking is marked confirmed but no corresponding payment record exists.'
        });
      }
    }
  });

  // 2. Check for Payments marked SUCCESS without linked Booking
  payments.forEach(p => {
    if (p.status === 'SUCCESS' && p.bookingId && !bookingMap.has(p.bookingId)) {
      anomalies.push({
        type: 'ORPHANED_SUCCESSFUL_PAYMENT',
        severity: 'CRITICAL',
        paymentId: p.id,
        orderId: p.orderId,
        bookingId: p.bookingId,
        message: 'Payment succeeded but referenced booking record is missing in database.'
      });
    }
  });

  // 3. Check for Stale Holds (> 15 Minutes old)
  const now = Date.now();
  holds.forEach(h => {
    if (now > h.expiresAt) {
      anomalies.push({
        type: 'EXPIRED_STALE_HOLD',
        severity: 'LOW',
        holdId: h.holdId,
        vendorId: h.vendorId,
        eventDate: h.eventDate,
        message: 'Slot hold is expired and pending garbage collection.'
      });
    }
  });

  // 4. Check for Pending Refunds without Resolution (> 48 Hours)
  refunds.forEach(r => {
    if (r.status === 'PENDING' && r.createdAt) {
      const ageHours = (now - new Date(r.createdAt).getTime()) / (1000 * 60 * 60);
      if (ageHours > 48) {
        anomalies.push({
          type: 'STUCK_REFUND_ALERT',
          severity: 'HIGH',
          refundId: r.id,
          bookingId: r.bookingId,
          ageHours: Math.round(ageHours),
          message: 'Refund has been pending for over 48 hours without Cashfree settlement.'
        });
      }
    }
  });

  metrics.discrepancyCount = anomalies.length;

  return {
    reconciledAt: new Date().toISOString(),
    status: anomalies.length === 0 ? 'HEALTHY' : 'ANOMALIES_DETECTED',
    metrics,
    anomalies
  };
}