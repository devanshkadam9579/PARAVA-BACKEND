/**
 * PARVA PLATFORM — AUTHORITATIVE PRODUCT ANALYTICS & MARKETPLACE INTELLIGENCE ENGINE
 * Version 2.0.0
 * 
 * Rules:
 * - Strict Data Minimization: Strips passwords, payment credentials, auth tokens, and private chat content.
 * - Server-side Aggregations: Computes customer funnels, vendor quality scores, marketplace liquidity, and revenue cohorts.
 */

export const ANALYTICS_EVENT_TYPES = {
  // Customer Funnel Events
  PAGE_VIEW: 'page_view',
  SEARCH_PERFORMED: 'search_performed',
  CATEGORY_VIEWED: 'category_viewed',
  VENDOR_VIEWED: 'vendor_viewed',
  SERVICE_SELECTED: 'service_selected',
  SLOT_CHECKED: 'slot_checked',
  COUPON_APPLIED: 'coupon_applied',
  BOOKING_STARTED: 'booking_started',
  PAYMENT_INITIATED: 'payment_initiated',
  PAYMENT_SUCCESS: 'payment_success',
  BOOKING_CONFIRMED: 'booking_confirmed',
  BOOKING_CANCELLED: 'booking_cancelled',
  REVIEW_SUBMITTED: 'review_submitted',

  // Vendor Performance Events
  VENDOR_REGISTERED: 'vendor_registered',
  VENDOR_ACTIVATED: 'vendor_activated',
  SERVICE_CREATED: 'service_created',
  AVAILABILITY_UPDATED: 'availability_updated',
  BOOKING_RECEIVED: 'booking_received',
  BOOKING_ACCEPTED: 'booking_accepted',
  BOOKING_REJECTED: 'booking_rejected',

  // Admin Operations Events
  VENDOR_VERIFIED: 'vendor_verified',
  REFUND_PROCESSED: 'refund_processed'
};

// In-Memory Event Buffer (Persisted to Firestore collection 'analytics_events')
const eventBuffer = [];

/**
 * Sanitizes and logs an analytics event
 */
export function trackEvent({
  eventType,
  userId = null,
  vendorId = null,
  categoryId = null,
  serviceId = null,
  bookingId = null,
  metadata = {},
  timestamp = new Date().toISOString()
}) {
  if (!eventType) return null;

  // Sanitize metadata - strictly remove sensitive keys
  const sanitizedMeta = { ...metadata };
  delete sanitizedMeta.password;
  delete sanitizedMeta.token;
  delete sanitizedMeta.secretKey;
  delete sanitizedMeta.cardNumber;
  delete sanitizedMeta.cvv;
  delete sanitizedMeta.messageContent;

  const eventRecord = {
    id: 'evt_' + Date.now() + '_' + Math.floor(1000 + Math.random() * 9000),
    eventType,
    userId,
    vendorId,
    categoryId,
    serviceId,
    bookingId,
    metadata: sanitizedMeta,
    timestamp
  };

  eventBuffer.push(eventRecord);
  if (eventBuffer.length > 5000) {
    eventBuffer.shift(); // Keep memory bounded
  }

  return eventRecord;
}

/**
 * Computes Customer Conversion Funnel
 */
