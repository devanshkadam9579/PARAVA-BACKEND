import { 
  calculateBookingPrice, 
  validateGuestCount, 
  evaluateCoupon, 
  PRICING_MODELS 
} from '../services/pricingEngine.js';

import { 
  checkAvailability, 
  createSlotHold, 
  releaseSlotHold, 
  areSlotsConflicting, 
  TIME_SLOTS 
} from '../services/availabilityEngine.js';

import { 
  validateBookingTransition, 
  BOOKING_STATES, 
  checkIdempotency, 
  saveIdempotency 
} from '../services/bookingStateMachine.js';

import { 
  calculateRefund 
} from '../services/refundEngine.js';

let passedTests = 0;
let totalTests = 0;

function assert(condition, testName) {
  totalTests++;
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passedTests++;
  } else {
    console.error(`  ✗ FAIL: ${testName}`);
    throw new Error(`Test failed: ${testName}`);
  }
}

console.log('\n==================================================');
console.log('🧪 RUNNING PARVA AUTHORITATIVE DOMAIN ENGINE TESTS');
console.log('==================================================\n');

// 1. PRICE CALCULATION — Catering (Rate × Guests)
console.log('Test Suite 1: Pricing Engine — Catering Guest Multiplication');
{
  const mockVendor = { id: 'v1', name: 'Royal Caterers', category: 'Catering' };
  const mockService = { 
    id: 's1', 
    name: 'Royal Rajasthani Thali', 
    pricingModel: PRICING_MODELS.PER_GUEST, 
    basePrice: 500,
    minimumGuests: 50,
    maximumGuests: 2000
  };

  const quote = calculateBookingPrice({
    vendor: mockVendor,
    service: mockService,
    guestCount: 100
  });

  assert(quote.subtotal === 50000, 'Subtotal correctly evaluates ₹500 × 100 = ₹50,000');
  assert(quote.platformFee === 2500, '5% Advance Connection Fee is ₹2,500');
  assert(quote.taxGst === 450, '18% GST on Advance Fee is ₹450');
  assert(quote.finalAdvanceDue === 2950, 'Total Advance Due is ₹2,950');
  assert(quote.balanceDueAtEvent === 47500, 'Remaining Balance Due at Event is ₹47,500');
}

// 2. ADD-ONS CALCULATION — Package + Addons
console.log('\nTest Suite 2: Pricing Engine — Package & Add-ons');
{
  const mockVendor = { id: 'v2', name: 'Dream Decorators', category: 'Decorators' };
  const mockService = { 
    id: 's2', 
    name: 'Royal Stage Decor', 
    pricingModel: PRICING_MODELS.PACKAGE_PLUS_ADDONS,
    basePrice: 25000 
  };
  const mockAddons = [
    { id: 'a1', name: 'Flower Upgrade', price: 5000 },
    { id: 'a2', name: 'Extra Fairy Lighting', price: 3000 }
  ];

  const quote = calculateBookingPrice({
    vendor: mockVendor,
    service: mockService,
    selectedAddons: mockAddons
  });

  assert(quote.subtotal === 33000, 'Subtotal correctly evaluates ₹25,000 + ₹5,000 + ₹3,000 = ₹33,000');
  assert(quote.addonsAmount === 8000, 'Addons total is ₹8,000');
}

// 3. COUPON ENGINE — Discount & Validation
console.log('\nTest Suite 3: Coupon Engine Validation');
{
  const mockVendor = { id: 'v2', name: 'Dream Decorators', category: 'Decorators' };
  const mockService = { id: 's2', name: 'Decor', basePrice: 33000 };
  const mockCoupon = {
    code: 'FESTIVE2000',
    discountType: 'fixed',
    discountAmount: 2000,
    minOrderAmountPaise: 1000000, // ₹10,000
    validUntil: new Date(Date.now() + 86400000).toISOString()
  };

  const quote = calculateBookingPrice({
    vendor: mockVendor,
    service: mockService,
    coupon: mockCoupon
  });

  assert(quote.discountAmount === 2000, 'Coupon discount ₹2,000 applied');
  assert(quote.adjustedSubtotal === 31000, 'Adjusted Subtotal is ₹31,000');
}

// 4. GUEST LIMIT REJECTION
console.log('\nTest Suite 4: Guest Count Boundary Validation');
{
  const mockService = { 
    id: 's1', 
    name: 'Catering', 
    pricingModel: PRICING_MODELS.PER_GUEST, 
    minimumGuests: 50, 
    maximumGuests: 500 
  };

  let errorThrown = false;
  try {
    validateGuestCount(mockService, 20);
  } catch (err) {
    errorThrown = true;
  }
  assert(errorThrown, 'Rejects guest count below minimum threshold (20 < 50)');
}

