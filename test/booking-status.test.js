'use strict';
/** Booking data validation and the status change from the dashboard. */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createBookings, validateBookingArgs } = require('../src/bookings');

describe('rejecting unusable booking data', () => {
  test('the placeholder name the model invented is rejected', () => {
    for (const name of ['Customer', 'kunde', 'N/A', '-', 'unknown', '']) {
      assert.ok(validateBookingArgs({ customer_name: name }), `"${name}" should be rejected`);
    }
  });

  test('a real name passes', () => {
    assert.strictEqual(validateBookingArgs({ customer_name: 'Anna Keller' }), null);
  });

  test('an age that is really a date is rejected', () => {
    // "the party is on October 20th" was once filed as age 20; 20 is a possible
    // age, so the rule can only catch the impossible ones.
    assert.ok(validateBookingArgs({ customer_name: 'Anna', child_age: 0 }));
    assert.ok(validateBookingArgs({ customer_name: 'Anna', child_age: 150 }));
    assert.ok(validateBookingArgs({ customer_name: 'Anna', child_age: 'twenty' }));
  });

  test('no age at all is fine', () => {
    assert.strictEqual(validateBookingArgs({ customer_name: 'Anna' }), null);
    assert.strictEqual(validateBookingArgs({ customer_name: 'Anna', child_age: '' }), null);
  });
});

describe('changing a booking status', () => {
  let bookings, calendarCalls;

  const calendar = {
    patchEvent: async (id, patch) => calendarCalls.push({ op: 'patch', id, patch }),
    deleteEvent: async (id) => calendarCalls.push({ op: 'delete', id }),
  };

  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
    calendarCalls = [];
    bookings = createBookings({ catalog: null, calendar, notify: null });
    db.put('bookings', {
      id: 'B1', status: 'PENDING', jid: 'x@s.whatsapp.net', phone: '41790000000',
      customerName: 'Anna Keller', productTitle: 'Einhorn Set',
      pickupDate: '2026-06-05', returnDate: '2026-06-07', calendarEventId: 'ev-1',
    });
  });

  test('confirming retitles the calendar event', async () => {
    const res = await bookings.setStatus('B1', 'CONFIRMED');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.previous, 'PENDING');
    assert.strictEqual(db.get('bookings', 'B1').status, 'CONFIRMED');
    assert.strictEqual(calendarCalls[0].op, 'patch');
    assert.match(calendarCalls[0].patch.summary, /^\[CONFIRMED\]/);
  });

  test('cancelling deletes the event so the days are free again', async () => {
    await bookings.setStatus('B1', 'CANCELLED');
    assert.strictEqual(calendarCalls[0].op, 'delete');
    assert.strictEqual(db.get('bookings', 'B1').calendarEventId, '');
    assert.strictEqual(db.get('bookings', 'B1').status, 'CANCELLED');
  });

  test('an unknown status is refused', async () => {
    const res = await bookings.setStatus('B1', 'MAYBE');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(db.get('bookings', 'B1').status, 'PENDING');
  });

  test('an unknown booking is refused', async () => {
    assert.strictEqual((await bookings.setStatus('nope', 'CONFIRMED')).ok, false);
  });

  test('setting the status it already has does nothing', async () => {
    const res = await bookings.setStatus('B1', 'PENDING');
    assert.strictEqual(res.unchanged, true);
    assert.strictEqual(calendarCalls.length, 0);
  });

  test('the booking still changes when the calendar call fails', async () => {
    const broken = createBookings({
      catalog: null, notify: null,
      calendar: { patchEvent: async () => { throw new Error('calendar down'); } },
    });
    const res = await broken.setStatus('B1', 'CONFIRMED');
    assert.strictEqual(res.ok, true);
    assert.match(res.calendarWarning, /calendar down/);
    assert.strictEqual(db.get('bookings', 'B1').status, 'CONFIRMED', 'the status must not be lost');
  });
});

describe('the owner price line follows the deposit setting', () => {
  let sent;
  const client = { sendText: async (jid, text) => sent.push(text), forwardImage: async () => {} };
  const { createNotifier } = require('../src/notify/owner');

  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
    await settings.update({ ownerWhatsapp: '41791111111' });
    sent = [];
  });

  const booking = {
    id: 'B1', customerName: 'Anna', phone: '417900', productTitle: 'Einhorn Set',
    pickupDate: '2026-06-05', returnDate: '2026-06-07', priceChf: 350,
  };

  test('included says so instead of adding the deposit on top', async () => {
    await settings.update({ depositMode: 'included' });
    await createNotifier({ client }).bookingRequest(booking);
    assert.match(sent[0], /CHF 350 \(inkl\. CHF 50\.- Kaution\)/);
  });

  test('separate shows it as an extra product', async () => {
    await settings.update({ depositMode: 'separate', depositProductUrl: 'https://x.ch/k' });
    await createNotifier({ client }).bookingRequest(booking);
    assert.match(sent[0], /\+ CHF 50\.- Kaution/);
  });

  test('manual says it is handed over at pickup', async () => {
    await settings.update({ depositMode: 'manual' });
    await createNotifier({ client }).bookingRequest(booking);
    assert.match(sent[0], /bei der Abholung/);
  });
});
