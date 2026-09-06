/**
 * PARVA PLATFORM — AUTHORITATIVE PRICING ENGINE
 * Version 2.0.0
 * 
 * Rules:
 * - Deterministic money arithmetic in integer paise (1 INR = 100 paise)
 * - Category-specific calculation strategies (Catering, Photography, Decor, DJ, Venue, Fixed)
 * - Strict guest count validation (minimumGuests, maximumGuests)
 * - Dynamic Coupon Engine with category, date, and cap rules
 * - Immutable price snapshot creation
 */

export const PRICING_MODELS = {
  PER_GUEST: 'PER_GUEST',
  PACKAGE: 'PACKAGE',
  PACKAGE_PLUS_ADDONS: 'PACKAGE_PLUS_ADDONS',
  HOURLY: 'HOURLY',
  PER_DAY: 'PER_DAY',
  FIXED: 'FIXED'
};

/**
 * Validates guest count against service configuration
 */
export function validateGuestCount(service, guestCount) {
  const min = service.minimumGuests || (service.pricingModel === PRICING_MODELS.PER_GUEST ? 10 : 1);
  const max = service.maximumGuests || 10000;
  
  const count = parseInt(guestCount, 10);
  if (isNaN(count) || count < min) {
    throw new Error(`INVALID_GUEST_COUNT: Minimum required guests for "${service.name}" is ${min}. Provided: ${guestCount}`);
  }
  if (count > max) {
    throw new Error(`INVALID_GUEST_COUNT: Maximum allowed guests for "${service.name}" is ${max}. Provided: ${guestCount}`);
  }
  return count;
}

/**
 * Validates and calculates coupon discount
 */
export function evaluateCoupon(coupon, subtotalPaise, category, userId) {
  if (!coupon) return { valid: false, discountPaise: 0, reason: 'NO_COUPON' };

  const now = new Date();
  if (coupon.validUntil && new Date(coupon.validUntil) < now) {
    return { valid: false, discountPaise: 0, reason: 'COUPON_EXPIRED' };
  }
  if (coupon.validFrom && new Date(coupon.validFrom) > now) {
    return { valid: false, discountPaise: 0, reason: 'COUPON_NOT_YET_ACTIVE' };
  }
  if (coupon.minOrderAmountPaise && subtotalPaise < coupon.minOrderAmountPaise) {
    return { 
      valid: false, 
      discountPaise: 0, 
      reason: `MIN_ORDER_NOT_MET: Minimum order required is ₹${coupon.minOrderAmountPaise / 100}` 
    };
  }
  if (coupon.eligibleCategories && coupon.eligibleCategories.length > 0) {
    const isCatEligible = coupon.eligibleCategories.some(
      c => c.toLowerCase() === (category || '').toLowerCase()
    );
    if (!isCatEligible) {
      return { valid: false, discountPaise: 0, reason: 'CATEGORY_NOT_ELIGIBLE' };
    }
  }

  let discountPaise = 0;
  if (coupon.discountType === 'percentage') {
    discountPaise = Math.round((subtotalPaise * (coupon.discountPercent || 0)) / 100);
    if (coupon.maxDiscountPaise && discountPaise > coupon.maxDiscountPaise) {
      discountPaise = coupon.maxDiscountPaise;
    }
  } else {
    // Fixed amount discount
    discountPaise = Math.round((coupon.discountAmount || 0) * 100);
  }

  // Cap discount at subtotal
  discountPaise = Math.min(discountPaise, subtotalPaise);

  return {
    valid: true,
    code: coupon.code,
    discountPaise,
    discountAmountINR: discountPaise / 100,
    message: `₹${discountPaise / 100} discount applied successfully`
  };
}

/**
 * Authoritative Master Price Calculator
 * 
 * @param {Object} params
 * @param {Object} params.vendor - Vendor entity from DB
 * @param {Object} params.service - Selected service entity from DB
 * @param {Object} [params.selectedPackage] - Optional selected package
 * @param {Array}  [params.selectedAddons] - Optional list of add-ons
 * @param {number} [params.guestCount] - Number of attendees
 * @param {number} [params.extraHours] - Additional hours for hourly services
 * @param {number} [params.durationDays] - Duration in days for venues
 * @param {Object} [params.coupon] - Optional coupon from DB
 * @returns {Object} Full breakdown and snapshot
 */
