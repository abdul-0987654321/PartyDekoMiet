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

/**
 * @param {object} deps
 * @param {object} deps.client
 * @param {string} [deps.business] line id. Defaults to 'party' - existing callers
 *   are unaffected. Only changes which settings keys recipients() reads from.
 * @param {function():string} [deps.ownNumbers] a professional's own alert
 *   numbers, read per alert so a change in the dashboard takes effect at once.
 *   Empty falls back to the Studio's settings, so her requests always reach
 *   somebody even before her own number is filled in.
 */
/**
 * Where an alert goes, and - just as important - why.
 *
 * There are four possible sources and they are tried in order, so "the field is
 * empty but alerts still arrive somewhere" is a perfectly ordinary state and
 * was impossible to understand from the dashboard. Two of these sources are not
 * visible anywhere: OWNER_WHATSAPP is set in the environment, and the linked
 * phone is not a setting at all. The owner deleted every number he could find
 * and the alerts kept coming, which from where he sat looked like the code
 * ignoring him.
 *
 * So this returns the numbers together with the name of the step that produced
 * them, and the dashboard prints it.
 *
 * @returns {{numbers: string[], source: string, key: string|null}}
 */
function explainRecipients({ business = 'party', ownNumbers = null, self = '' } = {}) {
  const studioSide = business !== 'party';
  const alertKey = studioSide ? 'studioAlertNumbers' : 'alertNumbers';
  const ownerKey = studioSide ? 'studioOwnerWhatsapp' : 'ownerWhatsapp';
  const clean = (raw) =>
    [...new Set(
      String(raw || '')
        .split(',')
        .map((n) => n.replace(/[^0-9]/g, ''))
        .filter((n) => n.length >= 8)
    )];

  const own = clean(ownNumbers ? ownNumbers() : '');
  if (own.length) return { numbers: own, source: 'line', key: null };

  const fromAlerts = clean(settings.get(alertKey));
  if (fromAlerts.length) return { numbers: fromAlerts, source: 'settings', key: alertKey };

  const fromOwner = clean(settings.get(ownerKey));
  if (fromOwner.length) return { numbers: fromOwner, source: 'owner', key: ownerKey };

  const linked = clean(self);
  if (linked.length) return { numbers: linked, source: 'linked', key: null };

  return { numbers: [], source: 'none', key: null };
}

function createNotifier({ client, business = 'party', ownNumbers = null }) {
  /**
   * The number this line is linked to - the phone that scanned the QR.
   *
   * Used only when nothing at all is configured. Somebody is holding that
   * phone, and it is the one person certain to be connected to this number, so
   * an alert reaching it is always better than an alert reaching nobody. For a
   * professional's own line that is her, which is what you would expect
   * without having to fill anything in.
   */
  function selfNumber() {
    try {
      const me = client.getStatus?.()?.me?.id || '';
      return String(me).split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
    } catch {
      return '';
    }
  }

  /**
   * Who gets alerts. Her own list wins, then the dedicated alert list, then the
   * owner number, so a fresh install still notifies someone. Everything that is
   * not PartyDekoMiet reads the Studio's settings.
   */
  function recipients() {
    return explainRecipients({ business, ownNumbers, self: selfNumber() }).numbers;
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
   * One named number, rather than whoever the alert list points at.
   *
   * Used to reach a professional about her own appointment. Kept apart from
   * owner() on purpose: that one is "tell whoever runs this", this one is "tell
   * exactly her", and the two must never quietly become the same thing.
   */
  async function toNumber(number, text) {
    const digits = String(number || '').replace(/[^0-9]/g, '');
    if (digits.length < 8) return { ok: false, error: 'no number' };
    try {
      await client.sendText(`${digits}@s.whatsapp.net`, `\u{1F514} ${text}`);
      return { ok: true };
    } catch (err) {
      log.error(`Could not notify ${digits}: ${err.message}`);
      return { ok: false, error: err.message };
    }
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
      // The dashboard, not a Google event. The calendar lives in the dashboard
      // now, and the alert used to end by telling the owner to go and edit an
      // event title by hand - a workflow that no longer exists and that read,
      // to him, like an instruction to confirm a payment himself.
      dashboardLink('/bookings') ? `${f.open}: ${dashboardLink('/bookings')}` : null,
      extra.calendarLink ? `${f.calendar}: ${extra.calendarLink}` : null,
      '',
      t.bookingFooter,
    ].filter((l) => l !== null);

    return owner(lines.join('\n'), { kind: 'booking_request', bookingId: booking.id });
  }

  /**
   * A link straight to the page where this is dealt with.
   *
   * Render sets RENDER_EXTERNAL_URL by itself, so this normally works with
   * nothing configured. Without either variable the line is simply left out -
   * a message saying "open the dashboard" with no address is noise.
   */
  function dashboardLink(path) {
    const base = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
    if (!base) return '';
    const biz = business === 'party' ? '' : '?biz=studio';
    return `${base}${path}${biz}`;
  }

  /** The message the owner gets for a new Studio appointment request. */
  async function appointmentRequest(appt, extra = {}) {
    const t = m();
    const f = t.appointmentFields;
    const pad = (label) => `${label}:`.padEnd(13);
    const lines = [
      t.appointmentTitle,
      '',
      `${pad(f.customer)}${appt.customerName}`,
      `${pad(f.whatsapp)}${appt.phone}`,
      `${pad(f.professional)}${appt.professionalName}`,
      `${pad(f.service)}${appt.serviceName}`,
      appt.priceChf ? `${pad(f.price)}CHF ${appt.priceChf}` : null,
      `${pad(f.date)}${appt.date}`,
      `${pad(f.time)}${appt.startTime}${appt.endTime ? `-${appt.endTime}` : ''}`,
      appt.sourcePortal ? `${pad(f.source)}${appt.sourcePortal}` : null,
      '',
      dashboardLink('/bookings') ? `${f.open}: ${dashboardLink('/bookings')}` : null,
      extra.calendarLink ? `${f.calendar}: ${extra.calendarLink}` : null,
      '',
      t.appointmentFooter,
    ].filter((l) => l !== null);

    return owner(lines.join('\n'), { kind: 'appointment_request', appointmentId: appt.id });
  }

  return { owner, toNumber, bookingRequest, appointmentRequest, recipients };
}

module.exports = { createNotifier, explainRecipients };
