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
import { calculateVendorCommission } from './services/commissionService.js';
import {
  sendBookingCreatedEmail,
  sendPaymentAndBookingConfirmedEmails,
  sendBookingCancellationEmail,
  sendRefundProcessedEmail,
  sendIdempotentEmail
} from './services/emailService.js';

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

// Initialize Razorpay SDK
// Initialize Cloudinary SDK
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'k03rmhkg',
  api_key: process.env.CLOUDINARY_API_KEY || '354754454388942',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'VJnWw6rsG05nPmBLOiUS5r0VDPw'
});

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_TE7IEPsVrpMrj7',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'BTTxm1K1lZj7VeTKlDdYYeYO',
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

const PORT = process.env.PORT || 5000;

// ==================== CLOUDINARY DIRECT UPLOAD ROUTE ====================
app.post('/api/upload/image', async (req, res) => {
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
  res.json({ status: 'ok', message: 'PARVA Celebrations Backend & Resend Email Automation Engine is Active!' });
});

// Middleware to check DB
app.use((req, res, next) => {
  if (!db && req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Database not initialized. Missing Service Account.' });
  }
  next();
});

// ==================== 1. PAYMENT & VERIFICATION ROUTES ====================

app.post('/api/payments/initiate', async (req, res) => {
  try {
    const { userId, vendorId, type, amount } = req.body;
    
    let subtotal = 0;
    let commissionAmount = 0;
    let gstAmount = 0;
    let connectionFee = 0;
    let total = 0;

    if (type === 'connection') {
      connectionFee = 499;
      gstAmount = Math.round(connectionFee * 0.18 * 100) / 100;
      total = connectionFee + gstAmount;
    } else if (type === 'booking') {
      subtotal = Number(amount) || 0;
      
      // Fetch dynamic commission settings from Admin settings
      let commissionPct = 10;
      if (db) {
        try {
          const settingsDoc = await db.collection('settings').doc('global').get();
          if (settingsDoc.exists && settingsDoc.data().commissionPercentage) {
            commissionPct = Number(settingsDoc.data().commissionPercentage);
          }
        } catch (e) {
          console.warn("Could not fetch commission settings, defaulting to 10%:", e);
        }
      }

      const commissionData = calculateVendorCommission(subtotal, { commissionPercentage: commissionPct });
      commissionAmount = commissionData.platformCommission;
      gstAmount = commissionData.gstOnCommission;
      total = subtotal; // Customer pays the booking amount
    } else {
      return res.status(400).json({ error: 'Invalid payment type requested.' });
    }

    const options = {
      amount: Math.round(total * 100),
      currency: "INR",
      receipt: `receipt_${Date.now()}`
    };

    const order = await razorpay.orders.create(options);
    
    res.json({
      success: true,
      orderId: order.id,
      keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_TE7IEPsVrpMrj7',
      amount: total,
      subtotal,
      connectionFee,
      commissionAmount,
      gstAmount
    });
  } catch (error) {
    console.error('Initiate Payment Error:', error);
    res.status(500).json({ error: error.message || 'Payment initiation failed' });
  }
});

