'use strict';
/**
 * The calendar, kept in our own store instead of Google's.
 *
 * Why this exists: connecting Google needs a calendar created, shared with a
 * service account, its id copied out and pasted into the server's environment -
 * four steps, in two different products, that have to be repeated per business
 * and that nobody can finish without us. The owner asked for the appointments
 * to live in the dashboard, so they do.
 *
 * Why it is shaped like the Google client rather than something simpler: all
 * the difficult parts - overlap, buffers, minimum notice, closed weekdays,
 * all-day blocking entries, [PENDING] versus [CONFIRMED] - already exist in
 * availability.js and slots.js, are tested, and take a plain array of events.
 * They never cared where the array came from. So this presents the same six
 * methods the Google client does, and everything above it is untouched: the
 * agent tools, the booking flow, the appointment flow, the alert texts.
 *
 * Events are rows in the `calendarEvents` table, each tagged with the business
 * it belongs to, so the two businesses never see each other's days - the same
 * separation the rest of the system keeps.
 *
 * The shape of a row follows Google's: start/end carry either `date` (all-day)
 * or `dateTime`, and the identifying details live in extendedProperties.private.
 * Keeping that shape is what lets the maths stay as it is, and would let a
 * Google calendar be switched back on beside this one.
 */

const db = require('../store/db');
const log = require('../log');
const { wallTimeToUtc } = require('./slots');

/**
 * A stored wall time, handed out as an instant.
 *
 * Google returns "2026-12-21T14:00:00+01:00"; the writers in this project pass
 * the wall time and the zone separately, as Google accepts. Stored naked, that
 * string is read as the server's own timezone, which on a UTC host moves every
 * appointment by an hour and quietly made booked slots look free. The wall time
 * is what the dashboard should show, so it is stored as written and the offset
 * is added here, where the maths reads it.
 */
function withOffset(dateTime, timeZone) {
  if (!dateTime) return dateTime;
  if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(dateTime)) return dateTime; // already absolute
  const [date, time] = String(dateTime).split('T');
  if (!date || !time || !timeZone) return dateTime;
  try {
    return wallTimeToUtc(date, time.slice(0, 5), timeZone).toISOString();
  } catch {
    return dateTime;
  }
}

const nowIso = () => new Date().toISOString();

function newId() {
  return `E${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
}

/** The stored row, back in the shape the availability maths expects. */
function toEvent(row) {
  let priv = {};
  try {
    priv = row.privateJson ? JSON.parse(row.privateJson) : {};
  } catch {
    priv = {};
  }
  const start = row.allDay
    ? { date: row.startDate }
    : { dateTime: withOffset(row.startDateTime, row.timeZone), timeZone: row.timeZone };
  const end = row.allDay
    ? { date: row.endDate }
    : { dateTime: withOffset(row.endDateTime, row.timeZone), timeZone: row.timeZone };
  return {
    id: row.id,
    summary: row.summary || '',
    description: row.description || '',
    start,
    end,
    transparency: row.transparency || 'opaque',
    extendedProperties: { private: priv },
    // Nothing to link to: the dashboard is where these are read.
    htmlLink: null,
    source: row.source || '',
  };
}

/** A Google-shaped event, flattened into a row. */
/** An instant, back to the wall time of its zone - what the dashboard shows. */
function toWallTime(dateTime, timeZone) {
  if (!dateTime || !timeZone) return dateTime || '';
  if (!/[Zz]$|[+-]\d{2}:\d{2}$/.test(dateTime)) return dateTime; // already a wall time
  const d = new Date(dateTime);
  if (Number.isNaN(d.getTime())) return dateTime;
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d)) p[part.type] = part.value;
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}`;
}

function toRow(business, event, existing = null) {
  const allDay = Boolean(event.start?.date);
  const zone = event.start?.timeZone || existing?.timeZone || '';
  return {
    id: existing?.id || event.id || newId(),
    business,
    allDay,
    startDate: allDay ? event.start.date : '',
    endDate: allDay ? event.end?.date || event.start.date : '',
    // Always stored as the wall time of its zone, never as an instant: that is
    // what the dashboard shows, and a patch hands back what toEvent produced.
    startDateTime: allDay ? '' : toWallTime(event.start?.dateTime || '', zone),
    endDateTime: allDay ? '' : toWallTime(event.end?.dateTime || '', zone),
    timeZone: zone,
    summary: event.summary || '',
    description: event.description || '',
    transparency: event.transparency || 'opaque',
    privateJson: JSON.stringify(event.extendedProperties?.private || {}),
    source: event.source || existing?.source || 'bot',
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

/**
 * Does this event touch [timeMin, timeMax)?
 *
 * All-day entries are compared as dates, timed ones as instants. An entry that
 * starts before the window and ends inside it counts - a rental running across
 * the end of a month is exactly the case that must not be missed.
 */
function overlapsWindow(row, timeMin, timeMax) {
  if (row.allDay) {
    const from = String(timeMin).slice(0, 10);
    const to = String(timeMax).slice(0, 10);
    const start = row.startDate;
    const end = row.endDate || row.startDate; // Google's all-day end is exclusive
    return start < to && end > from;
  }
  const start = Date.parse(withOffset(row.startDateTime, row.timeZone));
  const end = Date.parse(withOffset(row.endDateTime || row.startDateTime, row.timeZone));
  if (Number.isNaN(start)) return false;
  return start < Date.parse(timeMax) && (Number.isNaN(end) ? start : end) > Date.parse(timeMin);
}

/**
 * @param {object} deps
 * @param {string} deps.business which business's days these are.
 * @param {string} [deps.timeZone]
 */
function createLocalCalendarClient({ business, timeZone = 'Europe/Zurich' }) {
  const rows = () => db.all('calendarEvents').filter((r) => r.business === business);

  return {
    // No account to share anything with - that is the point of this one.
    serviceAccountEmail: null,
    local: true,
    timeZone,

    async check() {
      return { ok: true, calendar: business, timeZone, local: true };
    },

    async listEvents({ timeMin, timeMax }) {
      return rows()
        .filter((r) => overlapsWindow(r, timeMin, timeMax))
        .map(toEvent)
        .sort((a, b) => String(a.start.dateTime || a.start.date).localeCompare(String(b.start.dateTime || b.start.date)));
    },

    async createEvent(event) {
      const row = toRow(business, event);
      db.put('calendarEvents', row);
      await db.flush();
      log.info(`[${business}] Calendar entry ${row.id} created: ${row.summary}`);
      return toEvent(row);
    },

    async patchEvent(eventId, patch) {
      const existing = db.get('calendarEvents', eventId);
      if (!existing || existing.business !== business) {
        throw new Error(`Calendar entry ${eventId} not found.`);
      }
      // A patch carries only what changed, so the rest is read back off the row.
      const merged = toRow(business, { ...toEvent(existing), ...patch }, existing);
      db.put('calendarEvents', merged);
      await db.flush();
      return toEvent(merged);
    },

    async deleteEvent(eventId) {
      const existing = db.get('calendarEvents', eventId);
      if (!existing || existing.business !== business) return { ok: true };
      db.remove('calendarEvents', eventId);
      await db.flush();
      log.info(`[${business}] Calendar entry ${eventId} removed.`);
      return { ok: true };
    },
  };
}

module.exports = { createLocalCalendarClient, toEvent, overlapsWindow };
