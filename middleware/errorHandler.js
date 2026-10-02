/**
 * PARVA PLATFORM — GLOBAL PRODUCTION ERROR HANDLER
 * Version 2.0.0
 */

export function errorHandler(err, req, res, next) {
  const statusCode = err.status || err.statusCode || 500;
  const isProd = process.env.NODE_ENV === 'production';

  // Server-side diagnostic log with full error stack
  console.error('[UNCAUGHT_ERROR]', {
    requestId: req.id,
    path: req.originalUrl || req.path,
    method: req.method,
    message: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString()
  });

  // Clean, sanitized client response (never leak internal stack traces in production)
  const clientResponse = {
    success: false,
    error: {
      code: err.code || (statusCode === 404 ? 'NOT_FOUND' : statusCode === 403 ? 'FORBIDDEN' : statusCode === 401 ? 'UNAUTHORIZED' : 'INTERNAL_SERVER_ERROR'),
      message: err.message || 'An unexpected error occurred. Please try again later.',
      requestId: req.id
    }
  };

  if (!isProd && err.stack) {
    clientResponse.error.debugStack = err.stack.split('\n').slice(0, 4);
  }

  res.status(statusCode).json(clientResponse);
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `The requested endpoint ${req.originalUrl || req.path} was not found on this server.`,
      requestId: req.id
    }
  });
}