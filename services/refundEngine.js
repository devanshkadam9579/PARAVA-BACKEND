/**
 * PARVA PLATFORM — AUTHORITATIVE REFUND ENGINE
 * Version 2.0.0
 * 
 * Rules:
 * - Notice >= 7 Days: 100% refund of advance fee
 * - Notice 3-6 Days: 50% refund
 * - Notice < 3 Days: 0% refund
 * - If Vendor Rejects: 100% immediate full refund
 */

export function calculateRefund({ booking, eventDate, cancellationDate = new Date(), reason, cancelledBy }) {
  if (!booking) throw new Error('REFUND_ERROR: Booking record required');

  const advancePaidINR = booking.priceSnapshot?.finalAdvanceDue || booking.advanceAmount || 0;
  if (advancePaidINR <= 0) {
    return { refundAmountINR: 0, refundPercentage: 0, reason: 'NO_ADVANCE_PAID' };
  }

  // If vendor rejected, 100% full refund
  if (cancelledBy === 'vendor' || booking.status === 'VENDOR_REJECTED') {
    return {
      refundAmountINR: advancePaidINR,
      refundPercentage: 100,
      policyApplied: 'VENDOR_REJECTION_FULL_REFUND',
      reason: reason || 'Vendor unable to fulfill booking'
    };
  }

  const targetDate = new Date(eventDate || booking.eventDate);
  const cancelDate = new Date(cancellationDate);
  const diffTime = targetDate.getTime() - cancelDate.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  let refundPercentage = 0;
  let policyApplied = '';

  if (diffDays >= 7) {
    refundPercentage = 100;
    policyApplied = 'EARLY_CANCELLATION_FULL_REFUND (>= 7 Days Notice)';
  } else if (diffDays >= 3) {
    refundPercentage = 50;
    policyApplied = 'PARTIAL_REFUND (3 - 6 Days Notice)';
  } else {
    refundPercentage = 0;
    policyApplied = 'LATE_CANCELLATION_NO_REFUND (< 3 Days Notice)';
  }

  const refundAmountINR = Math.round((advancePaidINR * refundPercentage) / 100);

  return {
    refundAmountINR,
    refundPercentage,
    policyApplied,
    daysUntilEvent: diffDays,
    originalAdvancePaidINR: advancePaidINR,
    reason: reason || 'Customer requested cancellation'
  };
}
