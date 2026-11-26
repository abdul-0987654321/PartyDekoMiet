'use strict';
/**
 * The Nummern page: add, assign, rename, switch off, switch on, remove.
 *
 * The case worth a test of its own is reassigning a number to a different
 * professional. Which woman a number belongs to is baked into the filter its
 * agent reads the directory through, and that filter is built when the line
 * boots - so a change saved in the dashboard did nothing until the next deploy,
 * and the number went on answering as the woman it used to belong to. Nothing
 * said so; the page showed the new name.
 */
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../src/http/server');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const registry = require('../src/lines');
const directory = require('../src/studio/directory');

process.env.DASHBOARD_PASSWORD = 'test-password-123';

const config = {
  env: 'test',
  openai: { model: 'gpt-4o-mini', apiKey: '' },
  calendar: { serviceAccountJsonB64: '' },
  storage: { webhookUrl: '', secret: '' },
  web: { port: 0, dashboardPassword: 'test-password-123' },
};

/** Records every boot/stop, which is what the assertions are about. */
const booted = [];
const stopped = [];
const running = new Map();

function fakeLineClient(id) {
  return {
    getStatus: () => ({ status: 'connected' }),
    stop: async () => stopped.push(id),
    logoutAndStop: async () => stopped.push(`logout:${id}`),
  };
}

async function fakeBoot(line) {
  booted.push({ id: line.id, professionalId: line.professionalId || '' });
  const entry = running.get(line.id) || {
    line,
    whatsapp: fakeLineClient(line.id),
    state: { ready: true, bootError: null, alertError: null },
    runtime: {},
  };
  entry.line = line;
  running.set(line.id, entry);
}

let server, base, cookie;

before(async () => {
  await db.init(createMemoryBackend());

  const app = createServer({
    config,
    state: { startedAt: 'x', ready: true },
    settings: { all: () => ({}), describe: () => [], get: () => null },
    whatsapp: { getStatus: () => ({ status: 'party' }) },
    runtime: {},
    studio: { state: { ready: true }, runtime: {}, whatsapp: { getStatus: () => ({ status: 'studio' }) }, directory },
    lines: { registry, running, boot: fakeBoot },
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=test-password-123',
    redirect: 'manual',
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
});

after(() => server?.close());

const get = (path) => fetch(`${base}${path}`, { headers: { cookie } }).then((r) => r.json());
const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
}).then((r) => r.json());
const patch = (path, body) => fetch(`${base}${path}`, {
  method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
}).then((r) => r.json());
const del = (path) => fetch(`${base}${path}`, { method: 'DELETE', headers: { cookie } }).then((r) => r.json());

beforeEach(() => {
  booted.length = 0;
  stopped.length = 0;
});

describe('the numbers page', () => {
  test('lists the two built-in numbers first', async () => {
    const d = await get('/api/lines');
    assert.deepStrictEqual(d.lines.slice(0, 2).map((l) => l.id), ['party', 'studio']);
    assert.ok(d.lines.every((l) => l.id === 'party' || l.id === 'studio' || l.id.startsWith('pro-')));
  });

  test('adding a number starts it at once, so the QR page has something to show', async () => {
    const d = await post('/api/lines', { name: 'Sofia M.' });
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.line.id, 'pro-sofia-m');
    assert.deepStrictEqual(booted.map((b) => b.id), ['pro-sofia-m']);
  });

  test('reassigning the professional rebuilds the running number', async () => {
    const sofia = await directory.createProfessional({ name: 'Sofia' });
    const d = await patch('/api/lines/pro-sofia-m', { professionalId: sofia.professional.id });

    assert.strictEqual(d.ok, true);
    assert.deepStrictEqual(
      booted,
      [{ id: 'pro-sofia-m', professionalId: sofia.professional.id }],
      'the filter must be rebuilt now, not at the next deploy'
    );
    assert.strictEqual(stopped.length, 0, 'and without hanging the number up');
  });

  test('renaming alone does not restart anything', async () => {
    const d = await patch('/api/lines/pro-sofia-m', { name: 'Sofia Maria' });
    assert.strictEqual(d.ok, true);
    assert.strictEqual(booted.length, 0);
    assert.strictEqual(stopped.length, 0);
  });

  test('switching off hangs the number up', async () => {
    await patch('/api/lines/pro-sofia-m', { active: false });
    assert.deepStrictEqual(stopped, ['pro-sofia-m']);
    assert.strictEqual(booted.length, 0);
  });

  test('switching on starts it again', async () => {
    await patch('/api/lines/pro-sofia-m', { active: true });
    assert.deepStrictEqual(booted.map((b) => b.id), ['pro-sofia-m']);
  });

  test('an alert number sent by an old page is accepted and ignored', async () => {
    // There is no such field any more: alerts go to the phone her number is
    // connected on. A stale tab posting one must not 500.
    const d = await patch('/api/lines/pro-sofia-m', { alertNumbers: '41791234567, 12' });
    assert.strictEqual(d.ok, true);
    assert.ok(!('alertNumbers' in d.line));
  });

  test('the limit is on the list, so the page can say how many are left', async () => {
    const d = await get('/api/lines');
    assert.strictEqual(d.max, 5);
  });

  test('removing logs the device out first, then drops the row', async () => {
    const d = await del('/api/lines/pro-sofia-m');
    assert.strictEqual(d.ok, true);
    assert.deepStrictEqual(stopped, ['logout:pro-sofia-m'], 'her phone must not keep a dead linked device');
    assert.strictEqual(registry.get('pro-sofia-m'), null);
    assert.strictEqual(running.has('pro-sofia-m'), false);
  });

  test('the built-in numbers cannot be removed', async () => {
    for (const id of ['party', 'studio']) {
      const d = await del(`/api/lines/${id}`);
      assert.strictEqual(d.ok, false);
    }
  });
});
