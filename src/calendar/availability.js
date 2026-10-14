'use strict';
/**
 * Availability: is a set free for the requested rental window?
 *
 * Product identity lives in the event's extendedProperties.private, so a renamed
 * event still blocks the right set. Events the owner creates by hand have no
 * such property, so the title and description are checked as a fallback - that
 * fallback is what makes manual entries work at all.
 *
 * Both [PENDING] and [CONFIRMED] block. An all-day event whose title contains a
 * blocking keyword ("Blocked", "Geschlossen", ...) blocks every set that day.
 */

const { rentalWindow, overlaps, eventDayRange, addDays, isIsoDay, weekdayOf, parseWeekdays } = require('./dates');

const PENDING = 'PENDING';
const CONFIRMED = 'CONFIRMED';

function statusOf(event) {
  const title = String(event.summary || '');
  if (/\[CONFIRMED\]/i.test(title)) return CONFIRMED;
  if (/\[PENDING\]/i.test(title)) return PENDING;
  return event.extendedProperties?.private?.bookingStatus || null;
}

/** True for an all-day event that blocks everything (owner holiday, closure). */
function isBlockingDay(event, keywords) {
  if (!event.start?.date) return false; // must be all-day
  const text = `${event.summary || ''} ${event.description || ''}`.toLowerCase();
  return keywords.some((k) => k && text.includes(k));
}

/** Does this event concern the given product? */
function matchesProduct(event, productId, productHandle) {
  const priv = event.extendedProperties?.private || {};
  const wanted = [productId, productHandle].filter(Boolean).map((s) => String(s).toLowerCase());
  if (!wanted.length) return false;

  const known = [priv.productId, priv.productHandle].filter(Boolean).map((s) => String(s).toLowerCase());
  if (known.length) return known.some((k) => wanted.includes(k));

  // Manual event: fall back to the text. Deliberately broad - a false positive
  // only means we offer an alternative date, a false negative means a double booking.
  const text = `${event.summary || ''} ${event.description || ''}`.toLowerCase();
  return wanted.some((w) => w.length > 2 && text.includes(w));
}

function parseKeywords(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * @param {object} opts
 * @param {object[]} opts.events        events overlapping the search range
 * @param {string}   opts.productId
 * @param {string}   [opts.productHandle]
 * @param {string}   opts.pickup        YYYY-MM-DD
 * @param {number}   opts.returnDayOffset
 * @param {number}   opts.bufferDays
 * @param {number}   opts.stock         how many copies of this set exist
 * @param {string}   opts.blockedKeywords
 * @param {string|number[]} [opts.closedWeekdays]  no pickup on these days, returns move past them
 * @returns {{available:boolean, reason:string|null, window:object, used:number, stock:number, conflicts:object[]}}
 */
function checkWindow({
  events = [],
  productId,
  productHandle,
  pickup,
  returnDayOffset = 2,
  bufferDays = 0,
  stock = 1,
  blockedKeywords = '',
  closedWeekdays = [],
  timeZone = 'Europe/Zurich',
}) {
  if (!isIsoDay(pickup)) throw new Error(`pickup must be YYYY-MM-DD, got "${pickup}"`);
  const win = rentalWindow(pickup, { returnDayOffset, bufferDays, closedWeekdays });

  // Nobody is there to hand the set over on a closed day.
  if (parseWeekdays(closedWeekdays).includes(weekdayOf(pickup))) {
    return { available: false, reason: 'closed_day', window: win, used: 0, stock, conflicts: [] };
  }
  const keywords = parseKeywords(blockedKeywords);
  const conflicts = [];

  for (const ev of events) {
    const range = eventDayRange(ev, timeZone);
    if (!range) continue;
    if (!overlaps(win.blockStart, win.blockEnd, range.first, range.last)) continue;

    if (isBlockingDay(ev, keywords)) {
      return {
        available: false,
        reason: 'blocked_day',
        window: win,
        used: 0,
        stock,
        conflicts: [{ id: ev.id, summary: ev.summary, ...range, kind: 'blocked_day' }],
      };
    }

    const st = statusOf(ev);
    if (st !== PENDING && st !== CONFIRMED) continue; // not one of our bookings
    if (!matchesProduct(ev, productId, productHandle)) continue;

    conflicts.push({ id: ev.id, summary: ev.summary, status: st, ...range, kind: 'booking' });
  }

  const used = conflicts.length;
  return {
    available: used < stock,
    reason: used < stock ? null : 'already_booked',
    window: win,
    used,
    stock,
    conflicts,
  };
}

/**
 * Walks forward day by day to find pickup dates that are free.
 * @returns {string[]} up to `count` free pickup dates
 */
function findNextFree({ events, productId, productHandle, from, days = 45, count = 3, ...opts }) {
  const found = [];
  for (let i = 0; i < days && found.length < count; i++) {
    const day = addDays(from, i);
    const res = checkWindow({ events, productId, productHandle, pickup: day, ...opts });
    if (res.available) found.push(day);
  }
  return found;
}

module.exports = {
  checkWindow, findNextFree, statusOf, matchesProduct, isBlockingDay, parseKeywords,
  PENDING, CONFIRMED,
};
