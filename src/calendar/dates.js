'use strict';
/**
 * Date helpers for the rental window.
 *
 * Everything is handled as a plain YYYY-MM-DD day in the shop's timezone. Rental
 * days are whole days, so using Date objects with times would only invite
 * off-by-one bugs around midnight and daylight saving.
 */

const DAY_MS = 86400000;

const isIsoDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** YYYY-MM-DD -> UTC midnight timestamp (used only for day arithmetic). */
function dayToMs(day) {
  if (!isIsoDay(day)) throw new Error(`Not a YYYY-MM-DD date: ${day}`);
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function msToDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(day, n) {
  return msToDay(dayToMs(day) + n * DAY_MS);
}

function diffDays(a, b) {
  return Math.round((dayToMs(b) - dayToMs(a)) / DAY_MS);
}

function todayIn(timeZone = 'Europe/Zurich') {
  return new Date().toLocaleDateString('en-CA', { timeZone });
}

/**
 * The days a booking occupies.
 * returnDayOffset 2 means: pickup Friday, return Sunday - three consecutive days.
 * bufferDays extends the block after the return for checking and cleaning.
 *
 * @returns {{pickup:string, return:string, blockStart:string, blockEnd:string}}
 *          blockEnd is inclusive.
 */
function rentalWindow(pickup, { returnDayOffset = 2, bufferDays = 0 } = {}) {
  const ret = addDays(pickup, returnDayOffset);
  return {
    pickup,
    return: ret,
    blockStart: pickup,
    blockEnd: addDays(ret, bufferDays),
  };
}

/** Inclusive day ranges: do [aStart,aEnd] and [bStart,bEnd] share a day? */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return dayToMs(aStart) <= dayToMs(bEnd) && dayToMs(bStart) <= dayToMs(aEnd);
}

/**
 * Google returns all-day events as date-only with an EXCLUSIVE end, and timed
 * events as dateTime. This gives the inclusive first and last day either way.
 */
function eventDayRange(event, timeZone = 'Europe/Zurich') {
  const startRaw = event.start?.date || event.start?.dateTime;
  const endRaw = event.end?.date || event.end?.dateTime;
  if (!startRaw) return null;

  const toDay = (raw, isAllDay) =>
    isAllDay ? String(raw).slice(0, 10) : new Date(raw).toLocaleDateString('en-CA', { timeZone });

  const startAllDay = Boolean(event.start?.date);
  const endAllDay = Boolean(event.end?.date);

  const first = toDay(startRaw, startAllDay);
  let last = endRaw ? toDay(endRaw, endAllDay) : first;
  // All-day end dates are exclusive in Google's API.
  if (endAllDay && diffDays(first, last) > 0) last = addDays(last, -1);
  if (diffDays(first, last) < 0) last = first;

  return { first, last };
}

module.exports = {
  isIsoDay, addDays, diffDays, todayIn, rentalWindow, overlaps, eventDayRange, dayToMs, msToDay,
};
