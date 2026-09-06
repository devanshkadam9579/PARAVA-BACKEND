/**
 * PARVA PLATFORM — AUTHORITATIVE MARKETPLACE INTELLIGENCE & SCORING ENGINE
 * Version 2.0.0
 * 
 * Rules:
 * - Deterministic, transparent, and explainable vendor performance scoring.
 * - Multi-factor smart recommendations based on availability, quality, category, and location.
 * - Price intelligence and statistical distribution analysis without overriding authoritative pricing.
 * - Statistical demand forecasting (LOW, NORMAL, HIGH, VERY_HIGH).
 */

export const DEMAND_LEVELS = {
  LOW: 'LOW',
  NORMAL: 'NORMAL',
  HIGH: 'HIGH',
  VERY_HIGH: 'VERY_HIGH'
};

/**
 * 1. Transparent Vendor Performance Scoring
 * Computes an explainable 0-100 score across 6 constituent pillars.
 */
export function calculateVendorScore(vendor, bookings = []) {
  if (!vendor) return null;

  const vendorBookings = bookings.filter(b => (b.vendorId === vendor.id || b.vendor?.id === vendor.id));
  const totalReceived = vendorBookings.length;
  const accepted = vendorBookings.filter(b => ['CONFIRMED', 'VENDOR_ACCEPTED', 'EVENT_STARTED', 'COMPLETED'].includes(b.status)).length;
  const rejected = vendorBookings.filter(b => b.status === 'REJECTED' || b.status === 'VENDOR_REJECTED').length;
  const completed = vendorBookings.filter(b => b.status === 'COMPLETED').length;
  const cancelled = vendorBookings.filter(b => b.status === 'CANCELLED').length;

  // Pillar 1: Rating Score (max 25 pts) -> based on 0-5 star rating
  const ratingVal = vendor.rating || 4.5;
  const ratingScore = Math.round((ratingVal / 5.0) * 25);

  // Pillar 2: Acceptance Score (max 20 pts)
  const acceptanceRatio = totalReceived > 0 ? (accepted / totalReceived) : 1.0;
  const acceptanceScore = Math.round(acceptanceRatio * 20);

  // Pillar 3: Completion Score (max 20 pts)
  const completionRatio = accepted > 0 ? (completed / accepted) : (totalReceived === 0 ? 1.0 : 0.8);
  const completionScore = Math.round(completionRatio * 20);

  // Pillar 4: Reliability & Cancellation Score (max 15 pts) -> penalizes vendor cancellations
  const cancellationRatio = totalReceived > 0 ? (cancelled / totalReceived) : 0;
  const reliabilityScore = Math.max(0, Math.round(15 - (cancellationRatio * 30)));

  // Pillar 5: Response Time Score (max 10 pts) -> assumed fast unless recorded slow
  const avgResponseMin = vendor.avgResponseMinutes || 15;
  const responseScore = avgResponseMin <= 15 ? 10 : (avgResponseMin <= 60 ? 8 : (avgResponseMin <= 240 ? 5 : 2));

  // Pillar 6: Profile & Service Completeness (max 10 pts)
  let profileScore = 0;
  if (vendor.name && vendor.city) profileScore += 2;
  if (vendor.coverImage || vendor.images?.length) profileScore += 2;
  if (Array.isArray(vendor.services) && vendor.services.length > 0) profileScore += 3;
  if (vendor.verified || vendor.verificationStatus === 'Approved') profileScore += 3;

  const overall = ratingScore + acceptanceScore + completionScore + reliabilityScore + responseScore + profileScore;

  return {
    vendorId: vendor.id,
    vendorName: vendor.name,
    overall, // 0 - 100
    tier: overall >= 85 ? 'ELITE' : (overall >= 70 ? 'PREFERRED' : (overall >= 50 ? 'STANDARD' : 'NEEDS_IMPROVEMENT')),
    breakdown: {
      ratingScore: { score: ratingScore, max: 25, weight: '25%' },
      acceptanceScore: { score: acceptanceScore, max: 20, weight: '20%' },
      completionScore: { score: completionScore, max: 20, weight: '20%' },
      reliabilityScore: { score: reliabilityScore, max: 15, weight: '15%' },
      responseScore: { score: responseScore, max: 10, weight: '10%' },
      profileScore: { score: profileScore, max: 10, weight: '10%' }
    },
    metrics: {
      rating: ratingVal,
      totalBookings: totalReceived,
      acceptanceRatePct: Math.round(acceptanceRatio * 100),
      cancellationRatePct: Math.round(cancellationRatio * 100),
      avgResponseMinutes: avgResponseMin
    }
  };
}

/**
 * 2. Deterministic Smart Vendor Recommendation Engine
 */
