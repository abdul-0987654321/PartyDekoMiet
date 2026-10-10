'use strict';
/**
 * Owner notifications over WhatsApp.
 *
 * Deliberately never throws: a failed notification must not break the customer
 * conversation that triggered it. If the owner cannot be reached the message is
 * logged, so nothing is silently lost.
 */

const log = require('../log');
const settings = require('../settings');

function createNotifier({ client }) {
  async function owner(text, meta = {}, imageBuffer = null) {
    const number = String(settings.get('ownerWhatsapp') || '').replace(/[^0-9]/g, '');
    if (!number) {
      log.warn(`No owner number configured - notification not sent: ${text.split('\n')[0]}`);
      return { ok: false, error: 'no owner number' };
    }
    const jid = `${number}@s.whatsapp.net`;
    const body = `🔔 ${text}`;

    try {
      if (imageBuffer) await client.forwardImage(jid, imageBuffer, body);
      else await client.sendText(jid, body);
      log.info(`Owner notified (${meta.kind || 'info'})`);
      return { ok: true };
    } catch (err) {
      log.error(`Could not notify the owner (${meta.kind || 'info'}): ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /** The message the owner gets for a new booking request. */
  async function bookingRequest(booking, extra = {}) {
    const lines = [
      'NEUE BUCHUNGSANFRAGE',
      '',
      `Kunde:     ${booking.customerName}`,
      `WhatsApp:  ${booking.phone}`,
      `Set:       ${booking.productTitle}`,
      `Abholung:  ${booking.pickupDate}`,
      `Rueckgabe: ${booking.returnDate}`,
      booking.priceChf ? `Preis:     CHF ${booking.priceChf} + CHF ${settings.get('depositChf')}.- Kaution` : null,
      booking.occasion ? `Anlass:    ${booking.occasion}` : null,
      booking.childAge ? `Alter:     ${booking.childAge}` : null,
      booking.themeNotes ? `Motto:     ${booking.themeNotes}` : null,
      booking.referencePhotoFileId ? 'Referenzbild: ja' : null,
      '',
      booking.productUrl ? `Shop: ${booking.productUrl}` : null,
      extra.calendarLink ? `Kalender: ${extra.calendarLink}` : null,
      '',
      'Status [PENDING]. Nach Zahlungseingang im Kalender auf [CONFIRMED] aendern.',
    ].filter(Boolean);

    return owner(lines.join('\n'), { kind: 'booking_request', bookingId: booking.id });
  }

  return { owner, bookingRequest };
}

module.exports = { createNotifier };
