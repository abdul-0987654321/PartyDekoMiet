'use strict';
/**
 * When the AI call fails the customer must not be left in silence. Reproduces
 * the exact production case: OpenAI answering 401 "Your API key has been
 * invalidated." for every message.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createRouter } = require('../src/whatsapp/router');

const JID = '41790000999@s.whatsapp.net';
const incoming = (text) => ({
  key: { remoteJid: JID, fromMe: false, id: 'm' + Math.random() },
  message: { conversation: text },
});

function authError() {
  const err = new Error('401 Your API key has been invalidated.');
  err.status = 401;
  return err;
}

let sent, alerts;
const client = {
  sendText: async (jid, text) => sent.push({ jid, text }),
  getStatus: () => ({ status: 'connected' }),
  downloadImage: async () => Buffer.from(''),
};
const notify = { owner: async (text, meta) => alerts.push({ text, meta }) };

function routerThatFails(err = authError()) {
  const agent = { reply: async () => { throw err; } };
  const r = createRouter({ client, agent, services: {}, notify });
  r.init();
  return r;
}

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  await settings.update({ ownerWhatsapp: '41791111111', botEnabled: true });
  sent = [];
  alerts = [];
});

describe('a failing AI', () => {
  test('still answers the customer instead of going silent', async () => {
    await routerThatFails().handle(incoming('Hoi, habt ihr Einhorn Deko?'));
    assert.strictEqual(sent.length, 1, 'the customer must get a reply');
    assert.strictEqual(sent[0].jid, JID);
    assert.match(sent[0].text, /technisch/i);
  });

  test('answers an English customer in English', async () => {
    await routerThatFails().handle(incoming('Hi, do you have unicorn decoration?'));
    assert.match(sent[0].text, /technical problem/i);
  });

  test('hands the chat to a human', async () => {
    const r = routerThatFails();
    await r.handle(incoming('Hoi'));
    assert.ok(r.isPaused(JID), 'the bot must step aside after failing');
  });

  test('tells the owner what to actually do about a 401', async () => {
    await routerThatFails().handle(incoming('Hoi'));
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0].text, /OpenAI-Schluessel/);
    assert.match(alerts[0].text, /OPENAI_API_KEY/);
    assert.strictEqual(alerts[0].meta.kind, 'ai_failure');
  });

  test('names the quota case differently', async () => {
    const err = new Error('429 rate limit');
    err.status = 429;
    await routerThatFails(err).handle(incoming('Hoi'));
    assert.match(alerts[0].text, /429/);
  });

  test('does not bury the owner under one alert per message', async () => {
    const r = routerThatFails();
    for (let i = 0; i < 5; i++) {
      r.resume(JID); // a new customer would not be paused
      await r.handle(incoming('Nachricht ' + i));
    }
    assert.strictEqual(sent.length, 5, 'every customer still gets an answer');
    assert.strictEqual(alerts.length, 1, 'but the owner is told once');
  });

  test('records the failure so the dashboard can show it', async () => {
    const r = routerThatFails();
    await r.handle(incoming('Hoi'));
    const health = r.aiHealth();
    assert.match(health.lastError, /^401/);
    assert.ok(health.lastErrorAt);
    assert.strictEqual(health.count, 1);
  });

  test('the conversation is still recorded', async () => {
    await routerThatFails().handle(incoming('Hoi, habt ihr Deko?'));
    const rows = db.all('chat').filter((m) => m.jid === JID);
    assert.strictEqual(rows.length, 2, 'the question and the fallback');
    assert.strictEqual(rows.find((r) => r.direction === 'in').text, 'Hoi, habt ihr Deko?');
  });
});
