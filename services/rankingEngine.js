/**
 * PARVA PLATFORM — SEARCH & VENDOR RANKING ENGINE
 * Version 2.0.0
 * 
 * Transparent ranking based on:
 * - Relevance (keyword matching)
 * - Quality Score (Verified badge, average rating, review count)
 * - Responsiveness & Acceptance Rate
 * - Price Sorting (asc / desc)
 */

export const SORT_OPTIONS = {
  RELEVANCE: 'relevance',
  RATING_DESC: 'rating_desc',
  PRICE_ASC: 'price_asc',
  PRICE_DESC: 'price_desc',
  POPULARITY: 'popularity'
};

export function searchAndRankVendors({
  vendors = [],
  query = '',
  category = null,
  city = null,
  sortBy = SORT_OPTIONS.RELEVANCE,
  minRating = 0
}) {
  let filtered = [...vendors];

  // 1. Filter by Category
  if (category && category.toLowerCase() !== 'all') {
    filtered = filtered.filter(v => (v.category || '').toLowerCase() === category.toLowerCase());
  }

  // 2. Filter by City
  if (city && city.toLowerCase() !== 'all') {
    filtered = filtered.filter(v => (v.city || '').toLowerCase().includes(city.toLowerCase()));
  }

  // 3. Filter by Minimum Rating
  if (minRating > 0) {
    filtered = filtered.filter(v => (v.rating || 0) >= minRating);
  }

  // 4. Keyword Query Matching
  if (query && query.trim()) {
    const q = query.toLowerCase().trim();
    filtered = filtered.filter(v => {
      const matchName = (v.name || '').toLowerCase().includes(q);
      const matchCat = (v.category || '').toLowerCase().includes(q);
      const matchCity = (v.city || '').toLowerCase().includes(q);
      const matchServices = Array.isArray(v.services) && v.services.some(s => (s.name || '').toLowerCase().includes(q));
      return matchName || matchCat || matchCity || matchServices;
    });
  }

  // 5. Ranking & Sorting
  filtered.sort((a, b) => {
    if (sortBy === SORT_OPTIONS.PRICE_ASC) {
      const priceA = a.basePrice || a.price || 0;
      const priceB = b.basePrice || b.price || 0;
      return priceA - priceB;
    }
    if (sortBy === SORT_OPTIONS.PRICE_DESC) {
      const priceA = a.basePrice || a.price || 0;
      const priceB = b.basePrice || b.price || 0;
      return priceB - priceA;
    }
    if (sortBy === SORT_OPTIONS.RATING_DESC) {
      return (b.rating || 0) - (a.rating || 0);
    }
    if (sortBy === SORT_OPTIONS.POPULARITY) {
      return (b.reviewCount || 0) - (a.reviewCount || 0);
    }

    // Default: Multi-Factor Relevance & Quality Score
    const scoreA = calculateQualityScore(a);
    const scoreB = calculateQualityScore(b);
    return scoreB - scoreA;
  });

  return filtered;
}

function calculateQualityScore(vendor) {
  let score = 0;
  // Star Rating weight (0 - 50 points)
  score += (vendor.rating || 4.5) * 10;
  // Verified Partner bonus (20 points)
  if (vendor.verified || vendor.verificationStatus === 'Approved') {
    score += 20;
  }
  // Review volume weight (up to 20 points)
  score += Math.min(20, (vendor.reviewCount || 0) * 0.5);
  // Guest Favourite tag bonus (10 points)
  if (vendor.isGuestFavourite) {
    score += 10;
  }
  return score;
}