export function calculateBookingPrice({
  vendor,
  service,
  selectedPackage,
  selectedAddons = [],
  guestCount = 100,
  extraHours = 0,
  durationDays = 1,
  coupon = null
}) {
  if (!vendor || !service) {
    throw new Error('PRICING_ERROR: Both vendor and service records are required for calculation');
  }

  const category = vendor.category || 'General';
  const pricingModel = service.pricingModel || 
    (category.toLowerCase() === 'catering' ? PRICING_MODELS.PER_GUEST : 
     (category.toLowerCase() === 'photography' || category.toLowerCase() === 'dj') ? PRICING_MODELS.HOURLY :
     PRICING_MODELS.PACKAGE_PLUS_ADDONS);

  let baseAmountPaise = 0;
  let guestAmountPaise = 0;
  let durationAmountPaise = 0;
  let addonsAmountPaise = 0;

  // 1. Base Package Calculation by Pricing Model
  if (pricingModel === PRICING_MODELS.PER_GUEST) {
    const validGuests = validateGuestCount(service, guestCount);
    const plateRateINR = selectedPackage?.price || service.basePrice || service.price || 500;
    const plateRatePaise = Math.round(plateRateINR * 100);
    guestAmountPaise = plateRatePaise * validGuests;
    baseAmountPaise = guestAmountPaise;
  } else if (pricingModel === PRICING_MODELS.HOURLY) {
    const basePackageINR = selectedPackage?.price || service.basePrice || service.price || 15000;
    baseAmountPaise = Math.round(basePackageINR * 100);
    const hourlyRateINR = service.hourlyRate || 2000;
    const extraHoursCount = Math.max(0, parseInt(extraHours, 10) || 0);
    durationAmountPaise = Math.round(hourlyRateINR * 100) * extraHoursCount;
  } else if (pricingModel === PRICING_MODELS.PER_DAY) {
    const dayRateINR = selectedPackage?.price || service.basePrice || service.price || 20000;
    const days = Math.max(1, parseInt(durationDays, 10) || 1);
    baseAmountPaise = Math.round(dayRateINR * 100) * days;
  } else {
    // Standard Package / Package + Addons / Fixed
    const packageINR = selectedPackage?.price || service.basePrice || service.price || 10000;
    baseAmountPaise = Math.round(packageINR * 100);
  }

  // 2. Add-ons Calculation
  if (Array.isArray(selectedAddons) && selectedAddons.length > 0) {
    addonsAmountPaise = selectedAddons.reduce((sum, addon) => {
      const addonPriceINR = addon.price || 0;
      return sum + Math.round(addonPriceINR * 100);
    }, 0);
  }

  // 3. Subtotal
  const subtotalPaise = baseAmountPaise + durationAmountPaise + addonsAmountPaise;

  // 4. Coupon Evaluation
  const couponResult = evaluateCoupon(coupon, subtotalPaise, category);
  const discountPaise = couponResult.discountPaise;
  const adjustedSubtotalPaise = Math.max(0, subtotalPaise - discountPaise);

  // 5. Escrow Advance Connection Fee (5% of Adjusted Subtotal)
  const platformFeePaise = Math.round(adjustedSubtotalPaise * 0.05);

  // 6. GST (18% on Platform/Advance Connection Fee)
  const taxGstPaise = Math.round(platformFeePaise * 0.18);

  // 7. Authoritative Totals
  const finalAdvanceDuePaise = platformFeePaise + taxGstPaise;
  const balanceDueAtEventPaise = adjustedSubtotalPaise - platformFeePaise;
  const totalEventValuePaise = adjustedSubtotalPaise;

  // 8. Immutable Price Snapshot
  const priceSnapshot = {
    calculationVersion: '2.0.0',
    calculatedAt: new Date().toISOString(),
    pricingModel,
    category,
    guestCount: pricingModel === PRICING_MODELS.PER_GUEST ? parseInt(guestCount, 10) : undefined,
    extraHours: pricingModel === PRICING_MODELS.HOURLY ? parseInt(extraHours, 10) : undefined,
    durationDays: pricingModel === PRICING_MODELS.PER_DAY ? parseInt(durationDays, 10) : undefined,
    
    // Monetary figures in INR for transparent display & records
    baseAmount: baseAmountPaise / 100,
    durationAmount: durationAmountPaise / 100,
    addonsAmount: addonsAmountPaise / 100,
    subtotal: subtotalPaise / 100,
    couponCode: couponResult.valid ? couponResult.code : null,
    discountAmount: discountPaise / 100,
    adjustedSubtotal: adjustedSubtotalPaise / 100,
    platformFee: platformFeePaise / 100,
    taxGst: taxGstPaise / 100,
    finalAdvanceDue: finalAdvanceDuePaise / 100,
    balanceDueAtEvent: balanceDueAtEventPaise / 100,
    totalEventValue: totalEventValuePaise / 100,
    currency: 'INR',
    
    // Internal minor unit precision
    _paise: {
      subtotalPaise,
      discountPaise,
      platformFeePaise,
      taxGstPaise,
      finalAdvanceDuePaise,
      balanceDueAtEventPaise,
      totalEventValuePaise
    }
  };

  return priceSnapshot;
}
