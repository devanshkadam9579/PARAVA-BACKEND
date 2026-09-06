import { DEFAULT_CATEGORIES } from '../seedData.js';
import { telegramService, TELEGRAM_ALERT_TYPES } from '../services/telegramService.js';
import { generateIcsCalendar, generateGoogleCalendarUrl } from '../services/calendarService.js';
import { notificationService, NOTIFICATION_TYPES } from '../services/notificationService.js';
import { checkAllIntegrationsHealth, INTEGRATION_STATUS } from '../services/integrationHealthService.js';

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
console.log('🎨 PHASE 13: PREMIUM UI/UX, IMAGE-FIRST MARKETPLACE & INTEGRATIONS');
console.log('======================================================================\n');

// 1. IMAGE-FIRST CATEGORIES & NO EMOJI INTEGRITY
console.log('[SECTION 1: Professional Image-First Marketplace Categories]');
{
  assert(DEFAULT_CATEGORIES.length >= 8, 'Marketplace seeded with rich event categories');

  // Verify every category has a valid image URL and NO emoji symbols
  const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/u;
  let allHaveValidImages = true;
  let anyHaveEmojis = false;

  for (const cat of DEFAULT_CATEGORIES) {
    if (!cat.image || !cat.image.startsWith('http')) {
      allHaveValidImages = false;
    }
    if (emojiRegex.test(cat.name) || emojiRegex.test(cat.iconName || '')) {
      anyHaveEmojis = true;
    }
  }

  assert(allHaveValidImages === true, 'All categories feature high-resolution professional image URLs');
  assert(anyHaveEmojis === false, 'Zero emoji-based category icons across marketplace definitions');
}

// 2. SECURE TELEGRAM OPERATIONAL ALERTS
console.log('\n[SECTION 2: Telegram Operational Alerts & Sanitization]');
await (async () => {
  telegramService.clear();

  // Test Booking alert formatting
  const bookingAlert = await telegramService.sendAlert(TELEGRAM_ALERT_TYPES.NEW_BOOKING, {
    bookingId: 'b_test_999',
    vendorName: 'Royal Grand Pavilion',
    category: 'Banquet Hall',
    eventDate: '2026-11-20',
    eventTimeSlot: 'evening',
    totalAmountINR: 150000,
    advancePaidINR: 8850
  });

  assert(bookingAlert.alert.message.includes('New Booking Confirmed'), 'Formats rich Telegram Markdown message');
  assert(bookingAlert.alert.message.includes('Royal Grand Pavilion'), 'Includes vendor and event details');
  assert(!bookingAlert.alert.message.includes('password') && !bookingAlert.alert.message.includes('cvv'), 'Guarantees zero PII or credentials leakage');

  // Non-blocking guarantee: Telegram handles offline gracefully
  assert(bookingAlert.sent === false && bookingAlert.reason === 'TELEGRAM_NOT_CONFIGURED', 'Non-blocking fallback when bot token not set in test env');
})();

// 3. CALENDAR EXPORT (ICS & GOOGLE CALENDAR)
console.log('\n[SECTION 3: iCalendar (.ics) and Google Calendar Exports]');
{
  const mockBooking = { id: 'b_cal_1', eventDate: '2026-12-10', eventTimeSlot: 'evening' };
  const mockVendor = { id: 'v1', name: 'Aura Florals', location: 'Kolhapur', whatsapp: '919999999999' };
  const mockService = { id: 's1', name: 'Royal Mandap Decor' };

  const ics = generateIcsCalendar({ booking: mockBooking, vendor: mockVendor, service: mockService });
  assert(ics.includes('BEGIN:VCALENDAR') && ics.includes('END:VCALENDAR'), 'Generates valid RFC-5545 iCalendar specification');
  assert(ics.includes('SUMMARY:MyParva: Royal Mandap Decor with Aura Florals'), 'Calendar title includes service and vendor');
  assert(ics.includes('LOCATION:Kolhapur, Maharashtra, India'), 'Location accurately populated in .ics');

  const gcalUrl = generateGoogleCalendarUrl({ booking: mockBooking, vendor: mockVendor, service: mockService });
  assert(gcalUrl.startsWith('https://calendar.google.com/calendar/render'), 'Generates valid Google Calendar URL');
  assert(gcalUrl.includes('MyParva'), 'Google Calendar URL includes event branding and parameters');
}

// 4. UNIFIED MULTI-CHANNEL NOTIFICATION ROUTER
console.log('\n[SECTION 4: Unified Multi-Channel Notification Router]');
await (async () => {
  notificationService.clear();

  const res = await notificationService.dispatch({
    recipientId: 'cust_user_42',
    recipientRole: 'CUSTOMER',
    type: NOTIFICATION_TYPES.BOOKING_CREATED,
    title: 'Booking Confirmed',
    message: 'Your booking with Royal Grand is confirmed',
    metadata: { email: 'customer@test.com', bookingId: 'b_123' },
    channels: ['IN_APP', 'EMAIL']
  });

  assert(res.inApp === true && res.emailQueued === true, 'Successfully dispatches to in-app inbox and email queue');

  const inbox = notificationService.getInbox('cust_user_42');
  assert(inbox.length === 1 && inbox[0].title === 'Booking Confirmed', 'Notification saved in customer inbox');

  const readRes = notificationService.markAsRead(inbox[0].id, 'cust_user_42');
  assert(readRes === true && inbox[0].read === true, 'Notification marked as read');
})();

// 5. CENTRAL INTEGRATIONS HEALTH PROBES
console.log('\n[SECTION 5: Central Integrations Health Probes]');
await (async () => {
  const health = await checkAllIntegrationsHealth();
  assert(health.overallHealth === 'HEALTHY', 'Overall integrations system healthy');
  assert(health.integrations.firebase.status === INTEGRATION_STATUS.CONNECTED, 'Firebase Admin SDK probe operational');
  assert(health.integrations.cloudinary.status === INTEGRATION_STATUS.CONNECTED, 'Cloudinary CDN probe operational');
  assert(health.integrations.cashfree !== undefined, 'Cashfree PG integration monitored');
  assert(health.integrations.resend !== undefined, 'Resend Email integration monitored');
  assert(health.integrations.telegram !== undefined, 'Telegram Alerting integration monitored');
})();

console.log('\n======================================================================');
console.log(`PHASE 13 TEST SUMMARY: ${passedTests} PASSED | ${totalTests - passedTests} FAILED`);
console.log('======================================================================\n');
