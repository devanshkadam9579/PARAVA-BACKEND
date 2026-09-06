/**
 * PARVA PLATFORM — PRODUCTION SECURITY & RELIABILITY MIDDLEWARE
 * Version 2.0.0
 */

import crypto from 'crypto';

// 1. Unique Request ID & Tracing
export function requestIdMiddleware(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

// 2. Production Security Headers
export function securityHeadersMiddleware(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  next();
}

// 3. Sliding Window In-Memory Rate Limiter
const rateLimitMap = new Map();

export function rateLimiter({ windowMs = 60 * 1000, maxRequests = 100, message = 'Too many requests. Please try again later.' } = {}) {
  // Periodic cleanup of expired rate limit entries every 5 minutes
  if (!rateLimiter._cleanupInterval) {
    rateLimiter._cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, record] of rateLimitMap.entries()) {
        if (now - record.startTime > windowMs) {
          rateLimitMap.delete(key);
        }
      }
    }, 5 * 60 * 1000);
    rateLimiter._cleanupInterval.unref();
  }

  return (req, res, next) => {
    // Exclude health checks from rate limiting
    if (req.path === '/health' || req.path === '/api/health') {
      return next();
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown-ip';
    const key = ${ip}:;
    const now = Date.now();

    let record = rateLimitMap.get(key);
    if (!record || now - record.startTime > windowMs) {
      record = { count: 1, startTime: now };
      rateLimitMap.set(key, record);
      return next();
    }

    record.count++;
    if (record.count > maxRequests) {
      const retryAfterSec = Math.ceil((record.startTime + windowMs - now) / 1000);
      res.setHeader('Retry-After', retryAfterSec);
      return res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message,
          retryAfterSeconds: retryAfterSec,
          requestId: req.id
        }
      });
    }

    next();
  };
}

// 4. Safe Structured Request Logger (Sanitizes Sensitive Fields)
export function structuredLogger(req, res, next) {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const durationMs = Date.now() - startTime;
    const logEntry = {
      requestId: req.id,
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl || req.path,
      statusCode: res.statusCode,
      durationMs,
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress,
      userUid: req.user?.uid || null,
      role: req.user?.role || null
    };

    // Safe log output - never log credentials, tokens, or payment secrets
    if (res.statusCode >= 500) {
      console.error('[API_ERROR]', JSON.stringify(logEntry));
    } else if (res.statusCode >= 400) {
      console.warn('[API_WARN]', JSON.stringify(logEntry));
    } else {
      console.log('[API_INFO]', ${logEntry.method}   in ms []);
    }
  });

  next();
}