import PDFDocument from 'pdfkit';

/**
 * Generates an official Booking Confirmation & Receipt PDF
 * @param {Object} data Booking and transaction data
 * @returns {Promise<Buffer>} PDF Buffer
 */
export async function generateBookingPdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const buffers = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });

      const {
        bookingId = 'PRV-XXXX',
        customerName = 'Valued Customer',
        customerPhone = 'N/A',
        customerEmail = 'N/A',
        vendorName = 'Event Partner',
        vendorCategory = 'Event Services',
        vendorLocation = 'Maharashtra, India',
        serviceName = 'Standard Event Service',
        eventDate = new Date().toISOString().split('T')[0],
        eventTimeSlot = 'Full Day (09:00 AM – 10:00 PM)',
        eventType = 'Wedding Celebration',
        guestCount = 'N/A',
        totalAmount = 0,
        amountPaid = 0,
        paymentStatus = 'Paid',
        paymentId = 'N/A',
        orderId = 'N/A',
        termsVersion = '1.2',
        termsAcceptedAt = new Date().toISOString(),
        items = [],
        pricing = null
      } = data || {};

      // Colors
      const primaryColor = '#9d174d';
      const secondaryColor = '#475569';
      const darkColor = '#0f172a';
      const lightBg = '#f8fafc';
      const greenColor = '#059669';

      // 1. Header Banner
      doc.rect(40, 40, 515, 60).fill(lightBg);

      doc.fillColor(primaryColor)
        .fontSize(22)
        .font('Helvetica-Bold')
        .text('PARVA CELEBRATIONS', 55, 52);

      doc.fillColor(secondaryColor)
        .fontSize(9)
        .font('Helvetica')
        .text('Official Booking Confirmation & Tax Invoice Receipt', 55, 78);

      doc.fillColor(greenColor)
        .fontSize(11)
        .font('Helvetica-Bold')
        .text('STATUS: CONFIRMED', 410, 55, { align: 'right' });

      doc.fillColor(secondaryColor)
        .fontSize(8)
        .font('Helvetica')
        .text(`Issued: ${new Date().toLocaleDateString('en-IN')}`, 410, 72, { align: 'right' });

      // 2. Booking Summary Grid
      const startY = 115;
      doc.fillColor(darkColor).fontSize(12).font('Helvetica-Bold').text(`Booking Reference: #${bookingId}`, 40, startY);

      doc.strokeColor('#e2e8f0').lineWidth(1).moveTo(40, startY + 18).lineTo(555, startY + 18).stroke();

      // Customer Details (Left column)
      doc.fillColor(primaryColor).fontSize(10).font('Helvetica-Bold').text('CUSTOMER INFORMATION', 40, startY + 28);
      doc.fillColor(darkColor).fontSize(9).font('Helvetica-Bold').text(String(customerName || 'Customer'), 40, startY + 44);
      doc.fillColor(secondaryColor).fontSize(9).font('Helvetica')
        .text(`Phone: ${customerPhone || 'N/A'}`, 40, startY + 58)
        .text(`Email: ${customerEmail || 'N/A'}`, 40, startY + 72);

      // Vendor Details (Right column)
      doc.fillColor(primaryColor).fontSize(10).font('Helvetica-Bold').text('VENDOR / SERVICE PROVIDER', 320, startY + 28);
      doc.fillColor(darkColor).fontSize(9).font('Helvetica-Bold').text(String(vendorName || 'Event Partner'), 320, startY + 44);
      doc.fillColor(secondaryColor).fontSize(9).font('Helvetica')
        .text(`Category: ${vendorCategory || 'Event Service'}`, 320, startY + 58)
        .text(`City: ${vendorLocation || 'Maharashtra, India'}`, 320, startY + 72);

      // 3. Event Details Box
      const eventBoxY = startY + 95;
      doc.rect(40, eventBoxY, 515, 46).fillAndStroke('#fdf2f8', '#fbcfe8');

      doc.fillColor(primaryColor).fontSize(9).font('Helvetica-Bold').text('EVENT SCHEDULE & SPECIFICATIONS', 55, eventBoxY + 8);
      doc.fillColor(darkColor).fontSize(8.5).font('Helvetica')
        .text(`Occasion: ${eventType}`, 55, eventBoxY + 24)
        .text(`Date of Event: ${eventDate}`, 175, eventBoxY + 24)
        .text(`Slot: ${eventTimeSlot}`, 295, eventBoxY + 24)
        .text(`Guests: ${guestCount}`, 450, eventBoxY + 24);

      // 4. Financial & Line Item Breakdown Table
      const tableY = eventBoxY + 56;
      doc.rect(40, tableY, 515, 22).fill(darkColor);
      doc.fillColor('#ffffff').fontSize(8.5).font('Helvetica-Bold')
        .text('SERVICE / ITEM DESCRIPTION', 55, tableY + 6)
        .text('QTY / DETAILS', 340, tableY + 6)
        .text('SUBTOTAL (INR)', 450, tableY + 6, { align: 'right' });

      // Render line items
      const displayItems = Array.isArray(items) && items.length > 0 ? items : [
        { name: serviceName, quantity: 1, price: totalAmount }
      ];

      let currentY = tableY + 22;
      const rowHeight = 22;
      const maxRows = Math.min(displayItems.length, 6);

      for (let i = 0; i < maxRows; i++) {
        const item = displayItems[i];
        const isAlt = i % 2 === 1;
        doc.rect(40, currentY, 515, rowHeight).fill(isAlt ? '#f8fafc' : '#ffffff').stroke('#e2e8f0');

        const itemName = item.name || item.serviceName || serviceName;
        const itemQty = item.guestCount ? `${item.guestCount} Guests` : (item.quantity ? `${item.quantity} Unit(s)` : '1 Slot');
        const itemPrice = item.price ? Number(item.price) : Number(totalAmount);

        doc.fillColor(darkColor).fontSize(8.5).font('Helvetica')
          .text(itemName.substring(0, 45), 55, currentY + 6)
          .text(itemQty, 340, currentY + 6)
          .text(`₹${itemPrice.toLocaleString('en-IN')}`, 450, currentY + 6, { align: 'right' });

        currentY += rowHeight;
      }

      // 5. Financial Totals Box
      const totalBoxY = currentY + 10;
      doc.rect(280, totalBoxY, 275, 105).fill(lightBg).stroke('#cbd5e1');

      const bookingFeeINR = pricing?.bookingFeeINR || Math.round(Number(totalAmount) * 0.05);
      const gstINR = pricing?.gstINR || Math.round(bookingFeeINR * 0.18);
      const discountINR = pricing?.couponDiscountINR || 0;
      const effectiveAdvance = Number(amountPaid) || (bookingFeeINR + gstINR);
      const remainingBalance = Math.max(0, Number(totalAmount) - discountINR - effectiveAdvance);

      let textY = totalBoxY + 8;
      doc.fillColor(secondaryColor).fontSize(8).font('Helvetica')
        .text('Gross Event Subtotal:', 295, textY)
        .text(`₹${Number(totalAmount).toLocaleString('en-IN')}`, 450, textY, { align: 'right' });

      if (discountINR > 0) {
        textY += 14;
        doc.fillColor(greenColor).fontSize(8).font('Helvetica')
          .text(`Coupon Discount:`, 295, textY)
          .text(`- ₹${discountINR.toLocaleString('en-IN')}`, 450, textY, { align: 'right' });
      }

      textY += 14;
      doc.fillColor(secondaryColor).fontSize(8).font('Helvetica')
        .text('Platform Booking Fee (5%):', 295, textY)
        .text(`₹${bookingFeeINR.toLocaleString('en-IN')}`, 450, textY, { align: 'right' });

      textY += 14;
      doc.fillColor(secondaryColor).fontSize(8).font('Helvetica')
        .text('GST on Platform Fee (18%):', 295, textY)
        .text(`₹${gstINR.toLocaleString('en-IN')}`, 450, textY, { align: 'right' });

      textY += 16;
      doc.rect(285, textY - 2, 265, 18).fill('#ecfdf5');
      doc.fillColor(greenColor).fontSize(9).font('Helvetica-Bold')
        .text('Advance Paid via Cashfree PG:', 295, textY + 2)
        .text(`₹${Number(amountPaid).toLocaleString('en-IN')}`, 450, textY + 2, { align: 'right' });

      textY += 20;
      doc.fillColor(primaryColor).fontSize(8.5).font('Helvetica-Bold')
        .text('Balance Due at Venue (to Vendor):', 295, textY)
        .text(`₹${remainingBalance.toLocaleString('en-IN')}`, 450, textY, { align: 'right' });

      // Payment References Box (Left)
      doc.fillColor(secondaryColor).fontSize(8).font('Helvetica')
        .text(`Payment Status: ${paymentStatus}`, 40, totalBoxY + 10)
        .text(`Payment ID: ${paymentId}`, 40, totalBoxY + 24)
        .text(`Order Reference: ${orderId}`, 40, totalBoxY + 38)
        .text(`Payment Gateway: Cashfree PG Secured`, 40, totalBoxY + 52)
        .text(`Security: RBI Compliant 256-bit TLS`, 40, totalBoxY + 66);

      // 6. Legal & Policies Box
      const legalY = totalBoxY + 115;
      doc.rect(40, legalY, 515, 80).fill('#f1f5f9').stroke('#e2e8f0');

      doc.fillColor(darkColor).fontSize(8.5).font('Helvetica-Bold').text('CANCELLATION, REFUND & LEGAL POLICIES', 55, legalY + 8);
      doc.fillColor(secondaryColor).fontSize(7.5).font('Helvetica')
        .text('• Cancellation Policy: Free cancellation within 48 hours of booking. 50% advance refund up to 14 days before event date.', 55, legalY + 22)
        .text('• Balance Payment: Remaining event balance is payable directly to the service vendor at the venue on or before event date.', 55, legalY + 33)
        .text('• Refund Settlement: Approved refunds are processed back to the original source method within 5-7 business days via Cashfree.', 55, legalY + 44)
        .text(`• Policy Agreement: Accepted Terms of Service (v${termsVersion}) at ${termsAcceptedAt}.`, 55, legalY + 55)
        .text('• 24x7 Customer Support: support@myparva.com | Parva Celebrations Marketplace Maharashtra', 55, legalY + 66);

      // Footer
      doc.fillColor(secondaryColor).fontSize(7.5).font('Helvetica')
        .text('PARVA Celebrations Platform — Computer generated official invoice receipt. No physical signature required.', 40, 770, { align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
