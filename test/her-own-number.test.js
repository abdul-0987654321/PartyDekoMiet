'use strict';
/**
 * A professional's own number shows her work, and the Studio's shows all of it.
 *
 * The Studio's number is the one place the whole studio can be seen at once -
 * every appointment, the whole calendar, every service - and it always was.
 * The leak ran the other way: open a professional's number and her
 * Appointments and Calendar listed everybody's, so the two pages showed the
 * same thing and her own portal was not hers.
 *
 * "Hers" means the appointments that belong to her, wherever the customer
 * wrote. Somebody who writes to the Studio's main number and books her is
 * still her afternoon, and an appointment missing from her own page is an
 * appointment she does not know about.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../src/http/server');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const directory = require('../src/studio/directory');

process.env.DASHBOARD_PASSWORD = 'test-password-123';

const config = {
  env: 'test',
  openai: { model: 'gpt-4o-mini', apiKey: '' },
  calendar: {},
  storage: {},
  web: { port: 0, dashboardPassword: 'test-password-123' },
};

const fakeSettings = {
  all: () => ({ dashboardLanguage: 'de', botEnabled: true, studioBotEnabled: true, botLanguage: 'auto' }),
  describe: () => [],
  get: () => null,
};
const wa = (label) => ({ getStatus: () => ({ status: 'connected', me: { id: `4178000${label}:1@s.whatsapp.net` } }) });

/** Every appointment in the table, whoever it belongs to. */
const allAppointments = (q = {}) =>
  db.all('appointments').filter((a) => !q.status || a.status === q.status);

let server, base, cookie, sofia, mia, tstLine;

/** A running professional line, the way index.js wires one up. */
function lineEntry(line) {
  return {
    line,
    state: { ready: true, startedAt: 'tst-start' },
    runtime: { appointments: { list: allAppointments } },
    whatsapp: wa('9'),
  };
}

const registry = {
  get: (id) => (id === tstLine?.id ? tstLine : null),
  all: () => [tstLine].filter(Boolean),
  isBuiltIn: () => false,
  MAX_LINES: 7,
};

before(async () => {
  await db.init(createMemoryBackend());

  const running = new Map();
  const app = createServer({
    config,
    state: { startedAt: 'party-start', ready: true },
    settings: fakeSettings,
    whatsapp: wa('1'),
    runtime: {},
    studio: {
      state: { startedAt: 'studio-start', ready: true },
      runtime: { appointments: { list: allAppointments } },
      whatsapp: wa('2'),
      directory,
    },
    lines: { registry, running, boot: async () => {} },
  });
  server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=test-password-123',
    redirect: 'manual',
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
  module.exports._running = running;
});

after(() => server?.close());

const get = (path) => fetch(`${base}${path}`, { headers: { cookie } }).then((r) => r.json());

const DAY = '2026-07-15';
const month = `from=2026-07-01&to=2026-07-31`;

beforeEach(async () => {
  for (const table of ['professionals', 'services', 'locations', 'appointments']) {
    for (const row of db.all(table)) db.remove(table, row.id);
  }

  const loc = (await directory.createLocation({ name: 'Zuerich Kreis 4', address: 'Langstrasse 175' })).location;
  sofia = (await directory.createProfessional({
    name: 'TST', locationId: loc.id, languages: 'de,en', workingHours: 'Mo-Fr 10-18', whatsapp: '41791112233',
  })).professional;
  mia = (await directory.createProfessional({ name: 'Mia' })).professional;

  await directory.createService({ name: 'Klassische Massage', durationMin: 60, priceChf: 150 });
  await directory.createService({ name: 'TST Spezial', priceChf: 220, professionalId: sofia.id });
  await directory.createService({ name: 'Mias Spezial', priceChf: 180, professionalId: mia.id });

  const appt = (id, pro, name) => db.put('appointments', {
    id, status: 'PENDING', jid: `4176000${id}@s.whatsapp.net`, phone: `4176000${id}`,
    customerName: name, professionalId: pro.id, professionalName: pro.name,
    serviceName: 'x', date: DAY, startTime: '14:00', endTime: '15:00', createdAt: new Date().toISOString(),
  });
  appt('A1', sofia, 'Marco');
  appt('A2', mia, 'Luca');
  await db.flush();

  // Her number exists and is running, linked to her.
  tstLine = { id: 'pro-tst', name: 'TST', professionalId: sofia.id, active: true, builtIn: false };
  module.exports._running.set('pro-tst', lineEntry(tstLine));
});

