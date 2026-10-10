'use strict';
/** Chat API and the service-account key reader. */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../src/http/server');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const { readServiceAccount } = require('../src/calendar/client');

process.env.DASHBOARD_PASSWORD = 'chat-test-pw';

const config = {
  env: 'test',
  openai: { model: 'gpt-4o-mini', apiKey: '' },
  calendar: {}, storage: {}, whatsapp: {}, business: {},
  web: { dashboardPassword: 'chat-test-pw' },
};
const state = { startedAt: new Date().toISOString(), ready: true };
const fakeSettings = { all: () => ({ dashboardLanguage: 'de' }), describe: () => [], get: () => 12 };

const paused = [];
const sent = [];
const fakeWhatsapp = {
  getStatus: () => ({ status: 'connected' }),
  isConnected: () => true,
  sendText: async (jid, text) => sent.push({ jid, text }),
  startPairing: async (n) =>
    String(n).replace(/\D/g, '').length >= 8 ? { ok: true, number: n } : { ok: false, message: 'bad number' },
  cancelPairing: () => ({ ok: true }),
};
const fakeRouter = {
  listPaused: () => paused,
  pause: (jid) => paused.push({ jid, until: new Date(Date.now() + 3600e3).toISOString() }),
  resume: (jid) => {
    const i = paused.findIndex((p) => p.jid === jid);
    if (i >= 0) paused.splice(i, 1);
  },
};

let server, base, cookie;
const JID = '41791111111@s.whatsapp.net';

before(async () => {
  await db.init(createMemoryBackend());
  db.put('chat', { id: '1', at: '2026-06-01T10:00:00Z', jid: JID, direction: 'in', text: 'Hoi, Einhorn Deko?' });
  db.put('chat', { id: '2', at: '2026-06-01T10:01:00Z', jid: JID, direction: 'out', text: 'Hoi! Wie alt wird das Kind?' });
  db.put('chat', { id: '3', at: '2026-06-02T09:00:00Z', jid: '41792222222@s.whatsapp.net', direction: 'in', text: 'Preis?' });
  db.put('customers', { jid: JID, phone: '41791111111', name: 'Anna Muster' });

  const app = createServer({
    config, state, settings: fakeSettings, whatsapp: fakeWhatsapp,
    runtime: { router: fakeRouter },
  });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=chat-test-pw',
    redirect: 'manual',
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
});

after(() => server?.close());

const get = (p) => fetch(`${base}${p}`, { headers: { cookie } }).then((r) => r.json());
const post = (p, body) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('chat list', () => {
  test('groups messages per conversation, newest first', async () => {
    const d = await get('/api/chats');
    assert.strictEqual(d.chats.length, 2);
    assert.strictEqual(d.chats[0].phone, '41792222222', 'the newest conversation comes first');
  });

  test('uses the stored customer name and the last message', async () => {
    const chat = (await get('/api/chats')).chats.find((c) => c.jid === JID);
    assert.strictEqual(chat.name, 'Anna Muster');
    assert.strictEqual(chat.lastText, 'Hoi! Wie alt wird das Kind?');
    assert.strictEqual(chat.lastDirection, 'out');
    assert.strictEqual(chat.messages, 2);
  });
});

describe('one thread', () => {
  test('returns the messages in order', async () => {
    const d = await get(`/api/chats/${encodeURIComponent(JID)}`);
    assert.deepStrictEqual(d.messages.map((m) => m.id), ['1', '2']);
    assert.strictEqual(d.customer.name, 'Anna Muster');
  });

  test('an unknown chat is empty rather than an error', async () => {
    const d = await get('/api/chats/' + encodeURIComponent('41799999999@s.whatsapp.net'));
    assert.strictEqual(d.ok, true);
    assert.deepStrictEqual(d.messages, []);
  });
});

describe('sending from the dashboard', () => {
  test('sends, records the message and pauses the bot in that chat', async () => {
    const res = await post(`/api/chats/${encodeURIComponent(JID)}/send`, { text: 'Hoi, hier Simone.' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(sent.at(-1).text, 'Hoi, hier Simone.');
    assert.ok(paused.some((p) => p.jid === JID), 'the bot must step aside');

    const d = await get(`/api/chats/${encodeURIComponent(JID)}`);
    assert.strictEqual(d.messages.at(-1).text, 'Hoi, hier Simone.');
    assert.strictEqual(d.messages.at(-1).direction, 'out');
  });

  test('empty text is rejected', async () => {
    assert.strictEqual((await post(`/api/chats/${encodeURIComponent(JID)}/send`, { text: '  ' })).status, 400);
  });
});

describe('pairing code endpoint', () => {
  test('accepts a plausible number', async () => {
    const res = await post('/api/whatsapp/pair', { number: '41791234567' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).ok, true);
  });

  test('rejects a too-short number', async () => {
    assert.strictEqual((await (await post('/api/whatsapp/pair', { number: '123' })).json()).ok, false);
  });
});

describe('service account key', () => {
  const key = {
    client_email: 'bot@p.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
  };
  const raw = JSON.stringify(key);

  test('accepts the raw JSON from the downloaded file', () => {
    assert.strictEqual(readServiceAccount(raw).client_email, key.client_email);
  });

  test('accepts base64, including when it was wrapped across lines', () => {
    const b64 = Buffer.from(raw).toString('base64');
    assert.strictEqual(readServiceAccount(b64).client_email, key.client_email);
    assert.strictEqual(readServiceAccount(b64.replace(/(.{24})/g, '$1\n')).client_email, key.client_email);
  });

  test('unescapes newlines in the private key', () => {
    const escaped = JSON.stringify({ ...key, private_key: '-----BEGIN-----\\nabc\\n-----END-----' });
    assert.ok(readServiceAccount(escaped).private_key.includes('\n'));
  });

  test('empty means "not configured", not an error', () => {
    assert.strictEqual(readServiceAccount(''), null);
    assert.strictEqual(readServiceAccount(undefined), null);
  });

  test('explains what is wrong instead of failing silently', () => {
    assert.throws(() => readServiceAccount('{"nope":1}'), /client_email/);
    assert.throws(() => readServiceAccount('garbage-not-base64'), /not JSON|neither/);
  });
});
