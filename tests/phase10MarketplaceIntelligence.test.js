/**
 * PARVA PLATFORM - PHASE 10 MARKETPLACE INTELLIGENCE, AUTOMATION & SCALE TEST SUITE
 * Version 2.0.0
 */

import { calculateVendorScore, getSmartRecommendations, computePriceIntelligence, forecastDemand, generateVendorRecommendations, DEMAND_LEVELS } from '../services/intelligenceEngine.js';
import { dispatchAutomationEvent, runScheduledMaintenanceJobs, evaluateRiskSignals, auditMarketplaceDataQuality, getFeatureFlags, setFeatureFlag } from '../services/automationEngine.js';

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

async function runPhase10Tests() {
  console.log('======================================================================');
  console.log('PHASE 10: MARKETPLACE INTELLIGENCE, AUTOMATION & SCALE VALIDATION');
  console.log('======================================================================\n');

  // 1. TRANSPARENT VENDOR PERFORMANCE SCORE
  console.log('[SECTION 1: Transparent Vendor Performance Scoring]');
  const mockVendor = {
    id: 'v_elite_decor',
    name: 'Elite Orchid Decorators',
    city: 'Pune',
    category: 'decorators',
    rating: 4.9,
    verified: true,
    services: [{ id: 's1', name: 'Mandap Setup' }],
    avgResponseMinutes: 10
  };
  const mockBookings = [
    { vendorId: 'v_elite_decor', status: 'COMPLETED' },
    { vendorId: 'v_elite_decor', status: 'COMPLETED' },
    { vendorId: 'v_elite_decor', status: 'CONFIRMED' }
  ];
  const score = calculateVendorScore(mockVendor, mockBookings);
  assert(score && score.overall >= 85, 'Vendor qualifies for ELITE tier with score >= 85 (Score: ' + score.overall + ')');
  assert(score.breakdown.ratingScore.score === 25, 'Rating score is 25/25 pts');
  assert(score.breakdown.acceptanceScore.score === 20, 'Acceptance score is 20/20 pts (100% acceptance)');
  assert(score.breakdown.responseScore.score === 10, 'Response score is 10/10 pts (<= 15 min response)');

  // 2. SMART VENDOR RECOMMENDATIONS
  console.log('\n[SECTION 2: Deterministic Smart Recommendations]');
  const vendorsPool = [
    { id: 'v1', name: 'Budget Sounds', category: 'dj', city: 'Pune', basePrice: 15000, rating: 4.2 },
    { id: 'v2', name: 'Royal Concert DJ', category: 'dj', city: 'Pune', basePrice: 45000, rating: 4.95, verified: true, isGuestFavourite: true }
  ];
  const recs = getSmartRecommendations({ vendors: vendorsPool, category: 'dj', city: 'Pune' });
  assert(recs.length === 2, 'Returns matched recommendations for category/city');
  assert(recs[0].id === 'v2', 'Top recommendation ranks verified guest favourite first');

  // 3. PRICE INTELLIGENCE & STATISTICAL DISTRIBUTIONS
  console.log('\n[SECTION 3: Marketplace Price Intelligence]');
  const priceIntel = computePriceIntelligence(vendorsPool, 'dj');
  assert(priceIntel.minPrice === 15000, 'Min price is 15,000 INR');
  assert(priceIntel.maxPrice === 45000, 'Max price is 45,000 INR');
  assert(priceIntel.avgPrice === 30000, 'Average price is 30,000 INR');
  assert(priceIntel.medianPrice === 30000, 'Median price is 30,000 INR');

  // 4. STATISTICAL DEMAND FORECASTING
  console.log('\n[SECTION 4: Statistical Demand Forecasting]');
  const weekendForecast = forecastDemand({
    category: 'catering',
    city: 'Pune',
    targetDate: '2026-11-21', // Saturday
    historicalBookings: [
      { vendor: { category: 'catering', city: 'Pune' } },
      { vendor: { category: 'catering', city: 'Pune' } },
      { vendor: { category: 'catering', city: 'Pune' } },
      { vendor: { category: 'catering', city: 'Pune' } },
      { vendor: { category: 'catering', city: 'Pune' } }
    ]
  });
  assert(weekendForecast.demandLevel === DEMAND_LEVELS.VERY_HIGH, 'Correctly forecasts VERY_HIGH demand for busy weekend');
  assert(weekendForecast.recommendedLeadTimeDays === 30, 'Recommends 30 days advance booking for peak season');

  // 5. ACTIONABLE VENDOR IMPROVEMENT TIPS
  console.log('\n[SECTION 5: Actionable Vendor Improvement Tips]');
  const tips = generateVendorRecommendations(score);
  assert(Array.isArray(tips) && tips.length <= 3, 'Generates top 3 prioritized vendor recommendations');

  // 6. EVENT AUTOMATION ENGINE
  console.log('\n[SECTION 6: Event Automation Dispatcher]');
  const autoEvent = await dispatchAutomationEvent({
    eventName: 'PAYMENT_SUCCESS',
    payload: { bookingId: 'bk_999', vendorId: 'v_elite_decor', eventDate: '2026-12-05' }
  });
  assert(autoEvent.status === 'PROCESSED', 'Automation event processed cleanly');
  assert(autoEvent.actionsTriggered.includes('CONFIRM_PAYMENT_LEDGER'), 'Triggers payment ledger confirmation');

  // 7. SCHEDULED MAINTENANCE JOBS
  console.log('\n[SECTION 7: Scheduled Maintenance Jobs]');
  const maintenanceResults = runScheduledMaintenanceJobs({
    holds: [{ holdId: 'h_old', vendorId: 'v1', eventDate: '2026-10-01', expiresAt: Date.now() - 5000 }],
    bookings: [{ id: 'b_pending', status: 'VENDOR_PENDING', createdAt: new Date(Date.now() - 15 * 3600 * 1000).toISOString() }] // 15 hrs old
  });
  assert(maintenanceResults.staleHoldsReleased === 1, 'Stale hold successfully released');
  assert(maintenanceResults.overdueVendorAlerts === 1, 'Overdue vendor SLA alert flagged');

  // 8. FRAUD & RISK SIGNALS DETECTION
  console.log('\n[SECTION 8: Fraud & Risk Signals Evaluator]');
  const riskEvaluation = evaluateRiskSignals({
    userId: 'user_suspicious',
    paymentAttempts: [{ status: 'FAILED' }, { status: 'FAILED' }, { status: 'FAILED' }],
    userBookings: [{ status: 'CANCELLED' }, { status: 'CANCELLED' }, { status: 'CANCELLED' }],
    couponsUsed: ['C1', 'C2', 'C3', 'C4']
  });
  assert(riskEvaluation.riskTier === 'HIGH_RISK', 'Accurately identifies HIGH_RISK abusive pattern');
  assert(riskEvaluation.adminReviewRequired === true, 'Flags account for admin review without automatic ban');

  // 9. DATA QUALITY INTEGRITY AUDITOR
  console.log('\n[SECTION 9: Data Quality Integrity Auditor]');
  const qualityAudit = auditMarketplaceDataQuality({
    vendors: [{ id: 'v_empty', name: 'Empty Vendor', services: [] }],
    services: [{ id: 's_invalid', name: 'Free Service', price: 0 }],
    bookings: [{ id: 'b_orphaned', customerId: null, vendorId: 'v1' }]
  });
  assert(qualityAudit.totalIssuesFound === 3, 'Identifies all 3 simulated data quality anomalies');

  // 10. SERVER-SIDE FEATURE FLAGS
  console.log('\n[SECTION 10: Server-Side Feature Flags]');
  const flags = getFeatureFlags();
  assert(flags.smartRecommendations === true, 'Smart recommendations feature flag is active');
  setFeatureFlag('smsReminders', true);
  assert(getFeatureFlags().smsReminders === true, 'Feature flag dynamic update successful');

  console.log('\n======================================================================');
  console.log('PHASE 10 TEST SUMMARY: ' + passed + ' PASSED | ' + failed + ' FAILED');
  console.log('======================================================================\n');

  if (failed > 0) process.exit(1);
}

runPhase10Tests().catch(err => {
  console.error(err);
  process.exit(1);
});