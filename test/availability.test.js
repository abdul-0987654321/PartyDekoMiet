'use strict';
/**
 * Availability is where a bug costs the client money: a false "free" means two
 * customers are promised the same set on the same weekend.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { checkWindow, findNextFree, statusOf, matchesProduct } = require('../src/calendar/availability');
const { rentalWindow, addDays, eventDayRange, overlaps } = require('../src/calendar/dates');

/** All-day event the way Google returns it: end date is EXCLUSIVE. */
const booking = (productId, firstDay, lastDay, status = 'PENDING', extra = {}) => ({
  id: `ev-${productId}-${firstDay}`,
  summary: `[${status}] Einhorn Set – Anna`,
  start: { date: firstDay },
  end: { date: addDays(lastDay, 1) },
  extendedProperties: { private: { productId, bookingStatus: status, ...extra } },
});

const blocked = (day, title = 'Geschlossen') => ({
  id: `block-${day}`,
  summary: title,
  start: { date: day },
  end: { date: addDays(day, 1) },
});

const OPTS = { returnDayOffset: 2, bufferDays: 0, blockedKeywords: 'blocked,geschlossen,ferien,closed' };

describe('rental window', () => {
  test('pickup + 2 gives three consecutive days', () => {
    const w = rentalWindow('2026-06-05', { returnDayOffset: 2 });
    assert.strictEqual(w.pickup, '2026-06-05'); // Friday
    assert.strictEqual(w.return, '2026-06-07'); // Sunday
    assert.strictEqual(w.blockEnd, '2026-06-07');
  });

  test('a buffer day extends the block but not the return date', () => {
    const w = rentalWindow('2026-06-05', { returnDayOffset: 2, bufferDays: 1 });
    assert.strictEqual(w.return, '2026-06-07');
    assert.strictEqual(w.blockEnd, '2026-06-08');
  });

  test('pickup + 3 is supported for the other reading of the AGB', () => {
    assert.strictEqual(rentalWindow('2026-06-05', { returnDayOffset: 3 }).return, '2026-06-08');
  });

  test('handles month and year boundaries', () => {
    assert.strictEqual(rentalWindow('2026-12-30', { returnDayOffset: 2 }).return, '2027-01-01');
    assert.strictEqual(rentalWindow('2028-02-28', { returnDayOffset: 2 }).return, '2028-03-01'); // leap year
  });
});

describe('Google all-day date handling', () => {
  test('the exclusive end date is converted to an inclusive last day', () => {
    const r = eventDayRange({ start: { date: '2026-06-05' }, end: { date: '2026-06-08' } });
    assert.deepStrictEqual(r, { first: '2026-06-05', last: '2026-06-07' });
  });

  test('a single all-day event spans one day', () => {
    const r = eventDayRange({ start: { date: '2026-06-05' }, end: { date: '2026-06-06' } });
    assert.deepStrictEqual(r, { first: '2026-06-05', last: '2026-06-05' });
  });

  test('inclusive ranges overlap on a shared edge day', () => {
    assert.ok(overlaps('2026-06-05', '2026-06-07', '2026-06-07', '2026-06-09'));
    assert.ok(!overlaps('2026-06-05', '2026-06-07', '2026-06-08', '2026-06-10'));
  });
});

