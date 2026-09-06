/**
 * PARVA PLATFORM — CUSTOMER & VENDOR RETENTION ENGINE
 * Version 1.0.0
 * 
 * Rules:
 * - Saved/Favorite vendors management (persists relationships even if vendor temporarily inactive)
 * - Repeat booking ("Book Again") with fresh server-side re-validation of pricing, availability, and policies
 * - Personalized customer offers based on behavioral signals
 * - Inactive customer win-back campaign generator
 * - Vendor inactivity / retention health evaluator
 */

import { calculateBookingPrice } from './pricingEngine.js';
import { checkAvailability } from './availabilityEngine.js';

// In-memory saved vendors: customerId -> Set of vendorIds
const savedVendors = new Map();

/**
 * Saves a vendor to customer favorites
 */
export function toggleSaveVendor(customerId, vendorId) {
  if (!customerId || !vendorId) throw new Error('RETENTION_ERROR: customerId and vendorId required');

  if (!savedVendors.has(customerId)) {
    savedVendors.set(customerId, new Set());
  }

  const set = savedVendors.get(customerId);
  let isSaved = false;

  if (set.has(vendorId)) {
    set.delete(vendorId);
    isSaved = false;
  } else {
    set.add(vendorId);
    isSaved = true;
  }

  return { customerId, vendorId, isSaved, totalSaved: set.size };
}

/**
 * Gets saved vendors for customer with current status
 */
export function getSavedVendors(customerId, allVendors = []) {
  const set = savedVendors.get(customerId) || new Set();
  const list = [];

  for (const vId of set) {
    const vendor = allVendors.find(v => v.id === vId);
    if (vendor) {
      list.push({
        vendorId: vendor.id,
        name: vendor.name,
        category: vendor.category,
        location: vendor.location,
        rating: vendor.rating || 4.8,
        basePrice: vendor.basePrice,
        image: Array.isArray(vendor.images) && vendor.images.length > 0 ? vendor.images[0] : null,
        verified: !!vendor.verified,
        status: vendor.status || 'ACTIVE'
      });
    } else {
      // Retain historical saved relationship even if vendor record is archived
      list.push({
        vendorId: vId,
        name: 'Archived / Inactive Partner',
        status: 'UNAVAILABLE'
      });
    }
  }

  return list;
}

/**
 * "Book Again" Repeat Booking Validator
 * Re-validates the previous booking parameters against LIVE current backend pricing and availability.
 */
export function prepareRepeatBooking({ previousBooking, currentVendor, currentService, newEventDate, newEventTimeSlot = 'evening', guestCount = null }) {
  if (!previousBooking || !currentVendor || !currentService) {
    throw new Error('REPEAT_BOOKING_ERROR: Previous booking, current vendor, and service required');
  }

  // 1. Re-validate availability
  const availabilityResult = checkAvailability({
    vendor: currentVendor,
    eventDate: newEventDate,
    eventTimeSlot: newEventTimeSlot
  });

  // 2. Freshly recalculate price using CURRENT prices (do not trust historical pricing blindly)
  const guests = guestCount || previousBooking.guestCount || 100;
  const priceQuote = calculateBookingPrice({
    vendor: currentVendor,
    service: currentService,
    guestCount: guests
  });

  return {
    isRepeatBooking: true,
    previousBookingId: previousBooking.id || previousBooking.bookingId,
    vendorId: currentVendor.id,
    vendorName: currentVendor.name,
    serviceId: currentService.id,
    serviceName: currentService.name,
    newEventDate,
    newEventTimeSlot,
    guestCount: guests,
    availability: availabilityResult,
    priceQuote,
    isEligible: availabilityResult.available,
    message: availabilityResult.available ? 'Ready for repeat booking confirmation' : availabilityResult.message
  };
}

/**
 * Generates personalized customer offers based on previous bookings and saved vendors
 */
