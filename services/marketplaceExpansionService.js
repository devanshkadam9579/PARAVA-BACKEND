/**
 * PARVA PLATFORM — MULTI-CITY EXPANSION, LIQUIDITY & UNIT ECONOMICS ENGINE
 * Version 1.0.0
 * 
 * Rules:
 * - Hierarchical location model: Country -> State -> City -> Area
 * - City activation statuses: PLANNED, ACTIVE, PAUSED, INACTIVE
 * - City marketplace analytics: GMV, Commission, AOV, Liquidity, Demand/Supply
 * - Vendor recruitment pipeline tracking
 * - Rigorous unit economics from authoritative backend data
 */

export const CITY_STATUSES = {
  ACTIVE: 'ACTIVE',
  PLANNED: 'PLANNED',
  PAUSED: 'PAUSED',
  INACTIVE: 'INACTIVE'
};

// Seed cities
const structuredCities = [
  {
    id: 'city_pune',
    name: 'Pune',
    state: 'Maharashtra',
    country: 'India',
    status: CITY_STATUSES.ACTIVE,
    tier: 'TIER_1',
    areas: ['Koregaon Park', 'Baner', 'Kothrud', 'Viman Nagar', 'Wakad', 'Hadapsar', 'Aundh'],
    popularCategories: ['Photography', 'Catering', 'Decoration', 'DJ & Music', 'Banquet Hall'],
    launchedAt: '2025-06-01T00:00:00Z'
  },
  {
    id: 'city_mumbai',
    name: 'Mumbai',
    state: 'Maharashtra',
    country: 'India',
    status: CITY_STATUSES.ACTIVE,
    tier: 'TIER_1',
    areas: ['Bandra', 'Andheri', 'Juhu', 'South Mumbai', 'Powai', 'Thane', 'Navi Mumbai'],
    popularCategories: ['Banquet Hall', 'Catering', 'Photography', 'Makeup & Styling', 'Decoration'],
    launchedAt: '2025-08-01T00:00:00Z'
  },
  {
    id: 'city_kolhapur',
    name: 'Kolhapur',
    state: 'Maharashtra',
    country: 'India',
    status: CITY_STATUSES.ACTIVE,
    tier: 'TIER_2',
    areas: ['Tarabai Park', 'Rajarampuri', 'Shahupuri', 'Nagala Park', 'Ruikar Colony'],
    popularCategories: ['Catering', 'Decoration', 'Photography', 'Banquet Hall'],
    launchedAt: '2026-01-15T00:00:00Z'
  },
  {
    id: 'city_nagpur',
    name: 'Nagpur',
    state: 'Maharashtra',
    country: 'India',
    status: CITY_STATUSES.PLANNED,
    tier: 'TIER_2',
    areas: ['Dharampeth', 'Civil Lines', 'Ramdaspeth', 'Manish Nagar'],
    popularCategories: ['Catering', 'Banquet Hall', 'Decoration'],
    plannedLaunch: '2026-12-01'
  }
];

// Vendor Recruitment Pipeline Funnel
const recruitmentPipeline = [];

/**
 * Retrieves all cities filtered by activation status
 */
export function getCities(filter = {}) {
  let list = [...structuredCities];
  if (filter.status) {
    list = list.filter(c => c.status === filter.status);
  }
  return list;
}

/**
 * Gets active cities for customer selection
 */
export function getActiveCities() {
  return structuredCities.filter(c => c.status === CITY_STATUSES.ACTIVE);
}

/**
 * Admin updates city activation status
 */
export function updateCityStatus(cityId, newStatus) {
  const city = structuredCities.find(c => c.id === cityId || c.name.toLowerCase() === cityId.toLowerCase());
  if (!city) {
    throw new Error(`CITY_ERROR: City "${cityId}" not found`);
  }
  if (!Object.values(CITY_STATUSES).includes(newStatus)) {
    throw new Error(`CITY_ERROR: Invalid city status "${newStatus}"`);
  }

  city.status = newStatus;
  city.updatedAt = new Date().toISOString();
  return city;
}

/**
 * Calculates marketplace metrics for a city
 */
export function calculateCityMarketplaceMetrics({ cityId, vendors = [], bookings = [] }) {
  const city = structuredCities.find(c => c.id === cityId || c.name.toLowerCase() === cityId.toLowerCase());
  const cityName = city ? city.name : cityId;

  const cityVendors = vendors.filter(v => (v.location || '').toLowerCase() === cityName.toLowerCase());
  const cityBookings = bookings.filter(b => (b.city || b.location || '').toLowerCase() === cityName.toLowerCase());

  let totalGmvPaise = 0;
  let totalCommissionPaise = 0;
  let completedBookings = 0;

  for (const b of cityBookings) {
    if (b.status === 'COMPLETED' || b.status === 'CONFIRMED') {
      const gmv = b._paise?.totalEventValuePaise || (b.totalAmount ? b.totalAmount * 100 : 0);
      const comm = b._paise?.platformFeePaise || (b.platformFee ? b.platformFee * 100 : Math.round(gmv * 0.05));
      totalGmvPaise += gmv;
      totalCommissionPaise += comm;
      completedBookings++;
    }
  }

  const aovPaise = completedBookings > 0 ? Math.round(totalGmvPaise / completedBookings) : 0;

  return {
    cityId,
    cityName,
    status: city ? city.status : 'UNKNOWN',
    totalVendors: cityVendors.length,
    activeVendors: cityVendors.filter(v => v.verified).length,
    totalBookings: cityBookings.length,
    completedBookings,
    gmvINR: totalGmvPaise / 100,
    commissionINR: totalCommissionPaise / 100,
    aovINR: aovPaise / 100
  };
}

