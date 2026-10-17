import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import admin from 'firebase-admin';
import { DEFAULT_CATEGORIES, DEFAULT_OPERATIONAL_CITIES, DEFAULT_PROMOS, DEFAULT_VENDORS } from './seedData.js';
import { generateBookingPdf } from './services/pdfService.js';
import { calculateBookingPrice, calculateCartQuote } from './services/pricingEngine.js';
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
  sendIdempotentEmail,
  sendOtpVerificationEmail,
  sendVendorKycStatusEmail,
  initEmailServiceFromDb,
  isResendConfigured,
  getMaskedResendApiKey,
  setDynamicResendApiKey,
  verifyResendHealth
} from './services/emailService.js';
import { validateEmail, validateIndianPhone } from './utils/validators.js';
import { requestIdMiddleware, securityHeadersMiddleware, rateLimiter, structuredLogger } from './middleware/securityMiddleware.js';
import { verifyAuth, verifyOptionalAuth, requireAdmin, requireVendor } from './middleware/authMiddleware.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

dotenv.config();

// Validate required configuration at startup
function validateStartupEnvironment() {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && (!process.env.CASHFREE_APP_ID || !process.env.CASHFREE_SECRET_KEY)) {
    console.error('[CRITICAL] Missing Cashfree payment credentials (CASHFREE_APP_ID, CASHFREE_SECRET_KEY) in production.');
    process.exit(1);
  }
}
validateStartupEnvironment();

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

if (db) {
  initEmailServiceFromDb(db).catch(err => console.warn('[EmailService] DB Init Notice:', err.message));
}

// Initialize Cashfree Payments PG SDK with sanitized environment variables
import { Cashfree, CFEnvironment } from 'cashfree-pg';

const cashfree = new Cashfree(
  process.env.CASHFREE_ENV === 'PRODUCTION' ? CFEnvironment.PRODUCTION : CFEnvironment.SANDBOX,
  process.env.CASHFREE_APP_ID || '',
  process.env.CASHFREE_SECRET_KEY || ''
);
cashfree.XApiVersion = process.env.CASHFREE_API_VERSION || '2023-08-01';

console.log(`[Cashfree] Initialized in ${process.env.CASHFREE_ENV === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX'} mode (API Version: ${cashfree.XApiVersion}). Client ID: ${cashfree.XClientId ? cashfree.XClientId.substring(0, 8) + '...' : 'None'}`);

// Initialize Cloudinary SDK with environment variables
let cloudinaryCloudName = process.env.CLOUDINARY_CLOUD_NAME;
let cloudinaryApiKey = process.env.CLOUDINARY_API_KEY;
let cloudinaryApiSecret = process.env.CLOUDINARY_API_SECRET;

// Auto-parse CLOUDINARY_URL if individual vars not provided
if ((!cloudinaryCloudName || !cloudinaryApiKey || !cloudinaryApiSecret) && process.env.CLOUDINARY_URL) {
  try {
    const parsed = new URL(process.env.CLOUDINARY_URL);
    cloudinaryCloudName = parsed.hostname;
    cloudinaryApiKey = parsed.username;
    cloudinaryApiSecret = parsed.password;
  } catch (_) {}
}

const isCloudinaryConfigured = Boolean(cloudinaryCloudName && cloudinaryApiKey && cloudinaryApiSecret);

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: cloudinaryCloudName,
    api_key: cloudinaryApiKey,
    api_secret: cloudinaryApiSecret
  });
  console.log(`[Cloudinary] Initialized CDN with Cloud Name: ${cloudinaryCloudName} (API Key: ${cloudinaryApiKey.substring(0, 6)}...)`);
} else {
  console.warn('[Cloudinary Warning] Cloudinary media credentials not provided in environment. Media uploads will fail safely.');
}

const app = express();

// Secure CORS - Allow local frontend, vendor app, admin portal, and deployed origins
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5000',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  process.env.APP_URL,
  process.env.VENDOR_APP_URL,
  process.env.ADMIN_APP_URL,
  'https://parava-frontend.onrender.com',
  'https://parva-vendor-app.onrender.com',
  'https://parva-admin.onrender.com',
  'https://myparva.com',
  'https://www.myparva.com'
].filter(Boolean);

app.use(requestIdMiddleware);
app.use(securityHeadersMiddleware);
app.use(structuredLogger);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.onrender.com') || origin.endsWith('.vercel.app') || origin.endsWith('myparva.com')) {
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

