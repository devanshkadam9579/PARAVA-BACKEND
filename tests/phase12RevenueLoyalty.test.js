import { 
  getCustomerLoyalty, 
  awardBookingPoints, 
  validateAndRedeemPoints, 
  commitPointRedemption, 
  reverseBookingPoints, 
  processPointExpirations, 
  getLoyaltyLedger,
  _resetLoyaltyState 
} from '../services/loyaltyService.js';

import { 
  getOrCreateReferralCode, 
  validateReferralCode, 
  registerReferralClaim, 
  processReferralBookingCompletion, 
  reverseReferralReward,
  _resetReferralState 
} from '../services/referralService.js';

import { 
  calculateStackedDiscounts, 
  evaluateCampaign, 
  saveCampaign, 
  CAMPAIGN_STATUSES, 
  _resetPromotionState 
} from '../services/promotionService.js';

import { 
  getVendorSubscription, 
  checkVendorEntitlements, 
  createVendorSubscriptionOrder, 
  activateVendorSubscription, 
  VENDOR_PLANS, 
  SUBSCRIPTION_STATUSES,
  _resetMonetizationState 
} from '../services/vendorMonetizationService.js';

import { 
  getCities, 
  getActiveCities, 
  updateCityStatus, 
  calculateCityMarketplaceMetrics, 
  updateRecruitmentStage, 
  getRecruitmentFunnelSummary, 
  calculateMarketplaceUnitEconomics, 
  CITY_STATUSES,
  _resetExpansionState 
} from '../services/marketplaceExpansionService.js';

import { 
  toggleSaveVendor, 
  getSavedVendors, 
  prepareRepeatBooking, 
  getPersonalizedCustomerOffers, 
  identifyInactiveCustomers, 
  evaluateVendorRetentionHealth,
  _resetRetentionState 
} from '../services/customerRetentionService.js';

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

console.log('\n======================================================================');
console.log('💎 PHASE 12: REVENUE, LOYALTY, REFERRALS & EXPANSION VALIDATION');
console.log('======================================================================\n');

// 1. CUSTOMER LOYALTY LEDGER & TIER PROGRESSION
console.log('[SECTION 1: Loyalty Ledger, Earning Rules & Tier Upgrades]');
{
  _resetLoyaltyState();

  const customerId = 'cust_loyal_1';
  let profile = getCustomerLoyalty(customerId);
  assert(profile.pointsBalance === 0 && profile.tier === 'STANDARD', 'New customer starts with 0 points and STANDARD tier');

  // Completed booking of ₹60,000 (gives 600 base points -> Silver tier >= 500)
  const earn1 = awardBookingPoints({
    customerId,
    bookingId: 'b_101',
    totalEventValueINR: 60000
  });

  assert(earn1.success && earn1.earnedPoints === 600, 'Earns 600 points for ₹60,000 completed event');
  assert(earn1.account.tier === 'SILVER', 'Tier automatically upgrades to SILVER');

  // Idempotency: Duplicate booking completion event must not award twice
  const duplicateEarn = awardBookingPoints({
    customerId,
    bookingId: 'b_101',
    totalEventValueINR: 60000
  });
  assert(duplicateEarn.alreadyAwarded === true, 'Duplicate completion event for same bookingId safely ignored');

  // Repeat booking bonus
  const earn2 = awardBookingPoints({
    customerId,
    bookingId: 'b_102',
    totalEventValueINR: 100000,
    isRepeatBooking: true
  });
  assert(earn2.earnedPoints === 1150, 'Silver tier (1.1x) + 50 repeat bonus gives 1,150 points');

  // Check ledger entries
  const ledger = getLoyaltyLedger(customerId);
  assert(ledger.length === 2, 'Loyalty ledger maintains exact auditable transaction history');
}

