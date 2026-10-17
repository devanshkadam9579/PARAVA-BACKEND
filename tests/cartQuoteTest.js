import { calculateCartQuote, PRICING_MODELS } from '../services/pricingEngine.js';

console.log('====================================================');
console.log('🧪 RUNNING PARVA MULTI-ITEM & CATERING QUOTE TESTS');
console.log('====================================================\n');

// Test 1: Catering service (100 guests @ ₹600)
console.log('Test 1: Catering calculation integrity (Single application of guest count)');
const cateringItem = {
  vendor: {
    id: 'v_cater_1',
    name: 'Saffron & Spice Gourmet Catering',
    category: 'Catering'
  },
  service: {
    id: 'svc_cater_buffet',
    name: 'Royal Shahi Buffet',
    basePrice: 600,
    basePlatePrice: 600,
    pricingModel: PRICING_MODELS.PER_GUEST,
    minimumGuests: 50,
    maximumGuests: 1000
  },
  guestCount: 100,
  quantity: 1
};

const quote1 = calculateCartQuote({
  cartItems: [cateringItem],
  bookingFeePercentage: 5,
  commissionPercentage: 10
});

console.log('Catering Subtotal:', quote1.subtotal, 'INR (Expected: 60000)');
console.log('Platform Fee (5%):', quote1.platformFee, 'INR (Expected: 3000)');
console.log('GST (18% on fee):', quote1.taxGst, 'INR (Expected: 540)');
console.log('Advance Due Now:', quote1.finalAdvanceDue, 'INR (Expected: 3540)');
console.log('Balance Due at Event:', quote1.balanceDueAtEvent, 'INR (Expected: 57000)');

if (
  quote1.subtotal === 60000 &&
  quote1.platformFee === 3000 &&
  quote1.taxGst === 540 &&
  quote1.finalAdvanceDue === 3540 &&
  quote1.balanceDueAtEvent === 57000
) {
  console.log('✅ Test 1 PASSED: Catering guest count applied exactly once.');
} else {
  console.error('❌ Test 1 FAILED');
  process.exit(1);
}

// Test 2: Multi-vendor cart (Catering ₹60,000 + Decorator ₹20,000) with ₹5,000 Coupon
console.log('\n----------------------------------------------------');
console.log('Test 2: Multi-vendor Cart with Coupon Discount');
const decorItem = {
  vendor: {
    id: 'v_decor_2',
    name: 'Aura Floral Decor',
    category: 'Decorator'
  },
  service: {
    id: 'svc_decor_mandap',
    name: 'Floral Mandap Setup',
    basePrice: 20000,
    pricingModel: PRICING_MODELS.PACKAGE
  },
  quantity: 1
};

const coupon5k = {
  code: 'CELEBRATE5K',
  discountType: 'flat',
  discountAmount: 5000,
  minSpend: 50000,
  active: true
};

const quote2 = calculateCartQuote({
  cartItems: [cateringItem, decorItem],
  coupon: coupon5k,
  bookingFeePercentage: 5,
  commissionPercentage: 10
});

console.log('Gross Subtotal:', quote2.subtotal, 'INR (Expected: 80000)');
console.log('Coupon Discount:', quote2.discount, 'INR (Expected: 5000)');
console.log('Discounted Subtotal:', quote2.discountedSubtotal, 'INR (Expected: 75000)');
console.log('Platform Fee (5%):', quote2.platformFee, 'INR (Expected: 3750)');
console.log('GST (18% on fee):', quote2.taxGst, 'INR (Expected: 675)');
console.log('Advance Due Now:', quote2.finalAdvanceDue, 'INR (Expected: 4425)');
console.log('Vendor Count:', quote2.vendorCount, '(Expected: 2)');

if (
  quote2.subtotal === 80000 &&
  quote2.discount === 5000 &&
  quote2.discountedSubtotal === 75000 &&
  quote2.platformFee === 3750 &&
  quote2.taxGst === 675 &&
  quote2.finalAdvanceDue === 4425 &&
  quote2.vendorCount === 2
) {
  console.log('✅ Test 2 PASSED: Multi-vendor cart and coupon discount calculated accurately.');
} else {
  console.error('❌ Test 2 FAILED');
  process.exit(1);
}

console.log('\n====================================================');
console.log('🎉 ALL CART QUOTE TESTS PASSED SUCCESSFULLY!');
console.log('====================================================');
