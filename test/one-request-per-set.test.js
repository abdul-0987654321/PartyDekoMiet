'use strict';
/**
 * One conversation, one open request.
 *
 * From the dashboard, three open requests for one conversation: the Einhorn set
 * on the 27th, the same set on the 1st, and the 27th still sitting there open
 * after the bot itself had told the customer the 27th was taken. Each one had
 * fired its own alert. The owner had three cards to read and no way to tell
 * which one the customer actually wanted.
 *
 * Two causes, both here. Changing a date was treated as a second booking. And
 * create() never asked whether the set was free - so a date the bot had just
 * refused could still be written into the book.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createBookings } = require('../src/bookings');
const { createCalendarService } = require('../src/calendar');
const { createLocalCalendarClient } = require('../src/calendar/local-client');

const TZ = 'Europe/Zurich';
const JID = '41791234567@s.whatsapp.net';
const OTHER = '41760000000@s.whatsapp.net';

const EINHORN = { id: 'p-einhorn', handle: 'einhorn', title: 'Einhorn Set', url: 'https://shop/einhorn', price: 580 };
const BOMBRIL = { id: 'p-bombril', handle: 'bombril', title: 'Bombril Set', url: 'https://shop/bombril', price: 250 };
const catalog = { byId: async (id) => [EINHORN, BOMBRIL].find((p) => p.id === id) || null };

/**
 * A pickup day the shop is actually open on, far enough out that notice
 * periods never interfere. Built from calendar days rather than instants: a
 * Date made from Date.now() and read back through toISOString mixes the host's
 * zone with UTC and lands on the wrong weekday on some machines.
 */
const shiftDay = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
function openDay(offset = 10) {
  let iso = shiftDay(new Date().toLocaleDateString('en-CA', { timeZone: TZ }), offset);
  while (new Date(`${iso}T12:00:00Z`).getUTCDay() === 0) iso = shiftDay(iso, 1);
  return iso;
}

let bookings, alerts, calendar;

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  alerts = [];
  calendar = createCalendarService({
    timeZone: TZ, getStock: () => 1,
    client: createLocalCalendarClient({ business: 'party', timeZone: TZ }),
  });
  bookings = createBookings({
    catalog,
    calendar,
    notify: {
      bookingRequest: async (b) => { alerts.push(b.id); return { ok: true }; },
      owner: async () => ({ ok: true }),
      toNumber: async () => ({ ok: true }),
    },
  });
});

const request = (over = {}) => bookings.create({
  product_id: EINHORN.id, start_date: openDay(), customer_name: 'Abdul', chatId: JID, ...over,
});

describe('changing the date', () => {
  test('withdraws the earlier request for the same set', async () => {
    const first = await request();
    assert.strictEqual(first.ok, true, first.error);
    const second = await request({ start_date: openDay(24) });
    assert.strictEqual(second.ok, true, second.error);
    assert.strictEqual(db.get('bookings', first.booking_id).status, 'CANCELLED');
    assert.strictEqual(db.get('bookings', second.booking_id).status, 'PENDING');
  });

  test('leaves exactly one open request in the dashboard', async () => {
    await request();
    await request({ start_date: openDay(24) });
    await request({ start_date: openDay(38) });

    const open = db.all('bookings').filter((b) => b.status === 'PENDING');
    assert.strictEqual(open.length, 1);
  });

  test('does not write to the customer about the withdrawn one', async () => {
    const told = [];
    bookings = createBookings({
      catalog, calendar,
      notify: {
        bookingRequest: async () => ({ ok: true }),
        owner: async () => ({ ok: true }),
        toNumber: async (n, text) => { told.push(text); return { ok: true }; },
      },
    });
    await request();
    await request({ start_date: openDay(24) });

    assert.deepStrictEqual(told, [], 'the customer cancelled nothing - they changed their mind mid-sentence');
  });

  test('a different set is a separate request, not a replacement', async () => {
    const einhorn = await request();
    const bombril = await request({ product_id: BOMBRIL.id });

    assert.strictEqual(db.get('bookings', einhorn.booking_id).status, 'PENDING');
    assert.strictEqual(db.get('bookings', bombril.booking_id).status, 'PENDING');
  });

  test("another customer's request is never touched", async () => {
    const theirs = await request({ chatId: OTHER, customer_name: 'Beat' });
    await request();

    assert.strictEqual(db.get('bookings', theirs.booking_id).status, 'PENDING');
  });

  test('a booking already confirmed is not withdrawn', async () => {
    const first = await request();
    await bookings.setStatus(first.booking_id, 'CONFIRMED');
    await request({ start_date: openDay(24) });

    assert.strictEqual(db.get('bookings', first.booking_id).status, 'CONFIRMED');
  });
});

describe('a date that is not free', () => {
  test('is refused rather than written into the book', async () => {
    // Another customer already has it for those days.
    await bookings.create({
      product_id: EINHORN.id, start_date: openDay(), customer_name: 'Beat', chatId: OTHER,
    });

    const res = await request();
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.available, false);
  });

  test('comes back with dates that are free, so the bot can offer them', async () => {
    await bookings.create({
      product_id: EINHORN.id, start_date: openDay(), customer_name: 'Beat', chatId: OTHER,
    });
    const res = await request();
    assert.ok(Array.isArray(res.next_free_pickup_dates));
  });

  test('and no alert goes out for a request that was not made', async () => {
    await bookings.create({
      product_id: EINHORN.id, start_date: openDay(), customer_name: 'Beat', chatId: OTHER,
    });
    alerts.length = 0;
    await request();
    assert.deepStrictEqual(alerts, []);
  });
});

describe('confirming', () => {
  test('tells the team as well as the customer', async () => {
    const told = [];
    bookings = createBookings({
      catalog, calendar,
      notify: {
        bookingRequest: async () => ({ ok: true }),
        owner: async (text) => { told.push({ to: 'team', text }); return { ok: true }; },
        toNumber: async (n, text) => { told.push({ to: n, text }); return { ok: true }; },
      },
    });
    const made = await request();
    told.length = 0;
    await bookings.setStatus(made.booking_id, 'CONFIRMED');

    assert.ok(told.some((t) => t.to === 'team'), 'the owner heard nothing at all before this');
    assert.ok(told.some((t) => t.to !== 'team'));
  });

  test('the team message says whether the customer was reached', async () => {
    const told = [];
    bookings = createBookings({
      catalog, calendar,
      notify: {
        bookingRequest: async () => ({ ok: true }),
        owner: async (text) => { told.push(text); return { ok: true }; },
        toNumber: async () => ({ ok: false, error: 'not connected' }),
      },
    });
    const made = await request();
    await bookings.setStatus(made.booking_id, 'CONFIRMED');

    assert.match(told.at(-1), /NICHT informiert|NOT be told/);
  });
});