// 2. LOYALTY REDEMPTION & REVERSAL SAFETY
console.log('\n[SECTION 2: Point Redemption & Cancellation Reversals]');
{
  const customerId = 'cust_loyal_1';
  const bookingSubtotalPaise = 5000000; // ₹50,000 subtotal

  // Validate redemption of 400 points (400 * 50 paise = ₹200 discount)
  const redemption = validateAndRedeemPoints({
    customerId,
    pointsToRedeem: 400,
    bookingSubtotalPaise
  });
  assert(redemption.valid && redemption.discountINR === 200, '400 points validates to ₹200 booking discount');

  // Commit redemption to ledger
  const commit = commitPointRedemption({
    customerId,
    pointsUsed: redemption.pointsUsed,
    bookingId: 'b_103',
    discountPaise: redemption.discountPaise
  });
  assert(commit.success && commit.account.redeemedPoints === 400, 'Point redemption debits account and logs REDEEMED ledger entry');

  // Cancellation point reversal
  const reversal = reverseBookingPoints({
    customerId,
    bookingId: 'b_101',
    reason: 'CUSTOMER_CANCELLED'
  });
  assert(reversal.success && reversal.reversedPoints === 600, 'Points earned from cancelled booking reversed cleanly');
}

// 3. POINT EXPIRATION SCHEDULER
console.log('\n[SECTION 3: Point Expiration Background Engine]');
await (async () => {
  _resetLoyaltyState();
  const customerId = 'cust_exp_1';
  awardBookingPoints({ customerId, bookingId: 'b_old_1', totalEventValueINR: 50000 }); // 500 pts
  await new Promise(r => setTimeout(r, 10));

  // Simulate expiration with 0 days threshold
  const expRes = processPointExpirations({ expirationDays: 0, customerId });
  assert(expRes.expiredCount === 1 && expRes.totalPointsExpired === 500, 'Expired points moved to EXPIRED ledger transactions');
  assert(getCustomerLoyalty(customerId).pointsBalance === 0, 'Customer points balance updated to 0');
})();

// 4. REFERRAL SYSTEM & FRAUD PREVENTION
console.log('\n[SECTION 4: Referral System & Fraud/Self-Referral Prevention]');
{
  _resetReferralState();
  const referrerId = 'cust_referrer_1';
  const code = getOrCreateReferralCode(referrerId);
  assert(code.startsWith('PARVA-'), 'Generates customer referral code without leaking internal UID');

  // Anti-fraud 1: Self referral
  const selfCheck = validateReferralCode(code, referrerId);
  assert(!selfCheck.valid && selfCheck.reason === 'SELF_REFERRAL_FORBIDDEN', 'Strictly blocks self-referral attempts');

  // Anti-fraud 2: Suspicious same-device cluster
  const refereeId = 'cust_referee_1';
  const suspiciousCheck = validateReferralCode(code, refereeId, {
    deviceId: 'dev_same_123',
    referrerDeviceId: 'dev_same_123'
  });
  assert(suspiciousCheck.adminReviewRequired === true, 'Flags matching device signature for admin review');

  // Legitimate referral registration
  const legitimateClaim = registerReferralClaim({
    code,
    refereeId,
    metadata: { deviceId: 'dev_clean_456' }
  });
  assert(legitimateClaim.status === 'REGISTERED', 'Legitimate referral registered successfully');

  // Reward triggers ONLY on completed booking >= min value
  const rewardResult = processReferralBookingCompletion({
    refereeId,
    bookingId: 'b_ref_first_1',
    totalEventValuePaise: 5000000 // ₹50,000
  });
  assert(rewardResult.eligible === true && rewardResult.referrerPointsToAward === 200, 'Referrer awarded 200 loyalty points on completed referee booking');

  // Reversal if referee cancels
  const revRef = reverseReferralReward({ bookingId: 'b_ref_first_1' });
  assert(revRef.reversed === true, 'Referral reward reversed upon booking cancellation');
}

