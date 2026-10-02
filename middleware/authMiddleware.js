/**
 * PARVA PLATFORM — FIREBASE ID TOKEN & AUTHORIZATION MIDDLEWARE
 * Production Security Hardening — Phase 1
 */

import admin from 'firebase-admin';

// Whitelist of authoritative master administrators
const AUTHORITATIVE_ADMIN_EMAILS = [
  'devanshkadam2@gmail.com',
  'devenshkadam2@gmail.com',
  'devansh@parva.com',
  'admin@myparva.com',
  'rohan@myparva.com'
];

/**
 * 1. Strict Authentication Middleware
 * Validates Bearer ID Token using Firebase Admin SDK.
 * Rejects missing or invalid tokens with HTTP 401.
 */
export async function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: { code: 'AUTH_REQUIRED', message: 'Authentication required. Missing Bearer token in Authorization header.' }
    });
  }

  const idToken = authHeader.split('Bearer ')[1].trim();
  if (!idToken) {
    return res.status(401).json({
      success: false,
      error: { code: 'AUTH_REQUIRED', message: 'Authentication token cannot be empty.' }
    });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || '',
      phone: decodedToken.phone_number || '',
      name: decodedToken.name || '',
      role: decodedToken.role || 'customer',
      claims: decodedToken
    };
    next();
  } catch (error) {
    console.warn('[AuthMiddleware] Token verification failed:', error.message);
    return res.status(401).json({
      success: false,
      error: { code: 'INVALID_TOKEN', message: 'Authentication token is invalid or has expired.' }
    });
  }
}

/**
 * 2. Optional Authentication Middleware
 * Extracts and verifies ID Token if supplied; does not reject guest/unauthenticated calls.
 */
export async function verifyOptionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const idToken = authHeader.split('Bearer ')[1].trim();
  if (!idToken) {
    req.user = null;
    return next();
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || '',
      phone: decodedToken.phone_number || '',
      name: decodedToken.name || '',
      role: decodedToken.role || 'customer',
      claims: decodedToken
    };
    next();
  } catch (error) {
    console.warn('[AuthMiddleware] Optional token verification notice:', error.message);
    // If client explicitly sent a corrupted or forged token, reject with 401
    return res.status(401).json({
      success: false,
      error: { code: 'INVALID_TOKEN', message: 'Provided authentication token is invalid or has expired.' }
    });
  }
}

/**
 * 3. Role-Based Authorization
 */
export function requireRole(allowedRoles = []) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You do not have required role permissions to access this resource.' }
      });
    }
    next();
  };
}

/**
 * 4. Authoritative Admin Guard
 * Checks:
 *   a) Firebase Token claim (role === 'admin' | 'master_admin')
 *   b) Master administrator email whitelist
 *   c) Firestore users/{uid} document role
 *   d) Firestore admins/{uid} document existence
 */
export async function requireAdmin(req, res, next) {
  if (!req.user || !req.user.uid) {
    return res.status(401).json({
      success: false,
      error: { code: 'AUTH_REQUIRED', message: 'Authentication required for administrative operations.' }
    });
  }

  const userEmail = (req.user.email || '').toLowerCase().trim();

  // A. Check Master Admin Email Whitelist
  if (userEmail && AUTHORITATIVE_ADMIN_EMAILS.includes(userEmail)) {
    req.user.isAdmin = true;
    return next();
  }

  // B. Check Custom Claims in Token
  if (['admin', 'master_admin'].includes(req.user.role) || req.user.claims?.admin === true) {
    req.user.isAdmin = true;
    return next();
  }

  // C. Check Firestore Authoritative Database
  try {
    if (admin.apps.length > 0) {
      const db = admin.firestore();

      // Check users/{uid} collection
      const userDoc = await db.collection('users').doc(req.user.uid).get();
      if (userDoc.exists) {
        const uData = userDoc.data();
        if (['admin', 'master_admin'].includes(uData.role) || uData.isAdmin === true) {
          req.user.isAdmin = true;
          return next();
        }
      }

      // Check admins/{uid} collection
      const adminDoc = await db.collection('admins').doc(req.user.uid).get();
      if (adminDoc.exists) {
        req.user.isAdmin = true;
        return next();
      }
    }
  } catch (dbErr) {
    console.error('[AuthMiddleware] Error checking admin database record:', dbErr.message);
  }

  return res.status(403).json({
    success: false,
    error: { code: 'FORBIDDEN_ADMIN_REQUIRED', message: 'Administrator access denied. Insufficient privileges.' }
  });
}

/**
 * 5. Authoritative Vendor Guard
 * Verifies that the authenticated user owns or is authorized for the vendor resource.
 * Admin users are granted access for operational supervision.
 */
export async function requireVendor(req, res, next) {
  if (!req.user || !req.user.uid) {
    return res.status(401).json({
      success: false,
      error: { code: 'AUTH_REQUIRED', message: 'Authentication required for vendor operations.' }
    });
  }

  // Allow admins to perform or assist vendor actions
  const userEmail = (req.user.email || '').toLowerCase().trim();
  if (userEmail && AUTHORITATIVE_ADMIN_EMAILS.includes(userEmail)) {
    req.user.isAdmin = true;
    return next();
  }

  const requestedVendorId = req.params.vendorId || req.body.vendorId;
  const bookingId = req.params.id || req.body.bookingId;
  const userUid = req.user.uid;

  try {
    if (admin.apps.length > 0) {
      const db = admin.firestore();

      // Case A: Vendor response to a booking
      if (bookingId) {
        const bookingDoc = await db.collection('bookings').doc(bookingId).get();
        if (!bookingDoc.exists) {
          return res.status(404).json({ success: false, error: 'Booking not found.' });
        }
        const bData = bookingDoc.data();
        const bVendorId = bData.vendor?.id || bData.vendorId;
        const bOwnerUid = bData.vendorOwnerUid || bData.vendor?.ownerUid;

        // Verify if authenticated UID matches vendor ID, owner UID, or vendor document owner
        if (userUid === bVendorId || userUid === bOwnerUid) {
          return next();
        }

        if (bVendorId) {
          const vDoc = await db.collection('vendors').doc(bVendorId).get();
          if (vDoc.exists) {
            const vData = vDoc.data();
            if (vData.ownerUid === userUid || vData.userId === userUid || vDoc.id === userUid) {
              return next();
            }
          }
        }

        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN_VENDOR_MISMATCH', message: 'Unauthorized: You do not own this vendor booking.' }
        });
      }

      // Case B: Direct vendor profile or catalogue operation
      if (requestedVendorId) {
        if (userUid === requestedVendorId) {
          return next();
        }
        const vDoc = await db.collection('vendors').doc(requestedVendorId).get();
        if (vDoc.exists) {
          const vData = vDoc.data();
          if (vData.ownerUid === userUid || vData.userId === userUid) {
            return next();
          }
        }
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN_VENDOR_MISMATCH', message: 'Unauthorized: You do not own this vendor entity.' }
        });
      }
    }
  } catch (err) {
    console.error('[AuthMiddleware] Error checking vendor ownership:', err.message);
  }

  // Fallback: Check if UID matches directly
  if (requestedVendorId && userUid === requestedVendorId) {
    return next();
  }

  return res.status(403).json({
    success: false,
    error: { code: 'FORBIDDEN_VENDOR_MISMATCH', message: 'Unauthorized: Vendor identity verification failed.' }
  });
}
