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
  /**
   * Who gets alerts. The dedicated alert list wins; when it is empty the owner
   * number is used, so a fresh install still notifies someone.
   */
  function recipients() {
    const raw = String(settings.get('alertNumbers') || '').trim();
    const list = (raw || String(settings.get('ownerWhatsapp') || ''))
      .split(',')
      .map((n) => n.replace(/[^0-9]/g, ''))
      .filter((n) => n.length >= 8);
    return [...new Set(list)]; // the same number listed twice would send twice
  }

  async function owner(text, meta = {}, imageBuffer = null) {
    const numbers = recipients();
    if (!numbers.length) {
      log.warn(`No alert number configured - notification not sent: ${text.split('\n')[0]}`);
      return { ok: false, error: 'no alert number' };
    }
    const body = `\u{1F514} ${text}`;
    const failed = [];

    for (const number of numbers) {
      const jid = `${number}@s.whatsapp.net`;
      try {
        if (imageBuffer) await client.forwardImage(jid, imageBuffer, body);
        else await client.sendText(jid, body);
      } catch (err) {
        // One unreachable number must not stop the others.
        failed.push(`${number}: ${err.message}`);
        log.error(`Could not notify ${number} (${meta.kind || 'info'}): ${err.message}`);
      }
    }

    const sent = numbers.length - failed.length;
    if (sent) log.info(`Alert sent to ${sent}/${numbers.length} number(s) (${meta.kind || 'info'})`);
    return failed.length === numbers.length
      ? { ok: false, error: failed.join('; ') }
      : { ok: true, sent, failed };
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

  return { owner, bookingRequest, recipients };
}

module.exports = { createNotifier };
