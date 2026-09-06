/**
 * PARVA PLATFORM — AUTHORITATIVE PROMOTION & MULTI-TIER DISCOUNT ENGINE
 * Version 2.0.0
 * 
 * Rules:
 * - Deterministic stacking hierarchy:
 *   1. BASE PRICE
 *   2. VENDOR PROMOTION (e.g. Seasonal 10% off service/package)
 *   3. PLATFORM PROMOTION (e.g. Diwali Platform Campaign)
 *   4. COUPON CODE (e.g. PARVA20)
 *   5. LOYALTY REDEMPTION (e.g. 500 points = ₹250)
 * - Server calculates and enforces final payable amount
 * - Usage tracking (per customer & global campaign limits)
 * - Vendor promotions cannot tamper with platform commission or core rules
 */

export const PROMOTION_TYPES = {
  PERCENTAGE: 'PERCENTAGE',
  FIXED_AMOUNT: 'FIXED_AMOUNT',
  CATEGORY_OFFER: 'CATEGORY_OFFER',
  VENDOR_OFFER: 'VENDOR_OFFER',
  FIRST_BOOKING: 'FIRST_BOOKING',
  REPEAT_CUSTOMER: 'REPEAT_CUSTOMER',
  SEASONAL_CAMPAIGN: 'SEASONAL_CAMPAIGN'
};

export const CAMPAIGN_STATUSES = {
  DRAFT: 'DRAFT',
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
};

// In-memory campaign storage
const campaigns = [
  {
    id: 'camp_diwali_2026',
    title: 'Diwali Grand Festivities',
    type: PROMOTION_TYPES.SEASONAL_CAMPAIGN,
    discountType: 'percentage',
    discountPercent: 10,
    maxDiscountPaise: 200000, // ₹2,000 max
    minOrderValuePaise: 1000000, // ₹10,000 min
    eligibleCategories: ['Decoration', 'Catering', 'Photography', 'Banquet Hall'],
    status: CAMPAIGN_STATUSES.ACTIVE,
    startDate: '2026-01-01T00:00:00Z',
    endDate: '2026-12-31T23:59:59Z',
    usageLimitGlobal: 10000,
    usageLimitPerCustomer: 2,
    currentUsageCount: 45
  },
  {
    id: 'camp_first_booking',
    title: 'Welcome to MyParva',
    type: PROMOTION_TYPES.FIRST_BOOKING,
    discountType: 'fixed',
    discountAmountINR: 500,
    minOrderValuePaise: 250000, // ₹2,500 min
    status: CAMPAIGN_STATUSES.ACTIVE,
    startDate: '2026-01-01T00:00:00Z',
    endDate: '2027-12-31T23:59:59Z',
    usageLimitGlobal: 50000,
    usageLimitPerCustomer: 1,
    currentUsageCount: 120
  }
];

// Usage ledger for customer campaign limits
const promotionUsageLedger = [];

/**
 * Validates whether a specific campaign is applicable
 */
export function evaluateCampaign({ campaign, subtotalPaise, category, vendorId, customerId, isFirstBooking = false }) {
  if (!campaign || campaign.status !== CAMPAIGN_STATUSES.ACTIVE) {
    return { valid: false, reason: 'CAMPAIGN_INACTIVE' };
  }

  const now = new Date();
  if (campaign.startDate && new Date(campaign.startDate) > now) {
    return { valid: false, reason: 'CAMPAIGN_NOT_STARTED' };
  }
  if (campaign.endDate && new Date(campaign.endDate) < now) {
    return { valid: false, reason: 'CAMPAIGN_EXPIRED' };
  }

  if (campaign.type === PROMOTION_TYPES.FIRST_BOOKING && !isFirstBooking) {
    return { valid: false, reason: 'ELIGIBLE_FOR_FIRST_BOOKING_ONLY' };
  }

  if (campaign.minOrderValuePaise && subtotalPaise < campaign.minOrderValuePaise) {
    return { 
      valid: false, 
      reason: `MIN_ORDER_NOT_MET: Minimum order is ₹${campaign.minOrderValuePaise / 100}` 
    };
  }

  if (campaign.eligibleCategories && campaign.eligibleCategories.length > 0) {
    const isCatMatch = campaign.eligibleCategories.some(c => c.toLowerCase() === (category || '').toLowerCase());
    if (!isCatMatch) {
      return { valid: false, reason: 'CATEGORY_NOT_ELIGIBLE' };
    }
  }

  if (campaign.eligibleVendors && campaign.eligibleVendors.length > 0) {
    const isVendorMatch = campaign.eligibleVendors.includes(vendorId);
    if (!isVendorMatch) {
      return { valid: false, reason: 'VENDOR_NOT_ELIGIBLE' };
    }
  }

  // Customer usage limit check
  if (customerId && campaign.usageLimitPerCustomer) {
    const custUsage = promotionUsageLedger.filter(u => u.campaignId === campaign.id && u.customerId === customerId).length;
    if (custUsage >= campaign.usageLimitPerCustomer) {
      return { valid: false, reason: 'CUSTOMER_USAGE_LIMIT_EXCEEDED' };
    }
  }

  // Calculate discount
  let discountPaise = 0;
  if (campaign.discountType === 'percentage') {
    discountPaise = Math.round((subtotalPaise * (campaign.discountPercent || 0)) / 100);
    if (campaign.maxDiscountPaise && discountPaise > campaign.maxDiscountPaise) {
      discountPaise = campaign.maxDiscountPaise;
    }
  } else {
    discountPaise = Math.round((campaign.discountAmountINR || 0) * 100);
  }

  // Cap at current subtotal
  discountPaise = Math.min(discountPaise, subtotalPaise);

  return {
    valid: true,
    campaignId: campaign.id,
    title: campaign.title,
    discountPaise,
    discountINR: discountPaise / 100
  };
}