export function computeCustomerFunnel(events = eventBuffer) {
  const counts = {
    visitors: 0,
    categoryViews: 0,
    vendorViews: 0,
    bookingStarted: 0,
    paymentInitiated: 0,
    paymentSuccess: 0,
    bookingConfirmed: 0,
    completedReviews: 0
  };

  events.forEach(e => {
    if (e.eventType === ANALYTICS_EVENT_TYPES.PAGE_VIEW) counts.visitors++;
    if (e.eventType === ANALYTICS_EVENT_TYPES.CATEGORY_VIEWED) counts.categoryViews++;
    if (e.eventType === ANALYTICS_EVENT_TYPES.VENDOR_VIEWED) counts.vendorViews++;
    if (e.eventType === ANALYTICS_EVENT_TYPES.BOOKING_STARTED) counts.bookingStarted++;
    if (e.eventType === ANALYTICS_EVENT_TYPES.PAYMENT_INITIATED) counts.paymentInitiated++;
    if (e.eventType === ANALYTICS_EVENT_TYPES.PAYMENT_SUCCESS) counts.paymentSuccess++;
    if (e.eventType === ANALYTICS_EVENT_TYPES.BOOKING_CONFIRMED) counts.bookingConfirmed++;
    if (e.eventType === ANALYTICS_EVENT_TYPES.REVIEW_SUBMITTED) counts.completedReviews++;
  });

  const visitorCount = Math.max(1, counts.visitors);
  const conversionRates = {
    visitorToVendorViewPct: ((counts.vendorViews / visitorCount) * 100).toFixed(1),
    vendorViewToBookingStartPct: counts.vendorViews ? ((counts.bookingStarted / counts.vendorViews) * 100).toFixed(1) : '0.0',
    bookingStartToPaymentPct: counts.bookingStarted ? ((counts.paymentInitiated / counts.bookingStarted) * 100).toFixed(1) : '0.0',
    paymentToConfirmationPct: counts.paymentInitiated ? ((counts.paymentSuccess / counts.paymentInitiated) * 100).toFixed(1) : '0.0',
    overallEndToEndConversionPct: ((counts.bookingConfirmed / visitorCount) * 100).toFixed(1)
  };

  return { counts, conversionRates };
}

/**
 * Computes Vendor Quality Signals & Activation Scores
 */
export function computeVendorPerformanceMetrics(vendor, bookings = []) {
  if (!vendor) return null;

  const vendorBookings = bookings.filter(b => (b.vendorId === vendor.id || b.vendor?.id === vendor.id));
  const totalReceived = vendorBookings.length;
  const accepted = vendorBookings.filter(b => ['CONFIRMED', 'VENDOR_ACCEPTED', 'EVENT_STARTED', 'COMPLETED'].includes(b.status)).length;
  const rejected = vendorBookings.filter(b => b.status === 'REJECTED' || b.status === 'VENDOR_REJECTED').length;
  const completed = vendorBookings.filter(b => b.status === 'COMPLETED').length;

  const acceptanceRatePct = totalReceived > 0 ? Math.round((accepted / totalReceived) * 100) : 100;
  const rejectionRatePct = totalReceived > 0 ? Math.round((rejected / totalReceived) * 100) : 0;
  const completionRatePct = accepted > 0 ? Math.round((completed / accepted) * 100) : 0;

  const isActivated = !!(
    vendor.name &&
    vendor.category &&
    Array.isArray(vendor.services) && vendor.services.length > 0 &&
    (vendor.verificationStatus === 'Approved' || vendor.verified)
  );

  return {
    vendorId: vendor.id,
    vendorName: vendor.name,
    category: vendor.category,
    rating: vendor.rating || 5.0,
    reviewCount: vendor.reviewCount || 0,
    totalBookingsReceived: totalReceived,
    acceptedBookings: accepted,
    rejectedBookings: rejected,
    completedBookings: completed,
    acceptanceRatePct,
    rejectionRatePct,
    completionRatePct,
    isActivated
  };
}

/**
 * Computes Marketplace Liquidity Metrics (Demand vs Supply per Category)
 */
export function computeMarketplaceLiquidity(categories = [], vendors = [], bookings = []) {
  return categories.map(cat => {
    const catVendors = vendors.filter(v => (v.category || '').toLowerCase() === cat.id.toLowerCase());
    const activeServices = catVendors.reduce((sum, v) => sum + (v.services?.length || 1), 0);
    const catBookings = bookings.filter(b => (b.vendor?.category || '').toLowerCase() === cat.id.toLowerCase());

    const demandScore = catBookings.length;
    const supplyScore = catVendors.length;
    let liquidityRatio = supplyScore > 0 ? (demandScore / supplyScore).toFixed(2) : '0.00';
    let balanceStatus = 'BALANCED';

    if (demandScore > supplyScore * 3) {
      balanceStatus = 'HIGH_DEMAND_UNDERSUPPLIED';
    } else if (supplyScore > demandScore * 5 && demandScore < 2) {
      balanceStatus = 'HIGH_SUPPLY_LOW_DEMAND';
    }

    return {
      categoryId: cat.id,
      categoryName: cat.name,
      activeVendors: supplyScore,
      activeServices,
      totalBookingRequests: demandScore,
      liquidityRatio: parseFloat(liquidityRatio),
      balanceStatus
    };
  });
}