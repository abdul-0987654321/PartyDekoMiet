'use strict';
/**
 * Time-slot availability for the Studio (massage appointments).
 *
 * This is deliberately a separate module from `availability.js`. PartyDekoMiet
 * books whole days (a 3-day rental window); the Studio books a specific
 * HH:MM-HH:MM slot on one day for one professional. The granularity and the
 * overlap math are different enough that forcing both through the same
 * function would make both harder to read and to trust.
 *
 * The conventions are kept the same as `availability.js` on purpose, so the
 * two modules stay easy to compare: [PENDING]/[CONFIRMED] in the event title
 * or extendedProperties.private.bookingStatus mark a booking; an all-day event
 * with a blocking keyword closes the whole day; identity lives in
 * extendedProperties.private with a text fallback for events the owner typed
 * by hand.
 */

const { isIsoDay } = require('./dates');

const PENDING = 'PENDING';
const CONFIRMED = 'CONFIRMED';

function statusOf(event) {
  const title = String(event.summary || '');
  if (/\[CONFIRMED\]/i.test(title)) return CONFIRMED;
  if (/\[PENDING\]/i.test(title)) return PENDING;
  return event.extendedProperties?.private?.bookingStatus || null;
}

function isBlockingDay(event, keywords) {
  if (!event.start?.date) return false; // must be all-day
  const text = `${event.summary || ''} ${event.description || ''}`.toLowerCase();
  return keywords.some((k) => k && text.includes(k));
}

function matchesProfessional(event, professionalId, professionalName) {
  const priv = event.extendedProperties?.private || {};
  if (priv.professionalId) return String(priv.professionalId).toLowerCase() === String(professionalId || '').toLowerCase();
  // Manual event: fall back to the name in the text. Deliberately broad - a
  // false positive only costs an alternative time offered, a false negative
  // risks double-booking the same professional.
  if (!professionalName) return false;
  const text = `${event.summary || ''} ${event.description || ''}`.toLowerCase();
  return text.includes(String(professionalName).toLowerCase());
}

function parseKeywords(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const isHHMM = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));

function toMinutes(hhmm) {
  if (!isHHMM(hhmm)) throw new Error(`Not an HH:MM time: ${hhmm}`);
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Converts a wall-clock date+time in `timeZone` to the UTC instant it
 * represents. `new Date("2026-06-05T10:00:00")` would parse in the server's
 * own timezone (UTC on Render), not the shop's - that mismatch is exactly the
 * kind of off-by-a-few-hours bug that makes "minimum notice" wrong without
 * ever showing up in a quick manual test. One correction pass is enough
 * outside the hour a DST change actually happens.
 */
function wallTimeToUtc(date, time, timeZone) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offsetMs = tzOffsetMsAt(guess, timeZone);
  return new Date(guess - offsetMs);
}

/** How far `timeZone` is ahead of UTC (ms) at the given UTC instant. */
function tzOffsetMsAt(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    parts.hour === '24' ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  return asUtc - utcMs;
}

/** An event's date + start/end minutes-of-day, in the given timezone. Null if it spans more than one day or is all-day. */
function eventSlot(event, timeZone) {
  const startRaw = event.start?.dateTime;
  const endRaw = event.end?.dateTime;
  if (!startRaw || !endRaw) return null; // all-day events are handled by isBlockingDay, not as a slot
  const startDate = new Date(startRaw);
  const endDate = new Date(endRaw);
  const fmt = (d, opts) => d.toLocaleString('en-CA', { timeZone, hour12: false, ...opts });
  const day = fmt(startDate, { year: 'numeric', month: '2-digit', day: '2-digit' }).slice(0, 10);
  const endDay = fmt(endDate, { year: 'numeric', month: '2-digit', day: '2-digit' }).slice(0, 10);
  if (day !== endDay) return null; // appointments never span midnight here
  const startMin = toMinutes(fmt(startDate, { hour: '2-digit', minute: '2-digit' }));
  const endMin = toMinutes(fmt(endDate, { hour: '2-digit', minute: '2-digit' }));
  return { date: day, startMin, endMin };
}

