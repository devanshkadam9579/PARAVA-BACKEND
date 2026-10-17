/**
 * PARVA PLATFORM — AUTHORITATIVE PRICING ENGINE
 * Version 2.1.0
 * 
 * Rules:
 * - Deterministic money arithmetic in integer paise (1 INR = 100 paise)
 * - Category-specific calculation strategies (Catering, Photography, Decor, DJ, Venue, Fixed)
 * - Strict guest count validation (minimumGuests, maximumGuests)
 * - Dynamic Coupon Engine with category, date, and cap rules (reduces subtotal)
 * - Dynamic Admin commission percentage from settings/global.commissionPercentage
 * - Immutable price snapshot creation for historical integrity
 */

import crypto from 'crypto';

export const PRICING_MODELS = {
  PER_GUEST: 'PER_GUEST',
  PER_PLATE: 'PER_PLATE',
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
  const min = service.minimumGuests || 10;
  const max = service.maximumGuests || 10000;
  
  const count = parseInt(guestCount, 10);
  if (isNaN(count) || count < min) {
    throw new Error(`INVALID_GUEST_COUNT: Minimum ${min} guests required (requested: ${guestCount})`);
  }
  if (count > max) {
    throw new Error(`INVALID_GUEST_COUNT: Maximum ${max} guests allowed (requested: ${guestCount})`);
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
  if (coupon.expiryDate && new Date(coupon.expiryDate) < now) {
    return { valid: false, discountPaise: 0, reason: 'COUPON_EXPIRED' };
  }
  if (coupon.validFrom && new Date(coupon.validFrom) > now) {
    return { valid: false, discountPaise: 0, reason: 'COUPON_NOT_YET_ACTIVE' };
  }

  const minSpendPaise = coupon.minOrderAmountPaise || (coupon.minSpend ? Number(coupon.minSpend) * 100 : 0);
  if (minSpendPaise > 0 && subtotalPaise < minSpendPaise) {
    return { 
      valid: false, 
      discountPaise: 0, 
      reason: `MIN_ORDER_NOT_MET: Minimum order required is ₹${minSpendPaise / 100}` 
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
  const isPercent = coupon.discountType === 'percentage' || coupon.discountPercent || (coupon.discount && !coupon.discountAmount);
  const percentVal = Number(coupon.discountPercent || coupon.discountValue || coupon.discount || 0);

  if (isPercent) {
    discountPaise = Math.round((subtotalPaise * percentVal) / 100);
    const maxDiscountPaise = coupon.maxDiscountPaise || (coupon.maxDiscount ? Number(coupon.maxDiscount) * 100 : null);
    if (maxDiscountPaise && discountPaise > maxDiscountPaise) {
      discountPaise = maxDiscountPaise;
    }
  } else {
    // Fixed amount discount
    const flatINR = Number(coupon.discountAmount || coupon.discountValue || coupon.discount || 0);
    discountPaise = Math.round(flatINR * 100);
  }

  // Cap discount at subtotal (never negative)
  discountPaise = Math.min(discountPaise, subtotalPaise);

  return {
    valid: true,
    code: coupon.code || coupon.id,
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
 * @param {number} [params.commissionPercentage] - Dynamic admin commission percentage (e.g. 10, 15, 8)
 * @param {number} [params.bookingFeePercentage] - Advance platform booking fee percentage (e.g. 5)
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
  coupon = null,
  commissionPercentage = 10,
  bookingFeePercentage = 5
}) {
  if (!vendor || !service) {
    throw new Error('PRICING_ERROR: Both vendor and service records are required for calculation');
  }

  const category = vendor.category || 'General';
  const rawModel = (service.pricingModel || service.pricingType || '').toUpperCase();
  const isCatering = category.toLowerCase().includes('cater');
  
  const pricingModel = rawModel || 
    (isCatering ? PRICING_MODELS.PER_GUEST : 
     (category.toLowerCase().includes('photo') || category.toLowerCase().includes('dj')) ? PRICING_MODELS.HOURLY :
     PRICING_MODELS.PACKAGE_PLUS_ADDONS);

  let baseAmountPaise = 0;
  let guestAmountPaise = 0;
  let durationAmountPaise = 0;
  let addonsAmountPaise = 0;

  // 1. Base Package Calculation by Pricing Model
  if (pricingModel === PRICING_MODELS.PER_GUEST || pricingModel === PRICING_MODELS.PER_PLATE || isCatering) {
    const validGuests = validateGuestCount(service, guestCount);
    const plateRateINR = Number(selectedPackage?.price || service.basePrice || service.price || 500);
    const plateRatePaise = Math.round(plateRateINR * 100);
    guestAmountPaise = plateRatePaise * validGuests;
    baseAmountPaise = guestAmountPaise;
  } else if (pricingModel === PRICING_MODELS.HOURLY) {
    const basePackageINR = Number(selectedPackage?.price || service.basePrice || service.price || 15000);
    baseAmountPaise = Math.round(basePackageINR * 100);
    const hourlyRateINR = Number(service.hourlyRate || 2000);
    const extraHoursCount = Math.max(0, parseInt(extraHours, 10) || 0);
    durationAmountPaise = Math.round(hourlyRateINR * 100) * extraHoursCount;
  } else if (pricingModel === PRICING_MODELS.PER_DAY) {
    const dayRateINR = Number(selectedPackage?.price || service.basePrice || service.price || 20000);
    const days = Math.max(1, parseInt(durationDays, 10) || 1);
    baseAmountPaise = Math.round(dayRateINR * 100) * days;
  } else {
    // Standard Package / Package + Addons / Fixed
    const packageINR = Number(selectedPackage?.price || service.basePrice || service.price || 10000);
    baseAmountPaise = Math.round(packageINR * 100);
  }

  // 2. Add-ons Calculation
  if (Array.isArray(selectedAddons) && selectedAddons.length > 0) {
    addonsAmountPaise = selectedAddons.reduce((sum, addon) => {
      const addonPriceINR = Number(addon.price || 0);
      return sum + Math.round(addonPriceINR * 100);
    }, 0);
  }

  // 3. Subtotal
  const subtotalPaise = baseAmountPaise + durationAmountPaise + addonsAmountPaise;

  // 4. Coupon Evaluation & Discount (Reduces Subtotal)
  const couponResult = evaluateCoupon(coupon, subtotalPaise, category);
  const discountPaise = couponResult.discountPaise;
  const discountedSubtotalPaise = Math.max(0, subtotalPaise - discountPaise);

  // 5. Dynamic Commission Calculation (Admin Configurable: e.g. 10%, 15%, 8%)
  const commPct = Number(commissionPercentage) >= 0 ? Number(commissionPercentage) : 10;
  const commissionAmountPaise = Math.round((discountedSubtotalPaise * commPct) / 100);

  // 6. Platform Advance Booking Fee (e.g. 5% of Discounted Subtotal)
  const feePct = Number(bookingFeePercentage) > 0 ? Number(bookingFeePercentage) : 5;
  const platformFeePaise = Math.round((discountedSubtotalPaise * feePct) / 100);

  // 7. GST (18% on Platform/Advance Booking Fee)
  const taxGstPaise = Math.round(platformFeePaise * 0.18);

  // 8. Authoritative Totals
  const finalAdvanceDuePaise = platformFeePaise + taxGstPaise;
  const balanceDueAtEventPaise = discountedSubtotalPaise - platformFeePaise;
  const totalEventValuePaise = discountedSubtotalPaise;
  const vendorPayoutPaise = Math.max(0, discountedSubtotalPaise - commissionAmountPaise);
  const platformRevenuePaise = commissionAmountPaise + platformFeePaise;

  // 9. Immutable Price Snapshot
  const priceSnapshot = {
    calculationVersion: '2.1.0',
    calculatedAt: new Date().toISOString(),
    pricingModel,
    category,
    guestCount: (pricingModel === PRICING_MODELS.PER_GUEST || isCatering) ? parseInt(guestCount, 10) : undefined,
    extraHours: pricingModel === PRICING_MODELS.HOURLY ? parseInt(extraHours, 10) : undefined,
    durationDays: pricingModel === PRICING_MODELS.PER_DAY ? parseInt(durationDays, 10) : undefined,
    
    // Monetary figures in INR
    baseAmount: baseAmountPaise / 100,
    durationAmount: durationAmountPaise / 100,
    addonsAmount: addonsAmountPaise / 100,
    subtotal: subtotalPaise / 100,
    couponCode: couponResult.valid ? couponResult.code : null,
    discount: discountPaise / 100,
    discountAmount: discountPaise / 100,
    discountedSubtotal: discountedSubtotalPaise / 100,
    adjustedSubtotal: discountedSubtotalPaise / 100,
    
    commissionPercentage: commPct,
    commissionAmount: commissionAmountPaise / 100,
    
    bookingFeePercentage: feePct,
    bookingFee: platformFeePaise / 100,
    platformFee: platformFeePaise / 100,
    tax: taxGstPaise / 100,
    taxGst: taxGstPaise / 100,
    
    finalAdvanceDue: finalAdvanceDuePaise / 100,
    advanceAmount: finalAdvanceDuePaise / 100,
    remainingAmount: balanceDueAtEventPaise / 100,
    balanceDueAtEvent: balanceDueAtEventPaise / 100,
    
    finalPrice: totalEventValuePaise / 100,
    totalEventValue: totalEventValuePaise / 100,
    
    vendorPayout: vendorPayoutPaise / 100,
    platformRevenue: platformRevenuePaise / 100,
    currency: 'INR',
    
    // Internal minor unit precision
    _paise: {
      subtotalPaise,
      discountPaise,
      discountedSubtotalPaise,
      commissionAmountPaise,
      platformFeePaise,
      taxGstPaise,
      finalAdvanceDuePaise,
      balanceDueAtEventPaise,
      totalEventValuePaise,
      vendorPayoutPaise,
      platformRevenuePaise
    }
  };

  return priceSnapshot;
}

/**
 * Authoritative Master Multi-Item / Multi-Vendor Cart Price & Quote Calculator
 * 
 * Rules:
 * - Deterministic integer paise arithmetic across all lines and totals
 * - Every cart line preserves vendorId, serviceId, packageId, guestCount, quantity, duration
 * - Single application of guest count to unit plate rate for catering
 * - Coupon applied to subtotal once, capping discount safely
 * - Multi-vendor breakdown with proportionate discounting and vendor net payout
 * - Produces an immutable, time-bounded quote with quoteId and expiresAt
 * 
 * @param {Object} params
 * @param {Array}  params.cartItems - Array of { vendor, service, selectedPackage, selectedAddons, guestCount, quantity, extraHours, durationDays, eventDate, eventTimeSlot }
 * @param {Object} [params.coupon] - Optional validated coupon from DB
 * @param {number} [params.commissionPercentage=10] - Dynamic admin commission %
 * @param {number} [params.bookingFeePercentage=5] - Dynamic advance booking fee %
 * @param {string} [params.currency='INR']
 * @returns {Object} Structured authoritative quote & price snapshot
 */
export function calculateCartQuote({
  cartItems = [],
  coupon = null,
  commissionPercentage = 10,
  bookingFeePercentage = 5,
  currency = 'INR'
}) {
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    throw new Error('CART_EMPTY: Cart must contain at least one item.');
  }

  const items = [];
  let cartSubtotalPaise = 0;
  const primaryCategory = cartItems[0]?.vendor?.category || 'General';

  for (const item of cartItems) {
    const vendor = item.vendor || {};
    const service = item.service || {};
    const category = (vendor.category || '').trim();
    const isCatering = category.toLowerCase().includes('cater');
    const rawModel = (service.pricingModel || service.pricingType || '').toUpperCase();
    const pricingModel = rawModel || (isCatering ? PRICING_MODELS.PER_GUEST : PRICING_MODELS.PACKAGE_PLUS_ADDONS);

    const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
    let lineBasePaise = 0;
    let lineDurationPaise = 0;
    let lineAddonsPaise = 0;
    let unitPriceINR = 0;
    let appliedGuestCount = null;

    if (pricingModel === PRICING_MODELS.PER_GUEST || pricingModel === PRICING_MODELS.PER_PLATE || isCatering) {
      const guests = validateGuestCount(service, item.guestCount || 100);
      appliedGuestCount = guests;
      // Unit plate rate: never pre-multiplied
      unitPriceINR = Number(
        item.basePlatePrice || 
        service.basePlatePrice || 
        item.selectedPackage?.price || 
        service.basePrice || 
        service.price || 
        500
      );
      // Guard: If service.price was mistakenly sent as total extended price (> 2500 and basePlatePrice exists), use basePlatePrice
      if (service.basePlatePrice && unitPriceINR === service.price && service.price > 2500) {
        unitPriceINR = Number(service.basePlatePrice);
      }
      lineBasePaise = Math.round(unitPriceINR * 100) * guests * qty;
    } else if (pricingModel === PRICING_MODELS.HOURLY) {
      unitPriceINR = Number(item.selectedPackage?.price || service.basePrice || service.price || 15000);
      lineBasePaise = Math.round(unitPriceINR * 100) * qty;
      const hourlyRateINR = Number(service.hourlyRate || 2000);
      const extraHours = Math.max(0, parseInt(item.extraHours, 10) || 0);
      lineDurationPaise = Math.round(hourlyRateINR * 100) * extraHours;
    } else if (pricingModel === PRICING_MODELS.PER_DAY) {
      unitPriceINR = Number(item.selectedPackage?.price || service.basePrice || service.price || 20000);
      const days = Math.max(1, parseInt(item.durationDays, 10) || 1);
      lineBasePaise = Math.round(unitPriceINR * 100) * days * qty;
    } else {
      unitPriceINR = Number(item.selectedPackage?.price || service.basePrice || service.price || 10000);
      lineBasePaise = Math.round(unitPriceINR * 100) * qty;
    }

    if (Array.isArray(item.selectedAddons) && item.selectedAddons.length > 0) {
      lineAddonsPaise = item.selectedAddons.reduce((sum, addon) => {
        return sum + Math.round(Number(addon.price || 0) * 100);
      }, 0);
    }

    const itemSubtotalPaise = lineBasePaise + lineDurationPaise + lineAddonsPaise;
    cartSubtotalPaise += itemSubtotalPaise;

    items.push({
      vendorId: vendor.id || item.vendorId || 'system',
      vendorName: vendor.name || 'Parva Partner',
      vendorCategory: category || 'General',
      serviceId: service.id || service.name || 'svc',
      serviceName: service.name || 'Service Package',
      pricingModel,
      unitPrice: unitPriceINR,
      quantity: qty,
      guestCount: appliedGuestCount,
      extraHours: item.extraHours ? parseInt(item.extraHours, 10) : undefined,
      durationDays: item.durationDays ? parseInt(item.durationDays, 10) : undefined,
      selectedPackage: item.selectedPackage || null,
      selectedAddons: item.selectedAddons || [],
      eventDate: item.eventDate || '',
      eventTimeSlot: item.eventTimeSlot || 'evening',
      lineSubtotal: itemSubtotalPaise / 100,
      _paise: {
        lineBasePaise,
        lineDurationPaise,
        lineAddonsPaise,
        itemSubtotalPaise
      }
    });
  }

  // Coupon evaluation
  const couponResult = evaluateCoupon(coupon, cartSubtotalPaise, primaryCategory);
  const discountPaise = couponResult.discountPaise;
  const discountedSubtotalPaise = Math.max(0, cartSubtotalPaise - discountPaise);

  // Platform fee (e.g. 5%) and GST (18% on platform fee)
  const feePct = Number(bookingFeePercentage) > 0 ? Number(bookingFeePercentage) : 5;
  const platformFeePaise = Math.round((discountedSubtotalPaise * feePct) / 100);
  const taxGstPaise = Math.round(platformFeePaise * 0.18);
  const finalAdvanceDuePaise = platformFeePaise + taxGstPaise;
  const balanceDueAtEventPaise = discountedSubtotalPaise - platformFeePaise;

  // Vendor breakdowns (for multi-vendor reconcile)
  const commPct = Number(commissionPercentage) >= 0 ? Number(commissionPercentage) : 10;
  const vendorBreakdowns = {};

  for (const item of items) {
    const vId = item.vendorId;
    if (!vendorBreakdowns[vId]) {
      vendorBreakdowns[vId] = {
        vendorId: vId,
        vendorName: item.vendorName,
        vendorCategory: item.vendorCategory,
        itemsSubtotalPaise: 0,
        discountPaise: 0,
        discountedSubtotalPaise: 0,
        commissionAmountPaise: 0,
        vendorPayoutPaise: 0
      };
    }
    vendorBreakdowns[vId].itemsSubtotalPaise += item._paise.itemSubtotalPaise;
  }

  // Allocate coupon discount proportionally across vendors
  for (const vId of Object.keys(vendorBreakdowns)) {
    const v = vendorBreakdowns[vId];
    const vProportion = cartSubtotalPaise > 0 ? v.itemsSubtotalPaise / cartSubtotalPaise : 0;
    v.discountPaise = Math.round(discountPaise * vProportion);
    v.discountedSubtotalPaise = Math.max(0, v.itemsSubtotalPaise - v.discountPaise);
    v.commissionAmountPaise = Math.round((v.discountedSubtotalPaise * commPct) / 100);
    v.vendorPayoutPaise = Math.max(0, v.discountedSubtotalPaise - v.commissionAmountPaise);

    v.itemsSubtotal = v.itemsSubtotalPaise / 100;
    v.discount = v.discountPaise / 100;
    v.discountedSubtotal = v.discountedSubtotalPaise / 100;
    v.commissionAmount = v.commissionAmountPaise / 100;
    v.vendorPayout = v.vendorPayoutPaise / 100;
  }

  const quoteId = `q_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const quoteExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  return {
    quoteId,
    expiresAt: quoteExpiresAt,
    currency,
    items,
    itemCount: items.length,
    vendorCount: Object.keys(vendorBreakdowns).length,
    vendorBreakdowns: Object.values(vendorBreakdowns),

    // Authoritative totals in INR
    subtotal: cartSubtotalPaise / 100,
    servicesTotal: cartSubtotalPaise / 100,
    couponCode: couponResult.valid ? couponResult.code : null,
    discount: discountPaise / 100,
    couponDiscount: discountPaise / 100,
    discountedSubtotal: discountedSubtotalPaise / 100,
    totalOrderValue: discountedSubtotalPaise / 100,
    finalPrice: discountedSubtotalPaise / 100,

    bookingFeePercentage: feePct,
    platformFee: platformFeePaise / 100,
    bookingFee: platformFeePaise / 100,
    taxGst: taxGstPaise / 100,
    tax: taxGstPaise / 100,

    finalAdvanceDue: finalAdvanceDuePaise / 100,
    advanceAmount: finalAdvanceDuePaise / 100,
    customerPayableNow: finalAdvanceDuePaise / 100,
    remainingAmount: balanceDueAtEventPaise / 100,
    balanceDueAtEvent: balanceDueAtEventPaise / 100,

    commissionPercentage: commPct,
    commissionAmount: Math.round((discountedSubtotalPaise * commPct) / 100) / 100,

    _paise: {
      subtotalPaise: cartSubtotalPaise,
      discountPaise,
      discountedSubtotalPaise,
      platformFeePaise,
      taxGstPaise,
      finalAdvanceDuePaise,
      balanceDueAtEventPaise
    }
  };
}
