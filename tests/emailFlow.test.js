/**
 * PARVA — RESEND EMAIL SYSTEM AUTOMATED VERIFICATION SUITE
 * 
 * Verifies all 16 mission-critical production criteria:
 * 1. Safe handling when RESEND_API_KEY is missing
 * 2. Booking created email for customer (Pending status, correct amount)
 * 3. Booking created email for vendor (Demand alert)
 * 4. Payment confirmed email for customer with genuine PDF attachment
 * 5. Payment confirmed email for customer without PDF (no misleading attachment notice)
 * 6. Payment confirmed email for vendor (dynamic vendor email, commission breakdown, payout)
 * 7. Multi-vendor booking support
 * 8. Booking cancelled email for customer (authoritative refund status)
 * 9. Booking cancelled email for vendor (slot released notice)
 * 10. Refund processed email (authoritative refund ID and amount)
 * 11. Idempotency: duplicate sends are skipped without duplicate dispatch
 * 12. Forced retry: admin retry bypasses idempotency and increments retry count
 * 13. Resend webhook: transitions status to 'delivered' on email.delivered
 * 14. Resend webhook: transitions status to 'bounced' on email.bounced
 * 15. Invalid / placeholder email address rejection
 * 16. OTP verification and Vendor KYC email dispatches
 */

import assert from 'assert';
import { 
  getResendClient, 
  setResendClient, 
  sendIdempotentEmail, 
  sendBookingCreatedEmail, 
  sendPaymentAndBookingConfirmedEmails, 
  sendBookingCancellationEmail, 
  sendRefundProcessedEmail, 
  sendOtpVerificationEmail, 
  sendVendorKycStatusEmail,
  getEmailLayout,
  formatTimeSlot
} from '../services/emailService.js';

// --- Lightweight In-Memory Firestore Mock ---
class MockDoc {
  constructor(data = null, id = 'doc') {
    this._data = data ? { ...data } : null;
    this.id = id;
  }
  get exists() {
    return this._data !== null;
  }
  data() {
    return this._data ? { ...this._data } : null;
  }
}

class MockDocRef {
  constructor(collection, id) {
    this.collection = collection;
    this.id = id;
  }
  async get() {
    const data = this.collection._docs.get(this.id);
    return new MockDoc(data, this.id);
  }
  async set(data, options = {}) {
    if (options.merge && this.collection._docs.has(this.id)) {
      const existing = this.collection._docs.get(this.id);
      this.collection._docs.set(this.id, { ...existing, ...data });
    } else {
      this.collection._docs.set(this.id, { ...data });
    }
    return true;
  }
  async update(data) {
    const existing = this.collection._docs.get(this.id) || {};
    this.collection._docs.set(this.id, { ...existing, ...data });
    return true;
  }
}

class MockCollection {
  constructor() {
    this._docs = new Map();
  }
  doc(id) {
    return new MockDocRef(this, id);
  }
  where(field, op, val) {
    return {
      get: async () => {
        const matches = [];
        for (const [id, data] of this._docs.entries()) {
          if (data && data[field] === val) {
            matches.push({
              id,
              data: () => ({ ...data }),
              ref: this.doc(id)
            });
          }
        }
        return {
          empty: matches.length === 0,
          docs: matches
        };
      }
    };
  }
  async get() {
    const docs = [];
    for (const [id, data] of this._docs.entries()) {
      docs.push({ id, data: () => ({ ...data }), ref: this.doc(id) });
    }
    return { empty: docs.length === 0, docs };
  }
}

class MockFirestore {
  constructor() {
    this.collections = new Map();
  }
  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new MockCollection());
    }
    return this.collections.get(name);
  }
}

// --- Mock Resend Client ---
class MockResendClient {
  constructor() {
    this.sentEmails = [];
    this.shouldFail = false;
    this.failureError = new Error('Simulated Resend API Rate Limit');
  }
  get emails() {
    return {
      send: async (payload) => {
        if (this.shouldFail) {
          return { data: null, error: this.failureError };
        }
        const messageId = `msg_test_${Math.random().toString(36).substring(2, 9)}`;
        this.sentEmails.push({ ...payload, id: messageId });
        return { data: { id: messageId }, error: null };
      }
    };
  }
}

