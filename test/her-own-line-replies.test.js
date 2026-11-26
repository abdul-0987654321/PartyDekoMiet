'use strict';
/**
 * A professional given her own number could not talk to the bot on it.
 *
 * The one number she was given so she could answer for herself was the one
 * number she could not answer from. Her line runs on her phone, so everything
 * she writes to the bot is an outgoing message in its own chat - the same
 * shape as the owner typing a command - and the handler that reads J, N,
 * "besetzt" and "der Kunde bleibt laenger" matched on the SENDER's number,
 * which on her own line is never her.
 *
 * So she got the appointment alert on her phone and had no way to answer it,
 * and could not say she was busy either. The owner put it plainly: everything
 * already goes to that number, so what is the second message for.
 *
 * Now: on her own line the alert ends with "reply J or N", she can answer in
 * that chat, and no second message is sent to the number on her profile.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const directory = require('../src/studio/directory');
const lines = require('../src/lines');
const { createAppointments } = require('../src/appointments');
const { createNotifier } = require('../src/notify/owner');
const { createRouter } = require('../src/whatsapp/router');
const { createLocalCalendarClient } = require('../src/calendar/local-client');
const { createStudioCalendarService } = require('../src/calendar/studio-service');
const { isBusy } = require('../src/studio/availability-status');

const HER_PHONE = '41791112233';
const SELF_JID = `${HER_PHONE}@s.whatsapp.net`;
const CUSTOMER = '150375495651422@lid';

let sent, client, notify, appointments, her, service, line, router;

/** Her own phone, which is also what this line is connected on. */
function makeClient() {
  sent = [];
  return {
    getStatus: () => ({ status: 'connected', me: { id: `${HER_PHONE}:4@s.whatsapp.net`, lid: null } }),
    isConnected: () => true,
    sendText: async (jid, text) => { sent.push({ jid, text }); },
    forwardImage: async () => {},
    downloadMedia: async () => Buffer.from('audio'),
    sendReadReceipt: async () => {},
  };
}

/** Something she typed into the bot's own chat on her phone. */
const fromHer = (text) => ({
  key: { remoteJid: SELF_JID, fromMe: true, id: 'h' + Math.random() },
  message: { conversation: text },
});

const spokenByHer = () => ({
  key: { remoteJid: SELF_JID, fromMe: true, id: 'v' + Math.random() },
  message: { audioMessage: { mimetype: 'audio/ogg' } },
});

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  await settings.update({ studioBotEnabled: true, botEnabled: true });

  her = (await directory.createProfessional({ name: 'tst', whatsapp: '41760000099' })).professional;
  service = (await directory.createService({ name: 'Massage 60', durationMin: 60, priceChf: 200 })).service;
  line = (await lines.create({ name: 'TST', professionalId: her.id })).line;

  client = makeClient();
  notify = createNotifier({ client, business: line.id });
  appointments = createAppointments({
    calendar: createStudioCalendarService({
      client: createLocalCalendarClient({ business: line.id, timeZone: 'Europe/Zurich' }),
      directory,
    }),
    notify,
    business: line.id,
  });

  router = createRouter({
    client,
    agent: { reply: async () => ({ text: 'never', toolCalls: [], handoff: false, blocked: false }) },
    services: { appointments, directory },
    notify,
    voice: { transcribe: async () => 'ich bin jetzt besetzt' },
    business: line.id,
  });
  router.init();
});

async function bookHer() {
  const res = await appointments.create({
    professional_id: her.id, service_id: service.id,
    date: '2026-12-02', start_time: '11:00', customer_name: 'Lia', chatId: CUSTOMER,
  });
  assert.strictEqual(res.ok, true, res.error);
  return res.appointment_id;
}

describe('a request booked on her own number', () => {
  test('arrives once, not twice', async () => {
    await bookHer();
    const hers = sent.filter((s) => s.jid.startsWith(HER_PHONE));
    assert.strictEqual(hers.length, 1, 'one appointment, one message');
  });

  test('tells her she can answer right there', async () => {
    await bookHer();
    const alert = sent.find((s) => s.jid.startsWith(HER_PHONE));
    assert.match(alert.text, /Antworte hier J/);
    assert.ok(!/Dashboard unter Termine auf "Bestaetigen"/.test(alert.text), 'not sent off to a page she never opens');
  });

  test('nothing goes to the number on her profile', async () => {
    await bookHer();
    assert.ok(!sent.some((s) => s.jid.startsWith('41760000099')), 'she already has it in her hand');
  });
});

describe('what she writes back in that chat', () => {
  test('J confirms the appointment', async () => {
    const id = await bookHer();
    sent.length = 0;

    await router.handle(fromHer('J'));

    assert.strictEqual(db.get('appointments', id).status, 'CONFIRMED');
    assert.ok(sent.some((s) => /Bestaetigt/i.test(s.text)), 'and she is told it registered');
  });

  test('N declines it', async () => {
    const id = await bookHer();
    await router.handle(fromHer('N'));
    assert.strictEqual(db.get('appointments', id).status, 'CANCELLED');
  });

  test('the customer hears about it, in the chat she wrote from', async () => {
    await bookHer();
    sent.length = 0;
    await router.handle(fromHer('J'));

    const toCustomer = sent.find((s) => s.jid === CUSTOMER);
    assert.ok(toCustomer, 'her J is what tells the customer');
    assert.match(toCustomer.text, /best(ae|ä)tigt/i);
  });

  test('"besetzt" marks her busy', async () => {
    await router.handle(fromHer('besetzt'));
    assert.strictEqual(isBusy(db.get('professionals', her.id), { timeZone: 'Europe/Zurich' }), true);
  });

  test('"frei" marks her free again', async () => {
    await router.handle(fromHer('besetzt'));
    await router.handle(fromHer('frei'));
    assert.strictEqual(isBusy(db.get('professionals', her.id), { timeZone: 'Europe/Zurich' }), false);
  });

  test('she can say it out loud, because her hands are busy', async () => {
    await router.handle(spokenByHer());
    assert.strictEqual(isBusy(db.get('professionals', her.id), { timeZone: 'Europe/Zurich' }), true);
  });
});

describe('what is not hers to answer still works as before', () => {
  test('an owner command in the same chat is still an owner command', async () => {
    await router.handle(fromHer('/status'));
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].text, /Bot/);
  });

  test('ordinary typing is neither, and nothing happens', async () => {
    await router.handle(fromHer('muss noch einkaufen gehen'));
    assert.deepStrictEqual(sent, [], 'not an answer, not a command, not a reply to anybody');
  });

  test("the bot's own alert coming back is not read as her answer", async () => {
    // Every alert lands in this same chat as an outgoing message.
    await router.handle(fromHer('\u{1F514} NEUE TERMINANFRAGE\n\nKunde: Lia'));
    assert.deepStrictEqual(sent, []);
  });

  test('a number with nobody linked to it keeps the plain owner behaviour', async () => {
    await lines.update(line.id, { professionalId: '' });
    await router.handle(fromHer('besetzt'));
    assert.deepStrictEqual(sent, [], 'nobody to mark busy, so it is just the owner typing');
  });
});