/**
 * Vendor Recruitment Pipeline: Adds or updates vendor recruitment stage
 */
export function updateRecruitmentStage({ leadId, vendorName, category, city, stage, notes = '' }) {
  const validStages = ['LEAD', 'INVITED', 'REGISTERED', 'ONBOARDING', 'VERIFICATION', 'ACTIVE', 'FIRST_BOOKING', 'RETAINED'];
  if (!validStages.includes(stage)) {
    throw new Error(`PIPELINE_ERROR: Invalid stage "${stage}"`);
  }

  const existingIdx = recruitmentPipeline.findIndex(r => r.leadId === leadId);
  const record = {
    leadId,
    vendorName,
    category,
    city,
    stage,
    notes,
    updatedAt: new Date().toISOString()
  };

  if (existingIdx >= 0) {
    recruitmentPipeline[existingIdx] = { ...recruitmentPipeline[existingIdx], ...record };
  } else {
    record.createdAt = new Date().toISOString();
    recruitmentPipeline.push(record);
  }

  return record;
}

/**
 * Retrieves recruitment pipeline funnel summary
 */
export function getRecruitmentFunnelSummary() {
  const summary = {
    LEAD: 0,
    INVITED: 0,
    REGISTERED: 0,
    ONBOARDING: 0,
    VERIFICATION: 0,
    ACTIVE: 0,
    FIRST_BOOKING: 0,
    RETAINED: 0
  };

  for (const item of recruitmentPipeline) {
    if (summary[item.stage] !== undefined) {
      summary[item.stage]++;
    }
  }

  return {
    totalLeads: recruitmentPipeline.length,
    funnel: summary
  };
}

/**
 * Master Unit Economics Calculator
 */
export function calculateMarketplaceUnitEconomics({ bookings = [], subscriptions = [], refunds = [], marketingSpendINR = 0 }) {
  let grossGmvPaise = 0;
  let grossCommissionPaise = 0;
  let totalAdvanceFeesPaise = 0;
  let completedCount = 0;
  let uniqueCustomers = new Set();
  let repeatCustomers = new Set();
  const customerBookingCounts = new Map();

  for (const b of bookings) {
    if (b.customerId) {
      const current = customerBookingCounts.get(b.customerId) || 0;
      customerBookingCounts.set(b.customerId, current + 1);
      if (current >= 1) {
        repeatCustomers.add(b.customerId);
      }
      uniqueCustomers.add(b.customerId);
    }

    if (b.status === 'COMPLETED' || b.status === 'CONFIRMED') {
      const gmv = b._paise?.totalEventValuePaise || (b.totalAmount ? b.totalAmount * 100 : 0);
      const comm = b._paise?.platformFeePaise || Math.round(gmv * 0.05);
      grossGmvPaise += gmv;
      grossCommissionPaise += comm;
      totalAdvanceFeesPaise += comm;
      completedCount++;
    }
  }

  // Subscription Revenue
  let subscriptionRevenuePaise = 0;
  for (const s of subscriptions) {
    if (s.status === 'ACTIVE' && s.amountPaise) {
      subscriptionRevenuePaise += s.amountPaise;
    }
  }

  // Refunds
  let refundTotalPaise = 0;
  for (const r of refunds) {
    refundTotalPaise += (r.refundAmountPaise || (r.refundAmount ? r.refundAmount * 100 : 0));
  }

  const netPlatformRevenuePaise = (grossCommissionPaise + subscriptionRevenuePaise) - refundTotalPaise;
  const aovINR = completedCount > 0 ? (grossGmvPaise / 100) / completedCount : 0;
  const repeatRatePercent = uniqueCustomers.size > 0 ? ((repeatCustomers.size / uniqueCustomers.size) * 100).toFixed(1) : '0.0';
  const cacINR = (marketingSpendINR > 0 && uniqueCustomers.size > 0) ? Math.round(marketingSpendINR / uniqueCustomers.size) : 0;

  return {
    grossGmvINR: grossGmvPaise / 100,
    grossCommissionINR: grossCommissionPaise / 100,
    subscriptionRevenueINR: subscriptionRevenuePaise / 100,
    refundsTotalINR: refundTotalPaise / 100,
    netPlatformRevenueINR: netPlatformRevenuePaise / 100,
    averageOrderValueINR: Math.round(aovINR),
    totalCompletedBookings: completedCount,
    uniqueCustomersCount: uniqueCustomers.size,
    repeatCustomersCount: repeatCustomers.size,
    repeatBookingRate: `${repeatRatePercent}%`,
    customerAcquisitionCostINR: cacINR
  };
}

/**
 * Resets state for testing
 */
export function _resetExpansionState() {
  recruitmentPipeline.length = 0;
}
