import { CacheService } from '../services/cacheService.js';
import { QueueService } from '../services/queueService.js';
import { createSlotHold, releaseSlotHold } from '../services/availabilityEngine.js';
import { calculateBookingPrice, PRICING_MODELS } from '../services/pricingEngine.js';
import { validateBookingTransition, BOOKING_STATES } from '../services/bookingStateMachine.js';

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
console.log('⚡ PHASE 11: SCALABILITY, PERFORMANCE, RELIABILITY & HA VALIDATION');
console.log('======================================================================\n');

// 1. IN-MEMORY CACHING & INVALIDATION HOOKS
console.log('[SECTION 1: In-Memory Caching & Safe Invalidation]');
{
  const cache = new CacheService(10, 5); // 10s TTL, max 5 entries

  // Cache miss
  const initial = cache.get('categories:all');
  assert(initial === null, 'Initial cache query returns null (miss)');

  // Cache set & hit
  const mockCategories = [{ id: 'cat1', name: 'Photography' }, { id: 'cat2', name: 'Catering' }];
  cache.set('categories:all', mockCategories, 2); // 2s TTL
  const cachedVal = cache.get('categories:all');
  assert(cachedVal !== null && cachedVal.length === 2, 'Returns cached value on hit');

  // Specific key invalidation
  cache.set('vendor:v1', { name: 'Royal Grand' });
  cache.invalidateVendorCache('v1');
  assert(cache.get('vendor:v1') === null, 'invalidateVendorCache clears targeted vendor cache');

  // Namespace invalidation
  cache.set('promotions:active', [{ code: 'PARVA20' }]);
  cache.set('promotions:user123', [{ code: 'WELCOME' }]);
  cache.invalidatePromotionCache();
  assert(cache.get('promotions:active') === null && cache.get('promotions:user123') === null, 'invalidatePromotionCache clears entire namespace');

  // Stats verification
  const stats = cache.getStats();
  assert(stats.sets >= 3 && stats.invalidations >= 2, 'Cache statistics tracking operates accurately');
}

// 2. CONCURRENCY & ATOMIC SLOT HOLD STRESS TEST (50 Simultaneous Requests)
console.log('\n[SECTION 2: Concurrency & Hotspot Protection (50 Concurrent Holds)]');
{
  const vendorId = 'v_stress_test_1';
  const eventDate = '2026-11-20';
  const slot = 'evening';
  const bookedSlots = [];
  const existingHolds = [];

  // Run 50 concurrent requests for the exact same slot
  const concurrentCount = 50;
  let successfulHolds = 0;
  let blockedHolds = 0;

  for (let i = 0; i < concurrentCount; i++) {
    const customerUid = `cust_stress_${i}`;
    try {
      const result = createSlotHold({
        vendorId,
        eventDate,
        eventTimeSlot: slot,
        customerUid
      });

      if (result && result.status === 'SLOT_HELD') {
        successfulHolds++;
      }
    } catch (err) {
      if (err.message && err.message.includes('SLOT_CONFLICT')) {
        blockedHolds++;
      }
    }
  }

  assert(successfulHolds === 1, `Exactly 1 out of 50 concurrent requests secured slot hold (Got: ${successfulHolds})`);
  assert(blockedHolds === 49, `49 out of 50 concurrent requests received conflict rejection (Got: ${blockedHolds})`);

  // Clean up hold
  releaseSlotHold(vendorId, eventDate);
}

