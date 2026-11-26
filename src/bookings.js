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
const customers = require('./customers');
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
  // "Separate" but no deposit item in the shop yet: say honestly that it comes on
  // top, without inventing how it is paid.
  if (mode === 'separate' && !settings.get('depositProductUrl')) {
    return lang === 'en'
      ? `On top of the rental price comes a CHF ${deposit}.- deposit, refunded after a complete return. We will tell you how to pay it when we confirm.`
      : `Zum Mietpreis kommt eine Kaution von CHF ${deposit}.-, die du nach vollstaendiger Rueckgabe zurueckbekommst. Wie du sie bezahlst, sagen wir dir mit der Bestaetigung.`;
  }
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
    // A reference photo the customer sent earlier is on their record. This line
    // read a variable that was never declared, so every single booking threw a
    // ReferenceError before it was written: the customer was told there was a
    // technical problem and the request reached nobody.
    const customer = customers.get('party', jid);

    // The same customer changing their mind about dates for the same set.
    //
    // Three open requests sat in the dashboard for one conversation: the set on
    // the 27th, the same set on the 1st, and the first one still open after the
    // bot itself had said the 27th was taken. Each one had sent its own alert.
    // Changing a date is not a second booking, so the earlier request is
    // withdrawn before the new one is made - which also frees the days it was
    // holding, so the availability check below is asked about a calendar that
    // no longer contains the customer's own abandoned attempt.
    const superseded = [];
    for (const old of db.all('bookings')) {
      if (old.status !== 'PENDING') continue;
      if (old.jid !== jid || !jid) continue;
      if (old.productId !== product.id) continue;
      const res = await setStatus(old.id, 'CANCELLED', { silent: true });
      if (res.ok) superseded.push(old.id);
    }
    if (superseded.length) {
      log.info(`Superseded earlier open request(s) for the same set: ${superseded.join(', ')}`);
    }

    // Is it actually free? This was never asked here, so a set the bot had just
    // said was taken could still be written into the book - and the owner found
    // out by reading two contradictory alerts.
    if (calendar) {
      try {
        const free = await calendar.checkAvailability({ productId: product.id, productHandle: product.handle, start: args.start_date });
        if (free.ok && free.available === false) {
          return {
            ok: false,
            error: 'Das Set ist an diesen Daten nicht frei. Biete dem Kunden eines der freien Daten an und frage, welches passt.',
            available: false,
            reason: free.reason,
            next_free_pickup_dates: free.next_free_pickup_dates || [],
          };
        }
      } catch (err) {
        // A calendar that cannot be read must not stop a request reaching the
        // team: a person checks it anyway before confirming.
        log.warn(`Availability could not be checked before booking: ${err.message}`);
      }
    }

    const booking = {
      id: newId(),
      business: 'party',
      status: 'PENDING',
      jid,
      phone: require('./contacts').phoneOf('party', jid) || '',
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
    customers.save('party', jid, {
      phone: booking.phone,
      name: booking.customerName,
      occasion: booking.occasion,
      childAge: booking.childAge,
      partyDate: booking.pickupDate,
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
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.silent] do not write to the customer. Used when an
   *   earlier request is withdrawn because the same customer is making a new
   *   one: they did not cancel anything, and telling them their booking was
   *   cancelled mid-conversation would be alarming and wrong.
   */
  async function setStatus(id, status, { silent = false } = {}) {
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

    // Tell the customer. Until now confirming was silent on their side: the
    // owner pressed the button, the dashboard turned green, and the person
    // waiting on WhatsApp heard nothing at all and had no way to know their
    // set was theirs.
    let customerTold = false;
    if (!silent && notify?.toNumber && booking.jid && (status === 'CONFIRMED' || status === 'CANCELLED')) {
      const { m } = require('./notify/messages');
      const texts = m();
      const text = status === 'CONFIRMED'
        ? texts.bookingConfirmedCustomer(booking)
        : texts.bookingCancelledCustomer(booking);
      const res = await notify.toNumber(String(booking.jid).split('@')[0], text, { plain: true });
      customerTold = Boolean(res?.ok);
      if (!customerTold) log.warn(`Booking ${id}: the customer could not be told (${res?.error || 'unknown'})`);
    }

    // And the team. The owner and his partner are not both looking at the
    // dashboard, so whoever pressed the button is otherwise the only person who
    // knows - and the owner reported confirming a booking and hearing nothing
    // at all, which from his side is indistinguishable from it not working.
    if (!silent && notify?.owner && (status === 'CONFIRMED' || status === 'CANCELLED')) {
      const { m } = require('./notify/messages');
      await notify.owner(m().bookingStatusChanged(booking, status, customerTold), { kind: 'booking_status' });
    }

    return { ok: true, booking, previous, calendarWarning, customerTold };
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