app.use(express.json({ 
  limit: '100mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

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

// ==================== CLOUDINARY DIRECT UPLOAD ROUTE (IMAGE & VIDEO) ====================
app.post(['/api/upload/image', '/api/upload/media'], rateLimiter({ windowMs: 60 * 1000, maxRequests: 50 }), verifyAuth, async (req, res) => {
  try {
    if (!isCloudinaryConfigured) {
      return res.status(503).json({
        success: false,
        error: 'Cloudinary media storage is not configured on this server.'
      });
    }

    const { image, media, folder = 'parva_vendors', resource_type } = req.body;
    const mediaPayload = image || media;
    if (!mediaPayload) {
      return res.status(400).json({ success: false, error: 'No media data provided.' });
    }

    const isVideo = resource_type === 'video' || 
                    (typeof mediaPayload === 'string' && (mediaPayload.startsWith('data:video/') || mediaPayload.includes('video/mp4') || mediaPayload.includes('video/webm')));

    const uploadOptions = {
      folder,
      resource_type: isVideo ? 'video' : 'image'
    };

    if (!isVideo) {
      uploadOptions.format = 'webp';
      uploadOptions.quality = 'auto:good';
      uploadOptions.fetch_format = 'auto';
    }

    const uploadResponse = await cloudinary.uploader.upload(mediaPayload, uploadOptions);

    console.log(`[Cloudinary] Successfully uploaded ${isVideo ? 'video' : 'image'}: ${uploadResponse.secure_url}`);
    res.json({
      success: true,
      url: uploadResponse.secure_url,
      public_id: uploadResponse.public_id,
      format: uploadResponse.format,
      resource_type: uploadResponse.resource_type || (isVideo ? 'video' : 'image'),
      bytes: uploadResponse.bytes
    });
  } catch (error) {
    console.error('Cloudinary Upload Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Media upload failed' });
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
    let authoritativePricingSnapshot = null;

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


      // 2. Authoritative Price & Quote Calculation via Pricing Engine
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

      // 3. Fetch Admin Global Settings (Booking Fee % and Commission %)
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

      // 4. Fetch Coupon from DB
      let couponRecord = null;
      if (couponCode && db) {
        try {
          const cleanCode = String(couponCode).trim().toUpperCase();
          const couponDoc = await db.collection('coupons').doc(cleanCode).get();
          if (couponDoc.exists) {
            couponRecord = couponDoc.data();
          }
        } catch (e) {
          console.warn("[Cashfree Order] Coupon fetch error:", e);
        }
      }

      // Build cart lines for authoritative quote engine
      let cartLines = [];
      if (Array.isArray(selectedServices) && selectedServices.length > 0) {
        cartLines = selectedServices.map(s => ({
          vendor: vendorData || { id: vendorId, category: vendorData?.category || 'General' },
          service: s,
          guestCount: planningGuestSize || 100,
          quantity: s.quantity || 1,
          eventDate,
          eventTimeSlot
        }));
      } else {
        cartLines = [{
          vendor: vendorData || { id: vendorId, category: vendorData?.category || 'General' },
          service: {
            id: 'base_service',
            name: vendorData?.category || 'Celebration Service',
            basePrice: vendorData?.basePrice || 5000,
            basePlatePrice: vendorData?.basePrice || 500
          },
          guestCount: planningGuestSize || 100,
          quantity: 1,
          eventDate,
          eventTimeSlot
        }];
      }

      const authoritativeQuote = calculateCartQuote({
        cartItems: cartLines,
        coupon: couponRecord,
        commissionPercentage: commissionPct,
        bookingFeePercentage: bookingFeePct
      });

      servicesTotal = authoritativeQuote.servicesTotal;
      couponDiscount = authoritativeQuote.couponDiscount;
      rawBookingFee = authoritativeQuote.platformFee;
      gstAmount = authoritativeQuote.taxGst;
      finalPayable = authoritativeQuote.finalAdvanceDue;
      authoritativePricingSnapshot = authoritativeQuote;
    } else {
      return res.status(400).json({ success: false, error: 'Invalid payment type requested.' });
    }

    // 4. Calculate Protected Commission Breakdown with Dynamic Admin Commission
    const commissionData = calculateVendorCommission({
      subtotal: servicesTotal,
      discount: couponDiscount,
      commissionPercentage: commissionPct
    });

    // 5. Generate Deterministic Cashfree Order with Verified Customer Identity
    const finalUserId = req.user?.uid;
    if (!finalUserId) {
      return res.status(401).json({ success: false, error: 'Authentication required. Please sign in to create a booking order.' });
    }
    const sanitizedPhone = String(customerPhone).replace(/\D/g, '').slice(-10) || '9999999999';
    const sanitizedCustomerId = String(finalUserId).replace(/[^a-zA-Z0-9_-]/g, '_');

    const reqOrigin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
    const frontendBase = reqOrigin || process.env.APP_URL || 'https://myparva.com';
    const cleanFrontendBase = frontendBase.replace(/\/+$/, '');
    const returnUrl = `${cleanFrontendBase}/payment/return?order_id={order_id}`;

    const backendBase = process.env.BACKEND_URL || (process.env.NODE_ENV === 'production' ? 'https://parava-backend.onrender.com' : 'http://localhost:5000');
    // Cashfree PG rejects localhost notify_url; only pass notify_url if it is an external/https URL
    const notifyUrl = backendBase.startsWith('http://localhost') ? undefined : `${backendBase.replace(/\/+$/, '')}/api/payments/cashfree/webhook`;

    const orderPayload = {
      order_id: orderId,
      order_amount: finalPayable,
      order_currency: 'INR',
      customer_details: {
        customer_id: sanitizedCustomerId,
        customer_name: customerName || 'Parva Customer',
        customer_email: (req.user?.email || customerEmail) && (req.user?.email || customerEmail).includes('@') ? (req.user?.email || customerEmail) : 'customer@parvaevents.com',
        customer_phone: sanitizedPhone.length === 10 ? sanitizedPhone : '9999999999'
      },
      order_meta: {
        return_url: returnUrl,
        ...(notifyUrl ? { notify_url: notifyUrl } : {})
      },
      order_note: `PARVA ${type.toUpperCase()} - ${vendorData?.name || vendorId || 'Service'} (Advance Booking Fee)`
    };

    console.log(`[PARVA_PAYMENT_CREATE] orderId=${orderId} userUid=${finalUserId} amount=${finalPayable} env=${process.env.CASHFREE_ENV || 'SANDBOX'}`);
    let orderData = null;

    try {
      const cfResponse = await cashfree.PGCreateOrder(orderPayload);
      orderData = cfResponse.data;
    } catch (cfErr) {
      const errMsg = cfErr?.response?.data?.message || cfErr.message || 'Cashfree gateway error';
      console.error(`[PARVA_PAYMENT_FAILED] orderId=${orderId} reason="${errMsg}"`);
      return res.status(502).json({
        success: false,
        error: `Payment session could not be established: ${errMsg}. Please try again.`
      });
    }

    if (!orderData || !orderData.payment_session_id) {
      console.error(`[PARVA_PAYMENT_FAILED] orderId=${orderId} reason="Missing payment_session_id from Cashfree"`);
      return res.status(502).json({
        success: false,
        error: 'Cashfree did not return an active payment session. Please retry.'
      });
    }

    // Persist pending order draft for authoritative payment verification on return or webhook
    if (db) {
      try {
        await db.collection('pending_orders').doc(orderId).set({
          orderId,
          userId: finalUserId,
          customerUid: finalUserId,
          vendorId: vendorId || vendorData?.id || 'system',
          vendorName: vendorData?.name || 'Event Partner',
          vendorCategory: vendorData?.category || 'Event Services',
          vendorLocation: vendorData?.location || 'Maharashtra',
          type,
          selectedServices: selectedServices || [],
          bundledItems: req.body.bundledItems || [],
          planningGuestSize,
          couponCode: couponCode || null,
          customerDetails: {
            name: customerName,
            phone: sanitizedPhone,
            email: req.user?.email || customerEmail,
            age: req.body.customerAge || '',
            address: req.body.eventLocationAddress || '',
            coords: req.body.eventLocationCoords || null,
            styleSuggestions: req.body.styleSuggestions || ''
          },
          eventDate,
          eventTimeSlot,
          servicesTotal,
          rawBookingFee,
          gstAmount,
          couponDiscount,
          finalPayable,
          commissionData,
          pricing: authoritativePricingSnapshot,
          quote: authoritativePricingSnapshot,
          status: 'PENDING_PAYMENT',
          createdAt: new Date().toISOString()
        });
      } catch (saveErr) {
        console.warn(`[Cashfree Order] Note saving pending_orders draft for ${orderId}:`, saveErr.message);
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
      quote: authoritativePricingSnapshot,
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

/**
 * Authoritative Pricing & Quote Endpoint: POST /api/pricing/quote
 * Computes deterministic, integer-paise financial quote for single or multi-item carts.
 */
async function handleCalculateQuote(req, res) {
  try {
    const { 
      items = [], 
      selectedServices = [], 
      vendorId, 
      planningGuestSize = 100, 
      guestCount,
      couponCode,
      eventDate = '',
      eventTimeSlot = 'evening'
    } = req.body;

    let rawItems = Array.isArray(items) && items.length > 0 ? items : [];
    if (rawItems.length === 0 && Array.isArray(selectedServices) && selectedServices.length > 0) {
      rawItems = selectedServices.map(s => ({
        vendorId: s.vendorId || vendorId,
        service: s,
        guestCount: s.guestCount || guestCount || planningGuestSize || 100,
        quantity: s.quantity || 1,
        eventDate: s.eventDate || eventDate,
        eventTimeSlot: s.eventTimeSlot || eventTimeSlot
      }));
    }

    if (rawItems.length === 0 && vendorId) {
      rawItems = [{
        vendorId,
        service: { id: 'base_package', name: 'Base Package' },
        guestCount: guestCount || planningGuestSize || 100,
        quantity: 1,
        eventDate,
        eventTimeSlot
      }];
    }

    if (rawItems.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one item is required to calculate a quote.' });
    }

    let bookingFeePct = 5;
    let commissionPct = 10;

    if (db) {
      try {
        const settingsDoc = await db.collection('settings').doc('global').get();
        if (settingsDoc.exists) {
          const sData = settingsDoc.data();
          if (sData.bookingFeePercentage !== undefined) bookingFeePct = Number(sData.bookingFeePercentage);
          if (sData.commissionPercentage !== undefined) commissionPct = Number(sData.commissionPercentage);
        }
      } catch (e) {}
    }

    const hydratedCartItems = [];
    for (const rawItem of rawItems) {
      const vId = rawItem.vendorId || rawItem.vendor?.id || vendorId;
      let vendorRecord = rawItem.vendor || null;

      if (!vendorRecord && vId && db) {
        try {
          const vDoc = await db.collection('vendors').doc(vId).get();
          if (vDoc.exists) vendorRecord = { id: vDoc.id, ...vDoc.data() };
        } catch (e) {}
      }

      hydratedCartItems.push({
        vendor: vendorRecord || { id: vId || 'system', category: 'General' },
        service: rawItem.service || { basePrice: vendorRecord?.basePrice || 5000 },
        selectedPackage: rawItem.selectedPackage || null,
        selectedAddons: rawItem.selectedAddons || [],
        guestCount: rawItem.guestCount || guestCount || planningGuestSize || 100,
        quantity: rawItem.quantity || 1,
        extraHours: rawItem.extraHours || 0,
        durationDays: rawItem.durationDays || 1,
        eventDate: rawItem.eventDate || eventDate,
        eventTimeSlot: rawItem.eventTimeSlot || eventTimeSlot
      });
    }

    let couponRecord = null;
    if (couponCode && db) {
      try {
        const cleanCode = String(couponCode).trim().toUpperCase();
        const cDoc = await db.collection('coupons').doc(cleanCode).get();
        if (cDoc.exists) {
          couponRecord = cDoc.data();
        }
      } catch (e) {}
    }

    const quote = calculateCartQuote({
      cartItems: hydratedCartItems,
      coupon: couponRecord,
      commissionPercentage: commissionPct,
      bookingFeePercentage: bookingFeePct
    });

    return res.json({
      success: true,
      quote
    });
  } catch (error) {
    console.error('[Pricing Quote Error]:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to calculate quote' });
  }
}

// Register pricing quote and Cashfree endpoints
app.post('/api/pricing/quote', verifyOptionalAuth, handleCalculateQuote);
app.post('/api/payments/cashfree/create-order', verifyAuth, handleCreateCashfreeOrder);
app.post('/api/payments/initiate', verifyAuth, handleCreateCashfreeOrder);

/**
 * Atomically confirms booking, transaction, slot reservation, receipt, emails, and notifications.
 * Idempotent: Can be called safely from status check, verification endpoint, or webhook.
 */
async function confirmBookingAndTransaction(orderId, paymentRecord, customerUid, supplementalBookingData) {
  const transactionId = `txn_${orderId}`;

  // 1. Idempotency Check: If already processed, return existing confirmed booking & transaction
  if (db) {
    const existingTxn = await db.collection('transactions').doc(transactionId).get();
    if (existingTxn.exists) {
      console.log(`[PARVA_PAYMENT_CONFIRMED] (Idempotent Cache) orderId=${orderId}`);
      let existingBookingDoc = await db.collection('bookings').doc(`b_${orderId}`).get();
      let existingBookingData = existingBookingDoc.exists ? existingBookingDoc.data() : null;
      if (!existingBookingData && supplementalBookingData?.id) {
        const directDoc = await db.collection('bookings').doc(supplementalBookingData.id).get();
        if (directDoc.exists) existingBookingData = directDoc.data();
      }
      if (!existingBookingData) {
        const snap = await db.collection('bookings').where('orderId', '==', orderId).limit(1).get();
        if (!snap.empty) existingBookingData = snap.docs[0].data();
      }
      return {
        success: true,
        idempotent: true,
        transaction: existingTxn.data(),
        booking: existingBookingData
      };
    }
  }

  // 2. Load draft from pending_orders if available
  let pendingData = null;
  if (db) {
    try {
      const pendingSnap = await db.collection('pending_orders').doc(orderId).get();
      if (pendingSnap.exists) pendingData = pendingSnap.data();
    } catch (e) {
      console.warn(`[Confirm] Note loading pending_orders for ${orderId}:`, e.message);
    }
  }

  const finalUserId = customerUid || pendingData?.userId || supplementalBookingData?.userId || 'guest-uid';
  const effectiveVendorId = pendingData?.vendorId || supplementalBookingData?.vendorId || supplementalBookingData?.vendor?.id || 'system';

  // Fetch Admin Settings
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
    } catch (e) {}
  }

  const payableAmount = Number(paymentRecord?.payment_amount || pendingData?.finalPayable || supplementalBookingData?.finalPrice || 0);
  const bookingSubtotal = Number(pendingData?.servicesTotal || supplementalBookingData?.totalPrice || payableAmount);
  const bookingDiscount = Number(pendingData?.couponDiscount || supplementalBookingData?.bundleDiscount || 0);

  const commissionData = calculateVendorCommission({
    subtotal: bookingSubtotal,
    discount: bookingDiscount,
    commissionPercentage: commissionPct
  });

  // Authoritative real payment ID from Cashfree (NEVER fabricated)
  const realPaymentId = paymentRecord?.cf_payment_id 
    ? String(paymentRecord.cf_payment_id) 
    : (paymentRecord?.payment_id ? String(paymentRecord.payment_id) : null);

  const transactionData = {
    id: transactionId,
    provider: 'CASHFREE',
    userId: finalUserId,
    customerUid: finalUserId,
    vendorId: effectiveVendorId,
    type: pendingData?.type || supplementalBookingData?.type || 'booking',
    orderId: orderId,
    paymentId: realPaymentId,
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
    try {
      await db.collection('transactions').doc(transactionId).set(transactionData);
    } catch (dbErr) {
      console.warn('[Firestore Transaction Warning]:', dbErr.message);
    }
  }

  const bookingId = supplementalBookingData?.id || `b_${orderId}`;
  const pricingSnapshot = {
    subtotal: bookingSubtotal,
    discount: bookingDiscount,
    discountedSubtotal: Math.max(0, bookingSubtotal - bookingDiscount),
    commissionPercentage: commissionPct,
    commissionAmount: commissionData.platformCommission,
    advanceAmount: payableAmount,
    remainingAmount: Math.max(0, (bookingSubtotal - bookingDiscount) - Math.round(payableAmount / 1.18)),
    vendorPayout: commissionData.vendorPayout,
    finalPrice: bookingSubtotal - bookingDiscount
  };

  const customerName = supplementalBookingData?.customerName || pendingData?.customerDetails?.name || 'Valued Customer';
  const customerEmail = supplementalBookingData?.customerEmail || pendingData?.customerDetails?.email || '';
  const customerPhone = supplementalBookingData?.customerPhone || pendingData?.customerDetails?.phone || '';
  const eventDate = supplementalBookingData?.eventDate || pendingData?.eventDate || '';
  const eventTimeSlot = supplementalBookingData?.eventTimeSlot || pendingData?.eventTimeSlot || 'full_day';
  const vendorName = supplementalBookingData?.vendor?.name || pendingData?.vendorName || 'Event Partner';
  const vendorCategory = supplementalBookingData?.vendor?.category || pendingData?.vendorCategory || 'Event Services';
  const vendorLocation = supplementalBookingData?.vendor?.location || pendingData?.vendorLocation || 'Maharashtra';

  const confirmedBooking = {
    ...(supplementalBookingData || {}),
    id: bookingId,
    userId: finalUserId,
    customerUid: finalUserId,
    customerName,
    customerEmail,
    customerPhone,
    eventDate,
    eventTimeSlot,
    vendorId: effectiveVendorId,
    vendor: supplementalBookingData?.vendor || {
      id: effectiveVendorId,
      name: vendorName,
      category: vendorCategory,
      location: vendorLocation
    },
    selectedServices: supplementalBookingData?.selectedServices || pendingData?.selectedServices || [],
    provider: 'CASHFREE',
    paymentStatus: 'Paid',
    status: 'Confirmed',
    transactionId,
    paymentId: realPaymentId,
    orderId: orderId,
    totalPrice: bookingSubtotal,
    finalPrice: pricingSnapshot.finalPrice,
    pricing: pricingSnapshot,
    commissionBreakdown: commissionData,
    termsVersion,
    termsAcceptedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString()
  };

  if (db) {
    try {
      await db.collection('bookings').doc(bookingId).set(confirmedBooking, { merge: true });

      // Mark pending_orders draft as CONFIRMED
      await db.collection('pending_orders').doc(orderId).set({
        status: 'CONFIRMED',
        bookingId,
        confirmedAt: new Date().toISOString()
      }, { merge: true }).catch(() => {});

      // Authoritative Double Booking Lock: Mark slot_reservations as CONFIRMED
      if (effectiveVendorId && eventDate) {
        const slotKey = `${effectiveVendorId}_${eventDate}_${(eventTimeSlot || 'full_day').toLowerCase()}`;
        await db.collection('slot_reservations').doc(slotKey).set({
          vendorId: effectiveVendorId,
          eventDate,
          slot: (eventTimeSlot || 'full_day').toLowerCase(),
          orderId,
          bookingId,
          status: 'CONFIRMED',
          confirmedAt: new Date().toISOString()
        }, { merge: true }).catch(() => {});
      }
    } catch (dbErr) {
      console.warn('[Firestore Booking Write Warning]:', dbErr.message);
    }

    // Operational Telegram Alert
    try {
      telegramService.sendAlert(TELEGRAM_ALERT_TYPES.NEW_BOOKING, {
        bookingId,
        vendorName,
        category: vendorCategory,
        eventDate,
        eventTimeSlot,
        totalAmountINR: bookingSubtotal,
        advancePaidINR: payableAmount
      }).catch(tgErr => console.warn('[Telegram Alert Warning]:', tgErr.message));
    } catch (tgEx) {}

    // Double Booking Prevention: Append eventDate to vendor's busyDates
    if (effectiveVendorId && eventDate) {
      try {
        const vRef = db.collection('vendors').doc(effectiveVendorId);
        await vRef.update({
          busyDates: admin.firestore.FieldValue.arrayUnion(eventDate)
        }).catch(() => {});
      } catch (lockErr) {}
    }

    // Lead Record
    const leadId = `lead_${Date.now()}`;
    await db.collection('leads').doc(leadId).set({
      id: leadId,
      bookingId,
      vendorId: effectiveVendorId,
      vendorName,
      customerName,
      customerPhone,
      customerEmail,
      eventDate,
      eventType: supplementalBookingData?.eventType || 'Celebration',
      amount: payableAmount,
      status: 'Confirmed & Paid',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});

    // PDF Receipt Generation
    let pdfBuffer = null;
    try {
      pdfBuffer = await generateBookingPdf({
        bookingId,
        customerName,
        customerPhone,
        customerEmail,
        vendorName,
        vendorCategory,
        vendorLocation,
        serviceName: confirmedBooking.selectedServices?.[0]?.name || vendorCategory,
        items: confirmedBooking.selectedServices || confirmedBooking.items || [],
        pricing: confirmedBooking.pricing || null,
        eventDate,
        eventTimeSlot: confirmedBooking.eventTimeSlot || confirmedBooking.timeSlot || 'Full Day (09:00 AM – 10:00 PM)',
        eventType: supplementalBookingData?.eventType || 'Celebration',
        guestCount: confirmedBooking.guestCount || supplementalBookingData?.guestCount || 'N/A',
        totalAmount: bookingSubtotal,
        amountPaid: payableAmount,
        paymentStatus: 'Paid',
        paymentId: realPaymentId,
        orderId,
        termsVersion,
        termsAcceptedAt: new Date().toISOString()
      });
    } catch (pdfErr) {
      console.error('[Cashfree] PDF Generation Error:', pdfErr.message);
    }

    // Automated Resend Emails (Idempotent with Dynamic Recipient Resolution)
    let resolvedVendorEmail = supplementalBookingData?.vendor?.email || pendingData?.vendorEmail || '';
    if (!resolvedVendorEmail && effectiveVendorId && db) {
      try {
        const vSnap = await db.collection('vendors').doc(effectiveVendorId).get();
        if (vSnap.exists) {
          const vData = vSnap.data();
          resolvedVendorEmail = vData.email || vData.contactEmail || '';
        }
      } catch (err) {
        console.warn('[Cashfree] Could not resolve vendor email:', err.message);
      }
    }

    const customer = { name: customerName, email: customerEmail, phone: customerPhone };
    const vendor = { 
      id: effectiveVendorId, 
      name: vendorName, 
      email: resolvedVendorEmail, 
      category: vendorCategory, 
      location: vendorLocation 
    };

    sendPaymentAndBookingConfirmedEmails({
      db,
      booking: confirmedBooking,
      customer,
      vendor,
      transaction: transactionData,
      pdfBuffer,
      commissionData
    }).catch(err => console.error('[Cashfree] Email Automation Error:', err.message));

    // Scoped & Idempotent Push / In-App Notifications
    if (finalUserId && finalUserId !== 'Guest' && finalUserId !== 'guest-uid') {
      await db.collection('notifications').doc(`notif_${bookingId}_customer`).set({
        id: `notif_${bookingId}_customer`,
        recipientUid: finalUserId,
        bookingId,
        vendorId: effectiveVendorId,
        type: 'BOOKING_CONFIRMED',
        title: `🎉 Booking Confirmed: #${bookingId}`,
        message: `Your celebration service with ${vendorName} is confirmed for ${eventDate}. Receipt sent to your email!`,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        read: false
      }, { merge: true }).catch(() => {});
    }

    if (effectiveVendorId) {
      await db.collection('notifications').doc(`notif_${bookingId}_vendor`).set({
        id: `notif_${bookingId}_vendor`,
        recipientUid: effectiveVendorId,
        bookingId,
        vendorId: effectiveVendorId,
        type: 'BOOKING_RECEIVED',
        title: `🔔 New Booking Received: #${bookingId}`,
        message: `New booking confirmed from ${customerName} for ${eventDate}. Advance paid: ₹${payableAmount}.`,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        read: false
      }, { merge: true }).catch(() => {});
    }

    await db.collection('notifications').doc(`notif_${bookingId}_admin`).set({
      id: `notif_${bookingId}_admin`,
      recipientUid: 'admin',
      bookingId,
      vendorId: effectiveVendorId,
      type: 'ADMIN_BOOKING_ALERT',
      title: `💰 New Confirmed Booking: #${bookingId}`,
      message: `Customer ${customerName} booked ${vendorName} for ₹${payableAmount}. Platform fee/commission: ₹${commissionData.platformCommission} (${commissionPct}%).`,
      financial: {
        grossAmount: payableAmount,
        commissionPercentage: commissionPct,
        commissionAmount: commissionData.platformCommission,
        vendorPayout: commissionData.vendorPayout,
        gatewayOrderId: orderId
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      read: false
    }, { merge: true }).catch(() => {});
  }

  console.log(`[PARVA_PAYMENT_CONFIRMED] orderId=${orderId} bookingId=${bookingId}`);
  return {
    success: true,
    transaction: transactionData,
    booking: confirmedBooking
  };
}

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

    console.log(`[Cashfree Verify] Request for Order ID: ${orderId}...`);

    let authenticatedCustomerUid = req.user?.uid || null;
    const authHeader = req.headers.authorization;
    if (!authenticatedCustomerUid && authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split('Bearer ')[1].trim();
      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        authenticatedCustomerUid = decodedToken.uid;
      } catch (authErr) {
        console.warn('[Cashfree Verify] Token verification notice:', authErr.message);
      }
    }
    const finalUserId = authenticatedCustomerUid || req.user?.uid;
    if (!finalUserId) {
      return res.status(401).json({ success: false, error: 'Authentication required. Please sign in to verify booking payment.' });
    }

    // 1. Fetch Order Payments from Cashfree API
    let paymentVerified = false;
    let paymentDetails = null;

    try {
      const fetchResponse = await cashfree.PGOrderFetchPayments(orderId);
      const payments = fetchResponse?.data || [];

      if (Array.isArray(payments) && payments.length > 0) {
        const successPayment = payments.find(p => p.payment_status === 'SUCCESS');
        if (successPayment) {
          paymentVerified = true;
          paymentDetails = successPayment;
        }
      }
    } catch (cfErr) {
      console.warn(`[Cashfree API] PGOrderFetchPayments note:`, cfErr?.response?.data || cfErr.message);
    }

    // Also check order status directly
    if (!paymentVerified) {
      try {
        const orderRes = await cashfree.PGFetchOrder(orderId);
        if (orderRes?.data?.order_status === 'PAID') {
          paymentVerified = true;
          paymentDetails = {
            cf_payment_id: paymentId || orderRes.data.cf_order_id,
            payment_amount: orderRes.data.order_amount,
            payment_status: 'SUCCESS'
          };
        }
      } catch (oErr) {
        console.warn(`[Cashfree API] PGFetchOrder note:`, oErr?.response?.data || oErr.message);
      }
    }

    if (!paymentVerified) {
      console.error(`[PARVA_PAYMENT_FAILED] orderId=${orderId} reason="Payment unconfirmed by Cashfree"`);
      return res.status(400).json({ 
        success: false, 
        error: 'Payment not verified by Cashfree Gateway. Status is unconfirmed.' 
      });
    }

    const result = await confirmBookingAndTransaction(orderId, paymentDetails, finalUserId, bookingData);
    res.json({
      success: true,
      provider: 'CASHFREE',
      transaction: result.transaction,
      booking: result.booking
    });
  } catch (error) {
    console.error('[Cashfree] Verification Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Payment verification failed' });
  }
}