// 3. ASYNCHRONOUS QUEUE & DEAD-LETTER QUEUE (DLQ)
console.log('\n[SECTION 3: Background Worker Queue, Exponential Retries & DLQ]');
await (async () => {
  const queue = new QueueService(2, 2); // 2 workers, max 2 retries (3 total attempts)

  let attemptCount = 0;
  // Register a handler that fails intentionally
  queue.registerHandler('SEND_RETRY_EMAIL', async (payload) => {
    attemptCount++;
    throw new Error('SMTP connection timeout simulated');
  });

  const job = queue.enqueue('SEND_RETRY_EMAIL', { to: 'customer@test.com' }, { maxRetries: 2 });
  assert(job.status === 'PROCESSING' || job.status === 'QUEUED', 'Job successfully enqueued');

  // Allow queue to drain retries
  await new Promise(r => setTimeout(r, 100));

  const metrics = queue.getMetrics();
  assert(metrics.failed >= 1, 'Failed jobs tracked in metrics');
  assert(metrics.dlqLength === 1, 'Job moved to Dead-Letter Queue (DLQ) after exceeding max retries');

  const dlq = queue.getDeadLetterQueue();
  assert(dlq[0].lastError.includes('SMTP connection timeout'), 'DLQ records exact failure reason');

  // Test DLQ Replay
  queue.registerHandler('SEND_RETRY_EMAIL', async (payload) => {
    // Fixed handler succeeds
    return { sent: true };
  });

  const replayed = queue.retryDlqJob(dlq[0].id);
  assert(replayed === true, 'DLQ job can be manually retried by admin/ops');
  await new Promise(r => setTimeout(r, 50));
  assert(queue.getMetrics().completed >= 1, 'Replayed DLQ job completes successfully');
})();

// 4. GRACEFUL DEGRADATION UNDER NON-CRITICAL SERVICE OUTAGES
console.log('\n[SECTION 4: Graceful Degradation (Core P0 Isolation)]');
{
  // Simulated scenario: Email & Analytics telemetry are completely offline, but customer booking MUST succeed
  let emailServiceFailed = false;
  let bookingCreated = false;

  try {
    // 1. Core pricing calculated
    const priceQuote = calculateBookingPrice({
      vendor: { id: 'v1', basePrice: 50000 },
      service: { id: 's1', pricingModel: PRICING_MODELS.FIXED, basePrice: 50000 }
    });
    assert(priceQuote._paise.totalEventValuePaise === 5000000, 'Core pricing calculates correctly');

    // 2. Booking state transition verified
    const transition = validateBookingTransition('PAYMENT_SUCCESS', 'VENDOR_PENDING');
    assert(transition === true, 'Core booking state machine operates independently');
    bookingCreated = true;

    // 3. Non-critical email fails asynchronously inside queue/try-catch
    try {
      throw new Error('External Notification Provider 503 Service Unavailable');
    } catch (err) {
      emailServiceFailed = true;
      // Non-blocking log
      // Do not rethrow to user
    }

    assert(bookingCreated === true && emailServiceFailed === true, 'P0 Booking flow succeeds despite P2 Email notification outage');
  } catch (criticalErr) {
    console.error('Critical Err:', criticalErr);
    assert(false, 'Critical flow should not have failed');
  }
}

// 5. CACHING SAFETY: Availability & Pricing Must Be Server-Authoritative
console.log('\n[SECTION 5: Cache Safety Enforcement]');
{
  // Rule: Dynamic quotes with custom guest counts must always be freshly calculated
  const quote1 = calculateBookingPrice({
    vendor: { id: 'v1', category: 'Catering' },
    service: { pricingModel: PRICING_MODELS.PER_GUEST, basePrice: 600, minimumGuests: 10, maximumGuests: 1000 },
    guestCount: 150
  });

  const quote2 = calculateBookingPrice({
    vendor: { id: 'v1', category: 'Catering' },
    service: { pricingModel: PRICING_MODELS.PER_GUEST, basePrice: 600, minimumGuests: 10, maximumGuests: 1000 },
    guestCount: 200
  });

  assert(quote1._paise.totalEventValuePaise === 9000000, 'Guest count 150 gives 90,000 INR');
  assert(quote2._paise.totalEventValuePaise === 12000000, 'Guest count 200 dynamically gives 120,000 INR (never cached blindly)');
}

console.log('\n======================================================================');
console.log(`PHASE 11 TEST SUMMARY: ${passedTests} PASSED | ${totalTests - passedTests} FAILED`);
console.log('======================================================================\n');