app.post('/api/payments/verify', async (req, res) => {
  try {
    const { 
      razorpay_payment_id, 
      razorpay_order_id, 
      razorpay_signature,
      userId,
      vendorId,
      type,
      totalAmount,
      bookingData,
      customerData
    } = req.body;

    // Validate Signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || 'BTTxm1K1lZj7VeTKlDdYYeYO')
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature." });
    }

    // Fetch dynamic commission settings
    let commissionPct = 10;
    let termsVersion = '1.2';
    if (db) {
      try {
        const settingsDoc = await db.collection('settings').doc('global').get();
        if (settingsDoc.exists) {
          const sData = settingsDoc.data();
          if (sData.commissionPercentage) commissionPct = Number(sData.commissionPercentage);
          if (sData.termsVersion) termsVersion = sData.termsVersion;
        }
      } catch (e) { }
    }

    const commissionData = calculateVendorCommission(Number(totalAmount) || 0, { commissionPercentage: commissionPct });

    // Save transaction
    const transactionId = `txn_${Date.now()}`;
    const transactionData = {
      id: transactionId,
      userId: userId || 'Guest',
      vendorId: vendorId || 'System',
      type: type || 'booking',
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      totalAmount: Number(totalAmount) || 0,
      platformCommission: commissionData.platformCommission,
      gstOnCommission: commissionData.gstOnCommission,
      vendorPayout: commissionData.vendorPayout,
      status: 'Paid',
      termsVersion,
      termsAcceptedAt: new Date().toISOString(),
      timestamp: new Date().toISOString()
    };
    
    await db.collection('transactions').doc(transactionId).set(transactionData);

    // If it's a booking, update status & trigger confirmation workflows
    let confirmedBooking = null;
    if (type === 'booking' && bookingData) {
      const bookingId = bookingData.id || `b_${Date.now()}`;
      confirmedBooking = {
        ...bookingData,
        id: bookingId,
        paymentStatus: 'Paid',
        status: 'Confirmed',
        transactionId,
        paymentId: razorpay_payment_id,
        orderId: razorpay_order_id,
        commissionBreakdown: commissionData,
        termsVersion,
        termsAcceptedAt: new Date().toISOString(),
        confirmedAt: new Date().toISOString()
      };

      await db.collection('bookings').doc(bookingId).set(confirmedBooking, { merge: true });

      // Create Lead record
      const leadId = `lead_${Date.now()}`;
      await db.collection('leads').doc(leadId).set({
        id: leadId,
        bookingId,
        vendorId: bookingData.vendor?.id || vendorId,
        vendorName: bookingData.vendor?.name || 'Event Partner',
        customerName: customerData?.name || bookingData.customerName || 'Valued Customer',
        customerPhone: customerData?.phone || bookingData.customerPhone || 'N/A',
        customerEmail: customerData?.email || bookingData.customerEmail || 'N/A',
        eventDate: bookingData.eventDate,
        eventType: bookingData.eventType || 'Celebration',
        amount: Number(totalAmount) || 0,
        status: 'Confirmed & Paid',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Generate Official Confirmation & Invoice PDF
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
          eventType: bookingData.eventType,
          totalAmount: Number(totalAmount) || 0,
          amountPaid: Number(totalAmount) || 0,
          paymentStatus: 'Paid',
          paymentId: razorpay_payment_id,
          orderId: razorpay_order_id,
          termsVersion,
          termsAcceptedAt: new Date().toISOString()
        });
      } catch (pdfErr) {
        console.error("Error generating booking PDF:", pdfErr);
      }

      // Backend Triggers Automated Emails via Resend
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

      // Trigger Email Automations in background (never block payment response)
      sendPaymentAndBookingConfirmedEmails({
        db,
        booking: confirmedBooking,
        customer,
        vendor,
        transaction: transactionData,
        pdfBuffer,
        commissionData
      }).catch(err => console.error("Email Automation Error:", err));

      // Trigger In-App Real-time Notification
      await db.collection('broadcast_notifications').add({
        title: `🎉 Booking Confirmed: #${bookingId}`,
        message: `Booking verified for ${bookingData.vendor?.name} on ${bookingData.eventDate}. Receipt sent to email!`,
        type: 'slot',
        vendorId: bookingData.vendor?.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({ success: true, transaction: transactionData, booking: confirmedBooking });
  } catch (error) {
    console.error('Verify Payment Error:', error);
    res.status(500).json({ error: error.message || 'Payment verification failed' });
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

// B. Booking Cancellation
app.post('/api/bookings/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = 'Customer requested cancellation', refundAmount = 0, customer, vendor } = req.body;

    const bookingRef = db.collection('bookings').doc(id);
    const bookingDoc = await bookingRef.get();
    
    if (!bookingDoc.exists) {
      return res.status(404).json({ success: false, error: 'Booking not found.' });
    }

    const updatedBooking = {
      ...bookingDoc.data(),
      status: 'Cancelled',
      cancellationReason: reason,
      refundAmount: Number(refundAmount) || 0,
      cancelledAt: new Date().toISOString()
    };

    await bookingRef.set(updatedBooking, { merge: true });

    // Trigger Cancellation Emails
    sendBookingCancellationEmail({
      db,
      booking: updatedBooking,
      customer: customer || { name: updatedBooking.customerName || 'Customer', email: updatedBooking.customerEmail },
      vendor: vendor || { name: updatedBooking.vendor?.name || 'Vendor', email: updatedBooking.vendor?.email },
      reason,
      refundAmount
    }).catch(err => console.error("Cancellation email error:", err));

    // In-App Notification
    await db.collection('broadcast_notifications').add({
      title: `⚠️ Booking Cancelled: #${id}`,
      message: `Booking for ${updatedBooking.vendor?.name || 'Vendor'} has been cancelled.`,
      type: 'system',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, booking: updatedBooking });
  } catch (error) {
    console.error('Cancel Booking Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// C. Refund Processed
app.post('/api/bookings/:id/refund', async (req, res) => {
  try {
    const { id } = req.params;
    const { refundAmount, refundId, customer } = req.body;

    const bookingRef = db.collection('bookings').doc(id);
    const bookingDoc = await bookingRef.get();
    
    if (!bookingDoc.exists) {
      return res.status(404).json({ success: false, error: 'Booking not found.' });
    }

    const refundData = {
      refundId: refundId || `rfd_${Date.now()}`,
      amount: Number(refundAmount) || bookingDoc.data().refundAmount || 0,
      processedAt: new Date().toISOString()
    };

    await bookingRef.set({
      refundStatus: 'Processed',
      refundData
    }, { merge: true });

    // Trigger Refund Email
    sendRefundProcessedEmail({
      db,
      booking: bookingDoc.data(),
      customer: customer || { name: bookingDoc.data().customerName || 'Customer', email: bookingDoc.data().customerEmail },
      refundData
    }).catch(err => console.error("Refund email error:", err));

    res.json({ success: true, refundData });
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

app.listen(PORT, () => {
  console.log(`PARVA Backend & Resend Email Service listening on port ${PORT}`);
});
