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
const customers = require('./customers');
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
/** The calendar day after a YYYY-MM-DD, without going near a timezone. */
function nextDay(day) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function validateAppointmentArgs(args) {
  const name = String(args.customer_name || '').trim();
  if (name.length < 2 || PLACEHOLDER_NAMES.has(name.toLowerCase())) {
    return 'Der Name des Kunden fehlt noch. Frag freundlich nach dem Namen, bevor du die Anfrage anlegst.';
  }
  return null;
}

/**
 * @param {object} deps
 * @param {object} [deps.calendar]
 * @param {object} [deps.notify]
 * @param {string} [deps.business] which number took the request. The customer
 *   record lives under that number, so looking the phone up as 'studio' on a
 *   professional's line found nothing and the alert showed a raw WhatsApp id
 *   the owner cannot call - the exact problem contacts.js exists to prevent.
 */
function createAppointments({ calendar, notify, business = 'studio' }) {
  /** One appointment at a time per conversation - see the note in bookings.js. */
  const chatLocks = new Map();
  function runAlone(jid, work) {
    const previous = chatLocks.get(jid) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    chatLocks.set(jid, next);
    next.catch(() => {}).finally(() => {
      if (chatLocks.get(jid) === next) chatLocks.delete(jid);
    });
    return next;
  }
  /**
   * @returns {object} tool result; the wording is read by the model, so it must
   *                   never sound like a confirmation.
   */
  async function create(args) {
    return runAlone(args.chatId || 'no-chat', () => createOne(args));
  }

  async function createOne(args) {
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


    // The same slot asked for twice in one conversation is one appointment.

    const alreadyThere = db.all('appointments').find(

      (a) => a.status === 'PENDING'

        && a.jid === jid && jid

        && a.professionalId === professional.id

        && a.date === args.date

        && a.startTime === args.start_time

    );

    if (alreadyThere) {

      log.info(`Appointment request for the same slot already open (${alreadyThere.id}) - not making a second.`);

      return { ok: true, appointment_id: alreadyThere.id, status: alreadyThere.status,

        note: 'Diese Anfrage liegt bereits beim Team. Sag dem Kunden nichts von einer zweiten Anfrage.' };

    }

    const appt = {
      id: newId(),
      status: 'PENDING',
      jid,
      phone: require('./contacts').phoneOf(business, jid) || '',
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
    // Under the number that took the request, not under the Studio: saving it
    // as 'studio' put her customer's name and phone into the Studio's records
    // and left her own empty, so the next time he wrote to her the bot did not
    // know him.
    customers.save(business, jid, { phone: appt.phone, name: appt.customerName });
    await db.flush();

    if (notify) {
      await notify.appointmentRequest(appt, { calendarLink });

      // And the woman the appointment is actually for. Without this she only
      // learns of it if somebody passes it on, which on the Studio's main
      // number means she often did not learn of it at all.
      //
      // Unless her number IS this number. The owner put his own number in her
      // profile while setting her up, so one appointment produced two separate
      // WhatsApp messages in the same chat - the team alert and "a new request
      // for you, reply J" - with nothing to say which was which or why there
      // were two. One chat, one message.
      const ownNumber = String(professional.whatsapp || '').replace(/[^0-9]/g, '');
      const thisNumber = (notify.recipients?.() || [])[0] || '';
      if (ownNumber && ownNumber !== thisNumber && notify.toNumber) {
        const { m } = require('./notify/messages');
        await notify.toNumber(ownNumber, m().proRequest(appt, professional.name));
      }
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

    // The customer hears about it too - same as on the PartyDekoMiet side.
    // Confirming used to be silent towards the person actually waiting.
    let customerTold = false;
    if (notify?.toChat && appt.jid && (status === 'CONFIRMED' || status === 'CANCELLED')) {
      const { m } = require('./notify/messages');
      const texts = m();
      const text = status === 'CONFIRMED'
        ? texts.appointmentConfirmedCustomer(appt)
        : texts.appointmentCancelledCustomer(appt);
      const res = await notify.toChat(appt.jid, text, { plain: true });
      customerTold = Boolean(res?.ok);
      if (customerTold) log.info(`Appointment ${id}: the customer was told it is ${status.toLowerCase()}.`);
      else log.warn(`Appointment ${id}: the customer could not be told (${res?.error || 'unknown'})`);
    }

    // The team as well, for the same reason as on the PartyDekoMiet side.
    if (notify?.owner && (status === 'CONFIRMED' || status === 'CANCELLED')) {
      const { m } = require('./notify/messages');
      await notify.owner(m().appointmentStatusChanged(appt, status, customerTold), { kind: 'appointment_status' });
    }

    return { ok: true, appointment: appt, previous, calendarWarning };
  }

  /**
   * The appointment a professional is in right now, as far as the calendar
   * knows: today, not cancelled, already started or starting within the hour.
   *
   * "Starting within the hour" is there because she usually speaks a minute or
   * two before the client is on the table, and refusing her then would teach
   * her that the thing does not work.
   */
  function currentFor(professionalId, { now = new Date(), timeZone = 'Europe/Zurich' } = {}) {
    const today = now.toLocaleDateString('en-CA', { timeZone });
    const clock = now.toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' });
    const inAnHour = new Date(now.getTime() + 60 * 60000)
      .toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' });

    const todays = db
      .all('appointments')
      .filter((a) => a.professionalId === professionalId && a.date === today && a.status !== 'CANCELLED')
      .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));

    /**
     * An appointment whose end is not after its start ends after midnight.
     *
     * A 23:30 booking of an hour is stored as 23:30-00:30 on the 23:30 day,
     * and "00:30 > 23:50" is false, so between its start and midnight it
     * looked finished. She said the client was staying longer, was told there
     * was no appointment running, and the room stayed free in the calendar for
     * the next person. A studio that works past midnight hits this every night
     * it is busy.
     */
    const pastMidnight = (a) => Boolean(a.endTime) && a.endTime <= a.startTime;

    // Running now, or the next one about to start.
    return (
      todays.find((a) => a.startTime <= clock && (!a.endTime || a.endTime > clock || pastMidnight(a)))
      || todays.find((a) => a.startTime > clock && a.startTime <= inAnHour)
      || null
    );
  }

  /**
   * The client is staying longer. Moves the end of the appointment and the
   * calendar entry with it, so the next person is not sent into an occupied
   * room - which is the whole reason this exists.
   *
   * @param {string} id
   * @param {number} minutes
   */
  async function extend(id, minutes) {
    const appt = db.get('appointments', id);
    if (!appt) return { ok: false, error: `appointment ${id} not found` };
    const extra = Number(minutes);
    if (!Number.isFinite(extra) || extra <= 0 || extra > 240) {
      return { ok: false, error: 'minutes must be between 1 and 240' };
    }

    const from = appt.endTime || appt.startTime;
    const [h, min] = String(from).split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(min)) {
      return { ok: false, error: 'appointment has no usable time' };
    }

    /**
     * Where the appointment currently ends, as minutes from its own start day.
     *
     * An appointment that already runs past midnight has an end earlier on the
     * clock than its start - 23:30 to 00:30 - and adding to it has to keep
     * counting forward into that next day, not wrap back to the morning of the
     * first one.
     */
    const DAY = 24 * 60;
    const startsAt = (() => {
      const [sh, sm] = String(appt.startTime || '').split(':').map(Number);
      return Number.isFinite(sh) && Number.isFinite(sm) ? sh * 60 + sm : 0;
    })();
    const alreadyPastMidnight = Boolean(appt.endTime) && appt.endTime <= appt.startTime;
    const total = h * 60 + min + (alreadyPastMidnight ? DAY : 0) + extra;

    // Two days is the ceiling: nothing here runs longer, and it stops a typo
    // in the spoken minutes from pushing an entry a week out.
    const LIMIT = startsAt + DAY;
    const capped = Math.min(total, LIMIT);
    const endsNextDay = capped >= DAY;
    const endMinutes = capped % DAY;
    const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;

    // The cap swallowed the whole extension: reporting success here would tell
    // her the room is held while the calendar still frees it at the old time.
    if (endTime === appt.endTime) {
      return {
        ok: false,
        atEndOfDay: true,
        error: `Der Termin endet schon um ${appt.endTime} - weiter geht es nicht.`,
      };
    }

    let calendarWarning = null;
    if (calendar && appt.calendarEventId) {
      try {
        const endDate = endsNextDay ? nextDay(appt.date) : appt.date;
        await calendar.patchEvent(appt.calendarEventId, {
          end: { dateTime: `${endDate}T${endTime}:00`, timeZone: calendar.timeZone || 'Europe/Zurich' },
        });
      } catch (err) {
        calendarWarning = err.message;
        log.error(`Appointment ${id}: calendar not extended (${err.message})`);
      }
    }

    const previousEnd = appt.endTime;
    appt.endTime = endTime;
    appt.updatedAt = new Date().toISOString();
    db.put('appointments', appt);
    await db.flush();
    log.info(`Appointment ${id}: extended by ${extra} min (${previousEnd} -> ${endTime})`);

    return { ok: true, appointment: appt, previousEnd, minutes: extra, calendarWarning };
  }

  function list({ status = null, limit = 100 } = {}) {
    return db
      .all('appointments')
      .filter((a) => !status || a.status === status)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  return { create, list, setStatus, extend, currentFor };
}

module.exports = { createAppointments, newId, validateAppointmentArgs };