export function getPersonalizedCustomerOffers({ customerId, pastBookings = [], allVendors = [] }) {
  const offers = [];
  const saved = savedVendors.get(customerId) || new Set();

  // Signal 1: Favorite category repeat offer
  if (pastBookings.length > 0) {
    const lastBooking = pastBookings[pastBookings.length - 1];
    const category = lastBooking.category || 'Catering';
    offers.push({
      offerId: `offer_rep_${category.toLowerCase()}`,
      title: `Special ${category} Repeat Offer`,
      description: `Enjoy ₹1,000 off your next ${category} celebration`,
      category,
      discountINR: 1000,
      badge: 'Loyalty Perk',
      validDays: 30
    });
  }

  // Signal 2: Saved vendor offer
  if (saved.size > 0) {
    const firstSavedId = Array.from(saved)[0];
    const vendor = allVendors.find(v => v.id === firstSavedId);
    if (vendor) {
      offers.push({
        offerId: `offer_saved_${vendor.id}`,
        title: `Exclusive deal with ${vendor.name}`,
        description: `5% bonus discount when you book your saved favorite`,
        vendorId: vendor.id,
        vendorName: vendor.name,
        badge: 'Saved Vendor Special',
        discountPercent: 5
      });
    }
  }

  // Fallback seasonal offer
  if (offers.length === 0) {
    offers.push({
      offerId: 'offer_welcome_celebration',
      title: 'Grand Celebration Welcome Offer',
      description: 'Get up to ₹1,500 off on catering and decoration bundles',
      discountINR: 1500,
      badge: 'Popular Deal'
    });
  }

  return offers;
}

/**
 * Identifies inactive customers for Admin Win-Back Campaigns
 */
export function identifyInactiveCustomers({ customers = [], bookings = [], inactiveDaysThreshold = 90 }) {
  const cutoff = Date.now() - (inactiveDaysThreshold * 24 * 60 * 60 * 1000);
  const inactiveList = [];

  for (const cust of customers) {
    const custBookings = bookings.filter(b => b.customerId === cust.id || b.customerUid === cust.id);
    if (custBookings.length === 0) continue;

    // Find most recent booking
    const sorted = custBookings.sort((a, b) => new Date(b.createdAt || b.eventDate) - new Date(a.createdAt || a.eventDate));
    const lastBookingTime = new Date(sorted[0].createdAt || sorted[0].eventDate).getTime();

    if (lastBookingTime < cutoff) {
      const daysInactive = Math.floor((Date.now() - lastBookingTime) / (24 * 60 * 60 * 1000));
      inactiveList.push({
        customerId: cust.id,
        name: cust.name || cust.displayName || 'Customer',
        email: cust.email,
        lastBookingDate: sorted[0].createdAt || sorted[0].eventDate,
        daysInactive,
        suggestedOffer: 'WIN_BACK_15_PERCENT'
      });
    }
  }

  return inactiveList;
}

/**
 * Identifies vendors needing retention attention
 */
export function evaluateVendorRetentionHealth(vendor, recentBookings = []) {
  const signals = [];
  let healthScore = 100;

  // Signal: Incomplete profile
  if (!vendor.images || vendor.images.length < 2) {
    signals.push('INSUFFICIENT_PHOTOS');
    healthScore -= 20;
  }

  // Signal: No active services
  if (!vendor.services || vendor.services.length === 0) {
    signals.push('NO_ACTIVE_SERVICES');
    healthScore -= 30;
  }

  // Signal: Low booking activity
  if (recentBookings.length === 0) {
    signals.push('NO_RECENT_BOOKINGS');
    healthScore -= 20;
  }

  let status = 'HEALTHY';
  if (healthScore < 50) status = 'CRITICAL_ATTENTION';
  else if (healthScore < 80) status = 'NEEDS_ATTENTION';

  return {
    vendorId: vendor.id,
    vendorName: vendor.name,
    healthScore,
    status,
    signals,
    recommendedAction: signals.length > 0 ? `Improve profile: ${signals.join(', ')}` : 'Maintain active availability'
  };
}

/**
 * Resets state for testing
 */
export function _resetRetentionState() {
  savedVendors.clear();
}
