'use strict';
/**
 * Appointment requests for the Studio.
 *
 * Mirrors bookings.js on purpose, so the two stay easy to compare. An
 * appointment created here is always PENDING - it becomes binding only when
 * the owner confirms it and switches the calendar event to [CONFIRMED];
 * nothing in this file may ever write CONFIRMED by itself.
 */

const log = require('./log');
const db = require('./store/db');
const settings = require('./settings');
const directory = require('./studio/directory');

function newId() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `A${d}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

/** Placeholders a model reaches for instead of asking for the real name. */
const PLACEHOLDER_NAMES = new Set([
  'customer', 'kunde', 'kundin', 'client', 'guest', 'gast', 'user', 'name',
  'unknown', 'unbekannt', 'n/a', 'na', '-', '--', 'test', 'anonymous',
]);

/** @returns {string|null} an error for the model, or null when the data is usable */
function validateAppointmentArgs(args) {
  const name = String(args.customer_name || '').trim();
  if (name.length < 2 || PLACEHOLDER_NAMES.has(name.toLowerCase())) {
    return 'Der Name des Kunden fehlt noch. Frag freundlich nach dem Namen, bevor du die Anfrage anlegst.';
  }
  return null;
}

function createAppointments({ calendar, notify }) {
  /**
   * @returns {object} tool result; the wording is read by the model, so it must
   *                   never sound like a confirmation.
   */
  async function create(args) {
    const problem = validateAppointmentArgs(args);
    if (problem) return { ok: false, error: problem };

    const professional = directory.getProfessional(args.professional_id);
    if (!professional) {
      return { ok: false, error: `Professional ${args.professional_id} nicht gefunden. Bitte zuerst get_professional_profile benutzen.` };
    }
    const service = directory.getService(args.service_id);
    if (!service) {
      return { ok: false, error: `Service ${args.service_id} nicht gefunden.` };
    }

    const jid = args.chatId || '';
    const customer = db.get('customers', jid);

    const appt = {
      id: newId(),
      status: 'PENDING',
      jid,
      phone: require('./contacts').phoneOf(jid) || '',
      customerName: args.customer_name,
      professionalId: professional.id,
      professionalName: professional.name,
      serviceId: service.id,
      serviceName: service.name,
      priceChf: service.priceChf || '',
      date: args.date,
      startTime: args.start_time,
      endTime: '',
      calendarEventId: '',
      sourcePortal: args.source_portal || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // The calendar is the source of truth for availability, so write it there
    // first. If that fails the appointment is still kept and the owner is told.
    let calendarLink = null;
    if (calendar) {
      try {
        const event = await calendar.createAppointmentEvent({ ...appt, durationMin: service.durationMin });
        appt.calendarEventId = event.id;
        appt.endTime = event.endTime;
        calendarLink = event.htmlLink;
      } catch (err) {
        log.error(`Could not write appointment ${appt.id} to the calendar: ${err.message}`);
      }
    }

    db.put('appointments', appt);
    db.put('customers', {
      ...(customer || { createdAt: new Date().toISOString() }),
      jid,
      business: 'studio',
      phone: appt.phone,
      name: appt.customerName,
      updatedAt: new Date().toISOString(),
    });
    await db.flush();

    if (notify) {
      await notify.appointmentRequest(appt, { calendarLink });
      if (!appt.calendarEventId) {
        const { m } = require('./notify/messages');
        await notify.owner(m().calendarFailed(appt.id), { kind: 'calendar_error', appointmentId: appt.id });
      }
    }

    log.info(`Appointment ${appt.id} created (PENDING) for ${appt.customerName} / ${appt.professionalName} / ${appt.serviceName}`);

    return {
      ok: true,
      appointment_id: appt.id,
      status: 'PENDING',
      date: appt.date,
      start_time: appt.startTime,
      note:
        'Die Anfrage ist beim Team. NICHT als bestaetigt darstellen. Sag dem Kunden, die Zeit sieht frei aus und das Team bestaetigt gleich.',
    };
  }

  /**
   * Changes an appointment's status from the dashboard and keeps the calendar
   * in step. CANCELLED frees the slot by deleting the event; anything else
   * just retitles it.
   *
   * @param {string} id
   * @param {'PENDING'|'CONFIRMED'|'CANCELLED'} status
   */
  async function setStatus(id, status) {
    const allowed = ['PENDING', 'CONFIRMED', 'CANCELLED'];
    if (!allowed.includes(status)) {
      return { ok: false, error: `status must be one of ${allowed.join(', ')}` };
    }
    const appt = db.get('appointments', id);
    if (!appt) return { ok: false, error: `appointment ${id} not found` };
    if (appt.status === status) return { ok: true, appointment: appt, unchanged: true };

    const previous = appt.status;
    let calendarWarning = null;

    if (calendar && appt.calendarEventId) {
      try {
        if (status === 'CANCELLED') {
          await calendar.deleteEvent(appt.calendarEventId);
          appt.calendarEventId = '';
        } else {
          await calendar.patchEvent(appt.calendarEventId, {
            summary: `[${status}] ${appt.serviceName} – ${appt.customerName}`,
            extendedProperties: { private: { bookingStatus: status } },
          });
        }
      } catch (err) {
        calendarWarning = err.message;
        log.error(`Appointment ${id}: calendar not updated (${err.message})`);
      }
    }

    appt.status = status;
    appt.updatedAt = new Date().toISOString();
    db.put('appointments', appt);
    await db.flush();
    log.info(`Appointment ${id}: ${previous} -> ${status}`);

    return { ok: true, appointment: appt, previous, calendarWarning };
  }

  function list({ status = null, limit = 100 } = {}) {
    return db
      .all('appointments')
      .filter((a) => !status || a.status === status)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  return { create, list, setStatus };
}

module.exports = { createAppointments, newId, validateAppointmentArgs };
