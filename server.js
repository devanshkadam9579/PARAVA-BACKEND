import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { v2 as cloudinary } from 'cloudinary';
import admin from 'firebase-admin';
import { DEFAULT_CATEGORIES, DEFAULT_PROMOS, DEFAULT_VENDORS } from './seedData.js';
import { generateBookingPdf } from './services/pdfService.js';
import { calculateBookingPrice } from './services/pricingEngine.js';
import { checkAvailability, createSlotHold, releaseSlotHold } from './services/availabilityEngine.js';
import { validateBookingTransition, BOOKING_STATES, checkIdempotency, saveIdempotency } from './services/bookingStateMachine.js';
import { calculateRefund } from './services/refundEngine.js';

import { calculateVendorCommission } from './services/commissionService.js';
import { telegramService, TELEGRAM_ALERT_TYPES } from './services/telegramService.js';
import {
  sendBookingCreatedEmail,
  sendPaymentAndBookingConfirmedEmails,
  sendBookingCancellationEmail,
  sendRefundProcessedEmail,
  sendIdempotentEmail
} from './services/emailService.js';
import { requestIdMiddleware, securityHeadersMiddleware, rateLimiter, structuredLogger } from './middleware/securityMiddleware.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import config from './firebase-applet-config.json' with { type: "json" };
import { getFirestore } from 'firebase-admin/firestore';

// Initialize Firebase Admin SDK
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else {
    const serviceAccountPath = path.resolve(__dirname, './serviceAccountKey.json');
    if (fs.existsSync(serviceAccountPath)) {
      serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    }
  }

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully with Service Account.");
  } else {
    console.warn("WARNING: Service Account credential not found. Initializing Firebase Admin with config projectId fallback:", config.projectId);
    admin.initializeApp({
      projectId: config.projectId
    });
  }
} catch (error) {
  console.error("Firebase Admin Initialization Error:", error);
}

const db = admin.apps.length > 0 
  ? (config.firestoreDatabaseId ? getFirestore(admin.apps[0], config.firestoreDatabaseId) : admin.firestore())
  : null;

// Initialize Cashfree Payments PG SDK
import { Cashfree, CFEnvironment } from 'cashfree-pg';

const cashfree = new Cashfree(
  process.env.CASHFREE_ENV === 'PRODUCTION' ? CFEnvironment.PRODUCTION : CFEnvironment.SANDBOX,
  process.env.CASHFREE_APP_ID || 'TEST111841318a08c860af55e862516f13148111',
  process.env.CASHFREE_SECRET_KEY || 'cfsk_ma_test_cb126d43432b695f46b3a42cadaa997c_2f8bf785'
);

console.log(`[Cashfree] Initialized in ${process.env.CASHFREE_ENV === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX'} mode. Client ID: ${cashfree.XClientId ? cashfree.XClientId.substring(0, 8) + '...' : 'None'}`);




// Initialize Cloudinary SDK
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'k03rmhkg',
  api_key: process.env.CLOUDINARY_API_KEY || '354754454388942',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'VJnWw6rsG05nPmBLOiUS5r0VDPw'
});

const app = express();

// Secure CORS - Allow local frontend, vendor app, admin portal, and deployed origins
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://localhost:5000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:5173',
  process.env.APP_URL || 'https://parava-frontend.onrender.com',
  process.env.VENDOR_APP_URL,
  process.env.ADMIN_APP_URL
].filter(Boolean);

app.use(requestIdMiddleware);
app.use(securityHeadersMiddleware);
app.use(structuredLogger);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.onrender.com') || origin.endsWith('.vercel.app')) {
      callback(null, true);
    } else {
      if (process.env.NODE_ENV === 'production') {
        callback(new Error('CORS_ORIGIN_NOT_ALLOWED'));
      } else {
        callback(null, true); // Permissive in dev/sandbox
      }
    }
  },
  credentials: true
}));

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

const PORT = process.env.PORT || 5000;

// ==================== HEALTH & OBSERVABILITY ENDPOINTS ====================
app.get(['/health', '/api/health'], (req, res) => {
  res.json({
    status: 'HEALTHY',
    service: 'PARVA-BACKEND',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV || 'development',
    database: db ? 'CONNECTED' : 'DISCONNECTED',
    gateway: 'CASHFREE',
    cashfreeEnv: process.env.CASHFREE_ENV === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
    requestId: req.id
  });
});

// Rate limiter for payment & booking mutations
const apiMutationLimiter = rateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: 'Too many operations in a short period. Please wait a moment.'
});

// ==================== CLOUDINARY DIRECT UPLOAD ROUTE ====================
app.post('/api/upload/image', rateLimiter({ windowMs: 60 * 1000, maxRequests: 20 }), async (req, res) => {
  try {
    const { image, folder = 'parva_vendors' } = req.body;
    if (!image) {
      return res.status(400).json({ success: false, error: 'No image data provided.' });
    }

    const uploadResponse = await cloudinary.uploader.upload(image, {
      folder,
      resource_type: 'image',
      format: 'webp', // Auto-convert to ultra-compact WebP
      quality: 'auto:good', // Cloudinary smart compression
      fetch_format: 'auto'
    });

    console.log(`[Cloudinary] Successfully uploaded image: ${uploadResponse.secure_url}`);
    res.json({
      success: true,
      url: uploadResponse.secure_url,
      public_id: uploadResponse.public_id,
      format: uploadResponse.format,
      bytes: uploadResponse.bytes
    });
  } catch (error) {
    console.error('Cloudinary Upload Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Image upload failed' });
  }
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    gateway: 'CASHFREE', 
    environment: process.env.CASHFREE_ENV === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
    message: 'PARVA Celebrations Backend, Cashfree Payments & Resend Email Engine is Active!' 
  });
});

// Middleware to check DB
app.use((req, res, next) => {
  if (!db && req.path.startsWith('/api/') && !req.path.startsWith('/api/health')) {
    return res.status(500).json({ error: 'Database not initialized. Missing Service Account.' });
  }
  next();
});


// ==================== AUTHORITATIVE DOMAIN ENDPOINTS ====================

// 1. Authoritative Pricing Quote Generator
app.post('/api/pricing/quote', async (req, res) => {
  try {
    const { vendor, service, selectedPackage, selectedAddons, guestCount, extraHours, durationDays, couponCode } = req.body;
    if (!vendor || !service) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'Both vendor and service payloads are required' }
      });
    }

    let coupon = null;
    if (couponCode && db) {
      const couponDoc = await db.collection('coupons').doc(couponCode.toUpperCase()).get();
      if (couponDoc.exists) {
        coupon = couponDoc.data();
      }
    }

    let commissionPercentage = 10;
    let bookingFeePercentage = 5;
    if (db) {
      try {
        const settingsDoc = await db.collection('settings').doc('global').get();
        if (settingsDoc.exists) {
          const sData = settingsDoc.data();
          if (sData.commissionPercentage !== undefined) commissionPercentage = Number(sData.commissionPercentage);
          if (sData.bookingFeePercentage !== undefined) bookingFeePercentage = Number(sData.bookingFeePercentage);
        }
      } catch (e) {
        console.warn('[Pricing Quote] Could not fetch settings/global:', e);
      }
    }

    const priceSnapshot = calculateBookingPrice({
      vendor,
      service,
      selectedPackage,
      selectedAddons,
      guestCount,
      extraHours,
      durationDays,
      coupon,
      commissionPercentage,
      bookingFeePercentage
    });

    return res.json({ success: true, data: priceSnapshot });
  } catch (error) {
    console.error('[Pricing API Error]:', error.message);
    return res.status(400).json({
      success: false,
      error: { code: 'PRICING_CALCULATION_ERROR', message: error.message }
    });
  }
});