/**
 * Authoritatively formats order status response while protecting customer PII from unauthorized snooping
 */
function formatSecureOrderResponse(orderId, bookingData, transactionData, reqUser) {
  const requesterUid = reqUser?.uid;
  const isAdmin = reqUser?.isAdmin || false;
  const isOwner = Boolean(
    requesterUid && (
      (bookingData && (bookingData.userId === requesterUid || bookingData.customerUid === requesterUid)) ||
      (transactionData && (transactionData.userId === requesterUid || transactionData.customerUid === requesterUid))
    )
  );

  // If an authenticated user attempts to inspect another customer's order, deny access
  if (requesterUid && !isOwner && !isAdmin) {
    return {
      authorized: false,
      error: 'Access denied: You do not have permission to view this order.'
    };
  }

  // Owner or authorized Admin receives the complete authoritative record
  if (isOwner || isAdmin) {
    return {
      authorized: true,
      data: {
        success: true,
        status: 'SUCCESS',
        orderId,
        transaction: transactionData,
        booking: bookingData
      }
    };
  }

  // Unauthenticated guest payment return redirect: Return sanitized receipt without private PII
  return {
    authorized: true,
    data: {
      success: true,
      status: 'SUCCESS',
      orderId,
      booking: {
        id: bookingData?.id,
        bookingIdString: bookingData?.bookingIdString,
        status: bookingData?.status || 'Confirmed',
        vendorName: bookingData?.vendor?.name || 'Parva Partner',
        eventDate: bookingData?.eventDate,
        eventTimeSlot: bookingData?.eventTimeSlot,
        serviceName: bookingData?.serviceName,
        totalPrice: bookingData?.totalPrice,
        finalPrice: bookingData?.finalPrice
      },
      transaction: {
        id: transactionData?.id,
        orderId: transactionData?.orderId,
        status: transactionData?.status || 'Paid',
        totalAmount: transactionData?.totalAmount
      }
    }
  };
}

/**
 * Dedicated Status Endpoint: GET/POST /api/payments/cashfree/status?orderId=XXXX
 * Authoritatively queries Cashfree, confirms booking if SUCCESS, and returns verified state.
 */
