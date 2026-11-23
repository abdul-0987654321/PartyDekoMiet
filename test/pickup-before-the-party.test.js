'use strict';
/**
 * A party on a day the shop is closed.
 *
 * From a real conversation: the customer's daughter's birthday was on a Sunday,
 * nobody is there to hand a set over on a Sunday, and the bot offered the Monday
 * and the Tuesday - both after the party. The decoration is collected before the
 * party, so the Saturday was the answer and it was never offered.
 *
 * The rule being locked in: an alternative pickup date must be the nearest one,
 * and the day before must be preferred over the day after.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { findFreeAround } = require('../src/calendar/availability');
const { createCalendarService } = require('../src/calendar');
const { createLocalCalendarClient } = require('../src/calendar/local-client');

const TZ = 'Europe/Zurich';

/**
 * Dates are handled as calendar days throughout, never as instants: building a
 * Date from `Date.now()` and reading it back with toISOString mixes the host's
 * zone with UTC, and an earlier version of these helpers quietly produced the
 * Saturday when it meant the Sunday - so the test failed on one host and passed
 * on another, which is worse than failing everywhere.
 */
const shift = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekdayOf = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();

/** The next Sunday at least a week out, so "too soon" never interferes. */
function nextSunday() {
  let iso = shift(new Date().toLocaleDateString('en-CA', { timeZone: TZ }), 8);
  while (weekdayOf(iso) !== 0) iso = shift(iso, 1);
  return iso;
}

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
});

describe('alternatives around a closed day', () => {
  test('the Saturday before is offered first, not the Monday after', () => {
    const sunday = nextSunday();
    const dates = findFreeAround({
      events: [], productId: 'SKU-1', wanted: sunday, notBefore: new Date().toLocaleDateString('en-CA', { timeZone: TZ }),
      closedWeekdays: 'sun', stock: 1, count: 3,
    });

    assert.strictEqual(dates[0], shift(sunday, -1), 'the day before the party');
    assert.ok(!dates.includes(sunday), 'the closed day itself is not an alternative');
  });

  test('a date in the past is never offered', () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    const dates = findFreeAround({
      events: [], productId: 'SKU-1', wanted: today, notBefore: today,
      closedWeekdays: '', stock: 1, count: 5,
    });
    assert.ok(dates.every((d) => d >= today));
  });

  test('tomorrow is offered when the wanted day is taken and tomorrow is open', () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    const dates = findFreeAround({
      events: [], productId: 'SKU-1', wanted: shift(today, 3), notBefore: today,
      closedWeekdays: '', stock: 1, count: 2,
    });
    assert.deepStrictEqual(dates, [shift(today, 2), shift(today, 4)], 'nearest first, earlier before later');
  });
});

describe('what the bot is told', () => {
  test('a Sunday party gets the Saturday as the first option', async () => {
    const sunday = nextSunday();
    const cal = createCalendarService({
      timeZone: TZ, getStock: () => 1,
      client: createLocalCalendarClient({ business: 'party', timeZone: TZ }),
    });

    const res = await cal.checkAvailability({ productId: 'SKU-1', start: sunday });
    assert.strictEqual(res.available, false);
    assert.strictEqual(res.reason, 'closed_day');
    assert.strictEqual(res.next_free_pickup_dates[0], shift(sunday, -1));
    assert.match(res.note, /VOR dem Fest/, 'the note has to say which way to look');
  });
});
