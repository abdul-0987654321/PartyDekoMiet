'use strict';
/**
 * Booking requests.
 *
 * A booking created here is always PENDING. It becomes binding only when the
 * owner has seen the paid Shopify order and switched the calendar event to
 * [CONFIRMED]; nothing in this file may ever write CONFIRMED by itself.
 */

const log = require('./log');
const db = require('./store/db');
const settings = require('./settings');
const { rentalWindow } = require('./calendar/dates');

function newId() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `B${d}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

/** The payment sentence depends on how the shop handles the deposit. */
function paymentHint(lang = 'de') {
  const deposit = settings.get('depositChf');
  const mode = settings.get('depositMode');
  const de = {
    included: `Die Kaution von CHF ${deposit}.- ist im Shop-Preis enthalten.`,
    separate: `Bitte im Shop zusaetzlich das Kautions-Produkt (CHF ${deposit}.-) in den Warenkorb legen: ${settings.get('depositProductUrl')}`,
    manual: `Die Kaution von CHF ${deposit}.- wird bei der Abholung hinterlegt.`,
  };
  const en = {
    included: `The CHF ${deposit}.- deposit is already included in the shop price.`,
    separate: `Please also add the deposit item (CHF ${deposit}.-) to your cart: ${settings.get('depositProductUrl')}`,
    manual: `The CHF ${deposit}.- deposit is handed over at pickup.`,
  };
  return (lang === 'en' ? en : de)[mode] || '';
}

/** Placeholders a model reaches for instead of asking for the real name. */
const PLACEHOLDER_NAMES = new Set([
  'customer', 'kunde', 'kundin', 'client', 'guest', 'gast', 'user', 'name',
  'unknown', 'unbekannt', 'n/a', 'na', '-', '--', 'test', 'anonymous',
]);

/**
 * The model once filed "October 20th" as the child's age, so the booking said
 * the birthday child was turning 20. Values that cannot be right are rejected
 * here rather than written into the owner's calendar.
 *
 * @returns {string|null} an error for the model, or null when the data is usable
 */
function validateBookingArgs(args) {
  const name = String(args.customer_name || '').trim();
  if (name.length < 2 || PLACEHOLDER_NAMES.has(name.toLowerCase())) {
    return 'Der Name des Kunden fehlt noch. Frag freundlich nach dem Namen, bevor du die Anfrage anlegst.';
  }
  if (args.child_age !== undefined && args.child_age !== null && args.child_age !== '') {
    const age = Number(args.child_age);
    if (!Number.isFinite(age) || age < 1 || age > 99) {
      return `child_age "${args.child_age}" ist kein plausibles Alter. Das Alter ist NICHT das Datum. Lass es weg oder frag nach.`;
    }
  }
  return null;
}

function createBookings({ catalog, calendar, notify }) {
  /**
   * @returns {object} tool result; the wording is read by the model, so it must
   *                   never sound like a confirmation.
   */
  async function create(args) {
    const problem = validateBookingArgs(args);
    if (problem) return { ok: false, error: problem };

    const product = catalog ? await catalog.byId(args.product_id) : null;
    if (!product) {
      return { ok: false, error: `Produkt ${args.product_id} nicht gefunden. Bitte zuerst search_products benutzen.` };
    }

    const win = rentalWindow(args.start_date, {
      returnDayOffset: settings.get('returnDayOffset'),
      bufferDays: settings.get('bufferDays'),
      closedWeekdays: settings.get('closedWeekdays'),
    });

    const jid = args.chatId || '';
    const customer = db.get('customers', jid);

    const booking = {
      id: newId(),
      status: 'PENDING',
      jid,
      phone: jid.split('@')[0] || '',
      customerName: args.customer_name,
      productId: product.id,
      productHandle: product.handle,
      productTitle: product.title,
      productUrl: product.url,
      priceChf: product.price,
      pickupDate: win.pickup,
      returnDate: win.return,
      occasion: args.occasion || '',
      childAge: args.child_age || '',
      themeNotes: args.theme_notes || '',
      referencePhotoFileId: customer?.referencePhotoFileId || (args.has_reference_photo ? 'pending' : ''),
      calendarEventId: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // The calendar is the source of truth for availability, so write it there
    // first. If that fails the booking is still kept and the owner is told.
    let calendarLink = null;
    if (calendar) {
      try {
        const event = await calendar.createBookingEvent(booking);
        booking.calendarEventId = event.id;
        calendarLink = event.htmlLink;
      } catch (err) {
        log.error(`Could not write booking ${booking.id} to the calendar: ${err.message}`);
      }
    }

    db.put('bookings', booking);
    db.put('customers', {
      ...(customer || { createdAt: new Date().toISOString() }),
      jid,
      phone: booking.phone,
      name: booking.customerName,
      occasion: booking.occasion,
      childAge: booking.childAge,
      partyDate: booking.pickupDate,
      updatedAt: new Date().toISOString(),
    });
    await db.flush();

    if (notify) {
      await notify.bookingRequest(booking, { calendarLink });
      if (!booking.calendarEventId) {
        const { m } = require('./notify/messages');
        await notify.owner(m().calendarFailed(booking.id), { kind: 'calendar_error', bookingId: booking.id });
      }
    }

    log.info(`Booking ${booking.id} created (PENDING) for ${booking.customerName} / ${booking.productTitle}`);

    return {
      ok: true,
      booking_id: booking.id,
      status: 'PENDING',
      pickup_date: booking.pickupDate,
      return_date: booking.returnDate,
      product_url: booking.productUrl,
      payment_hint: paymentHint('de'),
      payment_hint_en: paymentHint('en'),
      note:
        'Die Anfrage ist beim Team. NICHT als bestaetigt darstellen. Dem Kunden den Shop-Link schicken und um die Zahlung dort bitten.',
    };
  }

  /**
   * Changes a booking's status from the dashboard and keeps the calendar in
   * step, because the calendar is what decides availability. CANCELLED frees
   * the dates by deleting the event; anything else just retitles it.
   *
   * @param {string} id
   * @param {'PENDING'|'CONFIRMED'|'CANCELLED'} status
   */
  async function setStatus(id, status) {
    const allowed = ['PENDING', 'CONFIRMED', 'CANCELLED'];
    if (!allowed.includes(status)) {
      return { ok: false, error: `status must be one of ${allowed.join(', ')}` };
    }
    const booking = db.get('bookings', id);
    if (!booking) return { ok: false, error: `booking ${id} not found` };
    if (booking.status === status) return { ok: true, booking, unchanged: true };

    const previous = booking.status;
    let calendarWarning = null;

    if (calendar && booking.calendarEventId) {
      try {
        if (status === 'CANCELLED') {
          await calendar.deleteEvent(booking.calendarEventId);
          booking.calendarEventId = '';
        } else {
          await calendar.patchEvent(booking.calendarEventId, {
            summary: `[${status}] ${booking.productTitle} \u2013 ${booking.customerName}`,
            extendedProperties: { private: { bookingStatus: status } },
          });
        }
      } catch (err) {
        // The booking still changes; the owner is told the calendar did not.
        calendarWarning = err.message;
        log.error(`Booking ${id}: calendar not updated (${err.message})`);
      }
    }

    booking.status = status;
    booking.updatedAt = new Date().toISOString();
    db.put('bookings', booking);
    await db.flush();
    log.info(`Booking ${id}: ${previous} -> ${status}`);

    return { ok: true, booking, previous, calendarWarning };
  }

  function list({ status = null, limit = 100 } = {}) {
    return db
      .all('bookings')
      .filter((b) => !status || b.status === status)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  return { create, list, setStatus, paymentHint };
}

module.exports = { createBookings, paymentHint, newId, validateBookingArgs };