export function getSmartRecommendations({
  vendors = [],
  category = null,
  city = null,
  maxBudget = null,
  limit = 6
}) {
  let matched = [...vendors];

  if (category && category.toLowerCase() !== 'all') {
    matched = matched.filter(v => (v.category || '').toLowerCase() === category.toLowerCase());
  }

  if (city && city.toLowerCase() !== 'all') {
    matched = matched.filter(v => (v.city || '').toLowerCase().includes(city.toLowerCase()));
  }

  if (maxBudget && maxBudget > 0) {
    matched = matched.filter(v => (v.basePrice || v.price || 0) <= maxBudget);
  }

  // Calculate recommendation weight
  matched.sort((a, b) => {
    const scoreA = (a.rating || 4.5) * 10 + (a.verified ? 15 : 0) + (a.isGuestFavourite ? 10 : 0);
    const scoreB = (b.rating || 4.5) * 10 + (b.verified ? 15 : 0) + (b.isGuestFavourite ? 10 : 0);
    return scoreB - scoreA;
  });

  return matched.slice(0, limit);
}

/**
 * 3. Marketplace Price Intelligence Analysis
 */
export function computePriceIntelligence(vendors = [], category = null) {
  let list = [...vendors];
  if (category && category.toLowerCase() !== 'all') {
    list = list.filter(v => (v.category || '').toLowerCase() === category.toLowerCase());
  }

  const prices = list.map(v => v.basePrice || v.price || 0).filter(p => p > 0).sort((a, b) => a - b);
  if (prices.length === 0) {
    return { count: 0, minPrice: 0, maxPrice: 0, avgPrice: 0, medianPrice: 0 };
  }

  const minPrice = prices[0];
  const maxPrice = prices[prices.length - 1];
  const avgPrice = Math.round(prices.reduce((sum, p) => sum + p, 0) / prices.length);
  const mid = Math.floor(prices.length / 2);
  const medianPrice = prices.length % 2 !== 0 ? prices[mid] : Math.round((prices[mid - 1] + prices[mid]) / 2);

  return {
    category: category || 'all',
    count: prices.length,
    minPrice,
    maxPrice,
    avgPrice,
    medianPrice,
    priceRangeRecommendation: {
      budgetTier: '₹' + minPrice.toLocaleString('en-IN') + ' - ₹' + medianPrice.toLocaleString('en-IN'),
      premiumTier: '₹' + medianPrice.toLocaleString('en-IN') + ' - ₹' + maxPrice.toLocaleString('en-IN')
    }
  };
}

/**
 * 4. Demand Forecasting Engine
 */
export function forecastDemand({ category, city, targetDate, historicalBookings = [] }) {
  const dateObj = new Date(targetDate || Date.now());
  const dayOfWeek = dateObj.getDay(); // 0 = Sunday, 6 = Saturday
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6 || dayOfWeek === 5); // Fri, Sat, Sun

  // Filter historical bookings for same category/city
  const matchingBookings = historicalBookings.filter(b => {
    const catMatch = !category || (b.vendor?.category || '').toLowerCase() === category.toLowerCase();
    const cityMatch = !city || (b.vendor?.city || '').toLowerCase().includes(city.toLowerCase());
    return catMatch && cityMatch;
  });

  const volume = matchingBookings.length;

  let demandLevel = DEMAND_LEVELS.NORMAL;
  let explanation = 'Standard booking activity expected for this timeframe.';

  if (isWeekend && volume >= 5) {
    demandLevel = DEMAND_LEVELS.VERY_HIGH;
    explanation = 'Peak weekend celebration season. Expect high slot competition.';
  } else if (isWeekend || volume >= 3) {
    demandLevel = DEMAND_LEVELS.HIGH;
    explanation = 'Elevated celebration booking demand. Early reservation advised.';
  } else if (volume === 0 && !isWeekend) {
    demandLevel = DEMAND_LEVELS.LOW;
    explanation = 'Off-peak weekday period with ample vendor capacity.';
  }

  return {
    category: category || 'all',
    city: city || 'all',
    targetDate: targetDate || dateObj.toISOString().split('T')[0],
    isWeekend,
    demandLevel,
    explanation,
    recommendedLeadTimeDays: demandLevel === DEMAND_LEVELS.VERY_HIGH ? 30 : (demandLevel === DEMAND_LEVELS.HIGH ? 14 : 7)
  };
}

/**
 * 5. Actionable Vendor Improvement Tips
 */
export function generateVendorRecommendations(vendorScore) {
  const tips = [];
  if (!vendorScore || !vendorScore.breakdown) return tips;

  const { breakdown, metrics } = vendorScore;

  if (breakdown.profileScore.score < 8) {
    tips.push({
      priority: 'HIGH',
      title: 'Complete Business Profile & Add Photos',
      impact: '+10% discovery visibility',
      action: 'Add high-resolution portfolio photos and service descriptions.'
    });
  }

  if (breakdown.acceptanceScore.score < 16) {
    tips.push({
      priority: 'HIGH',
      title: 'Improve Booking Acceptance Rate',
      impact: '+15% higher search placement',
      action: 'Keep your calendar availability updated to avoid declining incoming client bookings.'
    });
  }

  if (breakdown.responseScore.score < 8) {
    tips.push({
      priority: 'MEDIUM',
      title: 'Respond Quicker to Inquiries',
      impact: 'Faster client confirmations',
      action: 'Aim to respond within 15 minutes to secure customer interest.'
    });
  }

  if (tips.length === 0) {
    tips.push({
      priority: 'LOW',
      title: 'Maintain Stellar Rating',
      impact: 'Elite partner status preserved',
      action: 'Invite completed wedding & celebration clients to submit reviews.'
    });
  }

  return tips.slice(0, 3);
}