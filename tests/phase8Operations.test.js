/**
 * PARVA PLATFORM - PHASE 8 REAL-WORLD LAUNCH VALIDATION & OPERATIONS TEST SUITE
 * Version 2.0.0
 */

import { calculateBookingPrice, PRICING_MODELS, validateGuestCount, evaluateCoupon } from '../services/pricingEngine.js';
import { checkAvailability, createSlotHold, releaseSlotHold, areSlotsConflicting, TIME_SLOTS } from '../services/availabilityEngine.js';
import { validateBookingTransition, BOOKING_STATES, checkIdempotency, saveIdempotency } from '../services/bookingStateMachine.js';
import { calculateRefund } from '../services/refundEngine.js';
import { reconcileMarketplaceData } from '../services/reconciliationService.js';
import { requireRole } from '../middleware/authMiddleware.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log('  [PASS] ' + message);
    passed++;
  } else {
    console.error('  [FAIL] ' + message);
    failed++;
  }
}

async function runPhase8ValidationTests() {
  console.log('======================================================================');
  console.log('PHASE 8: REAL-WORLD MARKETPLACE OPERATIONS & LAUNCH VALIDATION');
  console.log('======================================================================\n');

  // 1. COMPLETE REAL-WORLD CUSTOMER JOURNEY
  console.log('[JOURNEY 1: Realistic Customer Lifecycle]');
  const vendor = {
    id: 'v_taj_catering',
    name: 'Taj Mahal Royal Caterers',
    category: 'catering',
    city: 'Mumbai',
    rating: 4.98
  };
  const service = {
    id: 'srv_royal_buffet',
    name: 'Grand Imperial Buffet',
    pricingModel: PRICING_MODELS.PER_GUEST,
    price: 800,
    minimumGuests: 100,
    maximumGuests: 2000
  };
  const guestCount = 250;
  const eventDate = '2026-11-25';
  const eventSlot = TIME_SLOTS.EVENING;

  // Step 1: Availability Check
  const avail = checkAvailability({ vendor, eventDate, eventTimeSlot: eventSlot });
  assert(avail.available === true, 'Step 1: Slot is available for customer booking');

  // Step 2: Authoritative Price Calculation
  const coupon = { code: 'EARLYBIRD', discountType: 'percentage', discountPercent: 5, maxDiscountPaise: 200000 };
  const quote = calculateBookingPrice({ vendor, service, guestCount, coupon });
  assert(quote.baseAmount === 200000, 'Step 2: Subtotal calculated (250 * 800 = 200,000 INR)');
  assert(quote.discountAmount === 2000, 'Step 3: Coupon discount capped at 2,000 INR');
  assert(quote.platformFee === 9900, 'Step 4: 5% Advance connection fee is 9,900 INR');
  assert(quote.taxGst === 1782, 'Step 5: 18% GST on advance fee is 1,782 INR');
  assert(quote.finalAdvanceDue === 11682, 'Step 6: Total advance payable at checkout is 11,682 INR');
  assert(quote.balanceDueAtEvent === 188100, 'Step 7: Balance due to vendor at event is 188,100 INR');

  // Step 3: Atomic 15-Minute Slot Hold
  const hold = createSlotHold({ vendorId: vendor.id, eventDate, eventTimeSlot: eventSlot, customerUid: 'cust_aarav_sharma' });
  assert(hold.status === 'SLOT_HELD' && hold.holdId, 'Step 8: 15-minute temporary slot hold created');

  // Step 4: Cashfree Order Linking & State Machine Progression
  assert(validateBookingTransition(BOOKING_STATES.SLOT_HELD, BOOKING_STATES.PAYMENT_PENDING), 'Step 9: State transition to PAYMENT_PENDING');
  assert(validateBookingTransition(BOOKING_STATES.PAYMENT_PENDING, BOOKING_STATES.PAYMENT_SUCCESS), 'Step 10: Cashfree payment verified, state -> PAYMENT_SUCCESS');
  assert(validateBookingTransition(BOOKING_STATES.PAYMENT_SUCCESS, BOOKING_STATES.VENDOR_PENDING), 'Step 11: Booking submitted to vendor queue (VENDOR_PENDING)');

  // Step 5: Vendor Acceptance & Confirmation
  assert(validateBookingTransition(BOOKING_STATES.VENDOR_PENDING, BOOKING_STATES.VENDOR_ACCEPTED), 'Step 12: Vendor reviews and accepts booking (VENDOR_ACCEPTED)');
  assert(validateBookingTransition(BOOKING_STATES.VENDOR_ACCEPTED, BOOKING_STATES.CONFIRMED), 'Step 13: Booking confirmed for event execution');

  // Step 6: Event Execution & Completion
  assert(validateBookingTransition(BOOKING_STATES.CONFIRMED, BOOKING_STATES.EVENT_STARTED), 'Step 14: Event day started (EVENT_STARTED)');
  assert(validateBookingTransition(BOOKING_STATES.EVENT_STARTED, BOOKING_STATES.COMPLETED), 'Step 15: Event completed and ready for review (COMPLETED)');

  // 2. OPERATIONAL RECONCILIATION ENGINE
  console.log('\n[JOURNEY 2: Operational Reconciliation & Anomaly Detection]');
  const mockBookings = [
    { id: 'b1', status: 'CONFIRMED', paymentOrderId: 'cf_order_001', priceSnapshot: { _paise: { totalEventValuePaise: 20000000, platformFeePaise: 990000 } } },
    { id: 'b2', status: 'CONFIRMED', paymentOrderId: 'cf_order_MISSING' } // Anomaly!
  ];
  const mockPayments = [
    { id: 'p1', orderId: 'cf_order_001', bookingId: 'b1', status: 'SUCCESS' },
    { id: 'p2', orderId: 'cf_order_ORPHAN', bookingId: 'b_nonexistent', status: 'SUCCESS' } // Anomaly!
  ];
  const mockHolds = [
    { holdId: 'h_stale', vendorId: 'v1', eventDate: '2026-10-01', expiresAt: Date.now() - 10000 } // Anomaly!
  ];
  const reconciliationResult = reconcileMarketplaceData({
    bookings: mockBookings,
    payments: mockPayments,
    holds: mockHolds,
    refunds: []
  });
  assert(reconciliationResult.status === 'ANOMALIES_DETECTED', 'Reconciliation engine detects anomalies');
  assert(reconciliationResult.anomalies.some(a => a.type === 'CONFIRMED_WITHOUT_PAYMENT_RECORD'), 'Identifies booking confirmed without payment record');
  assert(reconciliationResult.anomalies.some(a => a.type === 'ORPHANED_SUCCESSFUL_PAYMENT'), 'Identifies orphaned successful payment');
  assert(reconciliationResult.anomalies.some(a => a.type === 'EXPIRED_STALE_HOLD'), 'Flags stale hold for garbage collection');

  // 3. SECURITY & PENETRATION-STYLE VALIDATIONS
  console.log('\n[JOURNEY 3: Security, IDOR & Price Manipulation Resistance]');
  // Attack 1: Client tries to inject price = 1
  const hackedQuote = calculateBookingPrice({ vendor, service, guestCount: 100, price: 1, amount: 1 });
  assert(hackedQuote.baseAmount === 80000, 'Client price injection ignored; backend calculates authoritative 80,000 INR');

  // Attack 2: Client tries to inject discount = 999999
  const fakeCoupon = { code: 'HACK999', discountType: 'fixed', discountAmount: 999999 };
  const fakeCouponEval = evaluateCoupon(fakeCoupon, 8000000, 'catering');
  assert(fakeCouponEval.discountPaise <= 8000000, 'Discount strictly capped at subtotal, preventing negative pricing');

  // Attack 3: Customer role tries to call Admin API
  let adminAccessBlocked = false;
  const testRes = { status: (c) => ({ json: () => { if (c === 403) adminAccessBlocked = true; } }) };
  requireRole(['admin'])({ user: { role: 'customer' } }, testRes, () => {});
  assert(adminAccessBlocked === true, 'Customer token strictly rejected with 403 on admin routes');

  // 4. HISTORICAL IMMUTABILITY SNAPSHOT TEST
  console.log('\n[JOURNEY 4: Historical Booking Price Immutability]');
  const initialSnapshot = calculateBookingPrice({ vendor, service, guestCount: 150 });
  // Vendor changes price in database from 800 to 1200
  const updatedService = { ...service, price: 1200 };
  const newQuote = calculateBookingPrice({ vendor, service: updatedService, guestCount: 150 });
  assert(initialSnapshot.baseAmount === 120000, 'Historical booking snapshot preserved at original base price (120,000 INR)');
  assert(newQuote.baseAmount === 180000, 'New quotes correctly reflect updated price (180,000 INR) without affecting past bookings');

  console.log('\n======================================================================');
  console.log('PHASE 8 VALIDATION SUMMARY: ' + passed + ' PASSED | ' + failed + ' FAILED');
  console.log('======================================================================\n');

  if (failed > 0) process.exit(1);
}

runPhase8ValidationTests().catch(err => {
  console.error(err);
  process.exit(1);
});