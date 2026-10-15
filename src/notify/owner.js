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
const { m } = require('./messages');

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

  /**
   * How the price reads depends on how the shop handles the deposit. Hardcoding
   * "+ CHF 50.- Kaution" made the owner's copy contradict what the customer was
   * told, because the default is that the deposit is already in the shop price.
   */
  function priceLine(priceChf) {
    const deposit = settings.get('depositChf');
    switch (settings.get('depositMode')) {
      case 'separate':
        return settings.get('depositProductUrl')
          ? `CHF ${priceChf} + CHF ${deposit}.- Kaution (eigenes Produkt im Shop)`
          : `CHF ${priceChf} + CHF ${deposit}.- Kaution (separat, Zahlungsweg mit dem Kunden klaeren)`;
      case 'manual':
        return `CHF ${priceChf} im Shop + CHF ${deposit}.- Kaution bei der Abholung`;
      default:
        return `CHF ${priceChf} (inkl. CHF ${deposit}.- Kaution)`;
    }
  }

  /** The message the owner gets for a new booking request. */
  async function bookingRequest(booking, extra = {}) {
    const t = m();
    const f = t.bookingFields;
    const pad = (label) => `${label}:`.padEnd(11);
    const lines = [
      t.bookingTitle,
      '',
      `${pad(f.customer)}${booking.customerName}`,
      `${pad(f.whatsapp)}${booking.phone}`,
      `${pad(f.set)}${booking.productTitle}`,
      `${pad(f.pickup)}${booking.pickupDate}`,
      `${pad(f.ret)}${booking.returnDate}`,
      booking.priceChf ? `${pad(f.price)}${priceLine(booking.priceChf)}` : null,
      booking.occasion ? `${pad(f.occasion)}${booking.occasion}` : null,
      booking.childAge ? `${pad(f.age)}${booking.childAge}` : null,
      booking.themeNotes ? `${pad(f.theme)}${booking.themeNotes}` : null,
      booking.referencePhotoFileId ? `${pad(f.photo)}${t.photoYes}` : null,
      '',
      booking.productUrl ? `${f.shop}: ${booking.productUrl}` : null,
      extra.calendarLink ? `${f.calendar}: ${extra.calendarLink}` : null,
      '',
      t.bookingFooter,
    ].filter((l) => l !== null);

    return owner(lines.join('\n'), { kind: 'booking_request', bookingId: booking.id });
  }

  return { owner, bookingRequest, recipients };
}

module.exports = { createNotifier };
