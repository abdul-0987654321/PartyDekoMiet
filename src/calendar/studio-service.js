'use strict';
/**
 * Calendar service for the Studio (appointments), used by the agent tools.
 *
 * Kept separate from calendar/index.js on purpose - that one books whole days
 * (the rental window); this one books an HH:MM-HH:MM slot on one day for one
 * professional. Reuses calendar/client.js (already generic - it takes
 * getCalendarId as a callback) and calendar/slots.js for the overlap math.
 */

const log = require('../log');
const settings = require('../settings');
const { createCalendarClient } = require('./client');
const { checkSlot, findNextFreeOnDay, PENDING } = require('./slots');
const { addDays, todayIn, isIsoDay } = require('./dates');

function createStudioCalendarService({ serviceAccountJsonB64, timeZone = 'Europe/Zurich' }) {
  const client = createCalendarClient({
    serviceAccountJsonB64,
    getCalendarId: () => settings.get('studioCalendarId'),
  });
  if (!client) return null;

  async function eventsOnDay(date) {
    return client.listEvents({
      timeMin: new Date(`${date}T00:00:00Z`).toISOString(),
      timeMax: new Date(`${addDays(date, 1)}T00:00:00Z`).toISOString(),
    });
  }

  function opts() {
    return {
      bufferMin: settings.get('studioBufferMin'),
      minNoticeHours: settings.get('studioMinNoticeHours'),
      blockedKeywords: settings.get('studioBlockedKeywords'),
      timeZone,
    };
  }

  return {
    serviceAccountEmail: client.serviceAccountEmail,
    check: () => client.check(),

    /**
     * Tool-facing slot check. The returned object is read by the model, so the
     * wording must never read as a confirmation.
     */
    async checkSlotAvailability({ professionalId, professionalName, date, startTime, durationMin }) {
      if (!settings.get('studioCalendarId')) {
        return { ok: false, error: 'Der Kalender ist noch nicht eingerichtet. Bitte den Fall weitergeben.' };
      }
      if (!isIsoDay(date)) return { ok: false, error: `Datum muss YYYY-MM-DD sein, erhalten: "${date}".` };
      const today = todayIn(timeZone);
      if (date < today) return { ok: false, error: `Das Datum ${date} liegt in der Vergangenheit.` };

      const events = await eventsOnDay(date);
      const res = checkSlot({ events, professionalId, professionalName, date, startTime, durationMin, ...opts() });

      if (res.available) {
        return {
          ok: true,
          available: true,
          date,
          start_time: startTime,
          note: 'Sieht frei aus. Das ist noch KEINE Bestaetigung - verbindlich wird es erst, wenn das Team es bestaetigt.',
        };
      }

      // Offer a few other times the same day, every 30 minutes from 1h after
      // the requested time to the end of a normal working window.
      const candidates = [];
      for (let m = 0; m < 12 * 60; m += 30) {
        const h = String(Math.floor(m / 60)).padStart(2, '0');
        const mm = String(m % 60).padStart(2, '0');
        candidates.push(`${h}:${mm}`);
      }
      const alternatives = findNextFreeOnDay({
        events, professionalId, professionalName, date, durationMin, candidateTimes: candidates, count: 3, ...opts(),
      });

      return {
        ok: true,
        available: false,
        reason: res.reason,
        date,
        next_free_times_same_day: alternatives,
        note:
          res.reason === 'blocked_day'
            ? 'An diesem Tag ist generell geschlossen.'
            : res.reason === 'too_soon'
              ? 'Das ist zu kurzfristig. Biete einen spaeteren Zeitpunkt an.'
              : 'Zu dieser Zeit schon vergeben.',
      };
    },

    /** Writes the PENDING event. Never CONFIRMED - only the owner does that. */
    async createAppointmentEvent(appt) {
      const title = `[${PENDING}] ${appt.serviceName} – ${appt.customerName}`;
      const [h, min] = appt.startTime.split(':').map(Number);
      const endTotal = h * 60 + min + Number(appt.durationMin || 0);
      const endTime = `${String(Math.floor(endTotal / 60)).padStart(2, '0')}:${String(endTotal % 60).padStart(2, '0')}`;

      const description = [
        `Kunde: ${appt.customerName}`,
        `WhatsApp: ${appt.phone || appt.jid || '-'}`,
        `Professional: ${appt.professionalName}`,
        `Service: ${appt.serviceName}`,
        appt.priceChf ? `Preis: CHF ${appt.priceChf}` : null,
        `Datum: ${appt.date}`,
        `Zeit: ${appt.startTime} - ${endTime}`,
        '',
        'Nach Bestaetigung durch das Team: [PENDING] im Titel durch [CONFIRMED] ersetzen.',
        `Termin-ID: ${appt.id}`,
      ]
        .filter(Boolean)
        .join('\n');

      const event = await client.createEvent({
        summary: title,
        description,
        start: { dateTime: `${appt.date}T${appt.startTime}:00`, timeZone },
        end: { dateTime: `${appt.date}T${endTime}:00`, timeZone },
        transparency: 'opaque',
        extendedProperties: {
          private: {
            professionalId: String(appt.professionalId || ''),
            appointmentId: String(appt.id),
            bookingStatus: PENDING,
            jid: String(appt.jid || ''),
          },
        },
      });

      log.info(`Calendar event created for appointment ${appt.id}: ${event.id}`);
      return { id: event.id, htmlLink: event.htmlLink, endTime };
    },

    patchEvent: (id, patch) => client.patchEvent(id, patch),
    deleteEvent: (id) => client.deleteEvent(id),
  };
}

module.exports = { createStudioCalendarService };
