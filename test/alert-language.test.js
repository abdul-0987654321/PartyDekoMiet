'use strict';
/** Owner alerts follow the dashboard language, not a hardcoded German. */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createNotifier } = require('../src/notify/owner');
const { createRouter } = require('../src/whatsapp/router');
const { m, ownerLang } = require('../src/notify/messages');

const JID = '41790000777@s.whatsapp.net';
const incoming = (text) => ({
  key: { remoteJid: JID, fromMe: false, id: 'x' + Math.random() },
  message: { conversation: text },
});

let sent, alerts;
const client = {
  sendText: async (jid, text) => sent.push(text),
  forwardImage: async () => {},
  getStatus: () => ({ status: 'connected' }),
};
const notify = { owner: async (text, meta) => alerts.push({ text, meta }) };

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  await settings.update({ ownerWhatsapp: '41791111111', botEnabled: true });
  sent = [];
  alerts = [];
});

const booking = {
  id: 'B1', customerName: 'Anna Keller', phone: '41790000000',
  productTitle: 'Einhorn Set', pickupDate: '2026-06-05', returnDate: '2026-06-07',
  priceChf: 89, occasion: '5. Geburtstag', childAge: 5,
};

describe('booking request', () => {
  test('German dashboard gets a German alert', async () => {
    await settings.update({ dashboardLanguage: 'de' });
    await createNotifier({ client }).bookingRequest(booking);
    assert.match(sent[0], /NEUE BUCHUNGSANFRAGE/);
    assert.match(sent[0], /Kunde:/);
    assert.match(sent[0], /Abholung:/);
  });

  test('English dashboard gets an English alert', async () => {
    await settings.update({ dashboardLanguage: 'en' });
    await createNotifier({ client }).bookingRequest(booking);
    assert.match(sent[0], /NEW BOOKING REQUEST/);
    assert.match(sent[0], /Customer:/);
    assert.match(sent[0], /Pickup:/);
    assert.ok(!sent[0].includes('BUCHUNGSANFRAGE'));
  });

  test('the facts survive the translation', async () => {
    await settings.update({ dashboardLanguage: 'en' });
    await createNotifier({ client }).bookingRequest(booking);
    for (const fact of ['Anna Keller', 'Einhorn Set', '2026-06-05', '2026-06-07']) {
      assert.ok(sent[0].includes(fact), `missing: ${fact}`);
    }
  });
});

describe('waiting-customer alert', () => {
  const makeRouter = () => {
    const r = createRouter({
      client, notify, services: {},
      agent: { reply: async () => ({ text: 'ok', toolCalls: [], handoff: false }) },
    });
    r.init();
    return r;
  };

  test('German', async () => {
    await settings.update({ dashboardLanguage: 'de' });
    const r = makeRouter();
    r.pause(JID, 12, 'handoff');
    await r.handle(incoming('Hallo?'));
    assert.match(alerts[0].text, /KUNDE WARTET/);
    assert.match(alerts[0].text, /pausiert/);
  });

  test('English', async () => {
    await settings.update({ dashboardLanguage: 'en' });
    const r = makeRouter();
    r.pause(JID, 12, 'handoff');
    await r.handle(incoming('Hello?'));
    assert.match(alerts[0].text, /CUSTOMER IS WAITING/);
    assert.match(alerts[0].text, /paused/);
    assert.ok(!alerts[0].text.includes('KUNDE'));
  });
});

describe('the message pack', () => {
  test('follows the setting', async () => {
    await settings.update({ dashboardLanguage: 'en' });
    assert.strictEqual(ownerLang(), 'en');
    await settings.update({ dashboardLanguage: 'de' });
    assert.strictEqual(ownerLang(), 'de');
  });

  test('both languages define the same keys', () => {
    const { T } = require('../src/notify/messages');
    assert.deepStrictEqual(Object.keys(T.de).sort(), Object.keys(T.en).sort());
    assert.deepStrictEqual(Object.keys(T.de.skipReasons).sort(), Object.keys(T.en.skipReasons).sort());
    assert.deepStrictEqual(Object.keys(T.de.bookingFields).sort(), Object.keys(T.en.bookingFields).sort());
  });

  test('every skip reason has a text in both languages', () => {
    for (const reason of ['bot_off', 'paused', 'rate_limit', 'no_agent']) {
      assert.ok(m().skipReasons[reason], `missing ${reason}`);
    }
  });
});
