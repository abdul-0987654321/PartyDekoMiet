'use strict';
/**
 * Every alert now lands in the bot's own WhatsApp chat.
 *
 * That is deliberate - the phone the number is connected on is the phone the
 * owner is holding - but it means the bot sends messages to itself, gets them
 * straight back as its own outgoing messages, and has to recognise them for
 * what they are. Get this wrong and the consequences are not subtle: the bot
 * answering its own alerts, or an alert being mistaken for the owner taking
 * over and pausing a chat that nobody was in.
 *
 * None of this was tested before, because before the change almost nobody's
 * alerts went to their own number.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createRouter } = require('../src/whatsapp/router');
const { createNotifier } = require('../src/notify/owner');

const OWN = '41781112233';
const SELF_JID = `${OWN}@s.whatsapp.net`;
const CUSTOMER = '41790000444@s.whatsapp.net';

let sent, agentCalls;

const client = {
  sendText: async (jid, text) => { sent.push({ jid, text }); return {}; },
  forwardImage: async (jid, buf, caption) => { sent.push({ jid, text: caption }); return {}; },
  getStatus: () => ({ status: 'connected', me: { id: `${OWN}:9@s.whatsapp.net`, lid: null } }),
  isConnected: () => true,
  sendReadReceipt: async () => {},
};

const agent = {
  reply: async (...args) => {
    agentCalls.push(args);
    return { text: 'ok', toolCalls: [], handoff: false, blocked: false };
  },
};

/** The bot's own alert, arriving back as an outgoing message in its own chat. */
const alertEcho = (text) => ({
  key: { remoteJid: SELF_JID, fromMe: true, id: 'a' + Math.random() },
  message: { conversation: text },
});

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  await settings.update({ botEnabled: true, studioBotEnabled: true });
  sent = [];
  agentCalls = [];
});

describe('an alert goes to the number the line is connected on', () => {
  test('and it is that number, without the device suffix', async () => {
    await createNotifier({ client, business: 'party' }).owner('NEUE BUCHUNGSANFRAGE\n\nKunde: Anna');
    assert.deepStrictEqual(sent.map((s) => s.jid), [SELF_JID]);
  });

  test('the Studio does the same on its own number', async () => {
    await createNotifier({ client, business: 'studio' }).owner('NEUE TERMINANFRAGE');
    assert.deepStrictEqual(sent.map((s) => s.jid), [SELF_JID]);
  });
});

describe('the alert coming back as the bot\'s own message', () => {
  test('is not answered', async () => {
    const r = createRouter({ client, agent, services: {}, notify: null });
    r.init();
    await r.handle(alertEcho('\u{1F514} NEUE BUCHUNGSANFRAGE\n\nKunde: Anna\nAbholung: 2026-06-05'));
    assert.deepStrictEqual(sent, [], 'the bot must not reply to its own alert');
    assert.deepStrictEqual(agentCalls, [], 'and must not spend a model call on it');
  });

  test('does not pause anything', async () => {
    // The "owner replied by hand, step aside" rule reads outgoing messages.
    // An alert is outgoing. If it were caught by that rule the bot would
    // silently go quiet on whatever chat it thought it was in.
    const r = createRouter({ client, agent, services: {}, notify: null });
    r.init();
    await r.handle(alertEcho('\u{1F514} Ein Kunde braucht jemanden.'));
    const paused = db.all('state').filter((s) => String(s.value || '').includes('pausedUntil'));
    assert.deepStrictEqual(paused, []);
  });

  test('the customer the alert is about is still served afterwards', async () => {
    const r = createRouter({ client, agent, services: {}, notify: null });
    r.init();
    await r.handle(alertEcho('\u{1F514} NEUE BUCHUNGSANFRAGE\n\nWhatsApp: 41790000444'));
    await r.handle({
      key: { remoteJid: CUSTOMER, fromMe: false, id: 'c1' },
      message: { conversation: 'hallo' },
    });
    assert.strictEqual(agentCalls.length, 1, 'her next message gets a normal answer');
    assert.ok(sent.some((s) => s.jid === CUSTOMER));
  });

  test('a real owner command in the same chat still works', async () => {
    // He can still talk to the bot there - that is the point of putting the
    // alerts where he already is.
    const r = createRouter({ client, agent, services: {}, notify: null });
    r.init();
    await r.handle({
      key: { remoteJid: SELF_JID, fromMe: true, id: 'cmd' },
      message: { conversation: '/status' },
    });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].jid, SELF_JID);
    assert.match(sent[0].text, /Bot/);
  });
});
