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
 * Where an alert goes.
 *
 * One answer, and it needs no setting up: the number this line is connected
 * on. Whoever scanned the QR for PartyDekoMiet is the person who deals with
 * PartyDekoMiet's requests; whoever scanned it for the Studio deals with the
 * Studio's; a professional's own number is her. The alert lands in that
 * phone's own "Message yourself" chat, which is a real chat with a real
 * notification, and the owner can answer the customer by quoting it.
 *
 * It used to be four sources tried in order - her own list, then an alert
 * list, then an owner number, then the linked phone - with three of them
 * typed in by hand and two of them invisible. Every single confusion about
 * alerts in the last month came out of that ladder: a number saved months ago
 * in the dashboard quietly beat the one set on Render, an emptied field
 * changed nothing because the next rung took over, and nobody could see which
 * rung was in play. Numbers are not worth typing when the right one is
 * already known, so now none of them are typed.
 *
 * When the line is not connected there is no number - and nothing could be
 * sent anyway, since sending needs the same socket.
 *
 * @returns {{numbers: string[], source: 'linked'|'offline', key: null}}
 */
function explainRecipients({ self = '' } = {}) {
  const numbers = [...new Set(
    String(self || '')
      .split(',')
      .map((n) => n.replace(/[^0-9]/g, ''))
      .filter((n) => n.length >= 8)
  )];
  return numbers.length
    ? { numbers, source: 'linked', key: null }
    : { numbers: [], source: 'offline', key: null };
}

function createNotifier({ client, business = 'party' }) {
  /**
   * The number this line is linked to - the phone that scanned the QR. The
   * only alert destination there is.
   */
  function selfNumber() {
    try {
      const me = client.getStatus?.()?.me?.id || '';
      return String(me).split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
    } catch {
      return '';
    }
  }

  /** Who gets alerts: the phone this line is connected on. */
  function recipients() {
    return explainRecipients({ self: selfNumber() }).numbers;
  }

  /**
   * The same alert, about the same chat, twice in a row.
   *
   * A customer writing two awkward messages in a row produced two identical
   * "somebody needs you" alerts within a minute. The second one carries no
   * information the first did not, and two buzzes for one situation is how
   * people start ignoring the buzz.
   *
   * Keyed on kind and chat, not on the text, so a handoff about one customer
   * never silences a handoff about another.
   */
  const recentAlerts = new Map();
  const REPEAT_WINDOW_MS = 2 * 60 * 1000;

  function isRepeat(meta) {
    if (!meta.kind || !meta.jid) return false;
    const key = `${meta.kind}:${meta.jid}`;
    const last = recentAlerts.get(key) || 0;
    const now = Date.now();
    if (now - last < REPEAT_WINDOW_MS) return true;
    recentAlerts.set(key, now);
    // Nothing older than the window is worth remembering.
    for (const [k, at] of recentAlerts) if (now - at > REPEAT_WINDOW_MS) recentAlerts.delete(k);
    return false;
  }

  /**
   * Which number this alert is about.
   *
   * Every alert now lands in one phone's own chat, and that phone may be the
   * one PartyDekoMiet is on, the one the Studio is on, or a professional's.
   * Three different things arriving in three different chats that all look the
   * same is how "what is this message and what am I supposed to do with it"
   * starts, and it did.
   */
  function lineLabel() {
    try {
      return require('../lines').nameOf(business);
    } catch {
      return '';
    }
  }

  async function owner(text, meta = {}, imageBuffer = null) {
    if (isRepeat(meta)) {
      log.info(`Alert suppressed (${meta.kind}) - the same one went out for this chat moments ago.`);
      return { ok: true, suppressed: true };
    }
    const numbers = recipients();
    if (!numbers.length) {
      log.warn(`This number is not connected - alert not sent: ${text.split('\n')[0]}`);
      return { ok: false, error: 'not connected' };
    }
    const label = lineLabel();
    const body = `\u{1F514} ${text}${label ? `\n\n[${label}]` : ''}`;
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
   * A message back into a chat we are already in.
   *
   * Not toNumber. WhatsApp now addresses most people by a hidden id - a LID,
   * like 150375495651422@lid - rather than by their phone number. Taking that
   * chat id apart and building "150375495651422@s.whatsapp.net" out of it
   * produces an address belonging to nobody, and the message goes nowhere.
   *
   * That is exactly what happened to every booking and appointment
   * confirmation: the owner pressed Confirm, the status changed, the calendar
   * updated, his own alert arrived - and the customer, the one person actually
   * waiting to hear, was sent a message to an address that does not exist.
   *
   * The chat id we already have is the right address. It is the chat the
   * conversation happened in.
   */
  async function toChat(jid, text, { plain = false } = {}) {
    const target = String(jid || '').trim();
    if (!target.includes('@')) {
      // Not a chat id but a bare number - the old call sites passed those.
      return toNumber(target, text, { plain });
    }
    try {
      await client.sendText(target, plain ? text : `\u{1F514} ${text}`);
      return { ok: true };
    } catch (err) {
      log.error(`Could not write to ${target}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /**
   * One named number, rather than whoever the alert list points at.
   *
   * Used to reach a professional about her own appointment, who is known by
   * her phone number and not by a chat. For somebody we are already talking
   * to, use toChat.
   */
  async function toNumber(number, text, { plain = false } = {}) {
    const digits = String(number || '').replace(/[^0-9]/g, '');
    if (digits.length < 8) return { ok: false, error: 'no number' };
    try {
      // The bell marks a message as internal. A customer being told their
      // booking is confirmed must not get one.
      await client.sendText(`${digits}@s.whatsapp.net`, plain ? text : `\u{1F514} ${text}`);
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

  /**
   * The message the owner gets for a new Studio appointment request.
   *
   * @param {object} [extra]
   * @param {boolean} [extra.ownLine] this number belongs to the professional
   *   the appointment is for, so the alert is already in her hand and ends
   *   with what she can do from there.
   */
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
      extra.ownLine ? t.appointmentFooterOwnLine : t.appointmentFooter,
    ].filter((l) => l !== null);

    return owner(lines.join('\n'), { kind: 'appointment_request', appointmentId: appt.id });
  }

  return { owner, toNumber, toChat, bookingRequest, appointmentRequest, recipients };
}

module.exports = { createNotifier, explainRecipients };