async function handleGetCashfreeOrderStatus(req, res) {
  try {
    const orderId = req.query.orderId || req.body.orderId;
    if (!orderId) {
      return res.status(400).json({ success: false, error: 'orderId parameter is required' });
    }

    console.log(`[PARVA_PAYMENT_RETURN] orderId=${orderId}`);

    // 1. Check idempotency: If already confirmed in Firestore, return immediately
    const transactionId = `txn_${orderId}`;
    if (db) {
      try {
        const existingTxn = await db.collection('transactions').doc(transactionId).get();
        if (existingTxn.exists) {
          let bookingDoc = await db.collection('bookings').doc(`b_${orderId}`).get();
          let bookingData = bookingDoc.exists ? bookingDoc.data() : null;
          if (!bookingData) {
            const snap = await db.collection('bookings').where('orderId', '==', orderId).limit(1).get();
            if (!snap.empty) bookingData = snap.docs[0].data();
          }
          console.log(`[PARVA_PAYMENT_STATUS] orderId=${orderId} cashfreeStatus=SUCCESS (cached)`);
          const secureRes = formatSecureOrderResponse(orderId, bookingData, existingTxn.data(), req.user);
          if (!secureRes.authorized) {
            return res.status(403).json({ success: false, error: secureRes.error });
          }
          return res.json(secureRes.data);
        }
      } catch (dbErr) {
        console.warn(`[Firestore Status Notice]:`, dbErr.message);
      }
    }

    // 2. Query Cashfree Payments directly
    let payments = [];
    let cfOrder = null;
    try {
      const fetchResponse = await cashfree.PGOrderFetchPayments(orderId);
      payments = fetchResponse?.data || [];
    } catch (cfErr) {
      console.warn(`[Cashfree API] PGOrderFetchPayments warning for ${orderId}:`, cfErr?.response?.data || cfErr.message);
    }

    try {
      const oRes = await cashfree.PGFetchOrder(orderId);
      cfOrder = oRes?.data;
    } catch (cfErr) {
      console.warn(`[Cashfree API] PGFetchOrder warning for ${orderId}:`, cfErr?.response?.data || cfErr.message);
    }

    // 3. Evaluate payment status
    const successPayment = Array.isArray(payments) ? payments.find(p => p.payment_status === 'SUCCESS') : null;
    const isSuccess = Boolean(successPayment) || cfOrder?.order_status === 'PAID';

    if (isSuccess) {
      console.log(`[PARVA_PAYMENT_STATUS] orderId=${orderId} cashfreeStatus=SUCCESS`);
      const paymentRecord = successPayment || {
        cf_payment_id: cfOrder?.cf_order_id || null,
        payment_amount: cfOrder?.order_amount || 0,
        payment_status: 'SUCCESS'
      };
      const result = await confirmBookingAndTransaction(orderId, paymentRecord, req.user?.uid || null, null);
      const secureRes = formatSecureOrderResponse(orderId, result.booking, result.transaction, req.user);
      if (!secureRes.authorized) {
        return res.status(403).json({ success: false, error: secureRes.error });
      }
      return res.json(secureRes.data);
    }

    const pendingPayment = Array.isArray(payments) ? payments.find(p => p.payment_status === 'PENDING') : null;
    if (pendingPayment || cfOrder?.order_status === 'ACTIVE') {
      console.log(`[PARVA_PAYMENT_STATUS] orderId=${orderId} cashfreeStatus=PENDING`);
      return res.json({
        success: true,
        status: 'PENDING',
        orderId,
        message: 'Payment is being processed by your bank. Please do not pay again.'
      });
    }

    if (cfOrder?.order_status === 'EXPIRED') {
      console.log(`[PARVA_PAYMENT_STATUS] orderId=${orderId} cashfreeStatus=EXPIRED`);
      return res.json({
        success: false,
        status: 'EXPIRED',
        orderId,
        message: 'Payment session expired. Please start a new checkout.'
      });
    }

    const failedPayment = Array.isArray(payments) ? payments.find(p => p.payment_status === 'FAILED' || p.payment_status === 'USER_DROPPED' || p.payment_status === 'CANCELLED') : null;
    if (failedPayment) {
      console.log(`[PARVA_PAYMENT_STATUS] orderId=${orderId} cashfreeStatus=${failedPayment.payment_status}`);
      return res.json({
        success: false,
        status: failedPayment.payment_status === 'USER_DROPPED' ? 'CANCELLED' : 'FAILED',
        orderId,
        message: failedPayment.payment_message || 'Payment was cancelled or failed.'
      });
    }

    console.log(`[PARVA_PAYMENT_STATUS] orderId=${orderId} cashfreeStatus=UNKNOWN`);
    return res.json({
      success: false,
      status: 'UNKNOWN',
      orderId,
      message: 'Payment status could not be determined. Please check My Bookings shortly.'
    });
  } catch (error) {
    console.error(`[PARVA_PAYMENT_FAILED] orderId=${req.query?.orderId || req.body?.orderId} reason="${error.message}"`);
    res.status(500).json({ success: false, error: 'Error checking payment status.' });
  }
}

// Register Payment Status and Verification Routes
app.get('/api/payments/cashfree/status', verifyOptionalAuth, handleGetCashfreeOrderStatus);
app.post('/api/payments/cashfree/status', verifyOptionalAuth, handleGetCashfreeOrderStatus);
app.post('/api/payments/cashfree/verify', verifyAuth, handleVerifyCashfreePayment);
app.post('/api/payments/verify', verifyAuth, handleVerifyCashfreePayment);

// ==================== CASHFREE WEBHOOK LISTENER ====================
app.post('/api/payments/cashfree/webhook', async (req, res) => {
  try {
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];

    console.log(`[Cashfree Webhook] Received webhook notification.`);

    // Cryptographic signature verification using unaltered rawBody
    if (process.env.NODE_ENV === 'production') {
      if (!signature || !timestamp) {
        console.error('[Cashfree Webhook Security] Missing signature or timestamp headers.');
        return res.status(400).json({ error: 'Missing webhook signature headers' });
      }
      try {
        cashfree.PGVerifyWebhookSignature(signature, rawBody, timestamp);
      } catch (sigErr) {
        console.error('[Cashfree Webhook Security] Signature verification failed:', sigErr.message);
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    } else if (signature && timestamp) {
      try {
        cashfree.PGVerifyWebhookSignature(signature, rawBody, timestamp);
      } catch (sigErr) {
        console.warn(`[Cashfree Webhook Development Notice]:`, sigErr.message);
      }
    }

    const { type, data } = req.body;
    console.log(`[PARVA_PAYMENT_WEBHOOK] orderId=${data?.order?.order_id || 'N/A'} eventType=${type}`);

    if (type === 'PAYMENT_SUCCESS_WEBHOOK' && data?.order?.order_id) {
      const orderId = data.order.order_id;
      const paymentRecord = {
        cf_payment_id: data.payment?.cf_payment_id || null,
        payment_amount: Number(data.order?.order_amount || data.payment?.payment_amount || 0),
        payment_status: 'SUCCESS'
      };
      await confirmBookingAndTransaction(orderId, paymentRecord, data.customer_details?.customer_id || null, null);
    }

    res.status(200).json({ status: 'OK' });
  } catch (error) {
    console.error('[Cashfree Webhook Error]:', error);
    res.status(500).json({ error: 'Webhook processing error' });
  }
});

