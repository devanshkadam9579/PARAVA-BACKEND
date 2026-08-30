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
        eventType = 'Wedding Celebration',
        guestCount = 'N/A',
        totalAmount = 0,
        amountPaid = 0,
        paymentStatus = 'Paid',
        paymentId = 'N/A',
        orderId = 'N/A',
        termsVersion = '1.2',
        termsAcceptedAt = new Date().toISOString()
      } = data;

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

      doc.moveDown(3);

      // 2. Booking Summary Grid
      const startY = 120;
      doc.fillColor(darkColor).fontSize(12).font('Helvetica-Bold').text(`Booking Reference: #${bookingId}`, 40, startY);
      
      doc.strokeColor('#e2e8f0').lineWidth(1).moveTo(40, startY + 18).lineTo(555, startY + 18).stroke();

      // Customer Details (Left column)
      doc.fillColor(primaryColor).fontSize(10).font('Helvetica-Bold').text('CUSTOMER INFORMATION', 40, startY + 28);
      doc.fillColor(darkColor).fontSize(9).font('Helvetica-Bold').text(customerName, 40, startY + 44);
      doc.fillColor(secondaryColor).fontSize(9).font('Helvetica')
        .text(`Phone: ${customerPhone}`, 40, startY + 58)
        .text(`Email: ${customerEmail}`, 40, startY + 72);

      // Vendor Details (Right column)
      doc.fillColor(primaryColor).fontSize(10).font('Helvetica-Bold').text('VENDOR / SERVICE PROVIDER', 320, startY + 28);
      doc.fillColor(darkColor).fontSize(9).font('Helvetica-Bold').text(vendorName, 320, startY + 44);
      doc.fillColor(secondaryColor).fontSize(9).font('Helvetica')
        .text(`Category: ${vendorCategory}`, 320, startY + 58)
        .text(`City: ${vendorLocation}`, 320, startY + 72);

      // 3. Event Details Box
      const eventBoxY = startY + 98;
      doc.rect(40, eventBoxY, 515, 50).fillAndStroke('#fdf2f8', '#fbcfe8');

      doc.fillColor(primaryColor).fontSize(10).font('Helvetica-Bold').text('EVENT SCHEDULE & SPECIFICATIONS', 55, eventBoxY + 10);
      doc.fillColor(darkColor).fontSize(9).font('Helvetica')
        .text(`Occasion: ${eventType}`, 55, eventBoxY + 28)
        .text(`Date of Event: ${eventDate}`, 190, eventBoxY + 28)
        .text(`Slot: ${eventTimeSlot || 'Full Day (09:00 AM – 10:00 PM)'}`, 310, eventBoxY + 28)
        .text(`Guests: ${guestCount || 100}`, 470, eventBoxY + 28);

      // 4. Financial & Line Item Breakdown Table
      const tableY = eventBoxY + 68;
      doc.rect(40, tableY, 515, 24).fill(darkColor);
      doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold')
        .text('SERVICE / ITEM DESCRIPTION', 55, tableY + 7)
        .text('QTY', 350, tableY + 7)
        .text('AMOUNT (INR)', 450, tableY + 7, { align: 'right' });

      // Table Row
      doc.rect(40, tableY + 24, 515, 30).fill('#ffffff').stroke('#e2e8f0');
      doc.fillColor(darkColor).fontSize(9).font('Helvetica')
        .text(`${serviceName} (${vendorCategory})`, 55, tableY + 34)
        .text('1 Slot', 350, tableY + 34)
        .text(`₹${Number(totalAmount).toLocaleString('en-IN')}`, 450, tableY + 34, { align: 'right' });

      // Table Totals
      const totalBoxY = tableY + 62;
      doc.rect(300, totalBoxY, 255, 80).fill(lightBg).stroke('#cbd5e1');

      doc.fillColor(secondaryColor).fontSize(9).font('Helvetica')
        .text('Subtotal:', 315, totalBoxY + 10)
        .text(`₹${Number(totalAmount).toLocaleString('en-IN')}`, 450, totalBoxY + 10, { align: 'right' })
        .text('Advance Paid via Gateway:', 315, totalBoxY + 26)
        .text(`₹${Number(amountPaid).toLocaleString('en-IN')}`, 450, totalBoxY + 26, { align: 'right' })
        .text('Payment Status:', 315, totalBoxY + 42)
        .text(`${paymentStatus}`, 450, totalBoxY + 42, { align: 'right' });

      doc.fillColor(primaryColor).fontSize(10).font('Helvetica-Bold')
        .text('Total Net Paid:', 315, totalBoxY + 60)
        .text(`₹${Number(amountPaid).toLocaleString('en-IN')}`, 450, totalBoxY + 60, { align: 'right' });

      // Payment References
      doc.fillColor(secondaryColor).fontSize(8).font('Helvetica')
        .text(`Payment Ref: ${paymentId}`, 40, totalBoxY + 15)
        .text(`Order Reference: ${orderId}`, 40, totalBoxY + 28)
        .text(`Gateway: Cashfree Payments Secured Settlement`, 40, totalBoxY + 41);


      // 5. Legal & Policies Box
      const legalY = totalBoxY + 95;
      doc.rect(40, legalY, 515, 90).fill('#f1f5f9').stroke('#e2e8f0');

      doc.fillColor(darkColor).fontSize(9).font('Helvetica-Bold').text('CANCELLATION, REFUND & LEGAL POLICIES', 55, legalY + 10);
      doc.fillColor(secondaryColor).fontSize(7.5).font('Helvetica')
        .text('• Cancellation Policy: Free cancellation within 48 hours of booking. 50% refund up to 14 days before event date.', 55, legalY + 26)
        .text('• Refund Settlement: Approved refunds are processed back to the original source method within 5-7 business days.', 55, legalY + 38)
        .text('• Terms & Privacy: By booking on PARVA, you agreed to Terms & Conditions (v' + termsVersion + ') and Platform Privacy Policy.', 55, legalY + 50)
        .text(`• Policy Agreement Timestamp: ${termsAcceptedAt}`, 55, legalY + 62)
        .text('• Support Contact: support@parvaevents.com | Helpdesk Hotline: +91 95790 00000', 55, legalY + 74);

      // Footer
      doc.fillColor(secondaryColor).fontSize(8).font('Helvetica')
        .text('PARVA Celebrations Platform — Computer generated official invoice receipt. No physical signature required.', 40, 770, { align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
