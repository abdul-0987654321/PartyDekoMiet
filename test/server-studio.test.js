'use strict';
/**
 * The dashboard serves both businesses from one process. These tests check the
 * part that is easy to get wrong silently: `?biz=studio` must route to the
 * Studio's own state/runtime/WhatsApp client and never leak Party data (or vice
 * versa), and the new Studio directory endpoints (professionals/services/
 * locations) must behave like the rest of the app's CRUD surface.
 */
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../src/http/server');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const directory = require('../src/studio/directory');

process.env.DASHBOARD_PASSWORD = 'test-password-123';

const config = {
  env: 'test',
  openai: { model: 'gpt-4o-mini', apiKey: '' },
  calendar: { serviceAccountJsonB64: '' },
  storage: { webhookUrl: '', secret: '' },
  web: { port: 0, dashboardPassword: 'test-password-123' },
};

const partyState = { startedAt: 'party-start', ready: true, storageError: null, storageWarning: null, knowledge: { source: 'files', faqEntries: 15 } };
const studioState = { startedAt: 'studio-start', ready: true, calendarError: 'studioCalendarId is not set yet.', knowledge: { source: 'files', faqEntries: 0 } };

const fakeSettings = {
  all: () => ({
    dashboardLanguage: 'de', botEnabled: true, studioBotEnabled: false, botLanguage: 'auto',
    calendarId: 'party-cal', studioCalendarId: '', ownerWhatsapp: '41790000000', studioOwnerWhatsapp: '41799999999',
  }),
  describe: () => [],
  get: () => null,
};

function fakeWhatsapp(label) {
  return { getStatus: () => ({ status: `${label}-status` }) };
}

let server, base, cookie;

before(async () => {
  await db.init(createMemoryBackend());

  const app = createServer({
    config,
    state: partyState,
    settings: fakeSettings,
    whatsapp: fakeWhatsapp('party'),
    runtime: {},
    studio: {
      state: studioState,
      runtime: {},
      whatsapp: fakeWhatsapp('studio'),
      directory,
    },
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

describe('/api/status picks the right business', () => {
  test('defaults to Party', async () => {
    const d = await get('/api/status');
    assert.strictEqual(d.biz, 'party');
    assert.strictEqual(d.startedAt, 'party-start');
    assert.strictEqual(d.whatsapp.status, 'party-status');
    assert.strictEqual(d.config.ownerNumber, '…0000');
    assert.strictEqual(d.config.botEnabled, true);
  });

  test('?biz=studio switches everything, never mixing Party fields in', async () => {
    const d = await get('/api/status?biz=studio');
    assert.strictEqual(d.biz, 'studio');
    assert.strictEqual(d.startedAt, 'studio-start');
    assert.strictEqual(d.whatsapp.status, 'studio-status');
    assert.strictEqual(d.config.ownerNumber, '…9999');
    assert.strictEqual(d.config.botEnabled, false);
    assert.strictEqual(d.catalog, null); // Studio has no Shopify catalog
    assert.strictEqual(d.calendarError, 'studioCalendarId is not set yet.');
  });
});

describe('/api/chats is filtered by business', () => {
  before(async () => {
    db.put('chat', { id: 'c1', business: 'party', at: '2026-01-01T00:00:00Z', jid: 'p@s.whatsapp.net', direction: 'in', text: 'party msg' });
    db.put('chat', { id: 'c2', business: 'studio', at: '2026-01-01T00:00:00Z', jid: 's@s.whatsapp.net', direction: 'in', text: 'studio msg' });
    await db.flush();
  });

  test('Party dashboard sees only Party chats', async () => {
    const d = await get('/api/chats');
    const jids = d.chats.map((c) => c.jid);
    assert.ok(jids.includes('p@s.whatsapp.net'));
    assert.ok(!jids.includes('s@s.whatsapp.net'));
  });

  test('Studio dashboard sees only Studio chats', async () => {
    const d = await get('/api/chats?biz=studio');
    const jids = d.chats.map((c) => c.jid);
    assert.ok(jids.includes('s@s.whatsapp.net'));
    assert.ok(!jids.includes('p@s.whatsapp.net'));
  });
});

describe('Studio directory API', () => {
  beforeEach(async () => {
    for (const row of db.all('professionals')) db.remove('professionals', row.id);
    for (const row of db.all('services')) db.remove('services', row.id);
    for (const row of db.all('locations')) db.remove('locations', row.id);
    await db.flush();
  });

  test('professionals: create, list, patch, delete', async () => {
    const created = await post('/api/studio/professionals', { name: 'Gabriela', age: 28 });
    assert.strictEqual(created.ok, true);
    const id = created.professional.id;

    const listed = await get('/api/studio/professionals');
    assert.strictEqual(listed.professionals.length, 1);

    const updated = await patch(`/api/studio/professionals/${id}`, { workingHours: 'Mo-Fr 10-18' });
    assert.strictEqual(updated.ok, true);
    assert.strictEqual(updated.professional.workingHours, 'Mo-Fr 10-18');

    const removed = await del(`/api/studio/professionals/${id}`);
    assert.strictEqual(removed.ok, true);
    assert.strictEqual((await get('/api/studio/professionals')).professionals.length, 0);
  });

  test('professionals: a bad value is rejected with 400, not written', async () => {
    const res = await fetch(`${base}/api/studio/professionals`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Nope', age: 5 }),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await get('/api/studio/professionals')).professionals.length, 0);
  });

  test('services: create and list, scoped to a professional', async () => {
    const p = await post('/api/studio/professionals', { name: 'Sofia' });
    await post('/api/studio/services', { name: 'Massage', durationMin: 60, priceChf: 150, professionalId: p.professional.id });
    const list = await get('/api/studio/services');
    assert.strictEqual(list.services.length, 1);
    assert.strictEqual(list.services[0].name, 'Massage');
  });

  test('locations: create and update', async () => {
    const created = await post('/api/studio/locations', { name: 'Haringstrasse', address: 'Haringstrasse 19' });
    assert.strictEqual(created.ok, true);
    const updated = await patch(`/api/studio/locations/${created.location.id}`, { address: 'Neue Adresse 1' });
    assert.strictEqual(updated.location.address, 'Neue Adresse 1');
  });

  test('photo upload and serve round-trips the bytes', async () => {
    const p = await post('/api/studio/professionals', { name: 'Lula' });
    const bytes = Buffer.from('not-really-a-jpeg');
    const up = await post(`/api/studio/professionals/${p.professional.id}/photo`, {
      name: 'lula.jpg', mimeType: 'image/jpeg', base64: bytes.toString('base64'),
    });
    assert.strictEqual(up.ok, true);
    assert.ok(up.photoFileId);

    const res = await fetch(`${base}/api/studio/photo/${up.photoFileId}`, { headers: { cookie } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/jpeg');
    const back = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(back.toString(), 'not-really-a-jpeg');
  });
});