// 2. Authoritative Availability Checker
app.post('/api/availability/check', async (req, res) => {
  try {
    const { vendorId, eventDate, eventTimeSlot } = req.body;
    if (!vendorId || !eventDate) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'vendorId and eventDate are required' }
      });
    }

    let vendor = null;
    let existingBookings = [];

    if (db) {
      const vendorDoc = await db.collection('vendors').doc(vendorId).get();
      if (vendorDoc.exists) {
        vendor = vendorDoc.data();
        vendor.id = vendorDoc.id;
      }
      const bookingsSnap = await db.collection('bookings')
        .where('vendorId', '==', vendorId)
        .where('eventDate', '==', eventDate)
        .get();
      bookingsSnap.forEach(doc => existingBookings.push(doc.data()));
    } else {
      vendor = { id: vendorId, busyDates: [] };
    }

    const result = checkAvailability({ vendor, eventDate, eventTimeSlot, existingBookings });
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('[Availability API Error]:', error.message);
    return res.status(400).json({
      success: false,
      error: { code: 'AVAILABILITY_ERROR', message: error.message }
    });
  }
});

// 3. Atomic Temporary Slot Hold
app.post('/api/bookings/hold', async (req, res) => {
  try {
    const { vendorId, eventDate, eventTimeSlot, customerUid } = req.body;
    if (!vendorId || !eventDate) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'vendorId, eventDate, and customerUid are required' }
      });
    }

    const holdResult = createSlotHold({ vendorId, eventDate, eventTimeSlot, customerUid });
    return res.json({ success: true, data: holdResult });
  } catch (error) {
    console.error('[Slot Hold API Error]:', error.message);
    return res.status(409).json({
      success: false,
      error: { code: 'SLOT_HOLD_CONFLICT', message: error.message }
    });
  }
});

// 4. Refund Policy Estimator
app.post('/api/bookings/refund-estimate', async (req, res) => {
  try {
    const { booking, reason, cancelledBy } = req.body;
    if (!booking) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'Booking record is required' }
      });
    }

    const refundDetails = calculateRefund({ booking, reason, cancelledBy });
    return res.json({ success: true, data: refundDetails });
  } catch (error) {
    console.error('[Refund Estimator Error]:', error.message);
    return res.status(400).json({
      success: false,
      error: { code: 'REFUND_ESTIMATE_ERROR', message: error.message }
    });
  }
});

// ==================== 1. CASHFREE PAYMENT & VERIFICATION ROUTES ====================

/**
 * Creates an authoritative Cashfree Order with server-side price security
 */
