import { calculateBookingPrice, PRICING_MODELS } from '../services/pricingEngine.js';
import { calculateVendorCommission } from '../services/commissionService.js';
import { checkAvailability } from '../services/availabilityEngine.js';

console.log('====================================================');
console.log('🧪 RUNNING PARVA AUTHORITATIVE PRICING & COMMISSION TESTS');
console.log('====================================================\n');

// 1. Service: ₹10,000, Coupon: 10%, Commission: 10%, Booking fee: 5%
const mockVendor = {
  id: 'v_decor_1',
  name: 'Royal Floral Decorators',
  category: 'Decorator',
  busyDates: ['2026-09-18', '2026-09-20']
};

const mockService = {
  id: 'svc_decor_1',
  name: 'Premium Mandap Floral Setup',
  basePrice: 10000,
  pricingModel: PRICING_MODELS.PACKAGE
};

const mockCoupon10Pct = {
  code: 'FESTIVE10',
  discountType: 'percentage',
  discountPercent: 10,
  active: true
};

console.log('Test 1: Price Calculation with 10% Coupon (Deducts from Subtotal)');
const quote10 = calculateBookingPrice({
  vendor: mockVendor,
  service: mockService,
  coupon: mockCoupon10Pct,
  commissionPercentage: 10,
  bookingFeePercentage: 5
});

console.log('Subtotal:', quote10.subtotal, 'INR (Expected: 10000)');
console.log('Coupon Discount:', quote10.discount, 'INR (Expected: 1000)');
console.log('Discounted Subtotal:', quote10.discountedSubtotal, 'INR (Expected: 9000)');
console.log('5% Advance Platform Fee:', quote10.platformFee, 'INR (Expected: 450)');
console.log('18% GST on Advance:', quote10.tax, 'INR (Expected: 81)');
console.log('Final Advance Payable Now:', quote10.finalAdvanceDue, 'INR (Expected: 531)');
console.log('10% Vendor Commission:', quote10.commissionAmount, 'INR (Expected: 900)');
console.log('Vendor Net Payout:', quote10.vendorPayout, 'INR (Expected: 8100)\n');

if (
  quote10.subtotal === 10000 &&
  quote10.discount === 1000 &&
  quote10.discountedSubtotal === 9000 &&
  quote10.platformFee === 450 &&
  quote10.tax === 81 &&
  quote10.finalAdvanceDue === 531 &&
  quote10.commissionAmount === 900 &&
  quote10.vendorPayout === 8100
) {
  console.log('✅ Test 1 PASSED: Pricing and Coupon discount calculated accurately.');
} else {
  console.error('❌ Test 1 FAILED: Discrepancy in calculation values.');
  process.exit(1);
}

// 2. Admin Commission Changed from 10% to 15%
console.log('\n----------------------------------------------------');
console.log('Test 2: Admin changes Commission from 10% to 15%');
const quote15 = calculateBookingPrice({
  vendor: mockVendor,
  service: mockService,
  coupon: mockCoupon10Pct,
  commissionPercentage: 15,
  bookingFeePercentage: 5
});

console.log('15% Commission Amount:', quote15.commissionAmount, 'INR (Expected: 1350)');
console.log('Vendor Net Payout at 15%:', quote15.vendorPayout, 'INR (Expected: 7650)');

if (quote15.commissionAmount === 1350 && quote15.vendorPayout === 7650) {
  console.log('✅ Test 2 PASSED: 15% Dynamic Commission calculates correctly.');
} else {
  console.error('❌ Test 2 FAILED');
  process.exit(1);
}

// 3. Admin Commission Changed from 15% to 8%
console.log('\n----------------------------------------------------');
console.log('Test 3: Admin changes Commission from 15% to 8%');
const quote8 = calculateBookingPrice({
  vendor: mockVendor,
  service: mockService,
  coupon: mockCoupon10Pct,
  commissionPercentage: 8,
  bookingFeePercentage: 5
});

console.log('8% Commission Amount:', quote8.commissionAmount, 'INR (Expected: 720)');
console.log('Vendor Net Payout at 8%:', quote8.vendorPayout, 'INR (Expected: 8280)');

if (quote8.commissionAmount === 720 && quote8.vendorPayout === 8280) {
  console.log('✅ Test 3 PASSED: 8% Dynamic Commission calculates correctly.');
} else {
  console.error('❌ Test 3 FAILED');
  process.exit(1);
}

// 4. Availability Test
console.log('\n----------------------------------------------------');
const now = new Date();
const futureBusyDate = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const futureFreeDate = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
mockVendor.busyDates = [futureBusyDate];

console.log(`Test 4: Real Vendor Availability (Busy on ${futureBusyDate})`);
const availBusy = checkAvailability({
  vendor: mockVendor,
  eventDate: futureBusyDate
});
console.log(`${futureBusyDate} status:`, availBusy.available ? 'AVAILABLE' : 'UNAVAILABLE (Blocked)');

const availFree = checkAvailability({
  vendor: mockVendor,
  eventDate: futureFreeDate
});
console.log(`${futureFreeDate} status:`, availFree.available ? 'AVAILABLE' : 'UNAVAILABLE');

if (!availBusy.available && availFree.available) {
  console.log('✅ Test 4 PASSED: Vendor availability correctly respects real busy dates.');
} else {
  console.error('❌ Test 4 FAILED');
  process.exit(1);
}

console.log('\n====================================================');
console.log('🎉 ALL BACKEND VERIFICATION TESTS PASSED SUCCESSFULLY!');
console.log('====================================================');
