'use strict';
/**
 * A professional answering an alert on her own WhatsApp.
 *
 * Two things are being guarded here. One is that J and N actually work. The
 * other, and the reason the parser is deliberately narrow, is that her message
 * must never be treated as a customer's: the model must not see it, the
 * customer must not receive anything because of it, and a sentence that merely
 * contains the word "nein" must not cancel somebody's appointment.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const directory = require('../src/studio/directory');
const { createAppointments } = require('../src/appointments');
const { createRouter } = require('../src/whatsapp/router');
const { parseReply, applyReply } = require('../src/studio/professional-replies');
const { m } = require('../src/notify/messages');

const HER = '41791112233';
const HER_JID = `${HER}@s.whatsapp.net`;
const CUSTOMER_JID = '41765554433@s.whatsapp.net';

function fakeClient() {
  const sent = [];
  return {
    sent,
    getStatus: () => ({ status: 'connected', me: { id: '41780000000:1@s.whatsapp.net' } }),
    isConnected: () => true,
    sendText: async (jid, text) => { sent.push({ jid, text }); return {}; },
  };
}

let sofia, service, appointments, notifier, client;

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  await settings.update({ studioAlertNumbers: '41700000000' });

  sofia = (await directory.createProfessional({ name: 'Sofia', whatsapp: HER })).professional;
  service = (await directory.createService({ name: 'Massage', durationMin: 60, priceChf: 150 })).service;

  client = fakeClient();
  notifier = {
    sent: [],
    owner: async (text) => { notifier.sent.push({ to: 'team', text }); return { ok: true }; },
    toNumber: async (number, text) => { notifier.sent.push({ to: number, text }); return { ok: true }; },
    appointmentRequest: async () => ({ ok: true }),
  };
  appointments = createAppointments({ business: 'studio', notify: notifier, calendar: null });
});

const request = (overrides = {}) => appointments.create({
  professional_id: sofia.id,
  service_id: service.id,
  date: '2027-03-04',
  start_time: '14:00',
  customer_name: 'Marco',
  chatId: CUSTOMER_JID,
  ...overrides,
});

describe('reading her answer', () => {
  for (const yes of ['J', 'ja', 'Ja!', 'ok', 'Y', 'yes', '👍']) {
    test(`"${yes}" is a yes`, () => assert.strictEqual(parseReply(yes).action, 'confirm'));
  }
  for (const no of ['N', 'nein', 'No', 'nope', '❌']) {
    test(`"${no}" is a no`, () => assert.strictEqual(parseReply(no).action, 'cancel'));
  }

  test('a sentence containing "nein" is not a cancellation', () => {
    assert.strictEqual(parseReply('nein das geht leider nicht an dem Tag').action, null);
  });

  test('a code is read out of the answer', () => {
    const r = parseReply('J A20261121-AB12C');
    assert.strictEqual(r.action, 'confirm');
    assert.strictEqual(r.code, 'A20261121-AB12C');
  });

  test('anything else is nothing', () => {
    for (const t of ['hallo', 'wann?', '', 'vielleicht']) {
      assert.strictEqual(parseReply(t).action, null, `"${t}" must not be a command`);
    }
  });
});

describe('she is told about her own appointment', () => {
  test('the request reaches her number, with the code', async () => {
    const res = await request();
    const hers = notifier.sent.find((s) => s.to === HER);
    assert.ok(hers, 'she has to hear about it');
    assert.match(hers.text, new RegExp(res.appointment_id));
  });

  test('a professional without a number is simply not written to', async () => {
    const mia = (await directory.createProfessional({ name: 'Mia' })).professional;
    await appointments.create({
      professional_id: mia.id, service_id: service.id,
      date: '2027-03-05', start_time: '10:00', customer_name: 'Luca', chatId: CUSTOMER_JID,
    });
    assert.strictEqual(notifier.sent.some((s) => s.to !== 'team'), false);
  });
});

describe('her answer changes the appointment', () => {
  test('J confirms it', async () => {
    const created = await request();
    const res = await applyReply({ professional: sofia, text: 'J', appointments, m: m() });

    assert.strictEqual(res.action, 'confirm');
    assert.strictEqual(db.get('appointments', created.appointment_id).status, 'CONFIRMED');
  });

  test('N cancels it', async () => {
    const created = await request();
    await applyReply({ professional: sofia, text: 'nein', appointments, m: m() });
    assert.strictEqual(db.get('appointments', created.appointment_id).status, 'CANCELLED');
  });

  test('with two open requests she is asked which, and nothing changes', async () => {
    const a = await request();
    const b = await request({ start_time: '16:00' });

    const res = await applyReply({ professional: sofia, text: 'J', appointments, m: m() });
    assert.strictEqual(res.changed, null, 'guessing would confirm the wrong one');
    assert.match(res.reply, new RegExp(a.appointment_id));
    assert.match(res.reply, new RegExp(b.appointment_id));
    assert.strictEqual(db.get('appointments', a.appointment_id).status, 'PENDING');
  });

  test('with two open requests a code picks the right one', async () => {
    const a = await request();
    const b = await request({ start_time: '16:00' });

    await applyReply({ professional: sofia, text: `J ${b.appointment_id}`, appointments, m: m() });
    assert.strictEqual(db.get('appointments', b.appointment_id).status, 'CONFIRMED');
    assert.strictEqual(db.get('appointments', a.appointment_id).status, 'PENDING');
  });

  test('she cannot answer for another professional', async () => {
    const mia = (await directory.createProfessional({ name: 'Mia' })).professional;
    const hers = await appointments.create({
      professional_id: mia.id, service_id: service.id,
      date: '2027-03-06', start_time: '11:00', customer_name: 'Luca', chatId: CUSTOMER_JID,
    });

    const res = await applyReply({ professional: sofia, text: `J ${hers.appointment_id}`, appointments, m: m() });
    assert.strictEqual(res.changed, null);
    assert.strictEqual(db.get('appointments', hers.appointment_id).status, 'PENDING');
  });

  test('with nothing open she is told so', async () => {
    const res = await applyReply({ professional: sofia, text: 'J', appointments, m: m() });
    assert.strictEqual(res.changed, null);
    assert.strictEqual(res.reply, m().proNothingOpen);
  });
});

describe('her message never becomes a customer conversation', () => {
  function routerFor(agentCalls) {
    const router = createRouter({
      client,
      agent: { reply: async () => { agentCalls.push(1); return { text: 'sales talk', toolCalls: [] }; } },
      services: { appointments, directory },
      notify: notifier,
      business: 'studio',
    });
    router.init();
    return router;
  }

  const fromHer = (text) => ({ key: { remoteJid: HER_JID, fromMe: false, id: 'x1' }, message: { conversation: text } });

  test('the model never sees it', async () => {
    await request();
    const calls = [];
    await routerFor(calls).handle(fromHer('J'));
    assert.deepStrictEqual(calls, [], 'she is not a customer');
  });

  test('she gets an answer, and the customer gets nothing', async () => {
    const created = await request();
    await routerFor([]).handle(fromHer('J'));

    assert.strictEqual(client.sent.length, 1);
    assert.strictEqual(client.sent[0].jid, HER_JID, 'only she is written to');
    assert.strictEqual(db.get('appointments', created.appointment_id).status, 'CONFIRMED');
  });

  test('the team is told she answered', async () => {
    await request();
    notifier.sent.length = 0;
    await routerFor([]).handle(fromHer('J'));
    assert.ok(notifier.sent.some((s) => s.to === 'team' && /Sofia/.test(s.text)));
  });

  test('something she writes that is not a command is answered with the two words', async () => {
    await request();
    const calls = [];
    await routerFor(calls).handle(fromHer('kannst du mir sagen wer das ist'));

    assert.deepStrictEqual(calls, [], 'still not handed to the model');
    assert.strictEqual(client.sent[0].text, m().proHelp);
  });

  test('a customer on the same line is unaffected', async () => {
    const calls = [];
    await routerFor(calls).handle({
      key: { remoteJid: CUSTOMER_JID, fromMe: false, id: 'c1' },
      message: { conversation: 'Hallo, habt ihr einen Termin frei?' },
    });
    assert.deepStrictEqual(calls, [1], 'customers still reach the bot');
  });

  test('an inactive professional is treated as a customer again', async () => {
    await directory.updateProfessional(sofia.id, { active: false });
    const calls = [];
    await routerFor(calls).handle(fromHer('J'));
    assert.deepStrictEqual(calls, [1]);
  });
});