// 5. MULTI-TIER PROMOTION ENGINE & DETERMINISTIC STACKING
console.log('\n[SECTION 5: Multi-Tier Promotion Engine & Stacking Order]');
{
  _resetPromotionState();
  const baseSubtotalPaise = 10000000; // ₹100,000

  // 1. Vendor Promo: 10% off (₹10,000)
  const vendorPromo = { active: true, discountPercent: 10 };

  // 2. Platform Campaign: Diwali 10% off capped at ₹2,000 (200,000 paise)
  const platformCampaign = {
    id: 'camp_diwali_2026',
    status: CAMPAIGN_STATUSES.ACTIVE,
    discountType: 'percentage',
    discountPercent: 10,
    maxDiscountPaise: 200000,
    minOrderValuePaise: 1000000,
    eligibleCategories: ['Catering']
  };

  // 3. Coupon: Fixed ₹1,000 off (100,000 paise)
  const couponResult = { valid: true, discountPaise: 100000 };

  // 4. Loyalty: 200 points = ₹100 off (10,000 paise)
  const loyaltyRedemption = { valid: true, discountPaise: 10000 };

  const stacked = calculateStackedDiscounts({
    baseSubtotalPaise,
    category: 'Catering',
    vendorId: 'v1',
    customerId: 'c1',
    vendorPromotion: vendorPromo,
    platformCampaign,
    couponResult,
    loyaltyRedemption
  });

  assert(stacked.layers.vendorDiscountINR === 10000, 'Layer 1: Vendor promo discount is ₹10,000');
  assert(stacked.layers.platformDiscountINR === 2000, 'Layer 2: Platform campaign capped at ₹2,000');
  assert(stacked.layers.couponDiscountINR === 1000, 'Layer 3: Coupon discount is ₹1,000');
  assert(stacked.layers.loyaltyDiscountINR === 100, 'Layer 4: Loyalty discount is ₹100');
  assert(stacked.totalDiscountINR === 13100, 'Total stacked discount is exactly ₹13,100');
  assert(stacked.finalAdjustedSubtotalINR === 86900, 'Final adjusted subtotal is ₹86,900');
}

// 6. VENDOR MONETIZATION & SERVER-AUTHORITATIVE ENTITLEMENTS
console.log('\n[SECTION 6: Vendor Monetization & Entitlements]');
{
  _resetMonetizationState();
  const vendorId = 'v_free_partner';

  // Free default
  const freeEntitlements = checkVendorEntitlements(vendorId);
  assert(freeEntitlements.planId === 'plan_free' && freeEntitlements.canUseAnalytics === false, 'Free plan has analytics disabled');

  // Upgrade to PRO
  const order = createVendorSubscriptionOrder({ vendorId, planId: 'plan_pro', billingMonths: 1 });
  assert(order.paymentRequired === true && order.amountINR === 1999, 'PRO plan order created with ₹1,999 due');

  // Payment Webhook Activates PRO
  activateVendorSubscription({
    vendorId,
    subscriptionId: order.subscription.subscriptionId,
    paymentTransactionId: 'pay_cf_sub_123'
  });

  const proEntitlements = checkVendorEntitlements(vendorId);
  assert(proEntitlements.canUseAnalytics === true && proEntitlements.canCreatePromotion === true, 'PRO plan unlocks analytics and promotional tools');
}

// 7. MULTI-CITY EXPANSION & ACTIVATION
console.log('\n[SECTION 7: Multi-City Architecture & Activation]');
{
  const activeCities = getActiveCities();
  assert(activeCities.length >= 3, 'Active marketplace cities available (Pune, Mumbai, Kolhapur)');

  // Admin activates planned city (Nagpur)
  const updatedCity = updateCityStatus('city_nagpur', CITY_STATUSES.ACTIVE);
  assert(updatedCity.status === 'ACTIVE', 'Admin successfully activates new city');

  // City metrics
  const mockBookings = [
    { city: 'Pune', status: 'COMPLETED', _paise: { totalEventValuePaise: 5000000, platformFeePaise: 250000 } },
    { city: 'Pune', status: 'COMPLETED', _paise: { totalEventValuePaise: 3000000, platformFeePaise: 150000 } }
  ];
  const metrics = calculateCityMarketplaceMetrics({ cityId: 'city_pune', vendors: [{ location: 'Pune', verified: true }], bookings: mockBookings });
  assert(metrics.completedBookings === 2 && metrics.gmvINR === 80000 && metrics.aovINR === 40000, 'City marketplace metrics calculated accurately');
}

