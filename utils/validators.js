/**
 * PARVA Validation Utilities
 * Strict validation for email addresses and Indian phone numbers
 */

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com',
  'tempmail.com',
  '10minutemail.com',
  'guerrillamail.com',
  'throwawaymail.com',
  'yopmail.com',
  'sharklasers.com',
  'fakeinbox.com',
  'dispostable.com',
  'trashmail.com',
  'temp-mail.org',
  'getairmail.com',
  'mytempemail.com',
  'getnada.com',
  'inboxkitten.com'
]);

// Standard Indian mobile number regex (10 digits starting with 6, 7, 8, 9)
const INDIAN_PHONE_REGEX = /^[6-9]\d{9}$/;

// RFC 5322 compliant email regex with valid TLD requirement
const STRICT_EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/**
 * Validates email format, domain, and disposable email providers.
 */
export function validateEmail(email) {
  if (!email || typeof email !== 'string') {
    return { isValid: false, error: 'Email address is required.' };
  }

  const trimmed = email.trim().toLowerCase();

  if (trimmed.length > 254) {
    return { isValid: false, error: 'Email address is too long (max 254 characters).' };
  }

  if (trimmed.includes('..')) {
    return { isValid: false, error: 'Email address cannot contain consecutive dots.' };
  }

  if (!STRICT_EMAIL_REGEX.test(trimmed)) {
    return { isValid: false, error: 'Please enter a valid email address (e.g. name@example.com).' };
  }

  const parts = trimmed.split('@');
  if (parts.length !== 2) {
    return { isValid: false, error: 'Please enter a valid email address.' };
  }

  const domain = parts[1];
  const domainParts = domain.split('.');
  const tld = domainParts[domainParts.length - 1];

  if (!tld || tld.length < 2 || !/^[a-zA-Z]{2,24}$/.test(tld)) {
    return { isValid: false, error: 'Email has an invalid top-level domain extension (e.g. .com, .in).' };
  }

  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    return { isValid: false, error: 'Disposable or temporary email addresses are not allowed.' };
  }

  return { isValid: true, email: trimmed };
}

/**
 * Validates and normalizes 10-digit Indian phone numbers.
 */
export function validateIndianPhone(phone) {
  if (!phone || typeof phone !== 'string') {
    return { isValid: false, error: 'Phone number is required.' };
  }

  // Strip all non-digit characters
  let digits = phone.replace(/\D/g, '');

  // Strip leading international code (+91 or 91) if 12 digits
  if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    // Strip leading 0 if 11 digits
    digits = digits.slice(1);
  }

  if (digits.length !== 10) {
    return { isValid: false, error: 'Phone number must be a valid 10-digit Indian mobile number.' };
  }

  if (!INDIAN_PHONE_REGEX.test(digits)) {
    return { isValid: false, error: 'Valid Indian mobile numbers must start with 6, 7, 8, or 9.' };
  }

  // Reject repeating fake numbers (e.g. 0000000000, 1111111111, ..., 9999999999)
  const isAllSameDigit = /^(\d)\1{9}$/.test(digits);
  if (isAllSameDigit) {
    return { isValid: false, error: 'Please enter a valid active phone number.' };
  }

  // Reject sequential fake numbers
  if (digits === '1234567890' || digits === '9876543210') {
    return { isValid: false, error: 'Please enter a genuine phone number.' };
  }

  return { isValid: true, phone: digits };
}
