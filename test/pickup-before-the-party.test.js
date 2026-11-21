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

/** The next Sunday at least a week out, so "too soon" never interferes. */
function nextSunday() {
  const d = new Date(Date.now() + 8 * 86400000);
  while (d.getDay() !== 0) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
const shift = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
});

describe('alternatives around a closed day', () => {
  test('the Saturday before is offered first, not the Monday after', () => {
    const sunday = nextSunday();
    const dates = findFreeAround({
      events: [], productId: 'SKU-1', wanted: sunday, notBefore: new Date().toISOString().slice(0, 10),
      closedWeekdays: 'sun', stock: 1, count: 3,
    });

    assert.strictEqual(dates[0], shift(sunday, -1), 'the day before the party');
    assert.ok(!dates.includes(sunday), 'the closed day itself is not an alternative');
  });

  test('a date in the past is never offered', () => {
    const today = new Date().toISOString().slice(0, 10);
    const dates = findFreeAround({
      events: [], productId: 'SKU-1', wanted: today, notBefore: today,
      closedWeekdays: '', stock: 1, count: 5,
    });
    assert.ok(dates.every((d) => d >= today));
  });

  test('tomorrow is offered when the wanted day is taken and tomorrow is open', () => {
    const today = new Date().toISOString().slice(0, 10);
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
