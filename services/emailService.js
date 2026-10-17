import { Resend } from 'resend';

const DEFAULT_FROM = process.env.EMAIL_FROM || 'PARVA Celebrations <notifications@myparva.com>';
const APP_URL = process.env.APP_URL || 'https://parava-frontend.onrender.com';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@parvaevents.com';
const SUPPORT_PHONE = '8554006073';

// Managed Resend Client with lazy evaluation, dynamic DB fallback, and mock injection for testing
let resendClient = null;
let dynamicApiKey = null;

export function setDynamicResendApiKey(key) {
  if (key && typeof key === 'string' && key.trim().startsWith('re_')) {
    dynamicApiKey = key.trim();
    resendClient = new Resend(dynamicApiKey);
    console.log('[EmailService] Dynamically configured active Resend API key.');
    return true;
  }
  return false;
}

export function isResendConfigured() {
  const key = dynamicApiKey || process.env.RESEND_API_KEY;
  return Boolean(
    key && 
    key.trim() !== '' && 
    !key.includes('PASTE_YOUR') && 
    !key.startsWith('YOUR_NEW_')
  );
}

export function getMaskedResendApiKey() {
  const key = dynamicApiKey || process.env.RESEND_API_KEY;
  if (!key || key.trim() === '' || key.includes('PASTE_YOUR') || key.startsWith('YOUR_NEW_')) {
    return null;
  }
  const clean = key.trim();
  if (clean.length <= 8) return 're_****';
  return `${clean.substring(0, 6)}...${clean.substring(clean.length - 4)}`;
}

export async function initEmailServiceFromDb(db) {
  if (!db) return;
  try {
    const doc = await db.collection('system_settings').doc('email').get();
    if (doc.exists && doc.data()?.resendApiKey) {
      setDynamicResendApiKey(doc.data().resendApiKey);
    }
  } catch (err) {
    console.warn('[EmailService] Notice: system_settings/email not queried or unavailable:', err.message);
  }
}

export function getResendClient() {
  if (resendClient) return resendClient;
  const key = dynamicApiKey || process.env.RESEND_API_KEY;
  if (!key || key.trim() === '' || key.includes('PASTE_YOUR') || key.startsWith('YOUR_NEW_')) {
    console.warn('[EmailService Warning] RESEND_API_KEY is not configured in environment or settings. Emails will fail safely.');
    return null;
  }
  resendClient = new Resend(key.trim());
  return resendClient;
}

export function setResendClient(client) {
  resendClient = client;
}

/**
 * Base responsive email template wrapper with branding, header, and legal footer
 */