/**
 * Is [startMin, endMin) free on `date` for this professional?
 *
 * @param {object} opts
 * @param {object[]} opts.events        events overlapping the day
 * @param {string}   opts.professionalId
 * @param {string}   [opts.professionalName]
 * @param {string}   opts.date          YYYY-MM-DD
 * @param {string}   opts.startTime     HH:MM
 * @param {number}   opts.durationMin
 * @param {number}   [opts.bufferMin]   gap required after the previous appointment and before the next
 * @param {number}   [opts.minNoticeHours]
 * @param {Date}     [opts.now]
 * @param {string}   [opts.blockedKeywords]
 * @param {string}   [opts.timeZone]
 * @returns {{available:boolean, reason:string|null, conflicts:object[]}}
 */
function checkSlot({
  events = [],
  professionalId,
  professionalName,
  date,
  startTime,
  durationMin,
  bufferMin = 0,
  minNoticeHours = 0,
  now = new Date(),
  blockedKeywords = '',
  timeZone = 'Europe/Zurich',
}) {
  if (!isIsoDay(date)) throw new Error(`date must be YYYY-MM-DD, got "${date}"`);
  if (!isHHMM(startTime)) throw new Error(`startTime must be HH:MM, got "${startTime}"`);
  if (!Number.isFinite(durationMin) || durationMin <= 0) throw new Error(`durationMin must be a positive number, got "${durationMin}"`);

  const startMin = toMinutes(startTime);
  const endMin = startMin + durationMin;
  if (endMin > 24 * 60) {
    return { available: false, reason: 'past_midnight', conflicts: [] };
  }

  if (minNoticeHours > 0) {
    const slotStart = wallTimeToUtc(date, startTime, timeZone);
    const minutesUntil = (slotStart.getTime() - now.getTime()) / 60000;
    if (minutesUntil < minNoticeHours * 60) {
      return { available: false, reason: 'too_soon', conflicts: [] };
    }
  }

  const keywords = parseKeywords(blockedKeywords);
  const conflicts = [];

  for (const ev of events) {
    if (isBlockingDay(ev, keywords)) {
      // An all-day blocking event only applies if it covers this date.
      const first = (ev.start.date || '').slice(0, 10);
      const lastExclusive = (ev.end?.date || ev.start.date || '').slice(0, 10);
      if (date >= first && date < lastExclusive) {
        return { available: false, reason: 'blocked_day', conflicts: [{ id: ev.id, summary: ev.summary, kind: 'blocked_day' }] };
      }
      continue;
    }

    const st = statusOf(ev);
    if (st !== PENDING && st !== CONFIRMED) continue;
    if (!matchesProfessional(ev, professionalId, professionalName)) continue;

    const slot = eventSlot(ev, timeZone);
    if (!slot || slot.date !== date) continue;

    // The buffer extends an existing appointment's end, so the next one cannot
    // start right on top of it. It does not push the existing appointment's
    // start earlier, since nothing needs to "arrive early" for a slot that is
    // itself new.
    const busyStart = slot.startMin;
    const busyEnd = slot.endMin + bufferMin;
    if (startMin < busyEnd && busyStart < endMin) {
      conflicts.push({ id: ev.id, summary: ev.summary, status: st, ...slot, kind: 'appointment' });
    }
  }

  return { available: conflicts.length === 0, reason: conflicts.length ? 'already_booked' : null, conflicts };
}

/**
 * Walks forward through candidate start times on one day to find free slots.
 * `candidateTimes` lets the caller pass working hours (e.g. every 30 min from
 * 10:00 to 19:00); this module has no opinion on working hours by itself.
 * @returns {string[]} up to `count` free HH:MM start times, in order
 */
function findNextFreeOnDay({ candidateTimes = [], count = 3, ...opts }) {
  const found = [];
  for (const t of candidateTimes) {
    if (found.length >= count) break;
    const res = checkSlot({ ...opts, startTime: t });
    if (res.available) found.push(t);
  }
  return found;
}

module.exports = {
  checkSlot, findNextFreeOnDay, statusOf, matchesProfessional, isBlockingDay, parseKeywords,
  toMinutes, isHHMM, wallTimeToUtc,
  PENDING, CONFIRMED,
};