// ==================== 2. CASHFREE REAL REFUND API ROUTE ====================
app.post('/api/payments/cashfree/refund', verifyAuth, requireAdmin, async (req, res) => {
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
      const errDetail = cfErr?.response?.data?.message || cfErr.message;
      console.error('[Cashfree Refund API Error]:', errDetail);
      if (process.env.NODE_ENV === 'production') {
        return res.status(502).json({
          success: false,
          error: `Payment gateway refund failed: ${errDetail}`
        });
      }
      console.warn('[Cashfree Refund Development Fallback]: Mocking refund response for local sandbox testing.');
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

    // Update Firestore booking record & dispatch refund email
    if (db && bookingId) {
      const bRef = db.collection('bookings').doc(bookingId);
      const bDoc = await bRef.get();
      const bData = bDoc.exists ? bDoc.data() : { id: bookingId };

      await bRef.set({
        refundStatus: refundData.refund_status || 'Processed',
        refundData: {
          refundId: refundData.refund_id,
          amount: Number(refundAmount),
          status: refundData.refund_status,
          processedAt: new Date().toISOString()
        }
      }, { merge: true });

      const customerRecipient = bData.customerEmail || bData.userEmail;
      if (customerRecipient) {
        sendRefundProcessedEmail({
          db,
          booking: { ...bData, id: bookingId },
          customer: { name: bData.customerName || 'Customer', email: customerRecipient },
          refundData: {
            refundId: refundData.refund_id,
            amount: Number(refundAmount),
            status: refundData.refund_status
          }
        }).catch(err => console.error('[Cashfree Refund] Email Notification Error:', err.message));
      }
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

// A. Booking Created (Pending Request - Authenticated Customer Required)
app.post('/api/bookings/create', verifyAuth, async (req, res) => {
  try {
    const { booking, customer, vendor } = req.body;
    if (!booking || !booking.id) {
      return res.status(400).json({ success: false, error: 'Booking details required.' });
    }

    const assignedUserId = req.user.uid;

    const pendingBooking = {
      ...booking,
      userId: assignedUserId,
      customerUid: assignedUserId,
      status: booking.status || 'Pending',
      paymentStatus: booking.paymentStatus || 'Pending',
      createdAt: new Date().toISOString()
    };

    await db.collection('bookings').doc(booking.id).set(pendingBooking, { merge: true });

    // Resolve full vendor details from Firestore if not provided in payload
    let resolvedVendor = vendor || booking.vendor || {};
    const effectiveVendorId = resolvedVendor.id || booking.vendorId;
    if ((!resolvedVendor.email || !resolvedVendor.name) && effectiveVendorId && db) {
      try {
        const vDoc = await db.collection('vendors').doc(effectiveVendorId).get();
        if (vDoc.exists) {
          const vData = vDoc.data();
          resolvedVendor = {
            id: effectiveVendorId,
            name: resolvedVendor.name || vData.name || vData.businessName || 'Event Partner',
            email: resolvedVendor.email || vData.email || vData.contactEmail || '',
            category: resolvedVendor.category || vData.category || 'Celebration Services',
            location: resolvedVendor.location || vData.location || 'Maharashtra'
          };
        }
      } catch (err) {}
    }

    const resolvedCustomer = {
      name: customer?.name || req.user.name || booking.customerName || 'Customer',
      email: customer?.email || req.user.email || booking.customerEmail || '',
      phone: customer?.phone || req.user.phone || booking.customerPhone || ''
    };

    // Trigger Initial "Booking Request Received" Email
    sendBookingCreatedEmail({
      db,
      booking: pendingBooking,
      customer: resolvedCustomer,
      vendor: resolvedVendor
    }).catch(err => console.error("Booking created email error:", err));

    res.json({ success: true, booking: pendingBooking });
  } catch (error) {
    console.error('Create Booking Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// A.1 Submit Customer Review (Authenticated Customer Only)
app.post('/api/reviews', verifyAuth, async (req, res) => {
  try {
    const { bookingId, vendorId, rating, comment } = req.body;
    if (!vendorId || !rating) {
      return res.status(400).json({ success: false, error: 'Vendor ID and rating are required.' });
    }

    const numericRating = Math.min(5, Math.max(1, Number(rating) || 5));
    const customerUid = req.user.uid;
    const customerName = req.user.name || req.user.email?.split('@')[0] || 'Verified Customer';

    const reviewId = `rev_${customerUid}_${vendorId}_${Date.now()}`;
    const reviewData = {
      id: reviewId,
      bookingId: bookingId || null,
      vendorId,
      customerUid,
      customerName,
      userName: customerName,
      rating: numericRating,
      comment: (comment || '').trim(),
      date: new Date().toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' }),
      createdAt: new Date().toISOString()
    };

    if (db) {
      // 1. Save review doc in Firestore
      await db.collection('reviews').doc(reviewId).set(reviewData);

      // 2. Recalculate Vendor Rating & Review Count
      const reviewsSnap = await db.collection('reviews').where('vendorId', '==', vendorId).get();
      if (!reviewsSnap.empty) {
        let totalStars = 0;
        const reviewList = [];
        reviewsSnap.forEach(docSnap => {
          const r = docSnap.data();
          totalStars += Number(r.rating) || 5;
          reviewList.push(r);
        });
        const reviewCount = reviewsSnap.size;
        const avgRating = Number((totalStars / reviewCount).toFixed(1));

        await db.collection('vendors').doc(vendorId).set({
          rating: avgRating,
          reviewCount,
          reviews: reviewList.slice(-10) // keep latest 10 reviews in snapshot
        }, { merge: true });
      }
    }

    res.json({ success: true, review: reviewData });
  } catch (error) {
    console.error('Submit Review Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// B. Booking Cancellation (Customer Requested with Support-Managed Refund Engine)
app.post('/api/bookings/:id/cancel', verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = 'Customer requested cancellation', refundAmount = 0, customer, vendor } = req.body;

    const bookingRef = db.collection('bookings').doc(id);
    const bookingDoc = await bookingRef.get();
    
    if (!bookingDoc.exists) {
      return res.status(404).json({ success: false, error: 'Booking not found.' });
    }

    const bData = bookingDoc.data();

    // Authoritative Ownership Check: Must be customer, assigned vendor, or admin
    const callerUid = req.user.uid;
    const isCustomer = (bData.userId && bData.userId === callerUid) || (bData.customerUid && bData.customerUid === callerUid);
    const isVendor = (bData.vendorId && bData.vendorId === callerUid) || (bData.vendor?.id && bData.vendor.id === callerUid) || (bData.vendorOwnerUid && bData.vendorOwnerUid === callerUid);
    const isAdmin = Boolean(req.user.isAdmin);

    if (!isCustomer && !isVendor && !isAdmin) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You are not authorized to cancel this booking.' }
      });
    }

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
        refundRequestedBy: isCustomer ? 'customer' : 'vendor',
        refundReason: reason,
        refundAmount: calculatedRefundAmt
      } : {})
    };

    await bookingRef.set(updatedBooking, { merge: true });

    // Release Calendar Slot Reservation & Busy Dates
    const effectiveVendorId = bData.vendorId || bData.vendor?.id;
    if (effectiveVendorId && bData.eventDate && db) {
      try {
        const slotKey = `${effectiveVendorId}_${bData.eventDate}_${(bData.eventTimeSlot || bData.timeSlot || 'full_day').toLowerCase()}`;
        await db.collection('slot_reservations').doc(slotKey).set({
          status: 'CANCELLED',
          cancelledAt: new Date().toISOString()
        }, { merge: true }).catch(() => {});

        await db.collection('vendors').doc(effectiveVendorId).update({
          busyDates: admin.firestore.FieldValue.arrayRemove(bData.eventDate)
        }).catch(() => {});
      } catch (slotErr) {
        console.warn('[Cancel Booking] Slot release notice:', slotErr.message);
      }
    }

    // Resolve full vendor details from Firestore if missing on booking object
    let resolvedVendorEmail = vendor?.email || updatedBooking.vendor?.email || '';
    if (!resolvedVendorEmail && effectiveVendorId && db) {
      try {
        const vDoc = await db.collection('vendors').doc(effectiveVendorId).get();
        if (vDoc.exists) {
          resolvedVendorEmail = vDoc.data().email || vDoc.data().contactEmail || '';
        }
      } catch (err) {}
    }

    const resolvedCustomer = {
      name: customer?.name || updatedBooking.customerName || 'Customer',
      email: customer?.email || updatedBooking.customerEmail || ''
    };
    const resolvedVendor = {
      id: effectiveVendorId,
      name: vendor?.name || updatedBooking.vendor?.name || 'Event Partner',
      email: resolvedVendorEmail
    };

    // Trigger Cancellation Emails (Customer + Vendor + Support)
    sendBookingCancellationEmail({
      db,
      booking: updatedBooking,
      customer: resolvedCustomer,
      vendor: resolvedVendor,
      reason,
      refundAmount: calculatedRefundAmt
    }).catch(err => console.error("Cancellation email error:", err));

    // Scoped In-App Notification (Customer)
    const targetCustomerUid = bData.userId || bData.customerUid;
    if (targetCustomerUid) {
      await db.collection('notifications').doc(`notif_cancel_${id}_customer`).set({
        id: `notif_cancel_${id}_customer`,
        recipientUid: targetCustomerUid,
        bookingId: id,
        type: 'slot',
        title: `⚠️ Booking Cancelled: #${id}`,
        message: `Booking for ${updatedBooking.vendor?.name || 'Vendor'} has been cancelled.${shouldRequestRefund ? ' Refund request logged.' : ''}`,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        read: false
      }, { merge: true });
    }

    // Scoped In-App Notification (Vendor)
    const targetVendorUid = bData.vendorId || bData.vendor?.id;
    if (targetVendorUid) {
      await db.collection('notifications').doc(`notif_cancel_${id}_vendor`).set({
        id: `notif_cancel_${id}_vendor`,
        recipientUid: targetVendorUid,
        bookingId: id,
        type: 'slot',
        title: `⚠️ Booking Cancelled: #${id}`,
        message: `Booking #${id} from ${updatedBooking.customerName || 'Customer'} has been cancelled.`,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        read: false
      }, { merge: true });
    }

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

// C. On-Demand Official PDF Invoice & Receipt Download
app.get('/api/bookings/:id/receipt', verifyOptionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { orderId } = req.query;

    const bookingRef = db.collection('bookings').doc(id);
    const bookingDoc = await bookingRef.get();

    if (!bookingDoc.exists) {
      return res.status(404).json({ success: false, error: 'Booking not found.' });
    }

    const bData = bookingDoc.data();
    const callerUid = req.user?.uid;

    let isAuthorized = false;
    if (callerUid) {
      const isCustomer = (bData.userId && bData.userId === callerUid) || (bData.customerUid === callerUid);
      const isVendor = (bData.vendorId && bData.vendorId === callerUid) || (bData.vendor?.id && bData.vendor.id === callerUid) || (bData.vendorOwnerUid && bData.vendorOwnerUid === callerUid);
      const isAdmin = Boolean(req.user.isAdmin);
      if (isCustomer || isVendor || isAdmin) {
        isAuthorized = true;
      }
    }

    // Allow guest access if providing matching Cashfree orderId for this booking
    if (!isAuthorized && orderId) {
      if (bData.orderId === orderId || bData.cashfreeOrderId === orderId) {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      return res.status(callerUid ? 403 : 401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'You are not authorized to access this receipt.' }
      });
    }

    const pdfBuffer = await generateBookingPdf({
      bookingId: bData.id || id,
      customerName: bData.customerName || bData.name || 'Valued Customer',
      customerPhone: bData.customerPhone || bData.phone || 'N/A',
      customerEmail: bData.customerEmail || bData.email || 'N/A',
      vendorName: bData.vendorName || bData.vendor?.name || 'Event Partner',
      vendorCategory: bData.vendorCategory || bData.vendor?.category || 'Event Service',
      vendorLocation: bData.vendorLocation || bData.vendor?.city || 'Maharashtra, India',
      serviceName: bData.serviceName || bData.selectedServices?.[0]?.name || 'Event Service',
      items: bData.selectedServices || bData.items || [],
      pricing: bData.pricing || null,
      eventDate: bData.eventDate || bData.date || new Date().toISOString().split('T')[0],
      eventTimeSlot: bData.eventTimeSlot || bData.timeSlot || 'Full Day (09:00 AM – 10:00 PM)',
      eventType: bData.eventType || 'Celebration',
      guestCount: bData.guestCount || 'N/A',
      totalAmount: bData.pricing?.subtotalINR || bData.totalPrice || bData.finalPrice || 0,
      amountPaid: bData.pricing?.totalPayableINR || bData.amountPaid || bData.pricing?.bookingFeeINR || 0,
      paymentStatus: bData.paymentStatus || 'Paid',
      paymentId: bData.paymentId || bData.cashfreePaymentId || 'N/A',
      orderId: bData.orderId || bData.cashfreeOrderId || 'N/A',
      termsVersion: bData.termsVersion || '1.2',
      termsAcceptedAt: bData.termsAcceptedAt || bData.createdAt || new Date().toISOString()
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="receipt_${id}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.status(200).send(pdfBuffer);
  } catch (error) {
    console.error('Download Receipt Error:', error);
    return res.status(500).json({ success: false, error: 'Failed to generate receipt PDF: ' + error.message });
  }
});

// D. Vendor Respond (Accept / Reject Flow with Authorization)
app.post('/api/vendor/bookings/:id/respond', verifyAuth, requireVendor, async (req, res) => {
  try {
    const { id } = req.params;
    const { action, vendorId, reason } = req.body; // action = 'accept' | 'reject'

    if (!id || !action) {
      return res.status(400).json({ success: false, error: 'Booking ID and action (accept/reject) are required.' });
    }

    const bookingRef = db.collection('bookings').doc(id);
    const bookingDoc = await bookingRef.get();

    if (!bookingDoc.exists) {
      return res.status(404).json({ success: false, error: 'Booking not found.' });
    }

    const bData = bookingDoc.data();

    if (action === 'accept') {
      const updatedBooking = {
        ...bData,
        status: 'Confirmed',
        vendorAcceptedAt: new Date().toISOString()
      };

      await bookingRef.set(updatedBooking, { merge: true });

      // Notify customer that vendor accepted (Scoped Notification)
      const targetCustomerUid = bData.userId || bData.customerUid;
      if (targetCustomerUid) {
        await db.collection('notifications').doc(`notif_accept_${id}_customer`).set({
          id: `notif_accept_${id}_customer`,
          recipientUid: targetCustomerUid,
          bookingId: id,
          type: 'slot',
          title: `🎉 Vendor Confirmed: #${id}`,
          message: `${bData.vendor?.name || 'Your vendor'} has accepted your event booking!`,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          read: false
        }, { merge: true });
      }

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

      // Notify customer that vendor declined (Scoped Notification)
      const targetCustomerUid = bData.userId || bData.customerUid;
      if (targetCustomerUid) {
        await db.collection('notifications').doc(`notif_reject_${id}_customer`).set({
          id: `notif_reject_${id}_customer`,
          recipientUid: targetCustomerUid,
          bookingId: id,
          type: 'slot',
          title: `⚠️ Vendor Declined: #${id}`,
          message: `${bData.vendor?.name || 'The vendor'} was unable to accept this booking. ${shouldRequestRefund ? 'Your advance fee refund request has been created.' : ''}`,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          read: false
        }, { merge: true });
      }

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

// C.1 Vendor KYC Submission (Authoritative write via Firebase Admin SDK)
app.post('/api/vendor/kyc/submit', verifyAuth, async (req, res) => {
  try {
    const { vendorId, kycData } = req.body;
    if (!vendorId || !kycData) {
      return res.status(400).json({ success: false, error: 'vendorId and kycData are required.' });
    }

    const requesterUid = req.user.uid;
    const requesterEmail = (req.user.email || '').toLowerCase();
    const isAdmin = [
      'devanshkadam2@gmail.com',
      'devenshkadam2@gmail.com',
      'devansh@parva.com',
      'admin@myparva.com',
      'rohan@myparva.com',
      'devanshkadam9579@gmail.com',
      'admin@parva.com'
    ].includes(requesterEmail);

    if (!db) {
      return res.status(500).json({ success: false, error: 'Database service is unavailable.' });
    }

    const vendorDoc = await db.collection('vendors').doc(vendorId).get();
    if (!vendorDoc.exists) {
      return res.status(404).json({ success: false, error: 'Vendor profile not found.' });
    }

    const vData = vendorDoc.data();
    const isOwner = vData.ownerUid === requesterUid || vData.userId === requesterUid || vendorId === requesterUid;

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, error: 'Unauthorized. You do not own this vendor profile.' });
    }

    const now = new Date().toISOString();
    const fullKycPayload = {
      ...kycData,
      vendorId,
      vendorName: vData.name || 'Vendor',
      vendorCategory: vData.category || 'Event Partner',
      ownerUid: vData.ownerUid || requesterUid,
      submittedAt: now,
      updatedAt: now
    };

    // 1. Authoritative write to dedicated vendor_kyc collection
    await db.collection('vendor_kyc').doc(vendorId).set(fullKycPayload, { merge: true });

    // 2. Authoritative update to vendors collection summary
    await db.collection('vendors').doc(vendorId).update({
      kyc: kycData,
      'kyc.status': kycData.status || 'PENDING_VERIFICATION',
      updatedAt: now
    });

    // 3. Dispatch in-app notification to Admin
    await db.collection('notifications').add({
      recipientUid: 'admin',
      type: 'KYC_SUBMITTED',
      title: `📑 New KYC Submission: ${vData.name || vendorId}`,
      message: `Vendor ${vData.name || vendorId} has submitted KYC documents for verification.`,
      vendorId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      read: false
    }).catch(() => {});

    console.log(`[KYC_SUBMITTED] Authoritative write successful for vendorId=${vendorId} by=${requesterUid}`);
    return res.json({
      success: true,
      message: 'KYC documents submitted successfully! Parva team will review your profile shortly.',
      kyc: fullKycPayload
    });
  } catch (error) {
    console.error('[KYC Submit Error]:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to submit KYC documents' });
  }
});

// C.2 Authoritative Admin Vendor KYC Review (Verify, Request Changes, Reject)
app.post('/api/admin/vendor-kyc/:vendorId/review', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { action, remarks = '', documentReviews = {} } = req.body;

    if (!vendorId || !action) {
      return res.status(400).json({ success: false, error: 'vendorId and action are required.' });
    }

    const validActions = ['VERIFY', 'REQUEST_CHANGES', 'REJECT'];
    if (!validActions.includes(action)) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid action "${action}". Must be one of: ${validActions.join(', ')}.` 
      });
    }

    if ((action === 'REQUEST_CHANGES' || action === 'REJECT') && (!remarks || !remarks.trim())) {
      return res.status(400).json({ 
        success: false, 
        error: `Mandatory remarks/reason required when action is "${action}". Please provide clear feedback to the vendor.` 
      });
    }

    if (!db) {
      return res.status(500).json({ success: false, error: 'Database service is unavailable.' });
    }

    const vendorRef = db.collection('vendors').doc(vendorId);
    const vendorDoc = await vendorRef.get();
    if (!vendorDoc.exists) {
      return res.status(404).json({ success: false, error: 'Vendor profile not found.' });
    }

    const vData = vendorDoc.data();
    const now = new Date().toISOString();
    const reviewerEmail = req.user?.email || 'admin@myparva.com';

    let targetKycStatus = 'PENDING_VERIFICATION';
    let targetApproved = false;
    let targetVerificationStatus = 'PENDING';
    let targetStatus = 'PENDING';

    if (action === 'VERIFY') {
      targetKycStatus = 'VERIFIED';
      targetApproved = true;
      targetVerificationStatus = 'APPROVED';
      targetStatus = 'ACTIVE';
    } else if (action === 'REQUEST_CHANGES') {
      targetKycStatus = 'ACTION_REQUIRED';
      targetApproved = false;
      targetVerificationStatus = 'ACTION_REQUIRED';
      targetStatus = 'PENDING';
    } else if (action === 'REJECT') {
      targetKycStatus = 'REJECTED';
      targetApproved = false;
      targetVerificationStatus = 'REJECTED';
      targetStatus = 'SUSPENDED';
    }

    // 1. Authoritative update to vendor_kyc collection
    const kycRef = db.collection('vendor_kyc').doc(vendorId);
    await kycRef.set({
      status: targetKycStatus,
      adminRemarks: remarks.trim(),
      reviewedAt: now,
      reviewedBy: reviewerEmail,
      documentReviews: documentReviews || {},
      updatedAt: now
    }, { merge: true });

    // 2. Authoritative update to vendors collection
    await vendorRef.set({
      approved: targetApproved,
      verificationStatus: targetVerificationStatus,
      status: targetStatus,
      rejectionReason: action === 'REJECT' ? remarks.trim() : null,
      kyc: {
        ...(vData.kyc || {}),
        status: targetKycStatus,
        adminRemarks: remarks.trim(),
        reviewedAt: now,
        reviewedBy: reviewerEmail
      },
      'kyc.status': targetKycStatus,
      approvedAt: action === 'VERIFY' ? now : (vData.approvedAt || null),
      rejectedAt: action === 'REJECT' ? now : null,
      updatedAt: now
    }, { merge: true });

    // 3. Dispatch persistent in-app notification to the vendor
    const recipientUid = vData.ownerUid || vData.userId || vendorId;
    let notifTitle = '🎉 Partner Profile Verified!';
    let notifMsg = 'Your government ID and business verification documents have been approved. You are now a Verified Partner!';

    if (action === 'REQUEST_CHANGES') {
      notifTitle = '⚠️ Additional Information Needed for KYC';
      notifMsg = remarks.trim() || 'Please open KYC Verification to review the reviewer remarks and update your documents.';
    } else if (action === 'REJECT') {
      notifTitle = '❌ KYC Verification Notice';
      notifMsg = remarks.trim() || 'Your KYC submission was not approved. Please review the reason and resubmit.';
    }

    await db.collection('notifications').add({
      recipientUid,
      vendorId,
      type: 'KYC_STATUS_UPDATE',
      title: notifTitle,
      message: notifMsg,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }).catch(err => console.warn('[KYC Notification Warning]:', err.message));

    // 4. Send official notification email to vendor if email configured
    if (vData.email) {
      sendVendorKycStatusEmail({
        vendorEmail: vData.email,
        vendorName: vData.name || 'Partner',
        status: targetKycStatus,
        remarks: remarks.trim()
      }).catch(err => console.warn('[KYC Email Warning]:', err.message));
    }

    // 5. Emit security audit log
    await db.collection('audit_logs').add({
      action: 'VENDOR_KYC_REVIEW',
      performedBy: reviewerEmail,
      vendorId,
      reviewAction: action,
      resultingStatus: targetKycStatus,
      remarks: remarks.trim(),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});

    console.log(`[KYC_REVIEW] Vendor ${vendorId} reviewed by ${reviewerEmail}: action=${action}, status=${targetKycStatus}`);

    return res.json({
      success: true,
      message: `Vendor KYC review recorded: ${action}`,
      vendorId,
      status: targetKycStatus
    });
  } catch (error) {
    console.error('[Admin KYC Review Error]:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to process KYC review' });
  }
});

// ==================== AUTH VALIDATION & OTP REGISTRATION ROUTES ====================

// In-memory fallback cache for OTPs
const otpMemoryCache = new Map();

// 1. Validate Credentials Endpoint
app.post('/api/auth/validate-credentials', (req, res) => {
  const { email, phone } = req.body;
  const emailRes = validateEmail(email);
  const phoneRes = validateIndianPhone(phone);

  if (!emailRes.isValid) {
    return res.status(400).json({ success: false, field: 'email', error: emailRes.error });
  }
  if (!phoneRes.isValid) {
    return res.status(400).json({ success: false, field: 'phone', error: phoneRes.error });
  }

  return res.json({
    success: true,
    email: emailRes.email,
    phone: phoneRes.phone,
    message: 'Email and phone number are valid.'
  });
});

// 2. Send Registration OTP Endpoint
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { email, phone, name, purpose = 'User Registration' } = req.body;

    const emailRes = validateEmail(email);
    if (!emailRes.isValid) {
      return res.status(400).json({ success: false, field: 'email', error: emailRes.error });
    }

    const phoneRes = validateIndianPhone(phone);
    if (!phoneRes.isValid) {
      return res.status(400).json({ success: false, field: 'phone', error: phoneRes.error });
    }

    const cleanEmail = emailRes.email;
    const cleanPhone = phoneRes.phone;

    // Generate secure 6-digit cryptographic OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    const otpData = {
      email: cleanEmail,
      phone: cleanPhone,
      otp,
      purpose,
      attempts: 0,
      verified: false,
      expiresAt,
      createdAt: new Date().toISOString()
    };

    otpMemoryCache.set(cleanEmail, otpData);

    if (db) {
      try {
        await db.collection('otps').doc(cleanEmail).set(otpData);
      } catch (e) {
        console.warn('[OTP Firestore Store Notice]:', e.message);
      }
    }

    console.log(`[PARVA_OTP] Generated OTP for email=${cleanEmail} phone=${cleanPhone} purpose=${purpose}`);

    // Dispatch via Resend Email
    const emailResult = await sendOtpVerificationEmail({
      email: cleanEmail,
      otp,
      name: name || '',
      purpose
    });

    return res.json({
      success: true,
      email: cleanEmail,
      phone: cleanPhone,
      expiresInSeconds: 600,
      emailDispatched: emailResult.success,
      message: emailResult.success 
        ? `Verification code sent to ${cleanEmail}.`
        : `Verification code generated. Please check your email ${cleanEmail}.`
    });
  } catch (error) {
    console.error('[Send OTP Error]:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to generate and send OTP' });
  }
});

// 3. Verify OTP Endpoint
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp, phone } = req.body;

    const emailRes = validateEmail(email);
    if (!emailRes.isValid) {
      return res.status(400).json({ success: false, error: emailRes.error });
    }

    const cleanEmail = emailRes.email;
    const cleanOtp = String(otp || '').trim();

    if (!cleanOtp || cleanOtp.length !== 6) {
      return res.status(400).json({ success: false, error: 'Please enter the complete 6-digit OTP code.' });
    }

    let record = null;
    if (db) {
      try {
        const snap = await db.collection('otps').doc(cleanEmail).get();
        if (snap.exists) record = snap.data();
      } catch (e) {}
    }

    if (!record) {
      record = otpMemoryCache.get(cleanEmail);
    }

    if (!record) {
      return res.status(400).json({ success: false, error: 'No active OTP found. Please request a new code.' });
    }

    if (Date.now() > record.expiresAt) {
      return res.status(400).json({ success: false, error: 'Verification code has expired. Please request a new code.' });
    }

    if (record.attempts >= 5) {
      return res.status(429).json({ success: false, error: 'Too many incorrect attempts. Please request a new verification code.' });
    }

    if (record.otp !== cleanOtp) {
      const attempts = (record.attempts || 0) + 1;
      record.attempts = attempts;
      otpMemoryCache.set(cleanEmail, record);
      if (db) {
        db.collection('otps').doc(cleanEmail).update({ attempts }).catch(() => {});
      }
      return res.status(400).json({
        success: false,
        error: `Incorrect OTP code. (${Math.max(0, 5 - attempts)} attempts remaining)`
      });
    }

    // OTP is valid!
    record.verified = true;
    record.verifiedAt = new Date().toISOString();
    otpMemoryCache.set(cleanEmail, record);

    if (db) {
      db.collection('otps').doc(cleanEmail).update({
        verified: true,
        verifiedAt: record.verifiedAt
      }).catch(() => {});
    }

    const secretKey = process.env.JWT_SECRET || process.env.CASHFREE_SECRET_KEY || crypto.randomBytes(32).toString('hex');
    const verificationToken = crypto.createHmac('sha256', secretKey)
      .update(`${cleanEmail}:${record.phone}:${Date.now()}`)
      .digest('hex');

    console.log(`[PARVA_OTP_VERIFIED] Success for ${cleanEmail} (phone: ${record.phone})`);

    return res.json({
      success: true,
      verified: true,
      verificationToken,
      email: cleanEmail,
      phone: record.phone,
      message: 'OTP verified successfully! You may now complete registration.'
    });
  } catch (error) {
    console.error('[Verify OTP Error]:', error);
    res.status(500).json({ success: false, error: error.message || 'OTP verification failed' });
  }
});

// D. Admin / Support Refund Processed (External Bank/UPI Confirmation)
app.post('/api/bookings/:id/refund', verifyAuth, requireAdmin, async (req, res) => {
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

// ==================== 2.5 RESEND DELIVERY & LIFECYCLE WEBHOOK ====================

app.post('/api/webhooks/resend', async (req, res) => {
  try {
    const event = req.body;
    const { type, data } = event;
    console.log(`[Resend Webhook] Received webhook event: ${type}, email_id: ${data?.email_id || 'N/A'}`);

    if (db && data?.email_id) {
      // Find matching email_events records by resendId or providerMessageId
      const snap = await db.collection('email_events').where('resendId', '==', data.email_id).get();
      if (!snap.empty) {
        const timestamp = event.created_at || new Date().toISOString();
        const updates = { updatedAt: timestamp };

        if (type === 'email.delivered') {
          updates.status = 'delivered';
          updates.deliveredAt = timestamp;
          updates.error = null;
        } else if (type === 'email.bounced') {
          updates.status = 'bounced';
          updates.bouncedAt = timestamp;
          updates.bounceReason = data.bounce?.message || data.reason || 'Bounced by recipient mail server';
        } else if (type === 'email.complained') {
          updates.status = 'complained';
          updates.complainedAt = timestamp;
        }

        for (const doc of snap.docs) {
          await doc.ref.set(updates, { merge: true });
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[Resend Webhook Error]:', err.message);
    res.status(500).json({ error: 'Webhook processing error' });
  }
});

// ==================== 3. ADMIN EMAIL LOGS & TEST ROUTES ====================

app.get('/api/admin/email-logs', verifyAuth, requireAdmin, async (req, res) => {
  try {
    let snap;
    try {
      snap = await db.collection('email_events').orderBy('updatedAt', 'desc').limit(100).get();
    } catch (idxErr) {
      // Fallback query if composite index is absent
      snap = await db.collection('email_events').limit(100).get();
    }
    const logs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Memory sort fallback to guarantee latest items are at the top
    logs.sort((a, b) => {
      const tA = new Date(a.updatedAt || a.lastAttemptAt || a.sentAt || a.createdAt || 0).getTime();
      const tB = new Date(b.updatedAt || b.lastAttemptAt || b.sentAt || b.createdAt || 0).getTime();
      return tB - tA;
    });

    res.json({ success: true, logs });
  } catch (error) {
    console.error('Fetch Email Logs Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/email-logs/retry', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { logId } = req.body;
    if (!logId) {
      return res.status(400).json({ success: false, error: 'logId is required' });
    }
    const logRef = db.collection('email_events').doc(logId);
    const logDoc = await logRef.get();

    if (!logDoc.exists) {
      return res.status(404).json({ success: false, error: 'Email log not found.' });
    }

    const data = logDoc.data();
    const result = await sendIdempotentEmail({
      db,
      eventType: data.eventType,
      bookingId: data.bookingId,
      recipient: data.recipient,
      subject: data.subject,
      html: data.html || `<p>Official Notification from PARVA for event ${data.eventType}.</p>`,
      isRetry: true
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error('Retry Email Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/email/test', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { to = 'devanshkadam2@gmail.com', role = 'customer' } = req.body;

    let subject = '🎉 PARVA Email Automation Test — Resend API Active';
    let roleHtml = '<p>This is a live test email confirming your <strong>Resend API</strong> integration is working with 100% reliability!</p>';

    if (role === 'vendor') {
      subject = '🔔 PARVA Vendor Alert — Test Notification';
      roleHtml = '<p>This is a test notification for <strong>Vendor Partner</strong> accounts regarding new booking alerts and payouts.</p>';
    } else if (role === 'admin') {
      subject = '⚡ PARVA Admin Alert — Test Notification';
      roleHtml = '<p>This is a test notification for <strong>PARVA Administration</strong> regarding system health and transaction alerts.</p>';
    }

    const result = await sendIdempotentEmail({
      db,
      eventType: `TEST_EMAIL_${role.toUpperCase()}`,
      bookingId: `TEST-${Date.now().toString().slice(-4)}`,
      recipient: to,
      subject,
      html: `
        <div style="font-family: sans-serif; padding: 24px; color: #0f172a; max-width: 500px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px;">
          <h2 style="color: #9d174d;">PARVA Celebrations</h2>
          ${roleHtml}
          <div style="background: #f8fafc; padding: 12px; border-radius: 8px; font-size: 13px; margin-top: 12px;">
            <p style="margin: 4px 0;"><strong>Role:</strong> ${role.toUpperCase()}</p>
            <p style="margin: 4px 0;"><strong>Recipient:</strong> ${to}</p>
            <p style="margin: 4px 0;"><strong>Status:</strong> Active & Operational</p>
            <p style="margin: 4px 0;"><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
          </div>
        </div>
      `,
      isRetry: true
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error('Test Email Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// A.3 Fetch Current Email System Settings (Admin Only)
app.get('/api/admin/email-settings', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const configured = isResendConfigured();
    const maskedKey = getMaskedResendApiKey();
    const senderFrom = process.env.EMAIL_FROM || 'PARVA Celebrations <notifications@myparva.com>';

    let dbSettings = null;
    if (db) {
      const doc = await db.collection('system_settings').doc('email').get();
      if (doc.exists) {
        dbSettings = doc.data();
      }
    }

    res.json({
      success: true,
      isConfigured: configured,
      maskedKey,
      senderFrom,
      source: dbSettings?.resendApiKey ? 'firestore_settings' : (process.env.RESEND_API_KEY && !process.env.RESEND_API_KEY.includes('PASTE_YOUR') ? 'environment_variable' : 'unconfigured'),
      lastUpdatedAt: dbSettings?.updatedAt || null,
      updatedBy: dbSettings?.updatedBy || null
    });
  } catch (error) {
    console.error('Fetch Email Settings Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// A.4 Update & Persist Resend API Key (Admin Only)
app.post('/api/admin/email-settings', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { resendApiKey, senderFrom } = req.body;
    const cleanKey = (resendApiKey || '').trim();

    if (!cleanKey || !cleanKey.startsWith('re_') || cleanKey.length < 15) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Resend API Key. A valid key starts with "re_" and is at least 15 characters long.'
      });
    }

    const applied = setDynamicResendApiKey(cleanKey);
    if (!applied) {
      return res.status(400).json({ success: false, error: 'Could not apply Resend API key.' });
    }

    if (db) {
      await db.collection('system_settings').doc('email').set({
        resendApiKey: cleanKey,
        senderFrom: senderFrom || process.env.EMAIL_FROM || 'PARVA Celebrations <notifications@myparva.com>',
        updatedAt: new Date().toISOString(),
        updatedBy: req.user.email || req.user.uid || 'admin'
      }, { merge: true });
    }

    console.log(`[Admin] Resend API Key successfully updated by ${req.user.email}`);

    res.json({
      success: true,
      message: 'Resend API Key updated and applied successfully.',
      isConfigured: true,
      maskedKey: getMaskedResendApiKey()
    });
  } catch (error) {
    console.error('Update Email Settings Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// A.5 Live Resend Connectivity & Render Health Check (Admin Only)
app.get(['/api/admin/email-health', '/api/email/health'], verifyAuth, requireAdmin, async (req, res) => {
  try {
    const health = await verifyResendHealth();
    res.status(health.healthy ? 200 : 200).json(health);
  } catch (error) {
    console.error('Email Health Diagnostic Error:', error);
    res.status(500).json({ success: false, healthy: false, error: error.message });
  }
});

app.post('/api/admin/email-health/check', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const health = await verifyResendHealth();
    res.json(health);
  } catch (error) {
    console.error('Email Health Check Error:', error);
    res.status(500).json({ success: false, healthy: false, error: error.message });
  }
});

// ==================== 4. EXISTING ADMIN & SYSTEM ROUTES ====================

// Authoritative Sync User: Derives UID and Email strictly from verified Firebase token
app.post('/api/admin/sync-user', verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const email = (req.user.email || '').toLowerCase().trim();
    const name = req.user.name || req.body.name || 'Admin';
    const adminEmails = [
      'devenshkadam2@gmail.com',
      'devanshkadam2@gmail.com',
      'devansh@parva.com',
      'admin@myparva.com',
      'rohan@myparva.com'
    ];
    
    if (adminEmails.includes(email)) {
      if (db) {
        await db.collection('users').doc(uid).set({
          uid,
          email,
          name,
          role: 'master_admin',
          city: 'Mumbai',
          syncedAt: new Date().toISOString()
        }, { merge: true });

        await db.collection('admins').doc(uid).set({
          uid,
          email,
          name,
          role: 'master_admin',
          updatedAt: new Date().toISOString()
        }, { merge: true });
      }
      return res.json({ success: true, role: 'master_admin' });
    }
    return res.status(403).json({ success: false, error: 'Not authorized for master administrator synchronization.' });
  } catch (err) {
    console.error("Sync User Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/dashboard', verifyAuth, requireAdmin, async (req, res) => {
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

app.post('/api/admin/categories', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { id, name, icon, iconName, image, status = 'active', displayOrder = 100, description = '', services = [] } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Category Name is required.' });
    }
    const cleanId = (id || name.toLowerCase().trim().replace(/[^a-z0-9]/g, '-')).toLowerCase().trim();
    const cleanName = name.trim();
    const cleanStatus = status === 'inactive' ? 'inactive' : 'active';
    const cleanOrder = Number(displayOrder) || 100;
    const cleanServices = Array.isArray(services) ? services.map(s => String(s).trim()).filter(Boolean) : [];

    const catData = {
      id: cleanId,
      name: cleanName,
      icon: icon || iconName || 'Sparkles',
      iconName: iconName || icon || 'Sparkles',
      image: image || 'https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&q=80&w=400',
      imageUrl: image || 'https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&q=80&w=400',
      status: cleanStatus,
      displayOrder: cleanOrder,
      description: String(description || '').trim(),
      services: cleanServices,
      updatedAt: new Date().toISOString()
    };

    await db.collection('categories').doc(cleanId).set(catData, { merge: true });
    res.json({ success: true, category: catData });
  } catch (error) {
    console.error('Admin Add Category Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/admin/categories/:id', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection('categories').doc(id).delete();
    res.json({ success: true, message: `Category ${id} deleted successfully.` });
  } catch (error) {
    console.error('Admin Delete Category Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/settings/:docId?', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const docId = req.params.docId || 'global';
    const docSnap = await db.collection('settings').doc(docId).get();
    if (docSnap.exists) {
      return res.json({ success: true, settings: docSnap.data() });
    }
    // Return standard defaults if not yet created
    const defaults = {
      commissionPercentage: 10,
      fixedCommissionFee: 0,
      bookingFeePercentage: 5,
      paymentsEnabled: true,
      supportEmail: 'support@parva.com',
      termsVersion: '1.2'
    };
    return res.json({ success: true, settings: defaults });
  } catch (error) {
    console.error('Admin Get Settings Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/settings', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const docId = req.body.docId || 'global';
    const rawData = req.body.data || req.body;
    
    // Sanitize and extract platform policy attributes
    const settingsData = {
      ...rawData,
      commissionPercentage: rawData.commissionPercentage !== undefined ? Number(rawData.commissionPercentage) : 10,
      fixedCommissionFee: rawData.fixedCommissionFee !== undefined ? Number(rawData.fixedCommissionFee) : 0,
      bookingFeePercentage: rawData.bookingFeePercentage !== undefined ? Number(rawData.bookingFeePercentage) : 5,
      paymentsEnabled: rawData.paymentsEnabled !== undefined ? Boolean(rawData.paymentsEnabled) : true,
      supportEmail: rawData.supportEmail ? String(rawData.supportEmail).trim() : 'support@parva.com',
      termsVersion: rawData.termsVersion ? String(rawData.termsVersion).trim() : '1.2',
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.email || 'admin'
    };
    // Remove docId and data wrapper if present
    delete settingsData.docId;
    delete settingsData.data;

    await db.collection('settings').doc(docId).set(settingsData, { merge: true });
    console.log(`[Admin Settings] Saved settings/${docId}:`, settingsData);

    res.json({ success: true, message: 'Settings saved and published successfully.', settings: settingsData });
  } catch (error) {
    console.error('Admin Save Settings Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Dedicated Centralized Branding & Logo Settings (Admin Only)
app.post('/api/admin/branding', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { logoUrl, logoAltText = 'myparva.com', logoDarkUrl, compactLogoUrl } = req.body;
    if (!logoUrl || typeof logoUrl !== 'string') {
      return res.status(400).json({ success: false, error: 'logoUrl is required and must be a valid string URL.' });
    }

    if (!logoUrl.startsWith('http://') && !logoUrl.startsWith('https://')) {
      return res.status(400).json({ success: false, error: 'Invalid logo URL format. Must start with http:// or https://' });
    }

    if (!db) {
      return res.status(503).json({ success: false, error: 'Database service is currently unavailable.' });
    }

    const settingsRef = db.collection('settings').doc('global');
    const currentSnap = await settingsRef.get();
    const currentData = currentSnap.exists ? currentSnap.data() : {};
    const previousLogoUrl = currentData.logoUrl || null;

    const now = new Date().toISOString();
    const brandingPayload = {
      logoUrl: logoUrl.trim(),
      logoAltText: String(logoAltText || 'myparva.com').trim(),
      logoUpdatedAt: now,
      logoUpdatedBy: req.user?.email || req.user?.uid || 'admin',
      previousLogoUrl: previousLogoUrl && previousLogoUrl !== logoUrl ? previousLogoUrl : (currentData.previousLogoUrl || null),
      ...(logoDarkUrl ? { logoDarkUrl: String(logoDarkUrl).trim() } : {}),
      ...(compactLogoUrl ? { compactLogoUrl: String(compactLogoUrl).trim() } : {})
    };

    await settingsRef.set(brandingPayload, { merge: true });

    // Emitting audit trail
    await db.collection('audit_logs').add({
      action: 'UPDATE_BRANDING_LOGO',
      performedBy: req.user?.email || req.user?.uid,
      logoUrl: brandingPayload.logoUrl,
      previousLogoUrl: brandingPayload.previousLogoUrl,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});

    console.log(`[Branding] Authoritative logo updated by ${brandingPayload.logoUpdatedBy}: ${brandingPayload.logoUrl}`);
    return res.json({
      success: true,
      message: 'Branding logo published successfully across all platforms.',
      branding: brandingPayload
    });
  } catch (error) {
    console.error('Admin Branding Update Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

const OFFICIAL_DEFAULT_LOGO = 'https://res.cloudinary.com/k03rmhkg/image/upload/v1792254596/parva_branding/myparva_official_logo.png';

// Public Branding Configuration Endpoint (Accessible to all frontends & apps)
app.get('/api/branding', async (req, res) => {
  try {
    if (db) {
      const docSnap = await db.collection('settings').doc('global').get();
      if (docSnap.exists) {
        const data = docSnap.data();
        return res.json({
          success: true,
          logoUrl: data.logoUrl || OFFICIAL_DEFAULT_LOGO,
          logoAltText: data.logoAltText || 'myparva.com',
          logoUpdatedAt: data.logoUpdatedAt || null,
          previousLogoUrl: data.previousLogoUrl || null
        });
      }
    }
    return res.json({
      success: true,
      logoUrl: OFFICIAL_DEFAULT_LOGO,
      logoAltText: 'myparva.com',
      logoUpdatedAt: null,
      previousLogoUrl: null
    });
  } catch (err) {
    return res.json({
      success: true,
      logoUrl: OFFICIAL_DEFAULT_LOGO,
      logoAltText: 'myparva.com',
      logoUpdatedAt: null
    });
  }
});

app.post('/api/admin/reset-defaults', verifyAuth, requireAdmin, async (req, res) => {
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
app.post('/api/admin/broadcast', verifyAuth, requireAdmin, async (req, res) => {
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
app.get('/api/admin/coupons', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const snap = await db.collection('coupons').get();
    const coupons = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, coupons });
  } catch (error) {
    console.error('Fetch Coupons Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/coupons', verifyAuth, requireAdmin, async (req, res) => {
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

app.delete('/api/admin/coupons/:id', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection('coupons').doc(id).delete();
    res.json({ success: true, message: `Coupon ${id} deleted successfully.` });
  } catch (error) {
    console.error('Delete Coupon Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// C. Cities Operations Route (Public Read, Admin Write)
app.get('/api/admin/cities', async (req, res) => {
  try {
    const docSnap = await db.collection('settings').doc('cities').get();
    const data = docSnap.exists ? docSnap.data() : {};
    const operationalCities = Array.isArray(data.operationalCities) && data.operationalCities.length > 0
      ? data.operationalCities
      : DEFAULT_OPERATIONAL_CITIES;
    const blockedCities = Array.isArray(data.blockedCities) ? data.blockedCities : [];

    res.json({
      success: true,
      operationalCities,
      blockedCities
    });
  } catch (error) {
    console.error('Fetch Cities Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/cities', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { blockedCities, operationalCities } = req.body;
    const cleanBlocked = Array.isArray(blockedCities) ? blockedCities.map(c => String(c).trim()).filter(Boolean) : [];
    
    // If operationalCities is provided, persist it, otherwise preserve existing or default
    const existingSnap = await db.collection('settings').doc('cities').get();
    const existingData = existingSnap.exists ? existingSnap.data() : {};
    const cleanOperational = Array.isArray(operationalCities) && operationalCities.length > 0
      ? Array.from(new Set(operationalCities.map(c => String(c).trim()).filter(Boolean)))
      : (Array.isArray(existingData.operationalCities) && existingData.operationalCities.length > 0 ? existingData.operationalCities : DEFAULT_OPERATIONAL_CITIES);

    await db.collection('settings').doc('cities').set({
      blockedCities: cleanBlocked,
      operationalCities: cleanOperational,
      updatedAt: new Date().toISOString()
    }, { merge: true });

    res.json({
      success: true,
      operationalCities: cleanOperational,
      blockedCities: cleanBlocked
    });
  } catch (error) {
    console.error('Save Cities Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// D. Vendor Verification / Status Update Route
app.patch('/api/admin/vendors/:id/status', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { approved, verificationStatus, status, rejectionReason } = req.body;
    const updateData = {
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.email || 'admin'
    };
    if (approved !== undefined) updateData.approved = Boolean(approved);
    if (verificationStatus) updateData.verificationStatus = String(verificationStatus);
    if (status) updateData.status = String(status);
    if (rejectionReason !== undefined) updateData.rejectionReason = String(rejectionReason);
    if (approved === true) updateData.approvedAt = new Date().toISOString();
    if (approved === false && rejectionReason) updateData.rejectedAt = new Date().toISOString();

    await db.collection('vendors').doc(id).set(updateData, { merge: true });
    res.json({ success: true, message: `Vendor ${id} status updated successfully.`, vendor: updateData });
  } catch (error) {
    console.error('Admin Update Vendor Status Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Admin Vendor Full Management Routes (Authoritative Admin SDK Save / Update)
app.post(['/api/admin/vendors', '/api/admin/vendors/:id'], verifyAuth, requireAdmin, async (req, res) => {
  try {
    const targetId = req.params.id || req.body.id || `vendor-${Date.now()}`;
    const vendorData = { ...req.body };
    delete vendorData.id;

    // Sanitize any undefined properties to omit them
    Object.keys(vendorData).forEach(key => {
      if (vendorData[key] === undefined) {
        delete vendorData[key];
      }
    });

    vendorData.updatedAt = new Date().toISOString();
    vendorData.updatedBy = req.user?.email || 'admin';

    await db.collection('vendors').doc(targetId).set(vendorData, { merge: true });
    console.log(`[Admin] Successfully saved vendor ${targetId}`);

    res.json({
      success: true,
      message: `Vendor ${targetId} saved successfully.`,
      id: targetId,
      vendor: vendorData
    });
  } catch (error) {
    console.error('Admin Save Vendor Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/admin/vendors/:id', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const vendorData = { ...req.body };
    delete vendorData.id;

    Object.keys(vendorData).forEach(key => {
      if (vendorData[key] === undefined) {
        delete vendorData[key];
      }
    });

    vendorData.updatedAt = new Date().toISOString();
    vendorData.updatedBy = req.user?.email || 'admin';

    await db.collection('vendors').doc(id).set(vendorData, { merge: true });
    console.log(`[Admin] Successfully updated vendor ${id}`);

    res.json({
      success: true,
      message: `Vendor ${id} updated successfully.`,
      id,
      vendor: vendorData
    });
  } catch (error) {
    console.error('Admin Update Vendor Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/admin/vendors/:id', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection('vendors').doc(id).delete();
    console.log(`[Admin] Successfully deleted vendor ${id}`);
    res.json({ success: true, message: `Vendor ${id} deleted successfully.` });
  } catch (error) {
    console.error('Admin Delete Vendor Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// E. Public Unified Catalog Read Endpoints (Data-Driven Single Source of Truth)
app.get('/api/catalog/categories', async (req, res) => {
  try {
    const snap = await db.collection('categories').get();
    let categories = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    if (categories.length === 0) {
      categories = DEFAULT_CATEGORIES;
    }
    // Filter active categories and sort by displayOrder
    const activeCategories = categories
      .filter(c => c.status !== 'inactive')
      .sort((a, b) => (Number(a.displayOrder) || 100) - (Number(b.displayOrder) || 100));

    res.json({ success: true, categories: activeCategories });
  } catch (error) {
    console.error('Catalog Categories Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/catalog/cities', async (req, res) => {
  try {
    const docSnap = await db.collection('settings').doc('cities').get();
    const data = docSnap.exists ? docSnap.data() : {};
    const operational = Array.isArray(data.operationalCities) && data.operationalCities.length > 0
      ? data.operationalCities
      : DEFAULT_OPERATIONAL_CITIES;
    const blocked = Array.isArray(data.blockedCities) ? data.blockedCities : [];
    const activeCities = operational.filter(city => !blocked.includes(city));

    res.json({ success: true, cities: activeCities, allOperational: operational, blocked });
  } catch (error) {
    console.error('Catalog Cities Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Production Error and 404 Handlers
app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`PARVA Backend & Resend Email Service listening on port ${PORT}`);
});
