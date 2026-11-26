'use strict';
/**
 * Pressing Bestaetigen tells the customer.
 *
 * Until now confirming was silent on their side. The owner pressed the button,
 * the dashboard turned green, and the person who had been waiting on WhatsApp
 * since the morning heard nothing - so either somebody wrote to them by hand,
 * or they sat there not knowing whether they had a set for Saturday.
 *
 * The message that goes out is written as a person writes: no bell, no status
 * codes. A customer must never receive something that looks like our internal
 * alert.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createBookings } = require('../src/bookings');
const { createAppointments } = require('../src/appointments');

const JID = '41791234567@s.whatsapp.net';

function notifier() {
  const sent = [];
  return {
    sent,
    owner: async () => ({ ok: true }),
    bookingRequest: async () => ({ ok: true }),
    appointmentRequest: async () => ({ ok: true }),
    // Two entry points now. A customer is reached through the chat we are
    // already in (toChat), because WhatsApp addresses most people by a
    // hidden id that cannot be turned back into a phone number. A
    // professional is reached by her number.
    toChat: async (jid, text, opts = {}) => { sent.push({ number: String(jid).split('@')[0], jid, text, ...opts }); return { ok: true }; },
    toNumber: async (number, text, opts = {}) => { sent.push({ number, text, ...opts }); return { ok: true }; },
  };
}

let notify, bookings, appointments;

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  notify = notifier();
  bookings = createBookings({ catalog: { byId: async () => null }, calendar: null, notify });
  appointments = createAppointments({ business: 'studio', calendar: null, notify });

  db.put('bookings', {
    id: 'B1', business: 'party', status: 'PENDING', jid: JID, customerName: 'Ana',
    productTitle: 'Baeren-Deko', pickupDate: '2026-12-09', returnDate: '2026-12-11',
  });
  db.put('appointments', {
    id: 'A1', status: 'PENDING', jid: JID, customerName: 'Marco', serviceName: 'Massage',
    professionalName: 'Sofia', date: '2026-12-09', startTime: '14:00', endTime: '15:00',
  });
});

describe('a confirmed booking', () => {
  test('reaches the customer', async () => {
    await bookings.setStatus('B1', 'CONFIRMED');
    assert.strictEqual(notify.sent.length, 1);
    assert.strictEqual(notify.sent[0].number, '41791234567');
  });

  test('says what was confirmed and when', async () => {
    await bookings.setStatus('B1', 'CONFIRMED');
    const { text } = notify.sent[0];
    assert.match(text, /best(ae|ä)tigt/i);
    assert.match(text, /Baeren-Deko/);
    assert.match(text, /2026-12-09/);
  });

  test('does not look like an internal alert', async () => {
    await bookings.setStatus('B1', 'CONFIRMED');
    assert.strictEqual(notify.sent[0].plain, true, 'no bell for a customer');
    assert.ok(!/\[CONFIRMED\]|PENDING|Dashboard/.test(notify.sent[0].text));
  });

  test('a cancellation is told kindly, and only once', async () => {
    await bookings.setStatus('B1', 'CANCELLED');
    assert.strictEqual(notify.sent.length, 1);
    assert.match(notify.sent[0].text, /leider/i);
  });

  test('nothing is sent while it is still pending', async () => {
    await bookings.setStatus('B1', 'PENDING');
    assert.strictEqual(notify.sent.length, 0);
  });

  test('confirming twice does not write twice', async () => {
    await bookings.setStatus('B1', 'CONFIRMED');
    await bookings.setStatus('B1', 'CONFIRMED');
    assert.strictEqual(notify.sent.length, 1);
  });

  test('a booking with no chat behind it is simply skipped', async () => {
    db.put('bookings', { id: 'B2', business: 'party', status: 'PENDING', customerName: 'Walk-in', productTitle: 'Set' });
    const res = await bookings.setStatus('B2', 'CONFIRMED');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(notify.sent.length, 0);
  });
});

describe('a confirmed appointment', () => {
  test('reaches the customer with the time', async () => {
    await appointments.setStatus('A1', 'CONFIRMED');
    assert.strictEqual(notify.sent.length, 1);
    assert.match(notify.sent[0].text, /14:00/);
    assert.match(notify.sent[0].text, /Sofia/);
  });

  test('is plain, like a person wrote it', async () => {
    await appointments.setStatus('A1', 'CONFIRMED');
    assert.strictEqual(notify.sent[0].plain, true);
  });
});