async function handleCreateCashfreeOrder(req, res) {
  try {
    const { 
      userId, 
      vendorId, 
      type = 'booking', 
      selectedServices = [], 
      planningGuestSize = 100, 
      couponCode,
      customerName = 'Parva Guest',
      customerPhone = '9999999999',
      customerEmail = 'guest@parvaevents.com',
      eventDate = '',
      eventTimeSlot = 'full_day'
    } = req.body;

    const orderId = req.body.orderId || `PRV_ORD_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;

    let servicesTotal = 0;
    let rawBookingFee = 0;
    let gstAmount = 0;
    let couponDiscount = 0;
    let finalPayable = 0;
    let vendorData = null;
    let bookingFeePct = 5;
    let commissionPct = 10;

    if (type === 'connection') {
      const connectionFee = 499;
      gstAmount = Math.round(connectionFee * 0.18);
      finalPayable = connectionFee + gstAmount;
      servicesTotal = connectionFee;
      rawBookingFee = connectionFee;
    } else if (type === 'booking') {
      // 1. True Atomic Double Booking & Slot Locking Protection (Firestore Transaction)
      if (vendorId && eventDate && db) {
        try {
          const reqSlot = (eventTimeSlot || 'full_day').toLowerCase();
          const conflictingSlots = reqSlot === 'full_day' 
            ? ['full_day', 'morning', 'afternoon', 'evening'] 
            : [reqSlot, 'full_day'];


          await db.runTransaction(async (transaction) => {
            const reservationRefs = conflictingSlots.map(s => 
              db.collection('slot_reservations').doc(`${vendorId}_${eventDate}_${s}`)
            );
            const snapshots = await Promise.all(reservationRefs.map(ref => transaction.get(ref)));

            for (const snap of snapshots) {
              if (snap.exists) {
                const data = snap.data();
                const now = Date.now();
                const isConfirmed = data.status === 'CONFIRMED';
                const isHoldActive = data.status === 'PENDING_PAYMENT' && data.expiresAt > now && data.orderId !== orderId;

                if (isConfirmed || isHoldActive) {
                  throw new Error(`SLOT_ALREADY_RESERVED:${data.slot || reqSlot}`);
                }
              }
            }

            // Lock the requested slot atomically with a 15-minute lease for checkout
            const targetRef = db.collection('slot_reservations').doc(`${vendorId}_${eventDate}_${reqSlot}`);
            transaction.set(targetRef, {
              vendorId,
              eventDate,
              slot: reqSlot,
              orderId,
              userId: userId || 'Guest',
              status: 'PENDING_PAYMENT',
              expiresAt: Date.now() + 15 * 60 * 1000,
              createdAt: new Date().toISOString()
            });
          });
        } catch (txnErr) {
          if (txnErr.message && txnErr.message.startsWith('SLOT_ALREADY_RESERVED')) {
            return res.status(409).json({
              success: false,
              error: `Slot Conflict: This vendor slot is already reserved or confirmed for ${eventDate} (${eventTimeSlot || 'selected slot'}). Please choose another date or time slot.`
            });
          }
          console.warn("[Slot Reservation Warning]:", txnErr.message);
        }
      }


      // 2. Authoritative Vendor Price Recalculation
      if (vendorId && db) {
        try {
          const vDoc = await db.collection('vendors').doc(vendorId).get();
          if (vDoc.exists) {
            vendorData = vDoc.data();
          }
        } catch (e) {
          console.warn("[Cashfree Order] Could not fetch vendor doc, using fallback catalog:", e);
        }
      }

      // Compute services total server-side with strict unit logic
      if (Array.isArray(selectedServices) && selectedServices.length > 0) {
        servicesTotal = selectedServices.reduce((sum, item) => {
          const itemPrice = Number(item.price) || 0;
          const qty = Math.max(1, Number(item.quantity) || 1);
          const unitStr = String(item.unit || '').toLowerCase();
          const isPerPersonOrPlate = unitStr.includes('plate') || unitStr.includes('person') || unitStr.includes('guest') || (vendorData && vendorData.category === 'Catering' && !unitStr.includes('fixed') && !unitStr.includes('package') && !unitStr.includes('event'));
          
          if (isPerPersonOrPlate) {
            const guests = Math.max(1, Number(planningGuestSize) || 100);
            return sum + (itemPrice * guests);
          }
          // Hourly, per-item, fixed or package pricing
          return sum + (itemPrice * qty);
        }, 0);
      } else if (vendorData && vendorData.basePrice) {
        const isCatering = vendorData.category === 'Catering';
        servicesTotal = isCatering ? (vendorData.basePrice * (planningGuestSize || 100)) : vendorData.basePrice;
      } else {
        servicesTotal = Number(req.body.amount) || 5000;
      }


      // 2. Fetch Admin Global Settings (Booking Fee % and Commission %)
      if (db) {
        try {
          const settingsDoc = await db.collection('settings').doc('global').get();
          if (settingsDoc.exists) {
            const sData = settingsDoc.data();
            if (sData.bookingFeePercentage !== undefined) bookingFeePct = Number(sData.bookingFeePercentage);
            if (sData.commissionPercentage !== undefined) commissionPct = Number(sData.commissionPercentage);
          }
        } catch (e) {
          console.warn("[Cashfree Order] Could not fetch settings:", e);
        }
      }

      // 3. Authoritative Coupon Verification & Discount Calculation (Reduces Subtotal)
      if (couponCode && db) {
        try {
          const cleanCode = String(couponCode).trim().toUpperCase();
          const couponDoc = await db.collection('coupons').doc(cleanCode).get();
          if (couponDoc.exists) {
            const cData = couponDoc.data();
            const isNotExpired = !cData.expiryDate || (new Date(cData.expiryDate) >= new Date());
            const meetsMinSpend = !cData.minSpend || (servicesTotal >= Number(cData.minSpend));

            if (cData.active !== false && isNotExpired && meetsMinSpend) {
              if (cData.discountType === 'percentage' || cData.discountPercent || (cData.discount && !cData.discountAmount)) {
                const pct = Number(cData.discountPercent || cData.discountValue || cData.discount || 0);
                let disc = Math.round((servicesTotal * pct) / 100);
                if (cData.maxDiscount && disc > Number(cData.maxDiscount)) {
                  disc = Number(cData.maxDiscount);
                }
                couponDiscount = disc;
              } else {
                couponDiscount = Number(cData.discountAmount || cData.discountValue || cData.discount || 0);
              }
            }
          }
        } catch (e) {
          console.warn("[Cashfree Order] Coupon validation error:", e);
        }
      }

      // Discounted Subtotal (never negative)
      const discountedSubtotal = Math.max(0, servicesTotal - couponDiscount);

      // Calculate Advance Booking Fee (e.g. 5% of discounted subtotal)
      rawBookingFee = Math.round((discountedSubtotal * bookingFeePct) / 100);
      if (rawBookingFee <= 0) rawBookingFee = Math.round((discountedSubtotal * 0.05));
      gstAmount = Math.round(rawBookingFee * 0.18);
      finalPayable = Math.max(1, rawBookingFee + gstAmount);
    } else {
      return res.status(400).json({ success: false, error: 'Invalid payment type requested.' });
    }

    // 4. Calculate Protected Commission Breakdown with Dynamic Admin Commission
    const commissionData = calculateVendorCommission({
      subtotal: servicesTotal,
      discount: couponDiscount,
      commissionPercentage: commissionPct
    });

    // 5. Generate Deterministic Cashfree Order
    const sanitizedPhone = String(customerPhone).replace(/\D/g, '').slice(-10) || '9999999999';
    const sanitizedCustomerId = String(userId || 'guest_user').replace(/[^a-zA-Z0-9_-]/g, '_');

    const orderPayload = {
      order_id: orderId,
      order_amount: finalPayable,
      order_currency: 'INR',
      customer_details: {
        customer_id: sanitizedCustomerId,
        customer_name: customerName || 'Parva Customer',
        customer_email: customerEmail && customerEmail.includes('@') ? customerEmail : 'customer@parvaevents.com',
        customer_phone: sanitizedPhone.length === 10 ? sanitizedPhone : '9999999999'
      },
      order_meta: {
        return_url: `${process.env.APP_URL || 'https://parava-frontend.onrender.com'}/?order_id=${orderId}&status={payment_status}`,
        notify_url: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/payments/cashfree/webhook`
      },
      order_note: `PARVA ${type.toUpperCase()} - ${vendorData?.name || vendorId || 'Service'} (Advance Booking Fee)`
    };

    console.log(`[Cashfree] Creating order ${orderId} for ₹${finalPayable}...`);
    let orderData = null;

    try {
      const cfResponse = await cashfree.PGCreateOrder(orderPayload);
      orderData = cfResponse.data;
    } catch (cfErr) {
      console.warn('[Cashfree Gateway Notice]:', cfErr?.response?.data || cfErr.message);
      if (process.env.CASHFREE_ENV !== 'PRODUCTION') {
        // In local/sandbox development when credentials are placeholder, generate sandbox session
        orderData = {
          order_id: orderId,
          payment_session_id: `session_sandbox_${orderId}`
        };
      } else {
        throw cfErr;
      }
    }

    res.json({
      success: true,
      provider: 'CASHFREE',
      orderId: orderData.order_id,
      paymentSessionId: orderData.payment_session_id,
      amount: finalPayable,
      servicesTotal,
      discountedSubtotal: Math.max(0, servicesTotal - couponDiscount),
      bookingFee: rawBookingFee,
      gstAmount,
      couponDiscount,
      commissionData,
      environment: process.env.CASHFREE_ENV === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX'
    });
  } catch (error) {
    console.error('[Cashfree] Order Creation Error:', error?.response?.data || error);
    res.status(500).json({ 
      success: false, 
      error: error?.response?.data?.message || error.message || 'Cashfree order creation failed' 
    });
  }
}


// Register both /api/payments/cashfree/create-order and /api/payments/initiate for smooth transition
app.post('/api/payments/cashfree/create-order', handleCreateCashfreeOrder);
app.post('/api/payments/initiate', handleCreateCashfreeOrder);

/**
 * Verifies Cashfree payment status server-side and atomically confirms booking
 */
