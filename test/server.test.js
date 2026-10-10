'use strict';
/** HTTP surface tests: health must never need a login, everything else must. */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../src/http/server');

process.env.DASHBOARD_PASSWORD = 'test-password-123';

const config = {
  env: 'test',
  openai: { model: 'gpt-4o-mini', apiKey: '' },
  calendar: { id: '', serviceAccountJsonB64: '' },
  storage: { webhookUrl: '', secret: '' },
  whatsapp: { ownerNumber: '41791234567' },
  business: { rentalDays: 3, depositChf: 50 },
  web: { port: 0, dashboardPassword: 'test-password-123' },
};
const state = { startedAt: new Date().toISOString(), ready: true, storageError: null, storageWarning: null, knowledge: { source: 'files', faqEntries: 15 } };

// A minimal settings stand-in: the real one needs storage, which these tests do not use.
const fakeSettings = {
  all: () => ({ dashboardLanguage: 'de', botEnabled: true, botLanguage: 'auto', calendarId: '', ownerWhatsapp: '41791234567' }),
  describe: () => [],
  get: () => null,
};

let server;
let base;

before(async () => {
  const app = createServer({ config, state, settings: fakeSettings });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

describe('/health', () => {
  test('is open and reports the service', async () => {
    const res = await fetch(`${base}/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.service, 'partydekomiet-bot');
    assert.strictEqual(body.whatsapp, 'not-wired');
    assert.ok(typeof body.uptimeSeconds === 'number');
  });

  test('leaks no configuration', async () => {
    const text = await (await fetch(`${base}/health`)).text();
    assert.ok(!text.includes('test-password-123'));
    assert.ok(!text.toLowerCase().includes('secret'));
    assert.ok(!text.includes('41791234567'));
  });
});

describe('authentication', () => {
  test('the status page redirects to the login', async () => {
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.get('location'), /\/login$/);
  });

  test('the API answers 401 instead of redirecting', async () => {
    const res = await fetch(`${base}/api/status`, { redirect: 'manual' });
    assert.strictEqual(res.status, 401);
  });

  test('a wrong password is rejected', async () => {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=wrong',
      redirect: 'manual',
    });
    assert.match(res.headers.get('location'), /fehler=1/);
    assert.ok(!res.headers.get('set-cookie'), 'no cookie on a failed login');
  });

  test('the right password sets an HttpOnly cookie and opens the API', async () => {
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=test-password-123',
      redirect: 'manual',
    });
    const cookie = login.headers.get('set-cookie');
    assert.ok(cookie, 'login should set a cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);

    const res = await fetch(`${base}/api/status`, { headers: { cookie: cookie.split(';')[0] } });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ready, true);
    assert.strictEqual(body.knowledge.faqEntries, 15);
    // The owner's number must only ever appear masked.
    assert.strictEqual(body.config.ownerNumber, '…4567');
    assert.ok(!JSON.stringify(body).includes('41791234567'));
  });

  test('a forged cookie is rejected', async () => {
    const res = await fetch(`${base}/api/status`, {
      headers: { cookie: `dash_session=${Math.floor(Date.now() / 1000) + 9999}.forged` },
    });
    assert.strictEqual(res.status, 401);
  });
});

describe('unknown routes', () => {
  test('return a JSON 404', async () => {
    const res = await fetch(`${base}/nope`, { redirect: 'manual' });
    assert.ok([302, 404].includes(res.status));
  });
});
