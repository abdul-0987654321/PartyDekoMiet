'use strict';
/**
 * Calendar service used by the agent tools.
 *
 * Events are all-day and span the whole rental window, so the owner sees a clear
 * bar across the days a set is out. Google treats all-day end dates as
 * exclusive, hence the +1 day when writing.
 */

const log = require('../log');
const settings = require('../settings');
const { createCalendarClient } = require('./client');
const { checkWindow, findNextFree, PENDING } = require('./availability');
const { rentalWindow, addDays, todayIn, isIsoDay } = require('./dates');

function createCalendarService({ serviceAccountJsonB64, timeZone = 'Europe/Zurich', getStock }) {
  const client = createCalendarClient({
    serviceAccountJsonB64,
    getCalendarId: () => settings.get('calendarId'),
  });
  if (!client) return null;

  const stockFor = (productId) => (getStock ? getStock(productId) : settings.get('defaultStock')) || 1;

  /** Loads every event that could touch the window, with slack for long bookings. */
  async function eventsAround(from, to) {
    return client.listEvents({
      timeMin: new Date(`${addDays(from, -14)}T00:00:00Z`).toISOString(),
      timeMax: new Date(`${addDays(to, 14)}T00:00:00Z`).toISOString(),
    });
  }

  function windowOpts() {
    return {
      returnDayOffset: settings.get('returnDayOffset'),
      bufferDays: settings.get('bufferDays'),
      blockedKeywords: settings.get('blockedKeywords'),
      timeZone,
    };
  }

  return {
    serviceAccountEmail: client.serviceAccountEmail,
    check: () => client.check(),

    /**
     * Tool-facing availability check.
     * The returned object is read by the model, so the wording matters: it must
     * not be able to read this as a confirmation.
     */
    async checkAvailability({ productId, productHandle, start }) {
      if (!settings.get('calendarId')) {
        return { ok: false, error: 'Der Kalender ist noch nicht eingerichtet. Bitte den Fall weitergeben.' };
      }
      if (!isIsoDay(start)) {
        return { ok: false, error: `Datum muss YYYY-MM-DD sein, erhalten: "${start}".` };
      }
      const today = todayIn(timeZone);
      if (start < today) {
        return { ok: false, error: `Das Datum ${start} liegt in der Vergangenheit.` };
      }

      const opts = windowOpts();
      const win = rentalWindow(start, opts);
      const events = await eventsAround(win.blockStart, addDays(win.blockEnd, 45));
      const stock = stockFor(productId);
      const res = checkWindow({ events, productId, productHandle, pickup: start, stock, ...opts });

      if (res.available) {
        return {
          ok: true,
          available: true,
          pickup_date: win.pickup,
          return_date: win.return,
          note: 'Sieht frei aus. Das ist noch KEINE Bestaetigung - verbindlich wird es erst nach Pruefung und Zahlungseingang.',
        };
      }

      const alternatives = findNextFree({
        events, productId, productHandle,
        from: addDays(start, 1), days: 45, count: 3, stock, ...opts,
      });

      return {
        ok: true,
        available: false,
        reason: res.reason,
        pickup_date: win.pickup,
        return_date: win.return,
        next_free_pickup_dates: alternatives,
        note:
          res.reason === 'blocked_day'
            ? 'An diesem Datum ist generell geschlossen.'
            : 'Das Set ist in diesem Zeitraum schon vergeben.',
      };
    },

    /** Writes the PENDING event. Never CONFIRMED - only the owner does that. */
    async createBookingEvent(booking) {
      const opts = windowOpts();
      const win = rentalWindow(booking.pickupDate, opts);
      const title = `[${PENDING}] ${booking.productTitle} – ${booking.customerName}`;

      const description = [
        `Kunde: ${booking.customerName}`,
        `WhatsApp: ${booking.phone || booking.jid || '-'}`,
        `Produkt: ${booking.productTitle}`,
        `Link: ${booking.productUrl || '-'}`,
        `Preis: ${booking.priceChf ? `CHF ${booking.priceChf}` : 'unbekannt'} + CHF ${settings.get('depositChf')}.- Kaution`,
        `Abholung: ${win.pickup}`,
        `Rueckgabe: ${win.return}`,
        booking.occasion ? `Anlass: ${booking.occasion}` : null,
        booking.childAge ? `Alter: ${booking.childAge}` : null,
        booking.themeNotes ? `Motto/Farben: ${booking.themeNotes}` : null,
        booking.hasReferencePhoto ? 'Referenzbild: ja, im Google-Drive-Ordner' : null,
        '',
        'Nach Zahlungseingang: [PENDING] im Titel durch [CONFIRMED] ersetzen.',
        `Buchungs-ID: ${booking.id}`,
      ]
        .filter(Boolean)
        .join('\n');

      const event = await client.createEvent({
        summary: title,
        description,
        start: { date: win.blockStart },
        end: { date: addDays(win.blockEnd, 1) }, // Google's all-day end is exclusive
        transparency: 'opaque',
        extendedProperties: {
          private: {
            productId: String(booking.productId || ''),
            productHandle: String(booking.productHandle || ''),
            bookingId: String(booking.id),
            bookingStatus: PENDING,
            jid: String(booking.jid || ''),
          },
        },
      });

      log.info(`Calendar event created for booking ${booking.id}: ${event.id}`);
      return { id: event.id, htmlLink: event.htmlLink, window: win };
    },

    async listUpcoming(days = 60) {
      const today = todayIn(timeZone);
      return client.listEvents({
        timeMin: new Date(`${today}T00:00:00Z`).toISOString(),
        timeMax: new Date(`${addDays(today, days)}T00:00:00Z`).toISOString(),
      });
    },

    patchEvent: (id, patch) => client.patchEvent(id, patch),
    deleteEvent: (id) => client.deleteEvent(id),
  };
}

module.exports = { createCalendarService };