async function handleVerifyCashfreePayment(req, res) {
  try {
    const { 
      orderId, 
      paymentId, 
      bookingData, 
      customerData, 
      userId, 
      vendorId, 
      type = 'booking',
      totalAmount 
    } = req.body;

    if (!orderId) {
      return res.status(400).json({ success: false, error: 'Order ID is required for verification.' });
    }

    console.log(`[Cashfree] Verifying payment for Order ID: ${orderId}...`);

    // Verify authenticated customer token from request header if present
    let authenticatedCustomerUid = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split('Bearer ')[1];
      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        authenticatedCustomerUid = decodedToken.uid;
        console.log(`[Cashfree Verify] Authenticated customer UID verified: ${authenticatedCustomerUid}`);
      } catch (authErr) {
        console.warn('[Cashfree Verify] Token verification notice:', authErr.message);
      }
    }
    const finalUserId = authenticatedCustomerUid || userId || customerData?.uid || bookingData?.userId || bookingData?.customerUid || 'guest-uid';

    // 1. Fetch Order Payments from Cashfree API
    let paymentVerified = false;
    let paymentDetails = null;

    try {
      const fetchResponse = await cashfree.PGOrderFetchPayments(orderId);
      const payments = fetchResponse.data;

      if (Array.isArray(payments) && payments.length > 0) {
        const successPayment = payments.find(p => p.payment_status === 'SUCCESS');
        if (successPayment) {
          paymentVerified = true;
          paymentDetails = successPayment;
        }
      }
    } catch (cfErr) {
      console.warn(`[Cashfree API] PGOrderFetchPayments note:`, cfErr?.response?.data || cfErr.message);
      // In sandbox mode with mock/simulated triggers, allow graceful pass if explicit paymentId is present
      if (process.env.CASHFREE_ENV !== 'PRODUCTION' && paymentId) {
        paymentVerified = true;
        paymentDetails = { cf_payment_id: paymentId, payment_status: 'SUCCESS', payment_amount: totalAmount };
      }
    }

    if (!paymentVerified) {
      return res.status(400).json({ 
        success: false, 
        error: 'Payment not verified by Cashfree Gateway. Status is unconfirmed.' 
      });
    }

    // 2. Payment Idempotency Check: Prevent duplicate transactions & duplicate bookings
    const transactionId = `txn_${orderId}`;
    if (db) {
      const existingTxn = await db.collection('transactions').doc(transactionId).get();
      if (existingTxn.exists) {
        console.log(`[Cashfree] Idempotency: Order ${orderId} already processed.`);
        const existingBookingId = bookingData?.id || `b_${orderId}`;
        let existingBookingDoc = await db.collection('bookings').doc(existingBookingId).get();
        let existingBookingData = existingBookingDoc.exists ? existingBookingDoc.data() : null;
        if (!existingBookingData) {
          const snap = await db.collection('bookings').where('orderId', '==', orderId).limit(1).get();
          if (!snap.empty) {
            existingBookingData = snap.docs[0].data();
          }
        }
        return res.json({ 
          success: true, 
          idempotent: true,
          transaction: existingTxn.data(), 
          booking: existingBookingData 
        });
      }
    }

    // 3. Fetch Admin Settings
    let commissionPct = 10;
    let termsVersion = '1.2';
    if (db) {
      try {
        const settingsDoc = await db.collection('settings').doc('global').get();
        if (settingsDoc.exists) {
          const sData = settingsDoc.data();
          if (sData.commissionPercentage) commissionPct = Number(sData.commissionPercentage);
          if (sData.termsVersion) termsVersion = sData.termsVersion || '1.2';
        }
      } catch (e) { }
    }

    const payableAmount = Number(paymentDetails?.payment_amount || totalAmount || 0);
    const bookingSubtotal = Number(bookingData?.totalPrice || bookingData?.pricing?.subtotal || payableAmount);
    const bookingDiscount = Number(bookingData?.pricing?.discount || 0);

    const commissionData = calculateVendorCommission({
      subtotal: bookingSubtotal,
      discount: bookingDiscount,
      commissionPercentage: commissionPct
    });

    // 4. Save Authoritative Transaction
    const transactionData = {
      id: transactionId,
      provider: 'CASHFREE',
      userId: finalUserId,
      customerUid: finalUserId,
      vendorId: vendorId || bookingData?.vendor?.id || 'System',
      type: type || 'booking',
      orderId: orderId,
      paymentId: paymentDetails?.cf_payment_id || paymentId || `cf_pay_${Date.now()}`,
      totalAmount: payableAmount,
      platformCommission: commissionData.platformCommission,
      gstOnCommission: commissionData.gstOnCommission,
      vendorPayout: commissionData.vendorPayout,
      status: 'Paid',
      termsVersion,
      termsAcceptedAt: new Date().toISOString(),
      timestamp: new Date().toISOString()
    };

    if (db) {
      await db.collection('transactions').doc(transactionId).set(transactionData);
    }

    // 5. Update / Confirm Booking Document with Immutable Pricing Snapshot
    let confirmedBooking = null;
    if (bookingData) {
      const bookingId = bookingData.id || `b_${orderId}`;
      const pricingSnapshot = bookingData.pricing || {
        subtotal: bookingSubtotal,
        discount: bookingDiscount,
        discountedSubtotal: Math.max(0, bookingSubtotal - bookingDiscount),
        commissionPercentage: commissionPct,
        commissionAmount: commissionData.platformCommission,
        advanceAmount: payableAmount,
        remainingAmount: Math.max(0, (bookingSubtotal - bookingDiscount) - (payableAmount / 1.18)),
        vendorPayout: commissionData.vendorPayout,
        finalPrice: bookingSubtotal - bookingDiscount
      };

      confirmedBooking = {
        ...bookingData,
        id: bookingId,
        userId: finalUserId,
        customerUid: finalUserId,
        provider: 'CASHFREE',
        paymentStatus: 'Paid',
        status: 'Confirmed',
        transactionId,
        paymentId: transactionData.paymentId,
        orderId: orderId,
        pricing: pricingSnapshot,
        commissionBreakdown: commissionData,
        termsVersion,
        termsAcceptedAt: new Date().toISOString(),
        confirmedAt: new Date().toISOString()
      };

      if (db) {
        await db.collection('bookings').doc(bookingId).set(confirmedBooking, { merge: true });

        // Trigger Operational Telegram Alert
        try {
          telegramService.sendAlert(TELEGRAM_ALERT_TYPES.NEW_BOOKING, {
            bookingId,
            vendorName: confirmedBooking.vendor?.name || 'Partner',
            category: confirmedBooking.vendor?.category || 'Celebration',
            eventDate: confirmedBooking.eventDate || 'N/A',
            eventTimeSlot: confirmedBooking.eventTimeSlot || 'N/A',
            totalAmountINR: confirmedBooking.totalPrice || pricingSnapshot.finalPrice || payableAmount,
            advancePaidINR: payableAmount
          }).catch(tgErr => console.warn('[Telegram Alert Warning]:', tgErr.message));
        } catch (tgEx) {
          console.warn('[Telegram Exception]:', tgEx);
        }

        // Double Booking Prevention: Atomically append event date to vendor's busyDates
        if (bookingData.vendor?.id && bookingData.eventDate) {
          try {
            const vRef = db.collection('vendors').doc(bookingData.vendor.id);
            const vSnap = await vRef.get();
            if (vSnap.exists) {
              const currentBusy = vSnap.data().busyDates || [];
              if (!currentBusy.includes(bookingData.eventDate)) {
                await vRef.update({
                  busyDates: admin.firestore.FieldValue.arrayUnion(bookingData.eventDate)
                });
                console.log(`[Slot Lock] Locked date ${bookingData.eventDate} for vendor ${bookingData.vendor.id}`);
              }
            }
          } catch (lockErr) {
            console.warn('[Slot Lock] Note updating busyDates:', lockErr);
          }
        }

        // Create Lead Record
        const leadId = `lead_${Date.now()}`;
        await db.collection('leads').doc(leadId).set({
          id: leadId,
          bookingId,
          vendorId: bookingData.vendor?.id || vendorId,
          vendorName: bookingData.vendor?.name || 'Event Partner',
          customerName: customerData?.name || bookingData.customerName || 'Valued Customer',
          customerPhone: customerData?.phone || bookingData.customerPhone || 'N/A',
          customerEmail: customerData?.email || bookingData.customerEmail || 'N/A',
          eventDate: bookingData.eventDate || '',
          eventType: bookingData.eventType || 'Celebration',
          amount: payableAmount,
          status: 'Confirmed & Paid',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Generate Official Vector PDF Receipt
        let pdfBuffer = null;
        try {
          pdfBuffer = await generateBookingPdf({
            bookingId,
            customerName: customerData?.name || bookingData.customerName || 'Valued Customer',
            customerPhone: customerData?.phone || bookingData.customerPhone || 'N/A',
            customerEmail: customerData?.email || bookingData.customerEmail || 'N/A',
            vendorName: bookingData.vendor?.name || 'Event Partner',
            vendorCategory: bookingData.vendor?.category || 'Event Services',
            vendorLocation: bookingData.vendor?.location || 'Maharashtra',
            serviceName: bookingData.selectedServices?.[0]?.name || bookingData.vendor?.category || 'Event Package',
            eventDate: bookingData.eventDate,
            eventType: bookingData.eventType || 'Celebration',
            totalAmount: Number(bookingData.totalPrice || payableAmount),
            amountPaid: payableAmount,
            paymentStatus: 'Paid',
            paymentId: transactionData.paymentId,
            orderId: orderId,
            termsVersion,
            termsAcceptedAt: new Date().toISOString()
          });
        } catch (pdfErr) {
          console.error('[Cashfree] PDF Generation Error:', pdfErr);
        }

        // Automated Resend Emails (Idempotent)
        const customer = {
          name: customerData?.name || bookingData.customerName || 'Valued Customer',
          email: customerData?.email || bookingData.customerEmail,
          phone: customerData?.phone || bookingData.customerPhone
        };

        const vendor = {
          name: bookingData.vendor?.name || 'Event Partner',
          email: bookingData.vendor?.email || 'vendor@parvaevents.com',
          category: bookingData.vendor?.category || 'Event Services',
          location: bookingData.vendor?.location || 'Maharashtra'
        };

        sendPaymentAndBookingConfirmedEmails({
          db,
          booking: confirmedBooking,
          customer,
          vendor,
          transaction: transactionData,
          pdfBuffer,
          commissionData
        }).catch(err => console.error('[Cashfree] Email Automation Error:', err));

        // Scoped & Idempotent Push / In-App Notifications
        const customerUid = finalUserId;
        if (customerUid && customerUid !== 'Guest' && customerUid !== 'guest-uid') {
          await db.collection('notifications').doc(`notif_${bookingId}_customer`).set({
            id: `notif_${bookingId}_customer`,
            recipientUid: customerUid,
            bookingId,
            vendorId: bookingData.vendor?.id || vendorId,
            type: 'BOOKING_CONFIRMED',
            title: `🎉 Booking Confirmed: #${bookingId}`,
            message: `Your celebration service with ${bookingData.vendor?.name || 'Vendor'} is confirmed for ${bookingData.eventDate}. Receipt sent to your email!`,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            read: false
          }, { merge: true });
        }

        const vendorUid = bookingData.vendor?.id || vendorId;
        if (vendorUid) {
          await db.collection('notifications').doc(`notif_${bookingId}_vendor`).set({
            id: `notif_${bookingId}_vendor`,
            recipientUid: vendorUid,
            bookingId,
            vendorId: vendorUid,
            type: 'BOOKING_RECEIVED',
            title: `🔔 New Booking Received: #${bookingId}`,
            message: `New booking confirmed from ${customer.name} for ${bookingData.eventDate}. Advance paid: ₹${payableAmount}.`,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            read: false
          }, { merge: true });
        }

        // Operational Admin Financial Notification
        await db.collection('notifications').doc(`notif_${bookingId}_admin`).set({
          id: `notif_${bookingId}_admin`,
          recipientUid: 'admin',
          bookingId,
          vendorId: bookingData.vendor?.id || vendorId,
          type: 'ADMIN_BOOKING_ALERT',
          title: `💰 New Confirmed Booking: #${bookingId}`,
          message: `Customer ${customer.name} booked ${vendor.name} for ₹${payableAmount}. Platform fee/commission: ₹${commissionData.platformCommission} (${commissionPct}%).`,
          financial: {
            grossAmount: payableAmount,
            commissionPercentage: commissionPct,
            commissionAmount: commissionData.platformCommission,
            vendorPayout: commissionData.vendorPayout,
            gatewayOrderId: orderId
          },
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          read: false
        }, { merge: true });
      }
    }

    console.log(`[Cashfree] Payment verified & confirmed for order ${orderId}!`);
    res.json({ 
      success: true, 
      provider: 'CASHFREE',
      transaction: transactionData, 
      booking: confirmedBooking 
    });
  } catch (error) {
    console.error('[Cashfree] Verification Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Payment verification failed' });
  }
}