export function getEmailLayout({ title, badge, contentHtml, actionButton, termsVersion = '1.2' }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; color: #0f172a; }
    .container { max-width: 580px; margin: 0 auto; background-color: #ffffff; border-radius: 24px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05); }
    .header { background: linear-gradient(135deg, #9d174d 0%, #831843 100%); padding: 32px 28px; text-align: center; color: #ffffff; }
    .brand-title { font-size: 24px; font-weight: 800; letter-spacing: -0.5px; margin: 0; }
    .brand-subtitle { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: #fbcfe8; margin-top: 4px; font-weight: 700; }
    .badge { display: inline-block; padding: 6px 14px; border-radius: 9999px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; margin-top: 14px; background-color: rgba(255, 255, 255, 0.2); color: #ffffff; backdrop-filter: blur(8px); }
    .content { padding: 32px 28px; line-height: 1.6; }
    .info-card { background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 16px; padding: 20px; margin: 20px 0; }
    .info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed #e2e8f0; font-size: 13px; }
    .info-label { color: #64748b; font-weight: 600; }
    .info-value { color: #0f172a; font-weight: 700; text-align: right; }
    .amount-highlight { color: #9d174d; font-size: 18px; font-weight: 900; }
    .btn { display: inline-block; background-color: #9d174d; color: #ffffff !important; padding: 14px 28px; border-radius: 12px; font-weight: 700; font-size: 14px; text-decoration: none; margin-top: 20px; box-shadow: 0 4px 12px rgba(157, 23, 77, 0.25); text-align: center; }
    .footer { background-color: #f1f5f9; padding: 24px; text-align: center; font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0; }
    .footer-links a { color: #64748b; text-decoration: underline; margin: 0 6px; }
    .legal-notice { margin-top: 12px; color: #94a3b8; font-size: 10px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="brand-title">PARVA</h1>
      <p class="brand-subtitle">Verified Event Marketplace & Planner</p>
      ${badge ? `<div class="badge">${badge}</div>` : ''}
    </div>
    
    <div class="content">
      ${contentHtml}
      
      ${actionButton ? `<a href="${actionButton.url}" class="btn">${actionButton.text}</a>` : ''}
    </div>

    <div class="footer">
      <p style="margin: 0 0 8px 0;">Need assistance? Reach out to <a href="mailto:${SUPPORT_EMAIL}" style="color: #9d174d; font-weight: 700;">${SUPPORT_EMAIL}</a> or Helpline <a href="tel:${SUPPORT_PHONE}" style="color: #9d174d; font-weight: 700;">${SUPPORT_PHONE}</a></p>
      <div class="footer-links">
        <a href="${APP_URL}/terms">Terms & Conditions</a> •
        <a href="${APP_URL}/privacy">Privacy Policy</a> •
        <a href="${APP_URL}/cancellation">Cancellation Policy</a> •
        <a href="${APP_URL}/refund">Refund Policy</a>
      </div>
      <p class="legal-notice">
        Terms Accepted: Version ${termsVersion}. All bookings are subject to verified vendor availability.
        <br>© ${new Date().getFullYear()} Parva Technologies Pvt. Ltd. All rights reserved.
      </p>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Idempotent Mail Dispatcher with Firestore Logging & Retry
 * Follows real email state machine: queued -> accepted -> delivered / bounced / failed
 */
export async function sendIdempotentEmail({ 
  db, 
  eventType, 
  bookingId, 
  recipient, 
  subject, 
  html, 
  attachments = [],
  isRetry = false
}) {
  const cleanRecipient = (recipient || '').trim().toLowerCase();
  if (!cleanRecipient || !cleanRecipient.includes('@') || cleanRecipient.endsWith('.local') || cleanRecipient.includes('example.com')) {
    console.warn(`[EmailService] Skipped sending to invalid or placeholder email: ${recipient}`);
    return { success: false, skipped: true, reason: 'Invalid or placeholder email address' };
  }

  const safeBookingId = bookingId || 'generic';
  const eventDocId = `email_${eventType}_${safeBookingId}_${cleanRecipient.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const now = new Date().toISOString();

  // 1. Idempotency Check in Firestore (skip if not an explicit retry and already accepted/delivered)
  if (db && !isRetry) {
    try {
      const existingDoc = await db.collection('email_events').doc(eventDocId).get();
      if (existingDoc.exists) {
        const data = existingDoc.data();
        if (data.status === 'accepted' || data.status === 'delivered' || data.status === 'sent') {
          console.log(`[EmailService] Idempotency: Email ${eventType} for ${safeBookingId} already accepted/sent (${data.status}). Skipping.`);
          return { success: true, idempotentSkipped: true, logId: eventDocId, resendId: data.resendId };
        }
      }
    } catch (e) {
      console.warn("[EmailService] Idempotency check error:", e.message);
    }
  }

  // 2. Verify Resend Client Configuration
  const client = getResendClient();
  if (!client) {
    const configError = 'RESEND_API_KEY is not configured in environment';
    console.error(`[EmailService Config Error] ${configError}. Email ${eventType} to ${cleanRecipient} marked as failed.`);
    if (db) {
      try {
        await db.collection('email_events').doc(eventDocId).set({
          eventType,
          bookingId: safeBookingId,
          recipient: cleanRecipient,
          subject,
          html: html || '',
          status: 'failed',
          error: configError,
          createdAt: now,
          updatedAt: now,
          lastAttemptAt: now
        }, { merge: true });
      } catch (err) {}
    }
    return { success: false, error: configError, code: 'RESEND_NOT_CONFIGURED' };
  }

  // 3. Mark state as queued / in-flight
  if (db) {
    try {
      await db.collection('email_events').doc(eventDocId).set({
        eventType,
        bookingId: safeBookingId,
        recipient: cleanRecipient,
        subject,
        html: html || '',
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        lastAttemptAt: now,
        retryCount: isRetry ? (1) : 0
      }, { merge: true });
    } catch (e) {}
  }

  // 4. Dispatch via Resend SDK
  try {
    const payload = {
      from: DEFAULT_FROM,
      to: [cleanRecipient],
      subject: subject,
      html: html,
      ...(attachments && attachments.length > 0 ? { attachments } : {})
    };

    const { data, error } = await client.emails.send(payload);

    if (error) {
      const errorMsg = error.message || (typeof error === 'string' ? error : JSON.stringify(error));
      console.error(`[EmailService] Resend API Error (${eventType} -> ${cleanRecipient}):`, errorMsg);
      if (db) {
        await db.collection('email_events').doc(eventDocId).set({
          eventType,
          bookingId: safeBookingId,
          recipient: cleanRecipient,
          subject,
          html: html || '',
          status: 'failed',
          error: errorMsg,
          updatedAt: new Date().toISOString(),
          lastAttemptAt: new Date().toISOString()
        }, { merge: true });
      }
      return { success: false, error: errorMsg };
    }

    const resendId = data?.id || null;
    console.log(`[EmailService] Email accepted by Resend (${eventType} -> ${cleanRecipient}), Resend ID: ${resendId}`);

    // Resend API returns acceptance for dispatch. True delivery is tracked via webhook (email.delivered).
    if (db) {
      await db.collection('email_events').doc(eventDocId).set({
        eventType,
        bookingId: safeBookingId,
        recipient: cleanRecipient,
        subject,
        html: html || '',
        status: 'accepted',
        resendId: resendId,
        providerMessageId: resendId,
        sentAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        error: null
      }, { merge: true });
    }

    return { success: true, resendId, status: 'accepted', logId: eventDocId };
  } catch (err) {
    console.error(`[EmailService] Unexpected Exception during email dispatch:`, err.message);
    if (db) {
      try {
        await db.collection('email_events').doc(eventDocId).set({
          eventType,
          bookingId: safeBookingId,
          recipient: cleanRecipient,
          subject,
          html: html || '',
          status: 'failed',
          error: err.message,
          updatedAt: new Date().toISOString(),
          lastAttemptAt: new Date().toISOString()
        }, { merge: true });
      } catch (logErr) {}
    }
    return { success: false, error: err.message };
  }
}

/**
 * 1. Initial Booking Request Created (Pending Payment / Verification)
 */
export async function sendBookingCreatedEmail({ db, booking, customer, vendor }) {
  const bookingId = booking.id || booking.bookingIdString;
  const bookingDate = booking.eventDate || 'TBD';
  const priceDisplay = Number(booking.finalPrice || booking.totalPrice || 0).toLocaleString('en-IN');
  const vendorName = vendor?.name || booking.vendor?.name || 'Event Partner';
  const vendorCategory = vendor?.category || booking.vendor?.category || 'Celebration Services';

  // Email to Customer: Clearly distinguish pending request from confirmed order
  const customerEmail = customer?.email || booking.customerEmail;
  if (customerEmail) {
    const customerHtml = getEmailLayout({
      title: 'Booking Request Received',
      badge: 'Status: Pending Confirmation',
      contentHtml: `
        <h2 style="font-size: 20px; font-weight: 800; color: #0f172a; margin-top: 0;">We've Received Your Booking Request! 🎉</h2>
        <p style="color: #475569; font-size: 14px;">Hi <strong>${customer.name || 'Valued Customer'}</strong>,</p>
        <p style="color: #475569; font-size: 14px;">Thank you for choosing PARVA for your celebration. We have received your booking request for <strong>${vendorName}</strong>.</p>
        
        <div class="info-card">
          <div class="info-row"><span class="info-label">Booking ID:</span><span class="info-value">#${bookingId}</span></div>
          <div class="info-row"><span class="info-label">Vendor / Service:</span><span class="info-value">${vendorName} (${vendorCategory})</span></div>
          <div class="info-row"><span class="info-label">Event Date:</span><span class="info-value">${bookingDate}</span></div>
          <div class="info-row"><span class="info-label">Occasion:</span><span class="info-value">${booking.eventType || 'Celebration'}</span></div>
          <div class="info-row"><span class="info-label">Estimated Total:</span><span class="info-value amount-highlight">₹${priceDisplay}</span></div>
          <div class="info-row"><span class="info-label">Payment Status:</span><span class="info-value" style="color: #d97706;">Pending Verification</span></div>
        </div>
        
        <p style="color: #64748b; font-size: 12px;">This is a booking request confirmation. You will receive an official payment confirmation and tax receipt email once your advance fee is verified.</p>
      `,
      actionButton: { text: 'View Booking Status', url: `${APP_URL}` }
    });

    await sendIdempotentEmail({
      db,
      eventType: 'BOOKING_CREATED_CUSTOMER',
      bookingId,
      recipient: customerEmail,
      subject: `Booking Request Received — #${bookingId}`,
      html: customerHtml
    });
  }

  // Email to Vendor: Alert of incoming demand
  const vendorEmail = vendor?.email || booking.vendor?.email;
  if (vendorEmail) {
    const vendorHtml = getEmailLayout({
      title: 'New Booking Demand Request',
      badge: 'Demand Alert',
      contentHtml: `
        <h2 style="font-size: 20px; font-weight: 800; color: #0f172a; margin-top: 0;">New Booking Demand Request! 🎉</h2>
        <p style="color: #475569; font-size: 14px;">Hi <strong>${vendorName}</strong>,</p>
        <p style="color: #475569; font-size: 14px;">A customer has created a booking request for your service on <strong>${bookingDate}</strong>.</p>
        
        <div class="info-card">
          <div class="info-row"><span class="info-label">Booking Reference:</span><span class="info-value">#${bookingId}</span></div>
          <div class="info-row"><span class="info-label">Customer Name:</span><span class="info-value">${customer?.name || 'Customer'}</span></div>
          <div class="info-row"><span class="info-label">Event Date:</span><span class="info-value">${bookingDate}</span></div>
          <div class="info-row"><span class="info-label">Occasion:</span><span class="info-value">${booking.eventType || 'Celebration'}</span></div>
          <div class="info-row"><span class="info-label">Gross Value:</span><span class="info-value amount-highlight">₹${priceDisplay}</span></div>
          <div class="info-row"><span class="info-label">Status:</span><span class="info-value" style="color: #d97706;">Pending Confirmation</span></div>
        </div>

        <p style="color: #475569; font-size: 13px;">Please verify your calendar availability in your Vendor Hub. Once advance payment is confirmed, this slot will be permanently locked for your schedule.</p>
      `,
      actionButton: { text: 'Open Vendor Hub', url: `${APP_URL}` }
    });

    await sendIdempotentEmail({
      db,
      eventType: 'BOOKING_CREATED_VENDOR',
      bookingId,
      recipient: vendorEmail,
      subject: `New Booking Demand Request — #${bookingId}`,
      html: vendorHtml
    });
  }
}

export function formatTimeSlot(slotId) {
  switch ((slotId || '').toLowerCase()) {
    case 'morning':
      return 'Morning (09:00 AM – 01:00 PM)';
    case 'afternoon':
      return 'Afternoon (01:00 PM – 05:00 PM)';
    case 'evening':
      return 'Evening (05:00 PM – 10:00 PM)';
    case 'full_day':
    default:
      return 'Full Day (09:00 AM – 10:00 PM)';
  }
}

/**
 * 2. Payment Successful & Booking Confirmed (With Official PDF Attachment & Multi-Vendor Handling)
 */
export async function sendPaymentAndBookingConfirmedEmails({ 
  db, 
  booking, 
  customer, 
  vendor, 
  transaction, 
  pdfBuffer, 
  commissionData 
}) {
  const bookingId = booking.id || booking.bookingIdString;
  const bookingDate = booking.eventDate || 'TBD';
  const timeSlotFormatted = formatTimeSlot(booking.eventTimeSlot || booking.timeSlot);
  const amountPaid = transaction?.totalAmount || booking.pricing?.advanceAmount || booking.finalPrice || booking.totalPrice || 0;
  const paymentId = transaction?.paymentId || booking.paymentId || 'PAY_SUCCESS';
  const eventAddress = booking.eventLocationAddress || customer?.eventLocationAddress || vendor?.location || 'Maharashtra, India';
  const customerAge = booking.customerAge || customer?.age || 'N/A';
  const styleNotes = booking.styleSuggestions || booking.notes || 'None specified';
  const vendorName = vendor?.name || booking.vendor?.name || 'Event Partner';
  const vendorCategory = vendor?.category || booking.vendor?.category || 'Celebration Services';

  // Receipt PDF Section: Conditionally displayed only if genuine PDF buffer is attached
  const receiptSectionHtml = pdfBuffer
    ? `
      <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 14px; padding: 16px; margin: 16px 0;">
        <h4 style="margin: 0 0 6px 0; color: #166534; font-size: 13px;">📎 Official Receipt PDF Attached</h4>
        <p style="margin: 0; color: #15803d; font-size: 12px;">An official PDF confirmation tax invoice has been generated and attached to this email for your records.</p>
      </div>
    `
    : `
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; padding: 16px; margin: 16px 0;">
        <h4 style="margin: 0 0 6px 0; color: #334155; font-size: 13px;">📄 Official Receipt Available</h4>
        <p style="margin: 0; color: #64748b; font-size: 12px;">Your verified payment receipt is available for download anytime directly from your PARVA booking dashboard.</p>
      </div>
    `;

  // Customer Email (Confirmation + Receipt)
  const customerEmail = customer?.email || booking.customerEmail;
  if (customerEmail) {
    const customerHtml = getEmailLayout({
      title: 'Booking Confirmed & Payment Received',
      badge: '✓ Payment Verified & Confirmed',
      contentHtml: `
        <h2 style="font-size: 20px; font-weight: 800; color: #059669; margin-top: 0;">Payment Successful & Booking Confirmed! 🎉</h2>
        <p style="color: #475569; font-size: 14px;">Hi <strong>${customer?.name || 'Valued Customer'}</strong>,</p>
        <p style="color: #475569; font-size: 14px;">Your payment has been successfully verified, and your booking with <strong>${vendorName}</strong> is officially <strong>CONFIRMED</strong>!</p>
        
        <div class="info-card">
          <div class="info-row"><span class="info-label">Booking Reference:</span><span class="info-value">#${bookingId}</span></div>
          <div class="info-row"><span class="info-label">Payment ID:</span><span class="info-value" style="font-family: monospace;">${paymentId}</span></div>
          <div class="info-row"><span class="info-label">Service & Vendor:</span><span class="info-value">${vendorName} (${vendorCategory})</span></div>
          <div class="info-row"><span class="info-label">Event Date:</span><span class="info-value">${bookingDate}</span></div>
          <div class="info-row"><span class="info-label">Time Slot:</span><span class="info-value font-bold" style="color: #9d174d;">${timeSlotFormatted}</span></div>
          <div class="info-row"><span class="info-label">Event Venue Address:</span><span class="info-value font-bold">${eventAddress}</span></div>
          ${booking.eventLocationCoords ? `<div class="info-row"><span class="info-label">GPS Coordinates:</span><span class="info-value" style="font-family: monospace;">Lat ${booking.eventLocationCoords.lat}, Lng ${booking.eventLocationCoords.lng}</span></div>` : ''}
          ${styleNotes && styleNotes !== 'None specified' ? `<div class="info-row"><span class="info-label">Style / Custom Notes:</span><span class="info-value">${styleNotes}</span></div>` : ''}
          <div class="info-row"><span class="info-label">Amount Paid:</span><span class="info-value amount-highlight">₹${Number(amountPaid).toLocaleString('en-IN')}</span></div>
          <div class="info-row"><span class="info-label">Payment Status:</span><span class="info-value" style="color: #059669;">✓ Verified (Paid)</span></div>
        </div>

        ${receiptSectionHtml}

        <h4 style="font-size: 13px; color: #0f172a; margin: 20px 0 8px 0;">Next Steps:</h4>
        <ol style="color: #475569; font-size: 13px; padding-left: 20px; margin: 0;">
          <li>The vendor has been notified and scheduled for your event date (${timeSlotFormatted}).</li>
          <li>Access your live in-app chat to communicate any specific requirements.</li>
          <li>You can view, manage, or share your celebration plan anytime from your dashboard.</li>
        </ol>
      `,
      actionButton: { text: 'View Confirmed Booking', url: `${APP_URL}` }
    });

    const attachments = pdfBuffer ? [{ filename: `Parva-Booking-${bookingId}.pdf`, content: pdfBuffer }] : [];

    await sendIdempotentEmail({
      db,
      eventType: 'BOOKING_CONFIRMED_CUSTOMER',
      bookingId,
      recipient: customerEmail,
      subject: `Booking Confirmed — #${bookingId}`,
      html: customerHtml,
      attachments
    });
  }

  // Multi-Vendor or Single Vendor Email Dispatch (resolved from real profiles)
  const vendorsList = Array.isArray(booking.vendors) && booking.vendors.length > 0 
    ? booking.vendors 
    : [{ 
        vendorId: vendor?.id || booking.vendorId, 
        vendorName: vendor?.name || booking.vendor?.name, 
        email: vendor?.email || booking.vendor?.email, 
        services: booking.selectedServices 
      }];

  const grossBookingTotal = booking.pricing?.subtotal || booking.totalPrice || amountPaid;

  for (const v of vendorsList) {
    const vEmail = v.email || (v.vendorId === vendor?.id ? vendor?.email : null);
    if (!vEmail) {
      console.warn(`[EmailService] Vendor notification skipped: No resolved email for vendor ${v.vendorId || v.vendorName}`);
      continue;
    }

    const vendorPayout = commissionData?.vendorPayout || booking.pricing?.vendorPayout || (amountPaid * 0.9);
    const platformCommission = commissionData?.platformCommission || booking.pricing?.commissionAmount || (amountPaid * 0.1);

    const vendorHtml = getEmailLayout({
      title: 'New Confirmed Booking & Earnings Statement',
      badge: '✓ Confirmed Order',
      contentHtml: `
        <h2 style="font-size: 20px; font-weight: 800; color: #059669; margin-top: 0;">New Confirmed Booking Received! 💰</h2>
        <p style="color: #475569; font-size: 14px;">Hi <strong>${v.vendorName || vendorName}</strong>,</p>
        <p style="color: #475569; font-size: 14px;">Customer <strong>${customer?.name || 'Customer'}</strong> (Age: ${customerAge}) has paid and confirmed their reservation for your service.</p>
        
        <div class="info-card">
          <div class="info-row"><span class="info-label">Booking Reference:</span><span class="info-value">#${bookingId}</span></div>
          <div class="info-row"><span class="info-label">Customer Name:</span><span class="info-value">${customer?.name || 'Customer'} (Age: ${customerAge})</span></div>
          <div class="info-row"><span class="info-label">Customer Contact:</span><span class="info-value font-bold" style="color: #9d174d;">${customer?.phone || 'Available in Vendor Hub'}</span></div>
          <div class="info-row"><span class="info-label">Customer Email:</span><span class="info-value">${customerEmail || 'N/A'}</span></div>
          <div class="info-row"><span class="info-label">Event Date:</span><span class="info-value">${bookingDate}</span></div>
          <div class="info-row"><span class="info-label">Time Slot:</span><span class="info-value font-bold" style="color: #9d174d;">${timeSlotFormatted}</span></div>
          <div class="info-row"><span class="info-label">Event Venue Address:</span><span class="info-value font-bold">${eventAddress}</span></div>
          ${booking.eventLocationCoords ? `<div class="info-row"><span class="info-label">GPS Coordinates:</span><span class="info-value" style="font-family: monospace;">Lat ${booking.eventLocationCoords.lat}, Lng ${booking.eventLocationCoords.lng}</span></div>` : ''}
          ${styleNotes && styleNotes !== 'None specified' ? `<div class="info-row"><span class="info-label">Style / Custom Suggestions:</span><span class="info-value">${styleNotes}</span></div>` : ''}
          <div class="info-row"><span class="info-label">Gross Booking Value:</span><span class="info-value">₹${Number(grossBookingTotal).toLocaleString('en-IN')}</span></div>
          <div class="info-row"><span class="info-label">Platform Commission:</span><span class="info-value" style="color: #64748b;">- ₹${Number(platformCommission).toLocaleString('en-IN')}</span></div>
          <div class="info-row"><span class="info-label">Net Vendor Payout:</span><span class="info-value amount-highlight">₹${Number(vendorPayout).toLocaleString('en-IN')}</span></div>
        </div>

        <p style="color: #475569; font-size: 13px;">This date and time slot (${timeSlotFormatted}) have been locked in your Operational Schedule Calendar.</p>
      `,
      actionButton: { text: 'Open Vendor Dashboard', url: `${APP_URL}` }
    });

    await sendIdempotentEmail({
      db,
      eventType: `BOOKING_CONFIRMED_VENDOR_${v.vendorId || 'primary'}`,
      bookingId,
      recipient: vEmail,
      subject: `New Booking Confirmed — #${bookingId}`,
      html: vendorHtml
    });
  }
}

/**
 * 3. Booking Cancellation
 */
export async function sendBookingCancellationEmail({ 
  db, 
  booking, 
  customer, 
  vendor, 
  reason = 'Customer requested cancellation', 
  refundAmount = 0 
}) {
  const bookingId = booking.id || booking.bookingIdString;
  const customerEmail = customer?.email || booking.customerEmail;
  const vendorEmail = vendor?.email || booking.vendor?.email;
  const vendorName = vendor?.name || booking.vendor?.name || 'Event Partner';

  let refundStatusLabel = 'No Refund Applicable';
  if (booking.refundStatus === 'Requested' || booking.refundStatus === 'Under Review') {
    refundStatusLabel = 'Refund Requested — Under Support Review';
  } else if (booking.refundStatus === 'Processed' || booking.refundStatus === 'SUCCESS') {
    refundStatusLabel = 'Refund Processed';
  } else if (booking.refundStatus === 'Rejected') {
    refundStatusLabel = 'Refund Declined (Per Cancellation Policy)';
  } else if (Number(refundAmount) > 0) {
    refundStatusLabel = 'Refund Logged for Support';
  }

  // Customer Cancellation Email
  if (customerEmail) {
    const customerHtml = getEmailLayout({
      title: 'Booking Cancelled',
      badge: 'Status: Cancelled',
      contentHtml: `
        <h2 style="font-size: 20px; font-weight: 800; color: #dc2626; margin-top: 0;">Booking Cancelled — #${bookingId}</h2>
        <p style="color: #475569; font-size: 14px;">Hi <strong>${customer?.name || 'Valued Customer'}</strong>,</p>
        <p style="color: #475569; font-size: 14px;">Your booking with <strong>${vendorName}</strong> for <strong>${booking.eventDate || 'Scheduled Date'}</strong> has been cancelled.</p>
        
        <div class="info-card">
          <div class="info-row"><span class="info-label">Booking Reference:</span><span class="info-value">#${bookingId}</span></div>
          <div class="info-row"><span class="info-label">Cancellation Reason:</span><span class="info-value">${reason}</span></div>
          <div class="info-row"><span class="info-label">Refund Status:</span><span class="info-value font-bold" style="color: #9d174d;">${refundStatusLabel}</span></div>
          <div class="info-row"><span class="info-label">Refund Amount:</span><span class="info-value amount-highlight">₹${Number(refundAmount).toLocaleString('en-IN')}</span></div>
        </div>

        <p style="color: #64748b; font-size: 12px;">Refunds are processed in accordance with our cancellation policy. For questions or adjustments, contact our support team at <a href="mailto:${SUPPORT_EMAIL}" style="color: #9d174d; font-weight: 700;">${SUPPORT_EMAIL}</a> or Helpline <strong>${SUPPORT_PHONE}</strong>.</p>
      `,
      actionButton: { text: 'Explore Other Vendors', url: `${APP_URL}` }
    });

    await sendIdempotentEmail({
      db,
      eventType: 'BOOKING_CANCELLED_CUSTOMER',
      bookingId,
      recipient: customerEmail,
      subject: `Booking Cancelled — #${bookingId}`,
      html: customerHtml
    });
  }

  // Vendor Cancellation Notice
  if (vendorEmail) {
    const vendorHtml = getEmailLayout({
      title: 'Booking Cancelled',
      badge: 'Calendar Slot Released',
      contentHtml: `
        <h2 style="font-size: 20px; font-weight: 800; color: #dc2626; margin-top: 0;">Booking Cancelled — #${bookingId}</h2>
        <p style="color: #475569; font-size: 14px;">Hi <strong>${vendorName}</strong>,</p>
        <p style="color: #475569; font-size: 14px;">Booking #${bookingId} for <strong>${booking.eventDate || 'Scheduled Date'}</strong> has been cancelled. Your calendar slot has been reopened for new customer inquiries.</p>
        
        <div class="info-card">
          <div class="info-row"><span class="info-label">Booking Reference:</span><span class="info-value">#${bookingId}</span></div>
          <div class="info-row"><span class="info-label">Customer:</span><span class="info-value">${customer?.name || 'Customer'}</span></div>
          <div class="info-row"><span class="info-label">Event Date:</span><span class="info-value">${booking.eventDate || 'N/A'}</span></div>
          <div class="info-row"><span class="info-label">Reason:</span><span class="info-value">${reason}</span></div>
        </div>
      `,
      actionButton: { text: 'View Vendor Schedule', url: `${APP_URL}` }
    });

    await sendIdempotentEmail({
      db,
      eventType: 'BOOKING_CANCELLED_VENDOR',
      bookingId,
      recipient: vendorEmail,
      subject: `Booking Cancelled — #${bookingId}`,
      html: vendorHtml
    });
  }
}

/**
 * 4. Refund Processed
 */
export async function sendRefundProcessedEmail({ db, booking, customer, refundData }) {
  const bookingId = booking.id || booking.bookingIdString;
  const customerEmail = customer?.email || booking.customerEmail;
  if (!customerEmail) return { success: false, skipped: true, reason: 'No customer email' };

  const refundAmount = refundData?.amount || 0;
  const refundId = refundData?.refundId || refundData?.refundReference || 'RFD_' + Date.now();

  const customerHtml = getEmailLayout({
    title: 'Refund Processed',
    badge: '✓ Refund Completed',
    contentHtml: `
      <h2 style="font-size: 20px; font-weight: 800; color: #059669; margin-top: 0;">Refund Successfully Processed! 💳</h2>
      <p style="color: #475569; font-size: 14px;">Hi <strong>${customer?.name || 'Valued Customer'}</strong>,</p>
      <p style="color: #475569; font-size: 14px;">We have successfully processed the refund for your cancelled booking #${bookingId}.</p>
      
      <div class="info-card">
        <div class="info-row"><span class="info-label">Booking ID:</span><span class="info-value">#${bookingId}</span></div>
        <div class="info-row"><span class="info-label">Refund Reference:</span><span class="info-value" style="font-family: monospace;">${refundId}</span></div>
        <div class="info-row"><span class="info-label">Refund Amount:</span><span class="info-value amount-highlight">₹${Number(refundAmount).toLocaleString('en-IN')}</span></div>
        <div class="info-row"><span class="info-label">Settlement Window:</span><span class="info-value">3–5 Banking Days</span></div>
        <div class="info-row"><span class="info-label">Destination:</span><span class="info-value">Original Payment Source</span></div>
        <div class="info-row"><span class="info-label">Status:</span><span class="info-value" style="color: #059669;">Settled to Bank / Card</span></div>
      </div>

      <p style="color: #64748b; font-size: 12px;">Depending on your bank or card issuer, the credited funds typically reflect in your account within 3 to 5 business days.</p>
    `,
    actionButton: { text: 'Return to Homepage', url: `${APP_URL}` }
  });

  return await sendIdempotentEmail({
    db,
    eventType: 'REFUND_PROCESSED_CUSTOMER',
    bookingId,
    recipient: customerEmail,
    subject: `Refund Processed — #${bookingId}`,
    html: customerHtml
  });
}

/**
 * 5. Send Secure Registration OTP Email
 */
export async function sendOtpVerificationEmail({ email, otp, name, purpose = 'Registration' }) {
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    return { success: false, reason: 'Invalid recipient email' };
  }

  const client = getResendClient();
  if (!client) {
    console.warn(`[EmailService Warning] Cannot send OTP email: RESEND_API_KEY is not configured.`);
    return { success: false, error: 'RESEND_NOT_CONFIGURED' };
  }

  const isVendor = purpose.toLowerCase().includes('vendor');
  const roleTitle = isVendor ? 'Partner' : 'Member';

  const contentHtml = `
    <h2 style="font-size: 20px; font-weight: 800; color: #1e293b; margin-top: 0;">Verify Your Account ✨</h2>
    <p style="color: #475569; font-size: 14px;">Hi ${name ? `<strong>${name}</strong>` : `Valued ${roleTitle}`},</p>
    <p style="color: #475569; font-size: 14px;">Thank you for registering on <strong>PARVA Celebrations</strong>. Please use the one-time verification code below to verify your email and activate your account:</p>
    
    <div style="background: linear-gradient(135deg, #fdf2f8 0%, #fce7f3 100%); border: 2px dashed #ec4899; border-radius: 16px; padding: 24px; text-align: center; margin: 24px 0;">
      <p style="margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 2px; color: #9d174d; font-weight: 800;">Your Verification OTP</p>
      <div style="font-size: 38px; font-weight: 900; letter-spacing: 10px; color: #9d174d; font-family: monospace; padding: 6px 0;">
        ${otp}
      </div>
      <p style="margin: 6px 0 0 0; font-size: 12px; color: #64748b; font-weight: 600;">Valid for 10 minutes</p>
    </div>

    <div class="info-card">
      <div class="info-row"><span class="info-label">Action:</span><span class="info-value">${purpose}</span></div>
      <div class="info-row"><span class="info-label">Recipient:</span><span class="info-value">${cleanEmail}</span></div>
      <div class="info-row"><span class="info-label">Security Note:</span><span class="info-value" style="color: #e11d48;">Do not share this code with anyone</span></div>
    </div>

    <p style="color: #94a3b8; font-size: 12px; margin-top: 20px;">
      If you did not initiate this request, you can safely ignore this email. No account will be activated without this verification code.
    </p>
  `;

  const emailHtml = getEmailLayout({
    title: `PARVA — Verification OTP: ${otp}`,
    badge: 'Security Verification',
    contentHtml
  });

  try {
    const data = await client.emails.send({
      from: DEFAULT_FROM,
      to: [cleanEmail],
      subject: `${otp} is your PARVA verification code`,
      html: emailHtml
    });
    console.log(`[EmailService] OTP email dispatched to ${cleanEmail} (Message ID: ${data?.id || 'OK'})`);
    return { success: true, messageId: data?.id };
  } catch (err) {
    console.warn(`[EmailService] OTP email dispatch warning:`, err?.message || err);
    return { success: false, error: err?.message || 'Could not send verification email' };
  }
}

/**
 * 6. Send Vendor KYC Verification Status Update Email
 */
export async function sendVendorKycStatusEmail({ vendorEmail, vendorName, status, remarks }) {
  const cleanEmail = (vendorEmail || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    return { success: false, reason: 'No valid email' };
  }

  const client = getResendClient();
  if (!client) {
    console.warn(`[EmailService Warning] Cannot send KYC status email: RESEND_API_KEY is not configured.`);
    return { success: false, error: 'RESEND_NOT_CONFIGURED' };
  }

  let subject = '';
  let badge = '';
  let heading = '';
  let statusColor = '#059669';
  let bodyText = '';
  let actionButton = { text: 'Open Vendor Dashboard', url: `${APP_URL}` };

  if (status === 'VERIFIED') {
    subject = '🎉 Congratulations! Your Parva Partner Profile is Verified';
    badge = 'KYC Approved & Verified';
    heading = 'Welcome to the Verified Parva Partner Network! 🌟';
    statusColor = '#059669';
    bodyText = `Your government ID and business verification documents have been reviewed and approved by our administrative team. Your listing is now active and verified with the Verified Partner Badge.`;
  } else if (status === 'ACTION_REQUIRED') {
    subject = '⚠️ Action Required: Additional information needed for your Parva KYC';
    badge = 'Action Required';
    heading = 'Additional Information Required for Verification';
    statusColor = '#d97706';
    bodyText = `Our verification team reviewed your KYC submission and requested updates before approval. Please review the reviewer's remarks below and resubmit the requested documents.`;
    actionButton = { text: 'Update KYC Documents', url: `${APP_URL}` };
  } else if (status === 'REJECTED') {
    subject = 'Update regarding your Parva Partner KYC Verification';
    badge = 'KYC Not Approved';
    heading = 'KYC Submission Not Approved';
    statusColor = '#e11d48';
    bodyText = `We regret to inform you that your KYC submission could not be verified at this time. Please see the review notes below for details.`;
    actionButton = { text: 'Review & Resubmit', url: `${APP_URL}` };
  } else {
    subject = 'Update regarding your Parva Partner KYC Status';
    badge = 'KYC Status Update';
    heading = 'KYC Submission Status Update';
    statusColor = '#64748b';
    bodyText = `Your KYC submission status has been updated to ${status}.`;
  }

  const contentHtml = `
    <h2 style="font-size: 20px; font-weight: 800; color: #1e293b; margin-top: 0;">${heading}</h2>
    <p style="color: #475569; font-size: 14px;">Dear <strong>${vendorName || 'Partner'}</strong>,</p>
    <p style="color: #475569; font-size: 14px;">${bodyText}</p>

    <div class="info-card">
      <div class="info-row">
        <span class="info-label">Verification Status:</span>
        <span class="info-value" style="color: ${statusColor}; font-weight: 800;">${status}</span>
      </div>
      ${remarks ? `
      <div style="padding-top: 10px;">
        <span class="info-label" style="display: block; margin-bottom: 4px;">Reviewer Remarks / Feedback:</span>
        <div style="background-color: #ffffff; border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; font-size: 13px; color: #334155;">
          ${remarks}
        </div>
      </div>
      ` : ''}
    </div>
  `;

  const emailHtml = getEmailLayout({
    title: subject,
    badge,
    contentHtml,
    actionButton
  });

  try {
    const data = await client.emails.send({
      from: DEFAULT_FROM,
      to: [cleanEmail],
      subject,
      html: emailHtml
    });
    console.log(`[EmailService] KYC Status email dispatched to ${cleanEmail} (Status: ${status}, Message ID: ${data?.id})`);
    return { success: true, messageId: data?.id };
  } catch (err) {
    console.warn(`[EmailService] KYC Status email warning:`, err?.message || err);
    return { success: false, error: err?.message };
  }
}

/**
 * 7. Live Resend Health & Connectivity Check
 * Verifies that the API key provided in Render or settings is active and accepted by Resend
 */
export async function verifyResendHealth() {
  const client = getResendClient();
  const maskedKey = getMaskedResendApiKey();
  const isConfigured = isResendConfigured();
  const senderFrom = process.env.EMAIL_FROM || 'PARVA Celebrations <notifications@myparva.com>';

  if (!client || !isConfigured) {
    return {
      healthy: false,
      isConfigured: false,
      maskedKey: null,
      source: 'unconfigured',
      error: 'RESEND_API_KEY is not configured in Render environment variables or settings.',
      suggestion: 'Set RESEND_API_KEY in Render Dashboard -> Environment -> Environment Variables.'
    };
  }

  const source = process.env.RESEND_API_KEY && !process.env.RESEND_API_KEY.includes('PASTE_YOUR') && !process.env.RESEND_API_KEY.startsWith('YOUR_NEW_')
    ? 'Render Environment Variable (process.env.RESEND_API_KEY)'
    : 'Admin Settings (Firestore)';

  const startTime = Date.now();
  try {
    let domainsCount = 0;
    let verifiedDomains = [];
    const domainRes = await client.domains.list();

    if (domainRes.error) {
      const status = domainRes.error.statusCode || (domainRes.error.message?.includes('API key') ? 401 : null);
      if (status === 401 || domainRes.error.name === 'validation_error') {
        return {
          healthy: false,
          isConfigured: true,
          maskedKey,
          source,
          error: domainRes.error.message || 'Invalid or revoked Resend API Key.',
          latencyMs: Date.now() - startTime,
          suggestion: 'Double-check the API key copied from https://resend.com/api-keys. It must begin with "re_".'
        };
      }
      if (status === 403 || domainRes.error.message?.includes('permission')) {
        return {
          healthy: true,
          isConfigured: true,
          maskedKey,
          source,
          scope: 'Sending Access Active',
          latencyMs: Date.now() - startTime,
          message: 'Resend API Key is active and verified for transactional sending.',
          senderFrom,
          checkedAt: new Date().toISOString()
        };
      }
    } else if (domainRes.data?.data) {
      domainsCount = domainRes.data.data.length;
      verifiedDomains = domainRes.data.data.filter(d => d.status === 'verified').map(d => d.name);
    }

    const latencyMs = Date.now() - startTime;
    return {
      healthy: true,
      isConfigured: true,
      maskedKey,
      source,
      senderFrom,
      domainsCount,
      verifiedDomains,
      latencyMs,
      checkedAt: new Date().toISOString(),
      message: 'Resend API connection is verified active and ready to deliver transactional emails.'
    };
  } catch (err) {
    return {
      healthy: false,
      isConfigured: true,
      maskedKey,
      source,
      error: err.message,
      latencyMs: Date.now() - startTime,
      suggestion: 'Check server network connectivity or verify Resend service status at https://status.resend.com.'
    };
  }
}