/**
 * Calculates master stacked pricing across all discount layers
 */
export function calculateStackedDiscounts({
  baseSubtotalPaise,
  category,
  vendorId,
  customerId,
  isFirstBooking = false,
  vendorPromotion = null,
  platformCampaign = null,
  couponResult = null,
  loyaltyRedemption = null
}) {
  let currentRunningPaise = baseSubtotalPaise;

  // Layer 1: Vendor Promotion
  let vendorDiscountPaise = 0;
  if (vendorPromotion && vendorPromotion.active) {
    if (vendorPromotion.discountPercent) {
      vendorDiscountPaise = Math.round((currentRunningPaise * vendorPromotion.discountPercent) / 100);
      if (vendorPromotion.maxDiscountPaise) {
        vendorDiscountPaise = Math.min(vendorDiscountPaise, vendorPromotion.maxDiscountPaise);
      }
    } else if (vendorPromotion.discountAmountINR) {
      vendorDiscountPaise = Math.round(vendorPromotion.discountAmountINR * 100);
    }
    vendorDiscountPaise = Math.min(vendorDiscountPaise, currentRunningPaise);
    currentRunningPaise -= vendorDiscountPaise;
  }

  // Layer 2: Platform Promotion Campaign
  let platformDiscountPaise = 0;
  if (platformCampaign) {
    const evalRes = evaluateCampaign({
      campaign: platformCampaign,
      subtotalPaise: currentRunningPaise,
      category,
      vendorId,
      customerId,
      isFirstBooking
    });
    if (evalRes.valid) {
      platformDiscountPaise = evalRes.discountPaise;
      currentRunningPaise -= platformDiscountPaise;
    }
  }

  // Layer 3: Coupon Code
  let couponDiscountPaise = 0;
  if (couponResult && couponResult.valid && couponResult.discountPaise) {
    couponDiscountPaise = Math.min(couponResult.discountPaise, currentRunningPaise);
    currentRunningPaise -= couponDiscountPaise;
  }

  // Layer 4: Loyalty Points Redemption
  let loyaltyDiscountPaise = 0;
  if (loyaltyRedemption && loyaltyRedemption.valid && loyaltyRedemption.discountPaise) {
    loyaltyDiscountPaise = Math.min(loyaltyRedemption.discountPaise, currentRunningPaise);
    currentRunningPaise -= loyaltyDiscountPaise;
  }

  const totalDiscountPaise = vendorDiscountPaise + platformDiscountPaise + couponDiscountPaise + loyaltyDiscountPaise;
  const finalAdjustedSubtotalPaise = Math.max(0, baseSubtotalPaise - totalDiscountPaise);

  return {
    baseSubtotalPaise,
    vendorDiscountPaise,
    platformDiscountPaise,
    couponDiscountPaise,
    loyaltyDiscountPaise,
    totalDiscountPaise,
    finalAdjustedSubtotalPaise,
    totalDiscountINR: totalDiscountPaise / 100,
    finalAdjustedSubtotalINR: finalAdjustedSubtotalPaise / 100,
    layers: {
      vendorDiscountINR: vendorDiscountPaise / 100,
      platformDiscountINR: platformDiscountPaise / 100,
      couponDiscountINR: couponDiscountPaise / 100,
      loyaltyDiscountINR: loyaltyDiscountPaise / 100
    }
  };
}

/**
 * Commits campaign usage upon booking creation
 */
export function recordCampaignUsage({ campaignId, customerId, bookingId, discountPaise }) {
  const campaign = campaigns.find(c => c.id === campaignId);
  if (campaign) {
    campaign.currentUsageCount = (campaign.currentUsageCount || 0) + 1;
  }

  promotionUsageLedger.push({
    campaignId,
    customerId,
    bookingId,
    discountPaise,
    usedAt: new Date().toISOString()
  });
}

/**
 * Gets all active campaigns for public display
 */
export function getActiveCampaigns() {
  const now = new Date();
  return campaigns.filter(c => 
    c.status === CAMPAIGN_STATUSES.ACTIVE &&
    (!c.startDate || new Date(c.startDate) <= now) &&
    (!c.endDate || new Date(c.endDate) >= now)
  );
}

/**
 * Admin creates or updates campaign
 */
export function saveCampaign(campaignData) {
  const id = campaignData.id || `camp_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const existingIdx = campaigns.findIndex(c => c.id === id);

  const cleanCampaign = {
    ...campaignData,
    id,
    updatedAt: new Date().toISOString()
  };

  if (existingIdx >= 0) {
    campaigns[existingIdx] = cleanCampaign;
  } else {
    cleanCampaign.createdAt = new Date().toISOString();
    cleanCampaign.currentUsageCount = 0;
    campaigns.push(cleanCampaign);
  }

  return cleanCampaign;
}

/**
 * Resets state for testing
 */
export function _resetPromotionState() {
  promotionUsageLedger.length = 0;
}