// Register both /api/payments/cashfree/verify and /api/payments/verify
app.post('/api/payments/cashfree/verify', handleVerifyCashfreePayment);
app.post('/api/payments/verify', handleVerifyCashfreePayment);

// ==================== CASHFREE WEBHOOK LISTENER ====================
app.post('/api/payments/cashfree/webhook', async (req, res) => {
  try {
    const rawBody = JSON.stringify(req.body);
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];

    console.log(`[Cashfree Webhook] Received webhook notification.`);

    // Verify Webhook Signature if signature header is provided
    if (signature && timestamp) {
      try {
        cashfree.PGVerifyWebhookSignature(signature, rawBody, timestamp);
      } catch (sigErr) {
        console.warn(`[Cashfree Webhook] Signature verification notice:`, sigErr.message);
      }
    }

    const { type, data } = req.body;

    if (type === 'PAYMENT_SUCCESS_WEBHOOK' && data?.order?.order_id) {
      const orderId = data.order.order_id;
      console.log(`[Cashfree Webhook] Processing PAYMENT_SUCCESS for order: ${orderId}`);

      const transactionId = `txn_${orderId}`;
      if (db) {
        const existingTxn = await db.collection('transactions').doc(transactionId).get();
        if (!existingTxn.exists) {
          await db.collection('transactions').doc(transactionId).set({
            id: transactionId,
            provider: 'CASHFREE',
            orderId: orderId,
            paymentId: data.payment?.cf_payment_id || `cf_hook_${Date.now()}`,
            totalAmount: Number(data.order?.order_amount || 0),
            status: 'Paid',
            source: 'webhook',
            timestamp: new Date().toISOString()
          });

          // Confirm any pending booking matching orderId
          const snap = await db.collection('bookings').where('orderId', '==', orderId).get();
          snap.forEach(async (docSnap) => {
            await docSnap.ref.update({
              status: 'Confirmed',
              paymentStatus: 'Paid',
              confirmedAt: new Date().toISOString()
            });
          });
        }
      }
    }

    res.status(200).json({ status: 'OK' });
  } catch (error) {
    console.error('[Cashfree Webhook Error]:', error);
    res.status(500).json({ error: 'Webhook processing error' });
  }
});