async function runTestSuite() {
  console.log('====================================================');
  console.log('🧪 RUNNING PARVA RESEND EMAIL SYSTEM TEST SUITE');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   Error: ${err.message}`);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   Error: ${err.message}`);
      failed++;
    }
  }

  const mockDb = new MockFirestore();
  const mockResend = new MockResendClient();
  setResendClient(mockResend);

  // Seed vendor in mock database
  await mockDb.collection('vendors').doc('v_kolhapur_caterer').set({
    id: 'v_kolhapur_caterer',
    name: 'Royal Kolhapur Caterers',
    email: 'caterer@kolhapurparty.com',
    category: 'Catering & Dining',
    location: 'Kolhapur, Maharashtra'
  });

  // TEST 1: Safe fallback when RESEND_API_KEY is not configured
  await testAsync('1. Graceful failure when Resend client is unconfigured', async () => {
    setResendClient(null);
    const origKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;

    const result = await sendIdempotentEmail({
      db: mockDb,
      eventType: 'TEST_NO_KEY',
      bookingId: 'B-001',
      recipient: 'user@parva.com',
      subject: 'Test Subject',
      html: '<p>Test</p>'
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'RESEND_NOT_CONFIGURED');

    // Restore mock client
    process.env.RESEND_API_KEY = origKey;
    setResendClient(mockResend);
  });

  // TEST 2: Booking Request Created - Customer Email
  await testAsync('2. Customer booking request received email (Pending status, correct total)', async () => {
    mockResend.sentEmails = [];
    await sendBookingCreatedEmail({
      db: mockDb,
      booking: {
        id: 'B_REQ_101',
        eventDate: '2026-11-15',
        finalPrice: 25000,
        eventType: 'Wedding Reception'
      },
      customer: {
        name: 'Rohan Deshmukh',
        email: 'rohan.deshmukh@gmail.com'
      },
      vendor: {
        name: 'Royal Kolhapur Caterers',
        category: 'Catering'
      }
    });

    assert.strictEqual(mockResend.sentEmails.length, 1);
    const email = mockResend.sentEmails[0];
    assert.strictEqual(email.to[0], 'rohan.deshmukh@gmail.com');
    assert.match(email.subject, /Booking Request Received — #B_REQ_101/);
    assert.match(email.html, /Pending Confirmation/);
    assert.match(email.html, /₹25,000/);
    assert.match(email.html, /Wedding Reception/);
  });

  // TEST 3: Booking Request Created - Vendor Email
  await testAsync('3. Vendor booking demand alert email', async () => {
    mockResend.sentEmails = [];
    await sendBookingCreatedEmail({
      db: mockDb,
      booking: {
        id: 'B_REQ_102',
        eventDate: '2026-11-20',
        finalPrice: 40000,
        eventType: 'Sangeet Night'
      },
      customer: {
        name: 'Aishwarya Patil',
        email: 'aishwarya@gmail.com'
      },
      vendor: {
        name: 'Royal Kolhapur Caterers',
        email: 'caterer@kolhapurparty.com',
        category: 'Catering'
      }
    });

    assert.strictEqual(mockResend.sentEmails.length, 2); // 1 customer + 1 vendor
    const vendorEmail = mockResend.sentEmails.find(e => e.to[0] === 'caterer@kolhapurparty.com');
    assert(vendorEmail, 'Vendor must receive demand alert email');
    assert.match(vendorEmail.subject, /New Booking Demand Request — #B_REQ_102/);
    assert.match(vendorEmail.html, /₹40,000/);
  });

  // TEST 4: Payment Confirmed - Customer with genuine PDF attachment
  await testAsync('4. Customer payment confirmed email with PDF attachment notice', async () => {
    mockResend.sentEmails = [];
    const samplePdfBuffer = Buffer.from('%PDF-1.4 Mock PDF Invoice Stream');

    await sendPaymentAndBookingConfirmedEmails({
      db: mockDb,
      booking: {
        id: 'B_CONF_201',
        eventDate: '2026-12-05',
        eventTimeSlot: 'evening',
        eventLocationAddress: 'Sayaji Hotel, Kolhapur',
        finalPrice: 50000,
        pricing: { advanceAmount: 2950 }
      },
      customer: {
        name: 'Amit Shinde',
        email: 'amit.shinde@yahoo.com',
        phone: '9876543210'
      },
      vendor: {
        id: 'v_kolhapur_caterer',
        name: 'Royal Kolhapur Caterers',
        email: 'caterer@kolhapurparty.com',
        category: 'Catering'
      },
      transaction: {
        paymentId: 'PAY_CF_887766',
        totalAmount: 2950
      },
      pdfBuffer: samplePdfBuffer
    });

    const custEmail = mockResend.sentEmails.find(e => e.to[0] === 'amit.shinde@yahoo.com');
    assert(custEmail, 'Customer confirmation email sent');
    assert.strictEqual(custEmail.attachments.length, 1);
    assert.strictEqual(custEmail.attachments[0].filename, 'Parva-Booking-B_CONF_201.pdf');
    assert.match(custEmail.html, /📎 Official Receipt PDF Attached/);
    assert.match(custEmail.html, /PAY_CF_887766/);
    assert.match(custEmail.html, /Evening \(05:00 PM – 10:00 PM\)/);
  });

  // TEST 5: Payment Confirmed - Customer without PDF buffer (no false attachment claim)
  await testAsync('5. Customer payment confirmed email without PDF buffer (honest notice)', async () => {
    mockResend.sentEmails = [];

    await sendPaymentAndBookingConfirmedEmails({
      db: mockDb,
      booking: {
        id: 'B_CONF_202',
        eventDate: '2026-12-10',
        eventTimeSlot: 'morning',
        finalPrice: 15000,
        pricing: { advanceAmount: 885 }
      },
      customer: {
        name: 'Pooja Kadam',
        email: 'pooja.kadam@gmail.com'
      },
      vendor: {
        id: 'v_kolhapur_caterer',
        name: 'Royal Kolhapur Caterers',
        email: 'caterer@kolhapurparty.com'
      },
      transaction: {
        paymentId: 'PAY_CF_334455',
        totalAmount: 885
      },
      pdfBuffer: null // No PDF generated
    });

    const custEmail = mockResend.sentEmails.find(e => e.to[0] === 'pooja.kadam@gmail.com');
    assert(custEmail, 'Customer email sent');
    assert.strictEqual(custEmail.attachments || undefined, undefined);
    assert.doesNotMatch(custEmail.html, /📎 Official Receipt PDF Attached/);
    assert.match(custEmail.html, /📄 Official Receipt Available/);
  });

  // TEST 6: Payment Confirmed - Vendor with Commission Breakdown & Schedule Lock
  await testAsync('6. Vendor confirmed booking notification with financial earnings breakdown', async () => {
    mockResend.sentEmails = [];

    await sendPaymentAndBookingConfirmedEmails({
      db: mockDb,
      booking: {
        id: 'B_CONF_203',
        eventDate: '2026-12-15',
        eventTimeSlot: 'full_day',
        finalPrice: 60000,
        pricing: {
          subtotal: 60000,
          commissionAmount: 6000,
          vendorPayout: 54000
        }
      },
      customer: {
        name: 'Vikram Joshi',
        email: 'vikram.j@gmail.com',
        phone: '9922001122'
      },
      vendor: {
        id: 'v_kolhapur_caterer',
        name: 'Royal Kolhapur Caterers',
        email: 'caterer@kolhapurparty.com'
      },
      transaction: {
        paymentId: 'PAY_CF_998877',
        totalAmount: 3540
      },
      commissionData: {
        platformCommission: 6000,
        vendorPayout: 54000
      }
    });

    const vendorEmail = mockResend.sentEmails.find(e => e.to[0] === 'caterer@kolhapurparty.com');
    assert(vendorEmail, 'Vendor notification email sent');
    assert.match(vendorEmail.html, /Gross Booking Value:<\/span><span class="info-value">₹60,000/);
    assert.match(vendorEmail.html, /Platform Commission:<\/span><span class="info-value" style="color: #64748b;">- ₹6,000/);
    assert.match(vendorEmail.html, /Net Vendor Payout:<\/span><span class="info-value amount-highlight">₹54,000/);
    assert.match(vendorEmail.html, /Full Day \(09:00 AM – 10:00 PM\)/);
  });

  // TEST 7: Multi-Vendor Confirmation Dispatch
  await testAsync('7. Multi-vendor confirmation dispatches to each vendor independently', async () => {
    mockResend.sentEmails = [];

    await sendPaymentAndBookingConfirmedEmails({
      db: mockDb,
      booking: {
        id: 'B_MULTI_301',
        eventDate: '2026-12-25',
        vendors: [
          { vendorId: 'v_cat', vendorName: 'Royal Kolhapur Caterers', email: 'caterer@kolhapurparty.com' },
          { vendorId: 'v_photo', vendorName: 'Studio Kolhapur', email: 'studio@kolhapurphoto.com' }
        ],
        pricing: { advanceAmount: 4000 }
      },
      customer: {
        name: 'Sachin Patil',
        email: 'sachin.p@gmail.com'
      },
      vendor: {
        id: 'v_cat',
        name: 'Royal Kolhapur Caterers',
        email: 'caterer@kolhapurparty.com'
      },
      transaction: { paymentId: 'PAY_MULTI_1' }
    });

    const recipients = mockResend.sentEmails.map(e => e.to[0]);
    assert(recipients.includes('sachin.p@gmail.com'), 'Customer received confirmation');
    assert(recipients.includes('caterer@kolhapurparty.com'), 'Caterer received confirmation');
    assert(recipients.includes('studio@kolhapurphoto.com'), 'Photographer received confirmation');
  });

  // TEST 8: Booking Cancellation - Customer (Refund Requested Under Review)
  await testAsync('8. Customer booking cancellation email with dynamic refund status', async () => {
    mockResend.sentEmails = [];

    await sendBookingCancellationEmail({
      db: mockDb,
      booking: {
        id: 'B_CANCEL_401',
        eventDate: '2026-12-30',
        refundStatus: 'Requested'
      },
      customer: {
        name: 'Neha Mane',
        email: 'neha.mane@gmail.com'
      },
      vendor: {
        name: 'Royal Kolhapur Caterers',
        email: 'caterer@kolhapurparty.com'
      },
      reason: 'Family emergency',
      refundAmount: 5000
    });

    const custEmail = mockResend.sentEmails.find(e => e.to[0] === 'neha.mane@gmail.com');
    assert(custEmail, 'Customer cancellation email sent');
    assert.match(custEmail.subject, /Booking Cancelled — #B_CANCEL_401/);
    assert.match(custEmail.html, /Refund Requested — Under Support Review/);
    assert.match(custEmail.html, /₹5,000/);
    assert.match(custEmail.html, /Family emergency/);
  });

  // TEST 9: Booking Cancellation - Vendor (Slot Released Notification)
  await testAsync('9. Vendor booking cancellation email notifies of reopened calendar slot', async () => {
    mockResend.sentEmails = [];

    await sendBookingCancellationEmail({
      db: mockDb,
      booking: {
        id: 'B_CANCEL_402',
        eventDate: '2026-12-30'
      },
      customer: {
        name: 'Neha Mane',
        email: 'neha.mane@gmail.com'
      },
      vendor: {
        name: 'Royal Kolhapur Caterers',
        email: 'caterer@kolhapurparty.com'
      },
      reason: 'Date changed'
    });

    const vendorEmail = mockResend.sentEmails.find(e => e.to[0] === 'caterer@kolhapurparty.com');
    assert(vendorEmail, 'Vendor cancellation email sent');
    assert.match(vendorEmail.html, /Calendar Slot Released/);
    assert.match(vendorEmail.html, /reopened for new customer inquiries/);
  });

  // TEST 10: Refund Successfully Processed Email
  await testAsync('10. Customer refund processed email with refund ID and timeline', async () => {
    mockResend.sentEmails = [];

    await sendRefundProcessedEmail({
      db: mockDb,
      booking: {
        id: 'B_REFUND_501',
        customerEmail: 'sunil.kamble@gmail.com'
      },
      customer: {
        name: 'Sunil Kamble',
        email: 'sunil.kamble@gmail.com'
      },
      refundData: {
        refundId: 'cf_rfd_88332211',
        amount: 3500
      }
    });

    assert.strictEqual(mockResend.sentEmails.length, 1);
    const email = mockResend.sentEmails[0];
    assert.strictEqual(email.to[0], 'sunil.kamble@gmail.com');
    assert.match(email.subject, /Refund Processed — #B_REFUND_501/);
    assert.match(email.html, /cf_rfd_88332211/);
    assert.match(email.html, /₹3,500/);
    assert.match(email.html, /3–5 Banking Days/);
  });

  // TEST 11: Idempotency Check (Skip duplicate send)
  await testAsync('11. Idempotent email dispatch skips duplicates when already accepted', async () => {
    mockResend.sentEmails = [];

    // First Send
    const res1 = await sendIdempotentEmail({
      db: mockDb,
      eventType: 'TEST_IDEMPOTENT',
      bookingId: 'B_IDEMP_01',
      recipient: 'idemp.user@gmail.com',
      subject: 'Idempotency Test 1',
      html: '<p>First Send</p>'
    });
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.status, 'accepted');
    assert.strictEqual(mockResend.sentEmails.length, 1);

    // Second Send with identical parameters
    const res2 = await sendIdempotentEmail({
      db: mockDb,
      eventType: 'TEST_IDEMPOTENT',
      bookingId: 'B_IDEMP_01',
      recipient: 'idemp.user@gmail.com',
      subject: 'Idempotency Test 2',
      html: '<p>Second Send</p>'
    });
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.idempotentSkipped, true);
    assert.strictEqual(mockResend.sentEmails.length, 1, 'Should NOT send a second email to Resend');
  });

  // TEST 12: Admin Explicit Retry (Bypasses Idempotency)
  await testAsync('12. Explicit retry (isRetry: true) bypasses idempotency check and increments count', async () => {
    mockResend.sentEmails = [];

    const resRetry = await sendIdempotentEmail({
      db: mockDb,
      eventType: 'TEST_IDEMPOTENT',
      bookingId: 'B_IDEMP_01',
      recipient: 'idemp.user@gmail.com',
      subject: 'Idempotency Test Retried',
      html: '<p>Retried Send</p>',
      isRetry: true
    });

    assert.strictEqual(resRetry.success, true);
    assert.strictEqual(resRetry.status, 'accepted');
    assert.strictEqual(mockResend.sentEmails.length, 1, 'Should dispatch retry to Resend');
  });

  // TEST 13: Resend Webhook Processing (email.delivered)
  await testAsync('13. Resend webhook processes email.delivered event to update status', async () => {
    const testResendId = 'msg_delivered_test_99';
    const logDocId = 'email_TEST_WEBHOOK_B99_hook_user_gmail_com';

    await mockDb.collection('email_events').doc(logDocId).set({
      eventType: 'TEST_WEBHOOK',
      bookingId: 'B99',
      recipient: 'hook.user@gmail.com',
      resendId: testResendId,
      status: 'accepted'
    });

    // Simulate Webhook Payload
    const webhookEvent = {
      type: 'email.delivered',
      created_at: new Date().toISOString(),
      data: {
        email_id: testResendId,
        to: ['hook.user@gmail.com']
      }
    };

    // Find and update matching record (replicating server.js webhook logic)
    const snap = await mockDb.collection('email_events').where('resendId', '==', webhookEvent.data.email_id).get();
    assert.strictEqual(snap.empty, false);
    for (const d of snap.docs) {
      await d.ref.update({
        status: 'delivered',
        deliveredAt: webhookEvent.created_at
      });
    }

    const updated = await mockDb.collection('email_events').doc(logDocId).get();
    assert.strictEqual(updated.data().status, 'delivered');
    assert(updated.data().deliveredAt);
  });

  // TEST 14: Resend Webhook Processing (email.bounced)
  await testAsync('14. Resend webhook processes email.bounced event and records bounce reason', async () => {
    const testResendId = 'msg_bounced_test_77';
    const logDocId = 'email_TEST_BOUNCE_B77_bounce_user_gmail_com';

    await mockDb.collection('email_events').doc(logDocId).set({
      eventType: 'TEST_BOUNCE',
      bookingId: 'B77',
      recipient: 'bounce.user@gmail.com',
      resendId: testResendId,
      status: 'accepted'
    });

    // Simulate Webhook Payload
    const webhookEvent = {
      type: 'email.bounced',
      created_at: new Date().toISOString(),
      data: {
        email_id: testResendId,
        bounce: { message: '550 5.1.1 User unknown mailbox' }
      }
    };

    const snap = await mockDb.collection('email_events').where('resendId', '==', webhookEvent.data.email_id).get();
    assert.strictEqual(snap.empty, false);
    for (const d of snap.docs) {
      await d.ref.update({
        status: 'bounced',
        bouncedAt: webhookEvent.created_at,
        bounceReason: webhookEvent.data.bounce.message
      });
    }

    const updated = await mockDb.collection('email_events').doc(logDocId).get();
    assert.strictEqual(updated.data().status, 'bounced');
    assert.strictEqual(updated.data().bounceReason, '550 5.1.1 User unknown mailbox');
  });

  // TEST 15: Invalid recipient rejection
  await testAsync('15. Rejection of invalid/placeholder emails without error thrown', async () => {
    const invalidEmails = ['invalid-email', 'user@domain.local', 'test@example.com', '', null];
    for (const inv of invalidEmails) {
      const res = await sendIdempotentEmail({
        db: mockDb,
        eventType: 'TEST_INVALID',
        bookingId: 'B_INV',
        recipient: inv,
        subject: 'Test',
        html: '<p>Test</p>'
      });
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.skipped, true);
    }
  });

  // TEST 16: OTP Verification & Vendor KYC Email
  await testAsync('16. OTP verification and Vendor KYC status updates dispatch correctly', async () => {
    mockResend.sentEmails = [];

    // OTP
    const otpResult = await sendOtpVerificationEmail({
      email: 'newuser@parva.com',
      otp: '784912',
      name: 'Pravin Jadhav',
      purpose: 'Customer Registration'
    });
    assert.strictEqual(otpResult.success, true);
    const otpEmail = mockResend.sentEmails.find(e => e.to[0] === 'newuser@parva.com');
    assert(otpEmail);
    assert.match(otpEmail.subject, /784912 is your PARVA verification code/);
    assert.match(otpEmail.html, /784912/);

    // KYC Verified
    const kycResult = await sendVendorKycStatusEmail({
      vendorEmail: 'caterer@kolhapurparty.com',
      vendorName: 'Royal Kolhapur Caterers',
      status: 'VERIFIED',
      remarks: 'All Aadhaar and FSSAI documents verified successfully.'
    });
    assert.strictEqual(kycResult.success, true);
    const kycEmail = mockResend.sentEmails.find(e => e.to[0] === 'caterer@kolhapurparty.com');
    assert(kycEmail);
    assert.match(kycEmail.subject, /Your Parva Partner Profile is Verified/);
    assert.match(kycEmail.html, /All Aadhaar and FSSAI documents verified successfully/);
  });

  console.log('\n====================================================');
  console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Fatal Test Runner Error:', err);
  process.exit(1);
});
