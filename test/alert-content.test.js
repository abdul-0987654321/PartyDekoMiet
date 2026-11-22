'use strict';
/**
 * What the alert actually tells the owner to do.
 *
 * It used to end with "change it to [CONFIRMED] in the calendar" - an
 * instruction to open Google Calendar and edit an event title by hand. That
 * workflow no longer exists, and read on a phone, next to a price and a shop
 * link, it looked like he was being asked to confirm a payment himself. There
 * was also a Kalender line that only ever had a link when Google was in use,
 * so after the move it quietly vanished and made the whole alert look broken.
 *
 * So: the alert points at the page where the work is actually done.
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createNotifier } = require('../src/notify/owner');

const ORIGINAL_URL = process.env.RENDER_EXTERNAL_URL;

function client() {
  const sent = [];
  return {
    sent,
    getStatus: () => ({ status: 'connected', me: { id: '41780000000:1@s.whatsapp.net' } }),
    isConnected: () => true,
    sendText: async (jid, text) => { sent.push(text); return {}; },
  };
}

const booking = {
  id: 'B1', customerName: 'Ana', phone: '41791234567', productTitle: 'Dschungel Safari Set',
  pickupDate: '2026-11-27', returnDate: '2026-11-30', priceChf: 550,
  productUrl: 'https://partydekomiet.ch/products/x',
};
const appointment = {
  id: 'A1', customerName: 'Marco', phone: '41791234567', professionalName: 'Sofia',
  serviceName: 'Massage', date: '2026-11-27', startTime: '14:00', endTime: '15:00', priceChf: 150,
};

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  await settings.update({ alertNumbers: '41790000000', studioAlertNumbers: '41790000000' });
  process.env.RENDER_EXTERNAL_URL = 'https://example.onrender.com';
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.RENDER_EXTERNAL_URL;
  else process.env.RENDER_EXTERNAL_URL = ORIGINAL_URL;
});

describe('the booking alert', () => {
  test('links to the page where it gets confirmed', async () => {
    const c = client();
    await createNotifier({ client: c, business: 'party' }).bookingRequest(booking);
    assert.match(c.sent[0], /https:\/\/example\.onrender\.com\/bookings/);
  });

  test('does not tell him to edit a calendar entry by hand', async () => {
    const c = client();
    await createNotifier({ client: c, business: 'party' }).bookingRequest(booking);
    assert.ok(!/\[CONFIRMED\]/.test(c.sent[0]), 'that workflow is gone');
  });

  test('says plainly that nothing is confirmed yet', async () => {
    const c = client();
    await createNotifier({ client: c, business: 'party' }).bookingRequest(booking);
    assert.match(c.sent[0], /Noch nicht bestaetigt/);
  });

  test('still carries what he needs to decide', async () => {
    const c = client();
    await createNotifier({ client: c, business: 'party' }).bookingRequest(booking);
    for (const needed of ['Ana', '41791234567', 'Dschungel Safari Set', '2026-11-27', '550']) {
      assert.match(c.sent[0], new RegExp(needed));
    }
  });

  test('without a public address the line is left out, not left empty', async () => {
    delete process.env.RENDER_EXTERNAL_URL;
    const c = client();
    await createNotifier({ client: c, business: 'party' }).bookingRequest(booking);
    assert.ok(!/Dashboard:/.test(c.sent[0]));
  });
});

describe('the appointment alert', () => {
  test('links to the Studio side of the dashboard', async () => {
    const c = client();
    await createNotifier({ client: c, business: 'studio' }).appointmentRequest(appointment);
    assert.match(c.sent[0], /\/bookings\?biz=studio/);
  });

  test('points at the Confirm button rather than the calendar', async () => {
    const c = client();
    await createNotifier({ client: c, business: 'studio' }).appointmentRequest(appointment);
    assert.ok(!/\[CONFIRMED\]/.test(c.sent[0]));
    assert.match(c.sent[0], /Bestaetigen/);
  });
});