describe('checkWindow', () => {
  test('free when nothing is in the calendar', () => {
    const r = checkWindow({ events: [], productId: 'p1', pickup: '2026-06-05', stock: 1, ...OPTS });
    assert.strictEqual(r.available, true);
    assert.strictEqual(r.used, 0);
  });

  test('blocked by an overlapping booking of the same product', () => {
    const r = checkWindow({
      events: [booking('p1', '2026-06-06', '2026-06-08')],
      productId: 'p1', pickup: '2026-06-05', stock: 1, ...OPTS,
    });
    assert.strictEqual(r.available, false);
    assert.strictEqual(r.reason, 'already_booked');
  });

  test('a CONFIRMED booking blocks just as a PENDING one does', () => {
    const r = checkWindow({
      events: [booking('p1', '2026-06-05', '2026-06-07', 'CONFIRMED')],
      productId: 'p1', pickup: '2026-06-06', stock: 1, ...OPTS,
    });
    assert.strictEqual(r.available, false);
  });

  test('a different product does not block', () => {
    const r = checkWindow({
      events: [booking('p2', '2026-06-05', '2026-06-07')],
      productId: 'p1', pickup: '2026-06-05', stock: 1, ...OPTS,
    });
    assert.strictEqual(r.available, true);
  });

  test('a booking that ends the day before is free', () => {
    const r = checkWindow({
      events: [booking('p1', '2026-06-01', '2026-06-04')],
      productId: 'p1', pickup: '2026-06-05', stock: 1, ...OPTS,
    });
    assert.strictEqual(r.available, true);
  });

  test('with a buffer day, back-to-back is no longer free', () => {
    const r = checkWindow({
      events: [booking('p1', '2026-06-01', '2026-06-04')],
      productId: 'p1', pickup: '2026-06-05', stock: 1,
      ...OPTS, bufferDays: 1,
    });
    // the earlier booking's own buffer is not modelled here, but ours extends:
    assert.strictEqual(r.available, true);
    const r2 = checkWindow({
      events: [booking('p1', '2026-06-08', '2026-06-10')],
      productId: 'p1', pickup: '2026-06-05', stock: 1, ...OPTS, bufferDays: 1,
    });
    assert.strictEqual(r2.available, false, 'our buffer day runs into the next booking');
  });

  test('stock 2 allows one overlap but not two', () => {
    const one = [booking('p1', '2026-06-05', '2026-06-07')];
    const two = [...one, { ...booking('p1', '2026-06-06', '2026-06-08'), id: 'ev-2' }];
    assert.strictEqual(checkWindow({ events: one, productId: 'p1', pickup: '2026-06-06', stock: 2, ...OPTS }).available, true);
    assert.strictEqual(checkWindow({ events: two, productId: 'p1', pickup: '2026-06-06', stock: 2, ...OPTS }).available, false);
  });

  test('an all-day "Geschlossen" blocks every product', () => {
    const r = checkWindow({
      events: [blocked('2026-06-06')],
      productId: 'p1', pickup: '2026-06-05', stock: 1, ...OPTS,
    });
    assert.strictEqual(r.available, false);
    assert.strictEqual(r.reason, 'blocked_day');
  });

  test('a timed event with a blocking word does not block the whole day', () => {
    const r = checkWindow({
      events: [{
        id: 'x', summary: 'Closed for lunch',
        start: { dateTime: '2026-06-06T12:00:00+02:00' },
        end: { dateTime: '2026-06-06T13:00:00+02:00' },
      }],
      productId: 'p1', pickup: '2026-06-05', stock: 1, ...OPTS,
    });
    assert.strictEqual(r.available, true, 'only all-day events are closures');
  });

  test('an unrelated personal appointment is ignored', () => {
    const r = checkWindow({
      events: [{ id: 'z', summary: 'Zahnarzt', start: { date: '2026-06-06' }, end: { date: '2026-06-07' } }],
      productId: 'p1', pickup: '2026-06-05', stock: 1, ...OPTS,
    });
    assert.strictEqual(r.available, true);
  });

  test('rejects a date that is not YYYY-MM-DD', () => {
    assert.throws(() => checkWindow({ events: [], productId: 'p1', pickup: '5.6.2026', ...OPTS }));
  });
});

describe('manual events the owner typed by hand', () => {
  test('are matched by the product name in the title', () => {
    const manual = {
      id: 'm1',
      summary: '[PENDING] einhorn-set – Beatrice',
      start: { date: '2026-06-05' },
      end: { date: '2026-06-08' },
    };
    assert.ok(matchesProduct(manual, '123', 'einhorn-set'));
    const r = checkWindow({
      events: [manual], productId: '123', productHandle: 'einhorn-set',
      pickup: '2026-06-06', stock: 1, ...OPTS,
    });
    assert.strictEqual(r.available, false);
  });

  test('the stored product id wins over the title', () => {
    const renamed = booking('p1', '2026-06-05', '2026-06-07');
    renamed.summary = '[PENDING] voellig anderer Titel';
    assert.ok(matchesProduct(renamed, 'p1'));
  });
});

describe('statusOf', () => {
  test('reads the status from the title', () => {
    assert.strictEqual(statusOf({ summary: '[PENDING] x' }), 'PENDING');
    assert.strictEqual(statusOf({ summary: '[CONFIRMED] x' }), 'CONFIRMED');
    assert.strictEqual(statusOf({ summary: 'Zahnarzt' }), null);
  });

  test('a title edited to CONFIRMED wins over a stale stored status', () => {
    const ev = booking('p1', '2026-06-05', '2026-06-07', 'PENDING');
    ev.summary = '[CONFIRMED] Einhorn Set – Anna';
    assert.strictEqual(statusOf(ev), 'CONFIRMED');
  });
});

describe('findNextFree', () => {
  test('suggests the first free pickup dates after a conflict', () => {
    const events = [booking('p1', '2026-06-05', '2026-06-09')];
    const free = findNextFree({
      events, productId: 'p1', from: '2026-06-05', days: 20, count: 3, stock: 1, ...OPTS,
    });
    assert.strictEqual(free.length, 3);
    assert.strictEqual(free[0], '2026-06-10');
    for (const day of free) {
      assert.strictEqual(
        checkWindow({ events, productId: 'p1', pickup: day, stock: 1, ...OPTS }).available, true
      );
    }
  });
});
