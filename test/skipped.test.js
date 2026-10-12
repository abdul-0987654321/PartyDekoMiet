'use strict';
/**
 * A customer message the bot deliberately does not answer must never be silent.
 * This is what made a paused chat look like a broken bot.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createRouter } = require('../src/whatsapp/router');

const JID = '41790000888@s.whatsapp.net';
const incoming = (text) => ({
  key: { remoteJid: JID, fromMe: false, id: 'm' + Math.random() },
  message: { conversation: text },
});

let sent, alerts;
const client = {
  sendText: async (jid, text) => sent.push({ jid, text }),
  getStatus: () => ({ status: 'connected' }),
};
const notify = { owner: async (text, meta) => alerts.push({ text, meta }) };
const agent = { reply: async () => ({ text: 'ok', toolCalls: [], handoff: false, blocked: false }) };

const makeRouter = () => {
  const r = createRouter({ client, agent, services: {}, notify });
  r.init();
  return r;
};

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  await settings.update({ ownerWhatsapp: '41791111111', botEnabled: true });
  sent = [];
  alerts = [];
});

describe('a paused chat', () => {
  test('still records what the customer wrote', async () => {
    const r = makeRouter();
    r.pause(JID, 12, 'handoff');
    await r.handle(incoming('Party de deko will best for me'));

    assert.strictEqual(sent.length, 0, 'the bot must stay quiet');
    const rows = db.all('chat').filter((m) => m.jid === JID);
    assert.strictEqual(rows.length, 1, 'but the message must not be lost');
    assert.strictEqual(rows[0].text, 'Party de deko will best for me');
  });

  test('nudges the owner that someone is waiting', async () => {
    const r = makeRouter();
    r.pause(JID, 12, 'handoff');
    await r.handle(incoming('Hello?'));
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0].text, /KUNDE WARTET/);
    assert.match(alerts[0].text, /pausiert/);
    assert.strictEqual(alerts[0].meta.reason, 'paused');
  });

  test('does not nudge again for every message', async () => {
    const r = makeRouter();
    r.pause(JID, 12, 'handoff');
    for (const m of ['a', 'b', 'c']) await r.handle(incoming(m));
    assert.strictEqual(alerts.length, 1, 'one nudge, not three');
    assert.strictEqual(db.all('chat').length, 3, 'all three messages kept');
  });

  test('the reason is readable on the dashboard', async () => {
    const r = makeRouter();
    r.pause(JID, 12, 'handoff');
    await r.handle(incoming('Hello?'));
    const s = r.skipped();
    assert.strictEqual(s.last.reason, 'paused');
    assert.strictEqual(s.last.jid, JID);
    assert.match(s.last.text, /Hello/);
  });
});

describe('the bot switched off', () => {
  test('records the message and says why', async () => {
    await settings.update({ botEnabled: false });
    const r = makeRouter();
    await r.handle(incoming('Habt ihr Deko?'));
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(r.skipped().last.reason, 'bot_off');
    assert.match(alerts[0].text, /ausgeschaltet/);
  });
});

describe('the hourly limit', () => {
  test('is reported rather than dropping the customer silently', async () => {
    await settings.update({ maxMsgsPerChatPerHour: 2 });
    const r = makeRouter();
    await r.handle(incoming('one'));
    await r.handle(incoming('two'));
    await r.handle(incoming('three'));
    assert.strictEqual(sent.length, 2, 'two answered');
    assert.strictEqual(r.skipped().last.reason, 'rate_limit');
    assert.ok(alerts.some((a) => a.meta.reason === 'rate_limit'));
  });
});

describe('no agent configured', () => {
  test('is reported', async () => {
    const r = createRouter({ client, agent: null, services: {}, notify });
    r.init();
    await r.handle(incoming('Hallo'));
    assert.strictEqual(r.skipped().last.reason, 'no_agent');
    assert.match(alerts[0].text, /OPENAI_API_KEY/);
  });
});
