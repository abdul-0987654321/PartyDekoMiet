'use strict';
/** Who gets alerted, and what happens when one number is unreachable. */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createNotifier } = require('../src/notify/owner');

let sent;
const client = {
  sendText: async (jid, text) => {
    if (jid.startsWith('49')) throw new Error('unreachable');
    sent.push({ jid, text });
  },
  forwardImage: async (jid, buf, caption) => sent.push({ jid, caption, image: true }),
};

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  sent = [];
});

describe('recipients', () => {
  test('falls back to the owner number when no alert list is set', async () => {
    await settings.update({ ownerWhatsapp: '41791111111', alertNumbers: '' });
    const n = createNotifier({ client });
    assert.deepStrictEqual(n.recipients(), ['41791111111']);
  });

  test('the alert list replaces the owner number', async () => {
    await settings.update({ ownerWhatsapp: '41791111111', alertNumbers: '41792222222, 923003333333' });
    const n = createNotifier({ client });
    assert.deepStrictEqual(n.recipients(), ['41792222222', '923003333333']);
  });

  test('a number listed twice is only alerted once', async () => {
    await settings.update({ alertNumbers: '41792222222, 41792222222' });
    assert.deepStrictEqual(createNotifier({ client }).recipients(), ['41792222222']);
  });
});

describe('sending', () => {
  test('sends to every configured number', async () => {
    await settings.update({ alertNumbers: '41792222222, 923003333333' });
    const res = await createNotifier({ client }).owner('Test');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.sent, 2);
    assert.deepStrictEqual(sent.map((s) => s.jid), [
      '41792222222@s.whatsapp.net', '923003333333@s.whatsapp.net',
    ]);
  });

  test('one unreachable number does not stop the others', async () => {
    await settings.update({ alertNumbers: '4900000000, 41792222222' });
    const res = await createNotifier({ client }).owner('Test');
    assert.strictEqual(res.ok, true, 'still a success if anyone got it');
    assert.strictEqual(res.sent, 1);
    assert.strictEqual(res.failed.length, 1);
    assert.strictEqual(sent.length, 1);
  });

  test('reports a failure only when nobody could be reached', async () => {
    await settings.update({ alertNumbers: '4900000000' });
    assert.strictEqual((await createNotifier({ client }).owner('Test')).ok, false);
  });

  test('says so when no number is configured at all', async () => {
    await settings.update({ ownerWhatsapp: '', alertNumbers: '' });
    const res = await createNotifier({ client }).owner('Test');
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /no alert number/);
    assert.strictEqual(sent.length, 0);
  });

  test('a booking request reaches every number', async () => {
    await settings.update({ alertNumbers: '41792222222, 923003333333' });
    await createNotifier({ client }).bookingRequest({
      id: 'B1', customerName: 'Anna', phone: '41790000000',
      productTitle: 'Einhorn Set', pickupDate: '2026-06-05', returnDate: '2026-06-07',
    });
    assert.strictEqual(sent.length, 2);
    assert.match(sent[0].text, /NEUE BUCHUNGSANFRAGE/);
    assert.match(sent[0].text, /Anna/);
  });
});

describe('the Studio notifier reads its own settings, not Party\'s', () => {
  test('recipients() uses studioAlertNumbers / studioOwnerWhatsapp, never the Party ones', async () => {
    await settings.update({
      ownerWhatsapp: '41791111111', alertNumbers: '41792222222',
      studioOwnerWhatsapp: '41793333333', studioAlertNumbers: '',
    });
    const n = createNotifier({ client, business: 'studio' });
    assert.deepStrictEqual(n.recipients(), ['41793333333']);
  });

  test('an appointment request reaches every configured Studio number', async () => {
    await settings.update({ studioAlertNumbers: '41793333333, 41794444444' });
    await createNotifier({ client, business: 'studio' }).appointmentRequest({
      id: 'A1', customerName: 'Anna', phone: '41790000000',
      professionalName: 'Gabriela', serviceName: 'Massage 60min',
      date: '2026-06-05', startTime: '14:00', endTime: '15:00',
    });
    assert.strictEqual(sent.length, 2);
    assert.match(sent[0].text, /NEUE TERMINANFRAGE/);
    assert.match(sent[0].text, /Gabriela/);
  });

  test('defaulting business leaves Party behaviour unchanged', async () => {
    await settings.update({ ownerWhatsapp: '41791111111', alertNumbers: '' });
    assert.deepStrictEqual(createNotifier({ client }).recipients(), ['41791111111']);
  });
});
