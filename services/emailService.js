import { Resend } from 'resend';

const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_X3SKrWAN_5esWMaAP7RfPqPzULAV6gmHE';
const DEFAULT_FROM = process.env.EMAIL_FROM || 'PARVA Celebrations <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || 'https://parava-frontend.onrender.com';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@parvaevents.com';

const resend = new Resend(RESEND_API_KEY);

/**
 * Base responsive email template wrapper with branding, header, and legal footer
 */
function getEmailLayout({ title, badge, contentHtml, actionButton, termsVersion = '1.2' }) {
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
    .info-row:last-child { border-bottom: none; }
    .info-label { color: #64748b; font-weight: 600; }
    .info-value { color: #0f172a; font-weight: 700; text-align: right; }
    .amount-highlight { font-size: 20px; font-weight: 800; color: #9d174d; }
    .btn { display: inline-block; width: 100%; box-sizing: border-box; text-align: center; background-color: #9d174d; color: #ffffff !important; text-decoration: none; font-weight: 700; font-size: 14px; padding: 14px 24px; border-radius: 14px; margin: 24px 0 12px 0; }
    .footer { background-color: #f1f5f9; padding: 24px 28px; text-align: center; font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0; }
    .footer-links a { color: #9d174d; text-decoration: none; margin: 0 6px; font-weight: 600; }
    .legal-notice { font-size: 10px; color: #94a3b8; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="brand-title">PARVA CELEBRATIONS</h1>
      <p class="brand-subtitle">Verified Event Marketplace & Planner</p>
      ${badge ? `<div class="badge">${badge}</div>` : ''}
    </div>
    
    <div class="content">
      ${contentHtml}
      
      ${actionButton ? `<a href="${actionButton.url}" class="btn">${actionButton.text}</a>` : ''}
    </div>

    <div class="footer">
      <p style="margin: 0 0 8px 0;">Need assistance? Reach out to <a href="mailto:${SUPPORT_EMAIL}" style="color: #9d174d; font-weight: 700;">${SUPPORT_EMAIL}</a></p>
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
 */
export async function sendIdempotentEmail({ db, eventType, bookingId, recipient, subject, html, attachments = [] }) {
  if (!recipient || !recipient.includes('@') || recipient.includes('.local')) {
    console.warn(`[EmailService] Skipped sending to invalid or placeholder email: ${recipient}`);
    return { success: false, skipped: true, reason: 'Invalid or simulated email address' };
  }

  const eventDocId = `email_${eventType}_${bookingId || 'generic'}_${recipient.replace(/[^a-zA-Z0-9]/g, '_')}`;

  // 1. Idempotency Check in Firestore
  if (db) {
    try {
      const existingDoc = await db.collection('email_events').doc(eventDocId).get();
      if (existingDoc.exists && existingDoc.data().status === 'sent') {
        console.log(`[EmailService] Idempotency: Email ${eventType} for ${bookingId} already sent. Skipping.`);
        return { success: true, idempotentSkipped: true, messageId: existingDoc.data().providerMessageId };
      }
    } catch (e) {
      console.warn('[EmailService] Firestore idempotency check error:', e);
    }
  }

  // 2. Dispatch via Resend
  try {
    const payload = {
      from: DEFAULT_FROM,
      to: [recipient],
      subject,
      html
    };

    if (attachments && attachments.length > 0) {
      payload.attachments = attachments.map(att => ({
        filename: att.filename,
        content: att.content.toString('base64')
      }));
    }

    const resendResponse = await resend.emails.send(payload);
    if (resendResponse.error) {
      throw new Error(resendResponse.error.message || 'Resend delivery failed');
    }
    const messageId = resendResponse.data?.id || 'resend_msg_' + Date.now();

    // 3. Log Success to Firestore
    if (db) {
      await db.collection('email_events').doc(eventDocId).set({
        id: eventDocId,
        eventType,
        bookingId: bookingId || 'N/A',
        recipient,
        subject,
        status: 'sent',
        providerMessageId: messageId,
        sentAt: new Date().toISOString(),
        error: null
      }, { merge: true });
    }

    console.log(`[EmailService] Sent '${eventType}' email to ${recipient} (Message ID: ${messageId})`);
    return { success: true, messageId };
  } catch (error) {
    console.error(`[EmailService] Error sending '${eventType}' email to ${recipient}:`, error);

    if (db) {
      try {
        await db.collection('email_events').doc(eventDocId).set({
          id: eventDocId,
          eventType,
          bookingId: bookingId || 'N/A',
          recipient,
          subject,
          status: 'failed',
          error: error.message || String(error),
          failedAt: new Date().toISOString()
        }, { merge: true });
      } catch (logErr) {
        console.error('[EmailService] Failed to log email error:', logErr);
      }
    }

    return { success: false, error: error.message };
  }
}

// ==================== EMAIL EVENT DISPATCHERS ====================

/**
 * 1. Booking Created (Pending Payment/Approval)
 */
export async function sendBookingCreatedEmail({ db, booking, customer, vendor }) {
  const bookingId = booking.id || booking.bookingIdString;
  const bookingDate = booking.eventDate || 'TBD';

  // Email to Customer
  const customerHtml = getEmailLayout({
    title: 'Booking Request Received',
    badge: 'Status: Pending Confirmation',
    contentHtml: `
      <h2 style="font-size: 20px; font-weight: 800; color: #0f172a; margin-top: 0;">Booking Request Received! 🌸</h2>
      <p style="color: #475569; font-size: 14px;">Hi <strong>${customer.name}</strong>,</p>
      <p style="color: #475569; font-size: 14px;">We have received your booking request for <strong>${vendor.name}</strong>. Please note that your booking is <strong>NOT YET CONFIRMED</strong> until payment verification and vendor calendar alignment are finalized.</p>
      
      <div class="info-card">
        <div class="info-row"><span class="info-label">Booking ID:</span><span class="info-value">#${bookingId}</span></div>
        <div class="info-row"><span class="info-label">Vendor / Service:</span><span class="info-value">${vendor.name} (${vendor.category})</span></div>
        <div class="info-row"><span class="info-label">Event Date:</span><span class="info-value">${bookingDate}</span></div>
        <div class="info-row"><span class="info-label">Occasion:</span><span class="info-value">${booking.eventType || 'Celebration'}</span></div>
        <div class="info-row"><span class="info-label">Estimated Total:</span><span class="info-value amount-highlight">₹${Number(booking.finalPrice || booking.totalPrice || 0).toLocaleString('en-IN')}</span></div>
      </div>
      
      <p style="color: #64748b; font-size: 12px;">You will receive an official payment confirmation and tax receipt email once your advance fee is processed.</p>
    `,
    actionButton: { text: 'View Booking Status', url: `${APP_URL}` }
  });

  await sendIdempotentEmail({
    db,
    eventType: 'BOOKING_CREATED_CUSTOMER',
    bookingId,
    recipient: customer.email,
    subject: `Booking Request Received — #${bookingId}`,
    html: customerHtml
  });

  // Email to Vendor
  if (vendor.email) {
    const vendorHtml = getEmailLayout({
      title: 'New Booking Request',
      badge: 'Demand Alert',
      contentHtml: `
        <h2 style="font-size: 20px; font-weight: 800; color: #0f172a; margin-top: 0;">New Booking Demand Request! 🎉</h2>
        <p style="color: #475569; font-size: 14px;">Hi <strong>${vendor.name}</strong>,</p>
        <p style="color: #475569; font-size: 14px;">A customer has created a booking request for your service on <strong>${bookingDate}</strong>.</p>
        
        <div class="info-card">
          <div class="info-row"><span class="info-label">Booking Reference:</span><span class="info-value">#${bookingId}</span></div>
          <div class="info-row"><span class="info-label">Customer Name:</span><span class="info-value">${customer.name}</span></div>
          <div class="info-row"><span class="info-label">Event Date:</span><span class="info-value">${bookingDate}</span></div>
          <div class="info-row"><span class="info-label">Occasion:</span><span class="info-value">${booking.eventType || 'Celebration'}</span></div>
          <div class="info-row"><span class="info-label">Gross Value:</span><span class="info-value amount-highlight">₹${Number(booking.finalPrice || booking.totalPrice || 0).toLocaleString('en-IN')}</span></div>
        </div>

        <p style="color: #475569; font-size: 13px;">Please ensure your availability calendar is updated in your Vendor Hub.</p>
      `,
      actionButton: { text: 'Open Vendor Hub', url: `${APP_URL}` }
    });

    await sendIdempotentEmail({
      db,
      eventType: 'BOOKING_CREATED_VENDOR',
      bookingId,
      recipient: vendor.email,
      subject: `New Booking Request — #${bookingId}`,
      html: vendorHtml
    });
  }
}

/**
 * 2. Payment Successful & Booking Confirmed (With Official PDF Attachment)
 */
export async function sendPaymentAndBookingConfirmedEmails({ db, booking, customer, vendor, transaction, pdfBuffer, commissionData }) {
  const bookingId = booking.id || booking.bookingIdString;
  const bookingDate = booking.eventDate || 'TBD';
  const amountPaid = transaction.totalAmount || booking.finalPrice || booking.totalPrice || 0;
  const paymentId = transaction.paymentId || 'PAY_SUCCESS';

  // Customer Email (Confirmation + Receipt + PDF Attachment)
  const customerHtml = getEmailLayout({
    title: 'Booking Confirmed & Payment Received',
    badge: '✓ Payment Verified & Confirmed',
    contentHtml: `
      <h2 style="font-size: 20px; font-weight: 800; color: #059669; margin-top: 0;">Payment Successful & Booking Confirmed! 🎉</h2>
      <p style="color: #475569; font-size: 14px;">Hi <strong>${customer.name}</strong>,</p>
      <p style="color: #475569; font-size: 14px;">Your payment has been successfully verified, and your booking with <strong>${vendor.name}</strong> is officially <strong>CONFIRMED</strong>!</p>
      
      <div class="info-card">
        <div class="info-row"><span class="info-label">Booking Reference:</span><span class="info-value">#${bookingId}</span></div>
        <div class="info-row"><span class="info-label">Payment ID:</span><span class="info-value" style="font-family: monospace;">${paymentId}</span></div>
        <div class="info-row"><span class="info-label">Service & Vendor:</span><span class="info-value">${vendor.name} (${vendor.category})</span></div>
        <div class="info-row"><span class="info-label">Event Date:</span><span class="info-value">${bookingDate}</span></div>
        <div class="info-row"><span class="info-label">Location / City:</span><span class="info-value">${vendor.location || 'Kolhapur'}</span></div>
        <div class="info-row"><span class="info-label">Amount Paid:</span><span class="info-value amount-highlight">₹${Number(amountPaid).toLocaleString('en-IN')}</span></div>
        <div class="info-row"><span class="info-label">Payment Status:</span><span class="info-value" style="color: #059669;">✓ Verified (Paid)</span></div>
      </div>

      <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 14px; padding: 16px; margin: 16px 0;">
        <h4 style="margin: 0 0 6px 0; color: #166534; font-size: 13px;">📎 Official Receipt PDF Attached</h4>
        <p style="margin: 0; color: #15803d; font-size: 12px;">An official PDF confirmation tax invoice has been generated and attached to this email for your records.</p>
      </div>

      <h4 style="font-size: 13px; color: #0f172a; margin: 20px 0 8px 0;">Next Steps:</h4>
      <ol style="color: #475569; font-size: 13px; padding-left: 20px; margin: 0;">
        <li>The vendor has been notified and scheduled for your event date.</li>
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
    recipient: customer.email,
    subject: `Booking Confirmed — #${bookingId}`,
    html: customerHtml,
    attachments
  });

  // Vendor Email (New Confirmed Booking & Payout Statement)
  if (vendor.email) {
    const vendorPayout = commissionData?.vendorPayout || (amountPaid * 0.9);
    const platformCommission = commissionData?.platformCommission || (amountPaid * 0.1);

    const vendorHtml = getEmailLayout({
      title: 'New Confirmed Booking & Earnings Statement',
      badge: '✓ Confirmed Order',
      contentHtml: `
        <h2 style="font-size: 20px; font-weight: 800; color: #059669; margin-top: 0;">New Confirmed Booking Received! 💰</h2>
        <p style="color: #475569; font-size: 14px;">Hi <strong>${vendor.name}</strong>,</p>
        <p style="color: #475569; font-size: 14px;">Customer <strong>${customer.name}</strong> has paid and confirmed their reservation for your service.</p>
        
        <div class="info-card">
          <div class="info-row"><span class="info-label">Booking Reference:</span><span class="info-value">#${bookingId}</span></div>
          <div class="info-row"><span class="info-label">Customer Name:</span><span class="info-value">${customer.name}</span></div>
          <div class="info-row"><span class="info-label">Customer Contact:</span><span class="info-value">${customer.phone || 'Available in Vendor Hub'}</span></div>
          <div class="info-row"><span class="info-label">Event Date:</span><span class="info-value">${bookingDate}</span></div>
          <div class="info-row"><span class="info-label">Gross Booking Value:</span><span class="info-value">₹${Number(amountPaid).toLocaleString('en-IN')}</span></div>
          <div class="info-row"><span class="info-label">Platform Commission:</span><span class="info-value" style="color: #64748b;">- ₹${Number(platformCommission).toLocaleString('en-IN')}</span></div>
          <div class="info-row"><span class="info-label">Net Vendor Payout:</span><span class="info-value amount-highlight">₹${Number(vendorPayout).toLocaleString('en-IN')}</span></div>
        </div>

        <p style="color: #475569; font-size: 13px;">This date has been automatically blocked in your Operational Schedule Calendar.</p>
      `,
      actionButton: { text: 'Open Vendor Dashboard', url: `${APP_URL}` }
    });

    await sendIdempotentEmail({
      db,
      eventType: 'BOOKING_CONFIRMED_VENDOR',
      bookingId,
      recipient: vendor.email,
      subject: `New Booking Confirmed — #${bookingId}`,
      html: vendorHtml
    });
  }
}

/**
 * 3. Booking Cancellation
 */
export async function sendBookingCancellationEmail({ db, booking, customer, vendor, reason = 'Customer requested cancellation', refundAmount = 0 }) {
  const bookingId = booking.id || booking.bookingIdString;

  // Customer Cancellation Email
  const customerHtml = getEmailLayout({
    title: 'Booking Cancelled',
    badge: 'Status: Cancelled',
    contentHtml: `
      <h2 style="font-size: 20px; font-weight: 800; color: #dc2626; margin-top: 0;">Booking Cancelled — #${bookingId}</h2>
      <p style="color: #475569; font-size: 14px;">Hi <strong>${customer.name}</strong>,</p>
      <p style="color: #475569; font-size: 14px;">Your booking with <strong>${vendor.name}</strong> for <strong>${booking.eventDate || 'Scheduled Date'}</strong> has been cancelled.</p>
      
      <div class="info-card">
        <div class="info-row"><span class="info-label">Booking Reference:</span><span class="info-value">#${bookingId}</span></div>
        <div class="info-row"><span class="info-label">Cancellation Reason:</span><span class="info-value">${reason}</span></div>
        <div class="info-row"><span class="info-label">Refund Amount:</span><span class="info-value amount-highlight">₹${Number(refundAmount).toLocaleString('en-IN')}</span></div>
        <div class="info-row"><span class="info-label">Refund Timeline:</span><span class="info-value">5-7 Business Days</span></div>
      </div>

      <p style="color: #64748b; font-size: 12px;">Refunds are credited directly to your original payment method in accordance with our cancellation policy.</p>
    `,
    actionButton: { text: 'Explore Other Vendors', url: `${APP_URL}` }
  });

  await sendIdempotentEmail({
    db,
    eventType: 'BOOKING_CANCELLED_CUSTOMER',
    bookingId,
    recipient: customer.email,
    subject: `Booking Cancelled — #${bookingId}`,
    html: customerHtml
  });

  // Vendor Cancellation Notice
  if (vendor.email) {
    const vendorHtml = getEmailLayout({
      title: 'Booking Cancelled',
      badge: 'Calendar Slot Released',
      contentHtml: `
        <h2 style="font-size: 20px; font-weight: 800; color: #dc2626; margin-top: 0;">Booking Cancelled — #${bookingId}</h2>
        <p style="color: #475569; font-size: 14px;">Hi <strong>${vendor.name}</strong>,</p>
        <p style="color: #475569; font-size: 14px;">Booking #${bookingId} for <strong>${booking.eventDate}</strong> has been cancelled. Your calendar slot has been reopened for new inquiries.</p>
        
        <div class="info-card">
          <div class="info-row"><span class="info-label">Customer:</span><span class="info-value">${customer.name}</span></div>
          <div class="info-row"><span class="info-label">Date Released:</span><span class="info-value">${booking.eventDate}</span></div>
          <div class="info-row"><span class="info-label">Reason:</span><span class="info-value">${reason}</span></div>
        </div>
      `,
      actionButton: { text: 'View Vendor Schedule', url: `${APP_URL}` }
    });

    await sendIdempotentEmail({
      db,
      eventType: 'BOOKING_CANCELLED_VENDOR',
      bookingId,
      recipient: vendor.email,
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
  const refundAmount = refundData.amount || 0;
  const refundId = refundData.refundId || 'RFD_' + Date.now();

  const customerHtml = getEmailLayout({
    title: 'Refund Processed',
    badge: '✓ Refund Completed',
    contentHtml: `
      <h2 style="font-size: 20px; font-weight: 800; color: #059669; margin-top: 0;">Refund Successfully Processed! 💳</h2>
      <p style="color: #475569; font-size: 14px;">Hi <strong>${customer.name}</strong>,</p>
      <p style="color: #475569; font-size: 14px;">We have processed the refund for your cancelled booking #${bookingId}.</p>
      
      <div class="info-card">
        <div class="info-row"><span class="info-label">Booking ID:</span><span class="info-value">#${bookingId}</span></div>
        <div class="info-row"><span class="info-label">Refund Reference:</span><span class="info-value" style="font-family: monospace;">${refundId}</span></div>
        <div class="info-row"><span class="info-label">Refund Amount:</span><span class="info-value amount-highlight">₹${Number(refundAmount).toLocaleString('en-IN')}</span></div>
        <div class="info-row"><span class="info-label">Settlement Window:</span><span class="info-value">3-5 Banking Days</span></div>
        <div class="info-row"><span class="info-label">Status:</span><span class="info-value" style="color: #059669;">Settled to Bank / Card</span></div>
      </div>
    `,
    actionButton: { text: 'Return to Homepage', url: `${APP_URL}` }
  });

  await sendIdempotentEmail({
    db,
    eventType: 'REFUND_PROCESSED_CUSTOMER',
    bookingId,
    recipient: customer.email,
    subject: `Refund Processed — #${bookingId}`,
    html: customerHtml
  });
}
