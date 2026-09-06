/**
 * PARVA PLATFORM - PHASE 9 GROWTH, ANALYTICS & MARKETPLACE OPTIMIZATION TEST SUITE
 * Version 2.0.0
 */

import { trackEvent, computeCustomerFunnel, computeVendorPerformanceMetrics, computeMarketplaceLiquidity, ANALYTICS_EVENT_TYPES } from '../services/analyticsEngine.js';
import { searchAndRankVendors, SORT_OPTIONS } from '../services/rankingEngine.js';

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

async function runPhase9Tests() {
  console.log('======================================================================');
  console.log('PHASE 9: GROWTH, ANALYTICS & MARKETPLACE OPTIMIZATION VALIDATION');
  console.log('======================================================================\n');

  // 1. DATA MINIMIZATION & EVENT TRACKING
  console.log('[SECTION 1: Event Tracking & Privacy Sanitization]');
  const event = trackEvent({
    eventType: ANALYTICS_EVENT_TYPES.BOOKING_STARTED,
    userId: 'user_123',
    vendorId: 'vendor_456',
    metadata: {
      guestCount: 250,
      packageId: 'pkg_royal',
      password: 'secret_pwd', // Must be stripped
      cardNumber: '411111111111' // Must be stripped
    }
  });
  assert(event && event.id, 'Analytics event generated with unique ID');
  assert(event.metadata.guestCount === 250, 'Legitimate metadata preserved');
  assert(event.metadata.password === undefined, 'Sensitive password key sanitized and omitted');
  assert(event.metadata.cardNumber === undefined, 'Sensitive card data sanitized and omitted');

  // 2. CUSTOMER CONVERSION FUNNEL METRICS
  console.log('\n[SECTION 2: Customer Funnel & Conversion Rates]');
  const mockEvents = [
    { eventType: ANALYTICS_EVENT_TYPES.PAGE_VIEW },
    { eventType: ANALYTICS_EVENT_TYPES.PAGE_VIEW },
    { eventType: ANALYTICS_EVENT_TYPES.PAGE_VIEW },
    { eventType: ANALYTICS_EVENT_TYPES.PAGE_VIEW },
    { eventType: ANALYTICS_EVENT_TYPES.VENDOR_VIEWED },
    { eventType: ANALYTICS_EVENT_TYPES.VENDOR_VIEWED },
    { eventType: ANALYTICS_EVENT_TYPES.BOOKING_STARTED },
    { eventType: ANALYTICS_EVENT_TYPES.PAYMENT_INITIATED },
    { eventType: ANALYTICS_EVENT_TYPES.PAYMENT_SUCCESS },
    { eventType: ANALYTICS_EVENT_TYPES.BOOKING_CONFIRMED },
    { eventType: ANALYTICS_EVENT_TYPES.REVIEW_SUBMITTED }
  ];
  const funnel = computeCustomerFunnel(mockEvents);
  assert(funnel.counts.visitors === 4, 'Visitor count is 4');
  assert(funnel.counts.vendorViews === 2, 'Vendor views count is 2');
  assert(funnel.counts.bookingConfirmed === 1, 'Booking confirmed count is 1');
  assert(funnel.conversionRates.overallEndToEndConversionPct === '25.0', 'End-to-end conversion rate calculated as 25.0%');

  // 3. VENDOR QUALITY SCORE & ACTIVATION METRICS
  console.log('\n[SECTION 3: Vendor Quality Score & Performance Metrics]');
  const mockVendor = {
    id: 'v_pista',
    name: 'Pista House Catering',
    category: 'catering',
    rating: 4.9,
    reviewCount: 48,
    verificationStatus: 'Approved',
    services: [{ id: 's1', name: 'Biryani Feast' }]
  };
  const mockBookings = [
    { vendorId: 'v_pista', status: 'CONFIRMED' },
    { vendorId: 'v_pista', status: 'COMPLETED' },
    { vendorId: 'v_pista', status: 'COMPLETED' },
    { vendorId: 'v_pista', status: 'REJECTED' }
  ];
  const vendorMetrics = computeVendorPerformanceMetrics(mockVendor, mockBookings);
  assert(vendorMetrics.totalBookingsReceived === 4, 'Total bookings received is 4');
  assert(vendorMetrics.acceptedBookings === 3, 'Accepted bookings count is 3');
  assert(vendorMetrics.acceptanceRatePct === 75, 'Acceptance rate is 75%');
  assert(vendorMetrics.completionRatePct === 67, 'Completion rate is 67%');
  assert(vendorMetrics.isActivated === true, 'Vendor qualifies as fully activated');

  // 4. MARKETPLACE LIQUIDITY (SUPPLY VS DEMAND)
  console.log('\n[SECTION 4: Marketplace Liquidity & Category Balance]');
  const categories = [
    { id: 'catering', name: 'Catering' },
    { id: 'photography', name: 'Photography' }
  ];
  const vendors = [
    { id: 'v1', category: 'catering', services: [1, 2] },
    { id: 'v2', category: 'photography', services: [1] }
  ];
  const liquidityBookings = [
    { vendor: { category: 'catering' } },
    { vendor: { category: 'catering' } },
    { vendor: { category: 'catering' } },
    { vendor: { category: 'catering' } }
  ];
  const liquidity = computeMarketplaceLiquidity(categories, vendors, liquidityBookings);
  assert(liquidity.length === 2, 'Computes liquidity for all marketplace categories');
  assert(liquidity[0].categoryId === 'catering' && liquidity[0].liquidityRatio === 4.0, 'Catering liquidity ratio is 4.0');
  assert(liquidity[0].balanceStatus === 'HIGH_DEMAND_UNDERSUPPLIED', 'Correctly flags high demand undersupplied category');

  // 5. SEARCH & MULTI-FACTOR RANKING & PRICE SORTING
  console.log('\n[SECTION 5: Search, Multi-Factor Ranking & Price Sorting]');
  const testVendorsList = [
    { id: 'v_budget', name: 'Budget Sounds', category: 'dj', city: 'Pune', basePrice: 15000, rating: 4.2, reviewCount: 5 },
    { id: 'v_premium', name: 'Grand Concert DJ', category: 'dj', city: 'Pune', basePrice: 55000, rating: 4.95, reviewCount: 60, verified: true, isGuestFavourite: true },
    { id: 'v_mid', name: 'Sangeet DJ Beats', category: 'dj', city: 'Mumbai', basePrice: 30000, rating: 4.8, reviewCount: 20 }
  ];

  // Price Ascending Sort
  const priceAsc = searchAndRankVendors({ vendors: testVendorsList, sortBy: SORT_OPTIONS.PRICE_ASC });
  assert(priceAsc[0].id === 'v_budget' && priceAsc[2].id === 'v_premium', 'Price Low->High sorts from 15k to 55k');

  // Price Descending Sort
  const priceDesc = searchAndRankVendors({ vendors: testVendorsList, sortBy: SORT_OPTIONS.PRICE_DESC });
  assert(priceDesc[0].id === 'v_premium' && priceDesc[2].id === 'v_budget', 'Price High->Low sorts from 55k to 15k');

  // Relevance & Quality Score Sort
  const qualitySort = searchAndRankVendors({ vendors: testVendorsList, sortBy: SORT_OPTIONS.RELEVANCE });
  assert(qualitySort[0].id === 'v_premium', 'Quality score algorithm ranks top verified guest favourite first');

  // City Filter Match
  const puneFiltered = searchAndRankVendors({ vendors: testVendorsList, city: 'Pune' });
  assert(puneFiltered.length === 2, 'City filter correctly isolates Pune vendors');

  console.log('\n======================================================================');
  console.log('PHASE 9 TEST SUMMARY: ' + passed + ' PASSED | ' + failed + ' FAILED');
  console.log('======================================================================\n');

  if (failed > 0) process.exit(1);
}

runPhase9Tests().catch(err => {
  console.error(err);
  process.exit(1);
});