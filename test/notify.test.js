'use strict';
/** Who gets alerted, and what happens when that number is unreachable. */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createNotifier } = require('../src/notify/owner');

let sent;

/** A client connected on `number`, which is where its alerts go. */
function clientOn(number) {
  return {
    getStatus: () => ({ status: 'connected', me: { id: number ? `${number}:3@s.whatsapp.net` : null } }),
    isConnected: () => Boolean(number),
    sendText: async (jid, text) => {
      // 49... stands in for a number WhatsApp will not deliver to.
      if (jid.startsWith('49')) throw new Error('unreachable');
      sent.push({ jid, text });
    },
    forwardImage: async (jid, buf, caption) => sent.push({ jid, caption, image: true }),
  };
}

const client = clientOn('41792222222');

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  sent = [];
});

describe('recipients', () => {
  test('the number this line is connected on', () => {
    assert.deepStrictEqual(createNotifier({ client }).recipients(), ['41792222222']);
  });

  test('a saved owner number does not change it', async () => {
    await settings.update({ ownerWhatsapp: '41791111111' });
    assert.deepStrictEqual(createNotifier({ client }).recipients(), ['41792222222']);
  });

  test('nothing at all while the line is not connected', () => {
    assert.deepStrictEqual(createNotifier({ client: clientOn('') }).recipients(), []);
  });
});

describe('sending', () => {
  test('sends to the connected number', async () => {
    const res = await createNotifier({ client }).owner('Test');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.sent, 1);
    assert.deepStrictEqual(sent.map((s) => s.jid), ['41792222222@s.whatsapp.net']);
  });

  test('reports a failure when the number cannot be reached', async () => {
    const res = await createNotifier({ client: clientOn('4900000000') }).owner('Test');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(sent.length, 0);
  });

  test('says so when the line is not connected', async () => {
    const res = await createNotifier({ client: clientOn('') }).owner('Test');
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /not connected/);
    assert.strictEqual(sent.length, 0);
  });

  test('a booking request carries the customer and the set', async () => {
    await createNotifier({ client }).bookingRequest({
      id: 'B1', customerName: 'Anna', phone: '41790000000',
      productTitle: 'Einhorn Set', pickupDate: '2026-06-05', returnDate: '2026-06-07',
    });
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].text, /NEUE BUCHUNGSANFRAGE/);
    assert.match(sent[0].text, /Anna/);
  });
});

describe('the Studio notifier', () => {
  test('an appointment request carries the professional and the service', async () => {
    await createNotifier({ client, business: 'studio' }).appointmentRequest({
      id: 'A1', customerName: 'Anna', phone: '41790000000',
      professionalName: 'Gabriela', serviceName: 'Massage 60min',
      date: '2026-06-05', startTime: '14:00', endTime: '15:00',
    });
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].text, /NEUE TERMINANFRAGE/);
    assert.match(sent[0].text, /Gabriela/);
  });

  test('the Studio and PartyDekoMiet each use their own connected number', () => {
    const party = createNotifier({ client: clientOn('41791111111'), business: 'party' });
    const studio = createNotifier({ client: clientOn('41793333333'), business: 'studio' });
    assert.deepStrictEqual(party.recipients(), ['41791111111']);
    assert.deepStrictEqual(studio.recipients(), ['41793333333']);
  });
});
