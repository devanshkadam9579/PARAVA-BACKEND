import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import admin from 'firebase-admin';
import { DEFAULT_CATEGORIES, DEFAULT_PROMOS, DEFAULT_VENDORS } from './seedData.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    console.log("Firebase Admin SDK initialized successfully.");
  } else {
    console.warn("WARNING: Firebase Admin not initialized. Missing FIREBASE_SERVICE_ACCOUNT_JSON in environment variables or serviceAccountKey.json locally.");
  }
} catch (error) {
  console.error("Firebase Admin Initialization Error:", error);
}

import { getFirestore } from 'firebase-admin/firestore';
import config from './firebase-applet-config.json' with { type: "json" };

const db = admin.apps.length > 0 
  ? (config.firestoreDatabaseId ? getFirestore(admin.apps[0], config.firestoreDatabaseId) : admin.firestore())
  : null;

// Initialize Razorpay SDK
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_TE7IEPsVrpMrj7',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'BTTxm1K1lZj7VeTKlDdYYeYO',
});

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'PARVA Backend is running successfully!' });
});

// Middleware to check DB
app.use((req, res, next) => {
  if (!db && req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Database not initialized. Missing Service Account.' });
  }
  next();
});

// 1. PAYMENT ROUTES
app.post('/api/payments/initiate', async (req, res) => {
  try {
    const { userId, vendorId, type, amount } = req.body;
    
    let subtotal = 0;
    let commissionAmount = 0;
    let gstAmount = 0;
    let connectionFee = 0;
    let total = 0;

    if (type === 'connection') {
      connectionFee = 499; // Flat connection fee to unlock chat
      gstAmount = Math.round(connectionFee * 0.18 * 100) / 100;
      total = connectionFee + gstAmount;
    } else if (type === 'booking') {
      subtotal = Number(amount) || 0;
      commissionAmount = Math.round(subtotal * 0.01 * 100) / 100; // 1% commission on vendor booking value
      gstAmount = Math.round(commissionAmount * 0.18 * 100) / 100; // 18% GST on commission
      total = commissionAmount + gstAmount;
    } else {
      return res.status(400).json({ error: 'Invalid payment type requested.' });
    }

    const options = {
      amount: Math.round(total * 100), // Razorpay accepts in paise
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
      commissionAmount,
      gstAmount,
      connectionFee,
      totalAmount
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

    // Save transaction to Firestore
    const transactionId = `txn_${Date.now()}`;
    const transactionData = {
      id: transactionId,
      userId: userId || 'Guest',
      vendorId: vendorId || 'System',
      type: type || 'connection',
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      commissionAmount: Number(commissionAmount) || 0,
      gstAmount: Number(gstAmount) || 0,
      connectionFee: Number(connectionFee) || 0,
      totalAmount: Number(totalAmount) || 0,
      status: 'Paid',
      timestamp: new Date().toISOString()
    };
    
    await db.collection('transactions').doc(transactionId).set(transactionData);

    // If it's a connection unlock, record it in connections collection to gate chat access
    if (type === 'connection' && userId && vendorId) {
      const connId = `${userId}_${vendorId}`;
      await db.collection('connections').doc(connId).set({
        id: connId,
        userId,
        vendorId,
        unlocked: true,
        timestamp: new Date().toISOString()
      });
    }

    res.json({ success: true, transaction: transactionData });
  } catch (error) {
    console.error('Verify Payment Error:', error);
    res.status(500).json({ error: error.message || 'Payment verification failed' });
  }
});

// Secure endpoint to sync master admin to users collection (bypassing client rules)
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

// 2. ADMIN DASHBOARD STATS ROUTE
app.get('/api/admin/dashboard', async (req, res) => {
  try {
    // Fetch users count
    const usersSnap = await db.collection('users').get();
    const totalUsers = usersSnap.size;

    // Fetch vendors count
    const vendorsSnap = await db.collection('vendors').get();
    const totalVendors = vendorsSnap.size;

    // Fetch bookings count
    const bookingsSnap = await db.collection('bookings').get();
    const totalBookings = bookingsSnap.size;

    // Fetch transaction totals
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
        totalCommission += (Number(data.commissionAmount) || 0);
        totalConnectionFees += (Number(data.connectionFee) || 0);
        
        recentTransactions.push(data);
      }
    });

    // Sort recent transactions by timestamp desc and take top 10
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

// 3. ADMIN RESET TO DEFAULTS ROUTE
app.post('/api/admin/reset-defaults', async (req, res) => {
  try {
    // 1. Delete all categories and write defaults
    const categoriesSnap = await db.collection('categories').get();
    for (const docSnap of categoriesSnap.docs) {
      await db.collection('categories').doc(docSnap.id).delete();
    }
    for (const cat of DEFAULT_CATEGORIES) {
      await db.collection('categories').doc(cat.id).set(cat);
    }

    // 2. Delete all promos and write defaults
    const promosSnap = await db.collection('promos').get();
    for (const docSnap of promosSnap.docs) {
      await db.collection('promos').doc(docSnap.id).delete();
    }
    for (const promo of DEFAULT_PROMOS) {
      await db.collection('promos').doc(promo.id).set(promo);
    }

    // 3. Delete all vendors and write defaults
    const vendorsSnap = await db.collection('vendors').get();
    for (const docSnap of vendorsSnap.docs) {
      await db.collection('vendors').doc(docSnap.id).delete();
    }
    for (const vendor of DEFAULT_VENDORS) {
      await db.collection('vendors').doc(vendor.id).set(vendor);
    }

    // 4. Optionally clear transactions
    const txnsSnap = await db.collection('transactions').get();
    for (const docSnap of txnsSnap.docs) {
      await db.collection('transactions').doc(docSnap.id).delete();
    }

    // 5. Optionally clear connections
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
  console.log(`PARVA Backend listening on port ${PORT}`);
});