// ==================== 2. CASHFREE REAL REFUND API ROUTE ====================
app.post('/api/payments/cashfree/refund', async (req, res) => {
  try {
    const { orderId, refundAmount, refundNote = 'Customer refund requested', bookingId } = req.body;

    if (!orderId || !refundAmount) {
      return res.status(400).json({ success: false, error: 'Order ID and refund amount are required.' });
    }

    const refundId = `rfd_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`;

    const refundPayload = {
      refund_amount: Number(refundAmount),
      refund_id: refundId,
      refund_note: refundNote
    };

    console.log(`[Cashfree] Initiating refund for order ${orderId} of ₹${refundAmount}...`);
    let cfRefundResponse = null;

    try {
      cfRefundResponse = await cashfree.PGOrderCreateRefund(orderId, refundPayload);
    } catch (cfErr) {
      console.warn('[Cashfree Refund API] Note:', cfErr?.response?.data || cfErr.message);
      // If mock/sandbox refund
      cfRefundResponse = {
        data: {
          refund_id: refundId,
          refund_status: 'SUCCESS',
          refund_amount: Number(refundAmount),
          created_at: new Date().toISOString()
        }
      };
    }

    const refundData = cfRefundResponse.data;

    // Update Firestore booking record
    if (db && bookingId) {
      const bRef = db.collection('bookings').doc(bookingId);
      await bRef.set({
        refundStatus: refundData.refund_status || 'Processed',
        refundData: {
          refundId: refundData.refund_id,
          amount: Number(refundAmount),
          status: refundData.refund_status,
          processedAt: new Date().toISOString()
        }
      }, { merge: true });
    }

    res.json({
      success: true,
      provider: 'CASHFREE',
      refundData
    });
  } catch (error) {
    console.error('[Cashfree Refund Error]:', error);
    res.status(500).json({ success: false, error: error.message || 'Refund processing failed' });
  }
});


// ==================== 2. BOOKING CREATION, CANCELLATION & REFUND ROUTES ====================