// 8. VENDOR RECRUITMENT PIPELINE
console.log('\n[SECTION 8: Vendor Recruitment Pipeline]');
{
  _resetExpansionState();
  updateRecruitmentStage({ leadId: 'lead_1', vendorName: 'Elite Sound', category: 'DJ', city: 'Pune', stage: 'LEAD' });
  updateRecruitmentStage({ leadId: 'lead_1', vendorName: 'Elite Sound', category: 'DJ', city: 'Pune', stage: 'ONBOARDING' });
  updateRecruitmentStage({ leadId: 'lead_2', vendorName: 'Grand Decor', category: 'Decoration', city: 'Kolhapur', stage: 'ACTIVE' });

  const funnel = getRecruitmentFunnelSummary();
  assert(funnel.totalLeads === 2 && funnel.funnel.ONBOARDING === 1 && funnel.funnel.ACTIVE === 1, 'Recruitment funnel tracks vendor acquisition stages');
}

// 9. REPEAT BOOKING & CUSTOMER RETENTION
console.log('\n[SECTION 9: Repeat Booking ("Book Again") & Saved Vendors]');
{
  _resetRetentionState();
  const customerId = 'cust_ret_1';
  const vendorId = 'v10';

  // Toggle favorite
  const saved = toggleSaveVendor(customerId, vendorId);
  assert(saved.isSaved === true, 'Vendor added to customer favorites');

  // Repeat booking re-validation
  const prevBooking = { id: 'b_old_99', guestCount: 120 };
  const mockVendor = { id: 'v10', name: 'Royal Caterers', category: 'Catering' };
  const mockService = { id: 's10', name: 'Luxury Feast', pricingModel: 'PER_GUEST', basePrice: 700 };

  const repeatPrep = prepareRepeatBooking({
    previousBooking: prevBooking,
    currentVendor: mockVendor,
    currentService: mockService,
    newEventDate: '2026-12-25',
    newEventTimeSlot: 'evening',
    guestCount: 120
  });

  assert(repeatPrep.isRepeatBooking === true && repeatPrep.priceQuote._paise.totalEventValuePaise === 8400000, 'Repeat booking freshly revalidates 120 guests × ₹700 = ₹84,000');
}

// 10. UNIT ECONOMICS & NET PLATFORM REVENUE
console.log('\n[SECTION 10: Master Unit Economics & Revenue Safety]');
{
  const mockBookings = [
    { customerId: 'c1', status: 'COMPLETED', _paise: { totalEventValuePaise: 10000000, platformFeePaise: 500000 } },
    { customerId: 'c1', status: 'COMPLETED', _paise: { totalEventValuePaise: 5000000, platformFeePaise: 250000 } }, // repeat
    { customerId: 'c2', status: 'COMPLETED', _paise: { totalEventValuePaise: 8000000, platformFeePaise: 400000 } }
  ];
  const mockSubs = [{ status: 'ACTIVE', amountPaise: 199900 }];
  const mockRefunds = [{ refundAmountPaise: 50000 }];

  const econ = calculateMarketplaceUnitEconomics({
    bookings: mockBookings,
    subscriptions: mockSubs,
    refunds: mockRefunds,
    marketingSpendINR: 1000
  });

  assert(econ.grossGmvINR === 230000, 'Gross GMV is ₹230,000');
  assert(econ.grossCommissionINR === 11500, 'Gross 5% advance commission is ₹11,500');
  assert(econ.subscriptionRevenueINR === 1999, 'Subscription revenue is ₹1,999');
  assert(econ.netPlatformRevenueINR === 12999, 'Net platform revenue is ₹12,999');
  assert(econ.repeatBookingRate === '50.0%', 'Repeat customer booking rate is 50.0%');
}

console.log('\n======================================================================');
console.log(`PHASE 12 TEST SUMMARY: ${passedTests} PASSED | ${totalTests - passedTests} FAILED`);
console.log('======================================================================\n');
