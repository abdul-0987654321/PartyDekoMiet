'use strict';
/**
 * Creating a PartyDekoMiet booking request.
 *
 * There was no test for this path, and it was broken: the record read a
 * variable that had never been declared, so every booking threw before it was
 * written. The customer was told there was a technical problem and asked to
 * wait for a colleague; no request reached anybody. It had been live for days,
 * because nothing else in the system depends on a booking being created.
 *
 * So the first test here is the plainest one possible - a booking is created -
 * and it is the one that matters.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const customers = require('../src/customers');
const { createBookings } = require('../src/bookings');
const { runTool } = require('../src/agent/tools');

const JID = '41791234567@s.whatsapp.net';
const PRODUCT = { id: 'p1', handle: 'dschungel', title: 'Dschungel Safari Set', url: 'https://shop/x', price: 550 };

const catalog = { byId: async (id) => (id === PRODUCT.id ? PRODUCT : null) };

/** A weekday far enough out that nothing else interferes. */
function openDay() {
  const d = new Date(Date.now() + 10 * 86400000);
  while (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

let bookings, alerts;

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  alerts = [];
  bookings = createBookings({
    catalog,
    calendar: null,
    notify: {
      bookingRequest: async (b) => { alerts.push(b); return { ok: true }; },
      owner: async () => ({ ok: true }),
    },
  });
});

const create = (over = {}) => bookings.create({
  product_id: PRODUCT.id, start_date: openDay(), customer_name: 'Ana', chatId: JID, ...over,
});

describe('a booking request', () => {
  test('is created, and says so', async () => {
    const res = await create();
    assert.strictEqual(res.ok, true, res.error);
    assert.ok(res.booking_id);
    assert.strictEqual(res.status, 'PENDING');
  });

  test('is written to the store', async () => {
    const res = await create();
    const saved = db.get('bookings', res.booking_id);
    assert.strictEqual(saved.customerName, 'Ana');
    assert.strictEqual(saved.productTitle, PRODUCT.title);
    assert.strictEqual(saved.business, 'party');
  });

  test('reaches the team', async () => {
    await create();
    assert.strictEqual(alerts.length, 1);
  });

  test('never comes back as confirmed', async () => {
    const res = await create();
    assert.strictEqual(res.status, 'PENDING');
    assert.ok(!/best[aä]tigt|confirmed/i.test(JSON.stringify(res)));
  });

  test('carries a reference photo the customer sent earlier', async () => {
    customers.save('party', JID, { referencePhotoFileId: 'FILE-1' });
    const res = await create();
    assert.strictEqual(db.get('bookings', res.booking_id).referencePhotoFileId, 'FILE-1');
  });

  test('works for a customer with no record at all', async () => {
    const res = await bookings.create({
      product_id: PRODUCT.id, start_date: openDay(), customer_name: 'Neu', chatId: '41760000000@s.whatsapp.net',
    });
    assert.strictEqual(res.ok, true, res.error);
  });

  test('an unknown product is refused without throwing', async () => {
    const res = await create({ product_id: 'nope' });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /nicht gefunden/);
  });

  test('a placeholder name is refused, so nobody is booked as "Kunde"', async () => {
    const res = await create({ customer_name: 'Kunde' });
    assert.strictEqual(res.ok, false);
  });
});

describe('through the tool the model actually calls', () => {
  test('create_booking_request succeeds', async () => {
    const res = await runTool('create_booking_request', {
      product_id: PRODUCT.id, start_date: openDay(), customer_name: 'Ana',
    }, { bookings, chatId: JID });

    assert.strictEqual(res.ok, true, res.error);
  });

  test('a failure is reported as a result, never as a crash', async () => {
    const res = await runTool('create_booking_request', {
      product_id: 'nope', start_date: openDay(), customer_name: 'Ana',
    }, { bookings, chatId: JID });

    assert.strictEqual(res.ok, false);
    assert.ok(!/fehlgeschlagen: .* is not defined/.test(res.error), 'a crash here means every booking is lost');
  });
});

describe('announcing is not claiming', () => {
  // The guard against "your request is with the team" with no tool behind it
  // started tearing down ordinary conversations: the model announces what it
  // is about to do, the customer says ok, and the tool runs on the next turn.
  // Handing that to a human one message before the booking is made is worse
  // than the problem it was built for.
  const { claimsRequestSent, requestWasMade } = require('../src/agent/guards');

  for (const said of [
    "I'll send your request to the team now.",
    'I will pass this on to the team.',
    'Ich gebe deine Anfrage jetzt weiter.',
    'Ich werde das ans Team weiterleiten.',
  ]) {
    test(`"${said.slice(0, 40)}" is an intention, not a claim`, () => {
      assert.strictEqual(claimsRequestSent(said), false);
    });
  }

  for (const said of [
    "I've created a booking request for the Gold Ring.",
    'Your request is with the team.',
    'Ich habe die Anfrage ans Team weitergegeben.',
  ]) {
    test(`"${said.slice(0, 40)}" is a claim`, () => {
      assert.strictEqual(claimsRequestSent(said), true);
    });
  }

  test('a claim is fine once the tool has actually run', () => {
    const calls = [{ name: 'create_booking_request', result: { ok: true } }];
    assert.strictEqual(requestWasMade(calls), true);
  });

  test('a failed tool call does not count as a request', () => {
    const calls = [{ name: 'create_booking_request', result: { ok: false } }];
    assert.strictEqual(requestWasMade(calls), false);
  });
});
