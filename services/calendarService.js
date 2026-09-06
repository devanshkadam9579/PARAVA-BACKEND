/**
 * PARVA PLATFORM — EVENT CALENDAR & EXPORT SERVICE
 * Version 1.0.0
 * 
 * Rules:
 * - Generates standard iCalendar (.ics) files for Apple Calendar, Outlook, and Android
 * - Generates direct Google Calendar export URLs
 * - Non-blocking, client or server-side downloadable
 */

/**
 * Formats a Date object to iCalendar UTC string format: YYYYMMDDTHHmmssZ
 */
function formatIcsDate(date) {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

/**
 * Calculates start and end timestamps based on eventDate and eventTimeSlot
 */
function parseEventTimestamps(eventDate, eventTimeSlot) {
  const [year, month, day] = eventDate.split('-').map(Number);
  let startHour = 9;
  let endHour = 14;

  if (eventTimeSlot === 'evening') {
    startHour = 17;
    endHour = 23;
  } else if (eventTimeSlot === 'fullday') {
    startHour = 9;
    endHour = 23;
  }

  const startDate = new Date(Date.UTC(year, month - 1, day, startHour - 5, 30)); // Offset for IST UTC+5:30
  const endDate = new Date(Date.UTC(year, month - 1, day, endHour - 5, 30));

  return { startDate, endDate };
}

/**
 * Generates an iCalendar (.ics) formatted string
 */
export function generateIcsCalendar({ booking, vendor, service }) {
  const eventDate = booking.eventDate || new Date().toISOString().split('T')[0];
  const slot = booking.eventTimeSlot || 'evening';
  const { startDate, endDate } = parseEventTimestamps(eventDate, slot);

  const title = `MyParva: ${service?.name || 'Celebration Event'} with ${vendor?.name || 'Vendor'}`;
  const location = `${vendor?.location || 'Event Location'}, Maharashtra, India`;
  const description = `Confirmed celebration booking on MyParva.\\nBooking ID: ${booking.id || booking.bookingId}\\nService: ${service?.name || 'Event Service'}\\nVendor Contact: ${vendor?.whatsapp || 'In-App Chat'}`;

  const icsLines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MyParva Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:booking_${booking.id || booking.bookingId}@myparva.in`,
    `DTSTAMP:${formatIcsDate(new Date())}`,
    `DTSTART:${formatIcsDate(startDate)}`,
    `DTEND:${formatIcsDate(endDate)}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${description}`,
    `LOCATION:${location}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR'
  ];

  return icsLines.join('\r\n');
}

/**
 * Generates Google Calendar web add-event URL
 */
export function generateGoogleCalendarUrl({ booking, vendor, service }) {
  const eventDate = booking.eventDate || new Date().toISOString().split('T')[0];
  const slot = booking.eventTimeSlot || 'evening';
  const { startDate, endDate } = parseEventTimestamps(eventDate, slot);

  const text = encodeURIComponent(`MyParva: ${service?.name || 'Event'} - ${vendor?.name || 'Vendor'}`);
  const details = encodeURIComponent(`Confirmed Booking #${booking.id || booking.bookingId} on MyParva.\nService: ${service?.name || 'Event'}\nVendor: ${vendor?.name || 'Vendor'}`);
  const location = encodeURIComponent(`${vendor?.location || 'Event Location'}, Maharashtra, India`);
  const dates = `${formatIcsDate(startDate)}/${formatIcsDate(endDate)}`;

  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${dates}&details=${details}&location=${location}`;
}