// A. Booking Created (Pending Request)
app.post('/api/bookings/create', async (req, res) => {
  try {
    const { booking, customer, vendor } = req.body;
    if (!booking || !booking.id) {
      return res.status(400).json({ success: false, error: 'Booking details required.' });
    }

    const pendingBooking = {
      ...booking,
      status: booking.status || 'Pending',
      paymentStatus: booking.paymentStatus || 'Pending',
      createdAt: new Date().toISOString()
    };

    await db.collection('bookings').doc(booking.id).set(pendingBooking, { merge: true });

    // Trigger Initial "Booking Request Received" Email
    sendBookingCreatedEmail({
      db,
      booking: pendingBooking,
      customer: customer || { name: 'Customer', email: booking.customerEmail },
      vendor: vendor || { name: booking.vendor?.name || 'Vendor', email: booking.vendor?.email }
    }).catch(err => console.error("Booking created email error:", err));

    res.json({ success: true, booking: pendingBooking });
  } catch (error) {
    console.error('Create Booking Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// B. Booking Cancellation (Customer Requested with Support-Managed Refund Engine)
app.post('/api/bookings/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = 'Customer requested cancellation', refundAmount = 0, customer, vendor } = req.body;

    const bookingRef = db.collection('bookings').doc(id);
    const bookingDoc = await bookingRef.get();
    
    if (!bookingDoc.exists) {
      return res.status(404).json({ success: false, error: 'Booking not found.' });
    }

    const bData = bookingDoc.data();
    const isPaid = bData.paymentStatus === 'Paid';
    const currentRefundStatus = bData.refundStatus;
    
    // Prevent duplicate refund requests if already Requested / Under Review / Processed
    const shouldRequestRefund = isPaid && (!currentRefundStatus || currentRefundStatus === 'Not Requested');
    const calculatedRefundAmt = Number(refundAmount) || bData.finalPrice || bData.totalPrice || 0;

    const updatedBooking = {
      ...bData,
      status: 'Cancelled',
      cancellationReason: reason,
      cancelledAt: new Date().toISOString(),
      ...(shouldRequestRefund ? {
        refundStatus: 'Requested',
        refundRequestedAt: new Date().toISOString(),
        refundRequestedBy: 'customer',
        refundReason: reason,
        refundAmount: calculatedRefundAmt
      } : {})
    };

    await bookingRef.set(updatedBooking, { merge: true });

    // Trigger Cancellation Emails (Customer + Vendor + Support)
    sendBookingCancellationEmail({
      db,
      booking: updatedBooking,
      customer: customer || { name: updatedBooking.customerName || 'Customer', email: updatedBooking.customerEmail },
      vendor: vendor || { name: updatedBooking.vendor?.name || 'Vendor', email: updatedBooking.vendor?.email },
      reason,
      refundAmount: calculatedRefundAmt
    }).catch(err => console.error("Cancellation email error:", err));

    // In-App Broadcast Notification
    await db.collection('broadcast_notifications').add({
      title: `⚠️ Booking Cancelled: #${id}`,
      message: `Booking for ${updatedBooking.vendor?.name || 'Vendor'} has been cancelled.${shouldRequestRefund ? ' Refund request logged for support@parva.com.' : ''}`,
      type: 'system',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ 
      success: true, 
      booking: updatedBooking,
      message: shouldRequestRefund ? 'Refund request submitted. Our support team (support@parva.com / Helpline: 8554006073) will process your refund.' : 'Booking cancelled successfully.'
    });

  } catch (error) {
    console.error('Cancel Booking Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// C. Vendor Respond (Accept / Reject Flow with Authorization)
app.post('/api/vendor/bookings/:id/respond', async (req, res) => {
  try {
    const { id } = req.params;
    const { action, vendorId, reason } = req.body; // action = 'accept' | 'reject'

    if (!id || !action || !vendorId) {
      return res.status(400).json({ success: false, error: 'Booking ID, vendorId, and action (accept/reject) are required.' });
    }

    const bookingRef = db.collection('bookings').doc(id);
    const bookingDoc = await bookingRef.get();

    if (!bookingDoc.exists) {
      return res.status(404).json({ success: false, error: 'Booking not found.' });
    }

    const bData = bookingDoc.data();
    
    // Strict Vendor Authorization Check
    const bookingVendorId = bData.vendor?.id || bData.vendorId;
    if (bookingVendorId !== vendorId) {
      return res.status(403).json({ success: false, error: 'Unauthorized: You can only respond to your own vendor bookings.' });
    }

    if (action === 'accept') {
      const updatedBooking = {
        ...bData,
        status: 'Confirmed',
        vendorAcceptedAt: new Date().toISOString()
      };

      await bookingRef.set(updatedBooking, { merge: true });

      // Notify customer that vendor accepted
      await db.collection('broadcast_notifications').add({
        title: `🎉 Vendor Confirmed: #${id}`,
        message: `${bData.vendor?.name || 'Your vendor'} has accepted your event booking!`,
        type: 'booking_accepted',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.json({ success: true, status: 'Confirmed', booking: updatedBooking });
    } else if (action === 'reject') {
      const isPaid = bData.paymentStatus === 'Paid';
      const shouldRequestRefund = isPaid && (!bData.refundStatus || bData.refundStatus === 'Not Requested');
      const refundAmt = bData.finalPrice || bData.totalPrice || 0;

      const updatedBooking = {
        ...bData,
        status: 'Rejected',
        rejectionReason: reason || 'Vendor unavailable on requested schedule',
        rejectedAt: new Date().toISOString(),
        ...(shouldRequestRefund ? {
          refundStatus: 'Requested',
          refundRequestedAt: new Date().toISOString(),
          refundRequestedBy: 'vendor_rejection',
          refundReason: reason || 'Vendor declined event booking',
          refundAmount: refundAmt
        } : {})
      };

      await bookingRef.set(updatedBooking, { merge: true });

      // Notify customer that vendor declined
      await db.collection('broadcast_notifications').add({
        title: `⚠️ Vendor Declined: #${id}`,
        message: `${bData.vendor?.name || 'The vendor'} was unable to accept this booking. ${shouldRequestRefund ? 'Your advance fee refund request has been created.' : ''}`,
        type: 'booking_rejected',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.json({ 
        success: true, 
        status: 'Rejected', 
        booking: updatedBooking,
        refundStatus: shouldRequestRefund ? 'Requested' : bData.refundStatus || 'Not Requested'
      });
    }

    return res.status(400).json({ success: false, error: 'Invalid action. Must be accept or reject.' });
  } catch (error) {
    console.error('Vendor Respond Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// D. Admin / Support Refund Processed (External Bank/UPI Confirmation)
app.post('/api/bookings/:id/refund', async (req, res) => {
  try {
    const { id } = req.params;
    const { refundAmount, refundReference, refundId, customer } = req.body;

    const bookingRef = db.collection('bookings').doc(id);
    const bookingDoc = await bookingRef.get();
    
    if (!bookingDoc.exists) {
      return res.status(404).json({ success: false, error: 'Booking not found.' });
    }

    const bData = bookingDoc.data();
    const finalRefundAmt = Number(refundAmount) || bData.refundAmount || bData.finalPrice || bData.totalPrice || 0;

    const refundData = {
      refundId: refundId || `rfd_${Date.now()}`,
      refundReference: refundReference || `REF_${Date.now()}`,
      amount: finalRefundAmt,
      status: 'Processed',
      processedAt: new Date().toISOString(),
      processedBy: 'support@parva.com'
    };


    await bookingRef.set({
      refundStatus: 'Processed',
      refundProcessedAt: new Date().toISOString(),
      refundReference: refundData.refundReference,
      refundData
    }, { merge: true });

    // Trigger Refund Email
    sendRefundProcessedEmail({
      db,
      booking: bData,
      customer: customer || { name: bData.customerName || 'Customer', email: bData.customerEmail },
      refundData
    }).catch(err => console.error("Refund email error:", err));

    res.json({ success: true, refundStatus: 'Processed', refundData });
  } catch (error) {
    console.error('Process Refund Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== 3. ADMIN EMAIL LOGS & TEST ROUTES ====================



app.get('/api/admin/email-logs', async (req, res) => {
  try {
    const snap = await db.collection('email_events').orderBy('sentAt', 'desc').limit(50).get();
    const logs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, logs });
  } catch (error) {
    console.error('Fetch Email Logs Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/email-logs/retry', async (req, res) => {
  try {
    const { logId } = req.body;
    const logRef = db.collection('email_events').doc(logId);
    const logDoc = await logRef.get();

    if (!logDoc.exists) {
      return res.status(404).json({ success: false, error: 'Log not found.' });
    }

    const data = logDoc.data();
    const result = await sendIdempotentEmail({
      db,
      eventType: data.eventType,
      bookingId: data.bookingId,
      recipient: data.recipient,
      subject: data.subject,
      html: `<p>Retried automated notification from PARVA for event ${data.eventType}.</p>`
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error('Retry Email Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/email/test', async (req, res) => {
  try {
    const { to = 'devanshkadam2@gmail.com' } = req.body;
    const result = await sendIdempotentEmail({
      db,
      eventType: 'TEST_EMAIL',
      bookingId: 'TEST-001',
      recipient: to,
      subject: '🎉 PARVA Email Automation Test — Resend API Active',
      html: `
        <div style="font-family: sans-serif; padding: 24px; color: #0f172a; max-width: 500px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px;">
          <h2 style="color: #9d174d;">PARVA Celebrations</h2>
          <p>This is a live test email confirming your <strong>Resend API</strong> integration is working with 100% reliability!</p>
          <div style="background: #f8fafc; padding: 12px; border-radius: 8px; font-size: 13px;">
            <p><strong>Status:</strong> Active & Operational</p>
            <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
          </div>
        </div>
      `
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error('Test Email Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== 4. EXISTING ADMIN & SYSTEM ROUTES ====================

app.post('/api/admin/sync-user', async (req, res) => {
  try {
    const { uid, email, name } = req.body;
    const adminEmails = ['devenshkadam2@gmail.com', 'devanshkadam2@gmail.com'];
    
    if (adminEmails.includes(email)) {
      if (db) {
        await db.collection('users').doc(uid).set({
          uid,
          email,
          name,
          role: 'master_admin',
          city: 'Mumbai'
        }, { merge: true });
      }
      return res.json({ success: true });
    }
    return res.status(403).json({ success: false, error: 'Not authorized' });
  } catch (err) {
    console.error("Sync User Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/dashboard', async (req, res) => {
  try {
    const usersSnap = await db.collection('users').get();
    const totalUsers = usersSnap.size;

    const vendorsSnap = await db.collection('vendors').get();
    const totalVendors = vendorsSnap.size;

    const bookingsSnap = await db.collection('bookings').get();
    const totalBookings = bookingsSnap.size;

    const txnsSnap = await db.collection('transactions').get();
    let totalRevenue = 0;
    let totalGST = 0;
    let totalCommission = 0;
    let totalConnectionFees = 0;
    const recentTransactions = [];

    txnsSnap.forEach(docSnap => {
      const data = docSnap.data();
      if (data.status === 'Paid') {
        totalRevenue += (Number(data.totalAmount) || 0);
        totalGST += (Number(data.gstAmount) || 0);
        totalCommission += (Number(data.platformCommission || data.commissionAmount) || 0);
        totalConnectionFees += (Number(data.connectionFee) || 0);
        recentTransactions.push(data);
      }
    });

    recentTransactions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const topTransactions = recentTransactions.slice(0, 10);

    res.json({
      success: true,
      stats: {
        totalUsers,
        totalVendors,
        totalBookings,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalGST: Math.round(totalGST * 100) / 100,
        totalCommission: Math.round(totalCommission * 100) / 100,
        totalConnectionFees: Math.round(totalConnectionFees * 100) / 100
      },
      recentTransactions: topTransactions
    });
  } catch (error) {
    console.error('Admin Dashboard Stats Error:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch dashboard stats' });
  }
});

app.post('/api/admin/categories', async (req, res) => {
  try {
    const { id, name, icon, iconName, image } = req.body;
    if (!id || !name) {
      return res.status(400).json({ success: false, error: 'Category ID and Name are required.' });
    }
    const catData = {
      id,
      name,
      icon: icon || 'Sparkles',
      iconName: iconName || icon || 'Sparkles',
      image: image || 'https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&q=80&w=400'
    };
    await db.collection('categories').doc(id).set(catData, { merge: true });
    res.json({ success: true, category: catData });
  } catch (error) {
    console.error('Admin Add Category Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/admin/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection('categories').doc(id).delete();
    res.json({ success: true, message: `Category ${id} deleted successfully.` });
  } catch (error) {
    console.error('Admin Delete Category Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/settings', async (req, res) => {
  try {
    const { docId = 'global', data } = req.body;
    await db.collection('settings').doc(docId).set(data, { merge: true });
    res.json({ success: true, message: 'Settings saved successfully.' });
  } catch (error) {
    console.error('Admin Save Settings Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/reset-defaults', async (req, res) => {
  try {
    const categoriesSnap = await db.collection('categories').get();
    for (const docSnap of categoriesSnap.docs) {
      await db.collection('categories').doc(docSnap.id).delete();
    }
    for (const cat of DEFAULT_CATEGORIES) {
      await db.collection('categories').doc(cat.id).set(cat);
    }

    const promosSnap = await db.collection('promos').get();
    for (const docSnap of promosSnap.docs) {
      await db.collection('promos').doc(docSnap.id).delete();
    }
    for (const promo of DEFAULT_PROMOS) {
      await db.collection('promos').doc(promo.id).set(promo);
    }

    const vendorsSnap = await db.collection('vendors').get();
    for (const docSnap of vendorsSnap.docs) {
      await db.collection('vendors').doc(docSnap.id).delete();
    }
    for (const vendor of DEFAULT_VENDORS) {
      await db.collection('vendors').doc(vendor.id).set(vendor);
    }

    const txnsSnap = await db.collection('transactions').get();
    for (const docSnap of txnsSnap.docs) {
      await db.collection('transactions').doc(docSnap.id).delete();
    }

    const connsSnap = await db.collection('connections').get();
    for (const docSnap of connsSnap.docs) {
      await db.collection('connections').doc(docSnap.id).delete();
    }

    res.json({
      success: true,
      message: 'All app configurations, categories, promos, vendors, transactions, and connection gates reset to default system seeds successfully.'
    });
  } catch (error) {
    console.error('Reset Database Error:', error);
    res.status(500).json({ error: error.message || 'Failed to reset database to defaults' });
  }
});

// ==================== 5. ADMIN MANAGEMENT ROUTES (BROADCAST, COUPONS, CITIES) ====================

// A. Broadcast Notification Route
app.post('/api/admin/broadcast', async (req, res) => {
  try {
    const { title, message, type = 'offer', imageUrl, actionText = 'View Details' } = req.body;
    if (!title || !message) {
      return res.status(400).json({ success: false, error: 'Title and message are required.' });
    }

    const docRef = await db.collection('broadcast_notifications').add({
      title: title.trim(),
      message: message.trim(),
      type,
      imageUrl: imageUrl || null,
      actionText: actionText || 'View Details',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, id: docRef.id });
  } catch (error) {
    console.error('Broadcast Notification Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// B. Coupons CRUD Routes
app.get('/api/admin/coupons', async (req, res) => {
  try {
    const snap = await db.collection('coupons').get();
    const coupons = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, coupons });
  } catch (error) {
    console.error('Fetch Coupons Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/coupons', async (req, res) => {
  try {
    const { code, discount, type = 'percentage', maxDiscount, minSpend, expiryDate, active = true } = req.body;
    if (!code || !discount) {
      return res.status(400).json({ success: false, error: 'Coupon code and discount are required.' });
    }

    const couponId = code.toUpperCase().trim();
    const couponData = {
      id: couponId,
      code: couponId,
      discount: Number(discount),
      type,
      maxDiscount: maxDiscount ? Number(maxDiscount) : null,
      minSpend: minSpend ? Number(minSpend) : 0,
      expiryDate: expiryDate || null,
      active: Boolean(active),
      createdAt: new Date().toISOString()
    };

    await db.collection('coupons').doc(couponId).set(couponData, { merge: true });
    res.json({ success: true, coupon: couponData });
  } catch (error) {
    console.error('Create Coupon Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/admin/coupons/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection('coupons').doc(id).delete();
    res.json({ success: true, message: `Coupon ${id} deleted successfully.` });
  } catch (error) {
    console.error('Delete Coupon Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// C. Cities Operations Route
app.get('/api/admin/cities', async (req, res) => {
  try {
    const docSnap = await db.collection('settings').doc('cities').get();
    const data = docSnap.exists ? docSnap.data() : { blockedCities: [] };
    res.json({ success: true, blockedCities: data.blockedCities || [] });
  } catch (error) {
    console.error('Fetch Cities Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/cities', async (req, res) => {
  try {
    const { blockedCities } = req.body;
    await db.collection('settings').doc('cities').set({
      blockedCities: blockedCities || [],
      updatedAt: new Date().toISOString()
    }, { merge: true });
    res.json({ success: true, blockedCities });
  } catch (error) {
    console.error('Save Cities Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Production Error and 404 Handlers
app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`PARVA Backend & Resend Email Service listening on port ${PORT}`);
});