// 5. AVAILABILITY & TIME OVERLAPS
console.log('\nTest Suite 5: Availability & Conflict Detection');
{
  const mockVendor = { 
    id: 'v10', 
    name: 'Grand Banquet', 
    busyDates: ['2026-10-15'],
    busySlots: { '2026-10-20': ['evening'] }
  };

  const result1 = checkAvailability({
    vendor: mockVendor,
    eventDate: '2026-10-15',
    eventTimeSlot: 'evening'
  });
  assert(!result1.available && result1.status === 'VENDOR_BLOCKED_DATE', 'Blocked date flagged as unavailable');

  const result2 = checkAvailability({
    vendor: mockVendor,
    eventDate: '2026-10-20',
    eventTimeSlot: 'evening'
  });
  assert(!result2.available && result2.status === 'VENDOR_BLOCKED_SLOT', 'Blocked evening slot flagged as unavailable');

  const result3 = checkAvailability({
    vendor: mockVendor,
    eventDate: '2026-10-20',
    eventTimeSlot: 'morning'
  });
  assert(result3.available, 'Non-conflicting morning slot on same date remains available');
}

// 6. ATOMIC 15-MINUTE SLOT HOLD & DOUBLE BOOKING PREVENTION
console.log('\nTest Suite 6: Atomic Temporary Slot Hold');
{
  const hold1 = createSlotHold({
    vendorId: 'v100',
    eventDate: '2026-11-05',
    eventTimeSlot: 'evening',
    customerUid: 'cust_A'
  });
  assert(hold1.status === 'SLOT_HELD', 'Customer A successfully creates 15-min slot hold');

  let customerBBlocked = false;
  try {
    createSlotHold({
      vendorId: 'v100',
      eventDate: '2026-11-05',
      eventTimeSlot: 'evening',
      customerUid: 'cust_B'
    });
  } catch (err) {
    customerBBlocked = true;
  }
  assert(customerBBlocked, 'Customer B is atomically blocked from double-booking held slot');

  releaseSlotHold('v100', '2026-11-05');
  const hold3 = createSlotHold({
    vendorId: 'v100',
    eventDate: '2026-11-05',
    eventTimeSlot: 'evening',
    customerUid: 'cust_B'
  });
  assert(hold3.status === 'SLOT_HELD', 'Slot becomes available immediately after release');
}

// 7. BOOKING STATE MACHINE TRANSITIONS
console.log('\nTest Suite 7: 16-State Booking Lifecycle Validation');
{
  assert(validateBookingTransition(BOOKING_STATES.DRAFT, BOOKING_STATES.PRICE_CONFIRMED), 'DRAFT -> PRICE_CONFIRMED is valid');
  assert(validateBookingTransition(BOOKING_STATES.SLOT_HELD, BOOKING_STATES.PAYMENT_PENDING), 'SLOT_HELD -> PAYMENT_PENDING is valid');
  assert(validateBookingTransition(BOOKING_STATES.PAYMENT_SUCCESS, BOOKING_STATES.VENDOR_PENDING), 'PAYMENT_SUCCESS -> VENDOR_PENDING is valid');

  let invalidTransitionBlocked = false;
  try {
    validateBookingTransition(BOOKING_STATES.COMPLETED, BOOKING_STATES.PAYMENT_PENDING);
  } catch (err) {
    invalidTransitionBlocked = true;
  }
  assert(invalidTransitionBlocked, 'COMPLETED -> PAYMENT_PENDING is strictly blocked');
}

// 8. IDEMPOTENCY REGISTRY
console.log('\nTest Suite 8: Request Idempotency Key Validation');
{
  const key = 'idem_req_9981';
  saveIdempotency(key, { bookingId: 'PRV-101', status: 'CONFIRMED' });
  const cached = checkIdempotency(key);
  assert(cached && cached.bookingId === 'PRV-101', 'Idempotent request returns cached response');
}

// 9. REFUND ENGINE — Cancellation Policy
console.log('\nTest Suite 9: Cancellation Policy Refund Calculation');
{
  const mockBooking = {
    eventDate: '2026-12-15',
    priceSnapshot: { finalAdvanceDue: 5000 }
  };

  // 10 Days Notice (>= 7 Days -> 100% Refund)
  const refund1 = calculateRefund({
    booking: mockBooking,
    cancellationDate: new Date('2026-12-05')
  });
  assert(refund1.refundAmountINR === 5000 && refund1.refundPercentage === 100, '>= 7 Days Notice returns 100% refund');

  // 4 Days Notice (3-6 Days -> 50% Refund)
  const refund2 = calculateRefund({
    booking: mockBooking,
    cancellationDate: new Date('2026-12-11')
  });
  assert(refund2.refundAmountINR === 2500 && refund2.refundPercentage === 50, '3-6 Days Notice returns 50% refund');

  // 1 Day Notice (< 3 Days -> 0% Refund)
  const refund3 = calculateRefund({
    booking: mockBooking,
    cancellationDate: new Date('2026-12-14')
  });
  assert(refund3.refundAmountINR === 0 && refund3.refundPercentage === 0, '< 3 Days Notice returns 0% refund');

  // Vendor Rejection -> Always 100% Refund
  const refundVendorReject = calculateRefund({
    booking: { ...mockBooking, status: 'VENDOR_REJECTED' },
    cancelledBy: 'vendor'
  });
  assert(refundVendorReject.refundAmountINR === 5000 && refundVendorReject.refundPercentage === 100, 'Vendor Rejection returns 100% refund');
}

console.log('\n==================================================');
console.log(`🏁 TEST RESULTS: ${passedTests}/${totalTests} TESTS PASSED WITH 100% SUCCESS`);
console.log('==================================================\n');