describe('appointments', () => {
  test("the Studio's number shows everybody's", async () => {
    const d = await get('/api/bookings?biz=studio');
    assert.deepStrictEqual(d.appointments.map((a) => a.id).sort(), ['A1', 'A2']);
  });

  test('her number shows only hers', async () => {
    const d = await get('/api/bookings?biz=pro-tst');
    assert.deepStrictEqual(d.appointments.map((a) => a.id), ['A1']);
  });

  test('an appointment booked on the Studio number still reaches her page', async () => {
    // This is the case that decides the rule: "hers" is who it is for, not
    // which number happened to take it.
    db.put('appointments', {
      id: 'A3', status: 'PENDING', jid: '41760009@s.whatsapp.net', phone: '41760009',
      customerName: 'Walk-in', professionalId: sofia.id, professionalName: 'TST',
      serviceName: 'x', date: DAY, startTime: '16:00', endTime: '17:00', createdAt: new Date().toISOString(),
    });
    const d = await get('/api/bookings?biz=pro-tst');
    assert.deepStrictEqual(d.appointments.map((a) => a.id).sort(), ['A1', 'A3']);
  });

  test('a row with no professional id on it still reaches her by name', async () => {
    // A row typed straight into the sheet, or written by an older version.
    // Without this it belongs to nobody: still on the Studio's page, missing
    // from the page of the only person who needs to know about it.
    db.put('appointments', {
      id: 'A-OLD', status: 'PENDING', jid: '41760008@s.whatsapp.net', phone: '41760008',
      customerName: 'Alt', professionalId: '', professionalName: 'TST',
      serviceName: 'x', date: DAY, startTime: '18:00', endTime: '19:00', createdAt: new Date().toISOString(),
    });
    const d = await get('/api/bookings?biz=pro-tst');
    assert.deepStrictEqual(d.appointments.map((a) => a.id).sort(), ['A-OLD', 'A1']);

    const cal = await get(`/api/calendar?biz=pro-tst&${month}`);
    assert.deepStrictEqual(cal.entries.map((e) => e.appointmentId).sort(), ['A-OLD', 'A1']);
  });

  test("a nameless, idless row does not land on somebody else's page", async () => {
    db.put('appointments', {
      id: 'A-ORPHAN', status: 'PENDING', jid: '41760007@s.whatsapp.net', phone: '41760007',
      customerName: 'Niemand', professionalId: '', professionalName: '',
      serviceName: 'x', date: DAY, startTime: '19:00', endTime: '20:00', createdAt: new Date().toISOString(),
    });
    const d = await get('/api/bookings?biz=pro-tst');
    assert.ok(!d.appointments.some((a) => a.id === 'A-ORPHAN'));
    const studio = await get('/api/bookings?biz=studio');
    assert.ok(studio.appointments.some((a) => a.id === 'A-ORPHAN'), 'but the Studio still sees it');
  });

  test('a number with nobody linked to it still sees the whole studio', async () => {
    // It answers for the Studio until somebody is chosen, so it shows the
    // Studio's day.
    module.exports._running.set('pro-tst', lineEntry({ ...tstLine, professionalId: '' }));
    registry.get = (id) => (id === 'pro-tst' ? { ...tstLine, professionalId: '' } : null);
    const d = await get('/api/bookings?biz=pro-tst');
    assert.deepStrictEqual(d.appointments.map((a) => a.id).sort(), ['A1', 'A2']);
    registry.get = (id) => (id === tstLine?.id ? tstLine : null);
  });
});

describe('calendar', () => {
  test("the Studio's number draws every appointment", async () => {
    const d = await get(`/api/calendar?biz=studio&${month}`);
    assert.deepStrictEqual(d.entries.map((e) => e.appointmentId).sort(), ['A1', 'A2']);
  });

  test('her calendar draws only her days', async () => {
    const d = await get(`/api/calendar?biz=pro-tst&${month}`);
    assert.deepStrictEqual(d.entries.map((e) => e.appointmentId), ['A1']);
  });

  test("nothing of PartyDekoMiet's reaches either of them", async () => {
    db.put('bookings', {
      id: 'B1', business: 'party', status: 'PENDING', customerName: 'Anna',
      productTitle: 'Ballonbogen', pickupDate: DAY, returnDate: DAY, createdAt: new Date().toISOString(),
    });
    for (const biz of ['studio', 'pro-tst']) {
      const d = await get(`/api/calendar?biz=${biz}&${month}`);
      assert.ok(!d.entries.some((e) => e.source === 'booking'), biz);
    }
  });
});

describe('services', () => {
  test("the Studio's number lists all of them", async () => {
    const d = await get('/api/studio/services?biz=studio');
    assert.deepStrictEqual(
      d.services.map((s) => s.name).sort(),
      ['Klassische Massage', 'Mias Spezial', 'TST Spezial']
    );
  });

  test('her number lists hers and the ones the whole studio offers', async () => {
    const d = await get('/api/studio/services?biz=pro-tst');
    assert.deepStrictEqual(d.services.map((s) => s.name).sort(), ['Klassische Massage', 'TST Spezial']);
    assert.strictEqual(d.forProfessional, sofia.id);
  });

  test("another professional's service is not on her page", async () => {
    const d = await get('/api/studio/services?biz=pro-tst');
    assert.ok(!d.services.some((s) => s.name === 'Mias Spezial'));
  });
});

describe('whose number is this', () => {
  test('her own page says so, with where and when she works', async () => {
    const d = await get('/api/status?biz=pro-tst');
    assert.ok(d.professional, 'her details come with the status');
    assert.strictEqual(d.professional.name, 'TST');
    assert.strictEqual(d.professional.locationName, 'Zuerich Kreis 4');
    assert.strictEqual(d.professional.locationAddress, 'Langstrasse 175');
    assert.strictEqual(d.professional.workingHours, 'Mo-Fr 10-18');
    assert.strictEqual(d.professional.whatsapp, '41791112233');
    assert.strictEqual(d.professional.availability, 'free');
  });

  test('the Studio and PartyDekoMiet belong to nobody, and say nothing', async () => {
    for (const path of ['/api/status', '/api/status?biz=studio']) {
      assert.strictEqual((await get(path)).professional, null, path);
    }
  });

  test('reassigning the number takes effect without a restart', async () => {
    // Read from the registry, not from the line captured when the number was
    // started, or the page keeps naming the person who had it yesterday.
    registry.get = (id) => (id === 'pro-tst' ? { ...tstLine, professionalId: mia.id } : null);
    const d = await get('/api/status?biz=pro-tst');
    assert.strictEqual(d.professional.name, 'Mia');
    const appts = await get('/api/bookings?biz=pro-tst');
    assert.deepStrictEqual(appts.appointments.map((a) => a.id), ['A2']);
    registry.get = (id) => (id === tstLine?.id ? tstLine : null);
  });
});
