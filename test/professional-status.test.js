'use strict';
/**
 * Busy, free, and "the client is staying longer", spoken on her own phone.
 *
 * Built after a real afternoon: a client stayed an hour past the booked time,
 * nobody was told, the next client was sent anyway and arrived to a closed
 * door. The last test in this file is that afternoon, run again.
 *
 * The transcriptions here are written the way the machine actually produces
 * them - lower case drift, filler words, no punctuation - because a vocabulary
 * that only works on tidy input is a vocabulary that does not work.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const directory = require('../src/studio/directory');
const { createAppointments } = require('../src/appointments');
const { createRouter } = require('../src/whatsapp/router');
const { createLocalCalendarClient } = require('../src/calendar/local-client');
const { createStudioCalendarService } = require('../src/calendar/studio-service');
const { parseStatus, minutesIn } = require('../src/studio/professional-status');
const { isBusy, setAvailability, roster } = require('../src/studio/availability-status');
const { handleProfessionalMessage } = require('../src/studio/professional-replies');
const { m } = require('../src/notify/messages');

const TZ = 'Europe/Zurich';
const HER = '41791112233';
const HER_JID = `${HER}@s.whatsapp.net`;

const todayIn = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const clockIn = (offsetMin = 0) =>
  new Date(Date.now() + offsetMin * 60000)
    .toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

let sofia, service, appointments, notifier, client, calendar;

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  await settings.update({ studioAlertNumbers: '41700000000' });

  sofia = (await directory.createProfessional({ name: 'Sofia', whatsapp: HER })).professional;
  service = (await directory.createService({ name: 'Massage', durationMin: 60, priceChf: 150 })).service;

  calendar = createStudioCalendarService({
    timeZone: TZ, client: createLocalCalendarClient({ business: 'studio', timeZone: TZ }),
  });
  notifier = {
    sent: [],
    owner: async (text) => { notifier.sent.push({ to: 'team', text }); return { ok: true }; },
    toNumber: async (n, text) => { notifier.sent.push({ to: n, text }); return { ok: true }; },
    appointmentRequest: async () => ({ ok: true }),
  };
  appointments = createAppointments({ business: 'studio', notify: notifier, calendar });

  client = {
    sent: [],
    getStatus: () => ({ status: 'connected', me: { id: '41780000000:1@s.whatsapp.net' } }),
    isConnected: () => true,
    sendText: async (jid, text) => { client.sent.push({ jid, text }); return {}; },
  };
});

const say = (text) => handleProfessionalMessage({ professional: db.get('professionals', sofia.id), text, appointments, m: m(), timeZone: TZ });

describe('understanding what she said', () => {
  for (const said of ['besetzt', 'ich bin besetzt', 'bin grad beschäftigt', 'busy', 'kunde ist da', 'ich arbeite gerade']) {
    test(`"${said}" means busy`, () => assert.strictEqual(parseStatus(said).command, 'busy'));
  }
  for (const said of ['frei', 'ich bin wieder frei', 'fertig', 'free now', 'kunde ist weg', 'done']) {
    test(`"${said}" means free`, () => assert.strictEqual(parseStatus(said).command, 'free'));
  }
  for (const said of [
    'der kunde bleibt noch eine halbe stunde',
    'er bleibt länger',
    'client stays 30 minutes longer',
    'noch eine stunde bitte',
  ]) {
    test(`"${said}" means staying longer`, () => assert.strictEqual(parseStatus(said).command, 'longer'));
  }

  test('"ich bin noch besetzt" is busy, not an extension', () => {
    // "Noch" is one of the commonest words in spoken German. Reading it as an
    // extension would add half an hour every time she said she was still busy.
    assert.strictEqual(parseStatus('ich bin noch besetzt').command, 'busy');
    assert.strictEqual(parseStatus('ich arbeite noch').command, 'busy');
  });

  test('"noch 30 minuten" is an extension - the length makes it one', () => {
    const r = parseStatus('noch 30 minuten');
    assert.strictEqual(r.command, 'longer');
    assert.strictEqual(r.minutes, 30);
  });

  test('both words in one sentence is not a guess', () => {
    const r = parseStatus('bin ich jetzt frei oder besetzt');
    assert.strictEqual(r.command, null);
    assert.strictEqual(r.ambiguous, true);
  });

  test('a bare J is left to the appointment answer', () => {
    assert.strictEqual(parseStatus('J').command, null);
    assert.strictEqual(parseStatus('ja').command, null);
  });

  test('how long, in the ways people say it', () => {
    assert.strictEqual(minutesIn('noch eine halbe stunde'), 30);
    assert.strictEqual(minutesIn('30 minuten'), 30);
    assert.strictEqual(minutesIn('45 min'), 45);
    assert.strictEqual(minutesIn('eine stunde'), 60);
    assert.strictEqual(minutesIn('zwei stunden'), 120);
    assert.strictEqual(minutesIn('anderthalb stunden'), 90);
    assert.strictEqual(minutesIn('half an hour'), 30);
    assert.strictEqual(minutesIn('besetzt'), null);
  });
});

describe('busy and free', () => {
  test('saying busy marks her busy', async () => {
    const res = await say('ich bin besetzt');
    assert.strictEqual(res.kind, 'busy');
    assert.strictEqual(isBusy(db.get('professionals', sofia.id), { timeZone: TZ }), true);
  });

  test('saying free clears it', async () => {
    await say('besetzt');
    await say('ich bin wieder frei');
    assert.strictEqual(isBusy(db.get('professionals', sofia.id), { timeZone: TZ }), false);
  });

  test('busy has no timer: an hour later she is still busy', async () => {
    await say('besetzt');
    const her = db.get('professionals', sofia.id);
    const inAnHour = new Date(Date.now() + 60 * 60000);
    assert.strictEqual(isBusy(her, { timeZone: TZ, now: inAnHour }), true, 'a timer would lie exactly when a client overruns');
  });

  test("yesterday's forgotten busy does not block today", () => {
    setAvailability(db.get('professionals', sofia.id), 'busy');
    const her = db.get('professionals', sofia.id);
    her.busySince = new Date(Date.now() - 36 * 3600000).toISOString();
    db.put('professionals', her);

    assert.strictEqual(isBusy(db.get('professionals', sofia.id), { timeZone: TZ }), false);
  });

  test('the roster says who is working', async () => {
    await directory.createProfessional({ name: 'Mia' });
    await say('besetzt');
    const list = roster({ timeZone: TZ });
    assert.deepStrictEqual(list.map((p) => `${p.name}:${p.busy}`), ['Mia:false', 'Sofia:true']);
  });
});

describe('the bot stops offering her while she is busy', () => {
  test('her slot today is refused, and she is not described as free', async () => {
    await say('besetzt');
    const res = await calendar.checkSlotAvailability({
      professionalId: sofia.id, professionalName: 'Sofia',
      date: todayIn(), startTime: '23:00', durationMin: 60,
    });

    assert.strictEqual(res.available, false);
    assert.strictEqual(res.reason, 'professional_busy');
  });

  test('tomorrow is still bookable - busy means now, not forever', async () => {
    await say('besetzt');
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: TZ });
    const res = await calendar.checkSlotAvailability({
      professionalId: sofia.id, professionalName: 'Sofia',
      date: tomorrow, startTime: '14:00', durationMin: 60,
    });
    assert.strictEqual(res.available, true);
  });

  test('another professional is unaffected', async () => {
    const mia = (await directory.createProfessional({ name: 'Mia' })).professional;
    await say('besetzt');
    const res = await calendar.checkSlotAvailability({
      professionalId: mia.id, professionalName: 'Mia',
      date: todayIn(), startTime: '23:00', durationMin: 60,
    });
    assert.strictEqual(res.available, true);
  });

  test('once she says free, she can be booked again', async () => {
    await say('besetzt');
    await say('frei');
    const res = await calendar.checkSlotAvailability({
      professionalId: sofia.id, professionalName: 'Sofia',
      date: todayIn(), startTime: '23:00', durationMin: 60,
    });
    assert.strictEqual(res.available, true);
  });
});

describe('the client is staying longer', () => {
  async function runningAppointment() {
    const created = await appointments.create({
      professional_id: sofia.id, service_id: service.id,
      date: todayIn(), start_time: clockIn(-20), customer_name: 'Marco', chatId: '4176@s.whatsapp.net',
    });
    return db.get('appointments', created.appointment_id);
  }

  test('the appointment end moves', async () => {
    const appt = await runningAppointment();
    const before = appt.endTime;
    const res = await say('der kunde bleibt noch eine halbe stunde');

    assert.strictEqual(res.kind, 'extended');
    const after = db.get('appointments', appt.id).endTime;
    assert.notStrictEqual(after, before);
    assert.strictEqual(after > before, true, 'it must move later, not earlier');
  });

  test('the calendar entry moves with it', async () => {
    const appt = await runningAppointment();
    await say('noch eine stunde');

    const row = db.all('calendarEvents').find((e) => e.id === appt.calendarEventId);
    assert.strictEqual(row.endDateTime.slice(11, 16), db.get('appointments', appt.id).endTime);
  });

  test('she is left marked busy', async () => {
    await runningAppointment();
    await say('der kunde bleibt länger');
    assert.strictEqual(isBusy(db.get('professionals', sofia.id), { timeZone: TZ }), true);
  });

  test('without a length, half an hour is assumed', async () => {
    const appt = await runningAppointment();
    const res = await say('der kunde bleibt noch länger');
    assert.strictEqual(res.minutes, 30);
  });

  test('with no appointment running she is told so, and nothing changes', async () => {
    const res = await say('der kunde bleibt noch eine stunde');
    assert.strictEqual(res.kind, 'no_appointment');
    assert.strictEqual(res.changed, null);
  });
});

describe('the dashboard sees the same thing', () => {
  const { createServer } = require('../src/http/server');
  process.env.DASHBOARD_PASSWORD = 'test-password-123';

  async function dashboard() {
    const app = createServer({
      config: { env: 'test', tz: TZ, openai: {}, calendar: {}, storage: {}, web: { dashboardPassword: 'test-password-123' } },
      state: { startedAt: 'x', ready: true },
      settings,
      whatsapp: { getStatus: () => ({ status: 'connected' }) },
      runtime: {},
      studio: { state: { ready: true }, runtime: {}, whatsapp: { getStatus: () => ({ status: 'connected' }) }, directory },
    });
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=test-password-123', redirect: 'manual',
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    return { base, cookie, close: () => server.close() };
  }

  test('the roster shows her as busy right after she says so', async () => {
    await say('besetzt');
    const d = await dashboard();
    try {
      const res = await fetch(`${d.base}/api/studio/roster`, { headers: { cookie: d.cookie } }).then((r) => r.json());
      const her = res.roster.find((p) => p.name === 'Sofia');
      assert.strictEqual(her.busy, true);
      assert.ok(her.since, 'since when is the useful part');
    } finally { d.close(); }
  });

  test('the owner can correct it by hand when she forgot', async () => {
    await say('besetzt');
    const d = await dashboard();
    try {
      const res = await fetch(`${d.base}/api/studio/professionals/${sofia.id}/availability`, {
        method: 'PATCH', headers: { cookie: d.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ availability: 'free' }),
      }).then((r) => r.json());
      assert.strictEqual(res.ok, true);
      assert.strictEqual(isBusy(db.get('professionals', sofia.id), { timeZone: TZ }), false);
    } finally { d.close(); }
  });

  test('a nonsense status is refused', async () => {
    const d = await dashboard();
    try {
      const res = await fetch(`${d.base}/api/studio/professionals/${sofia.id}/availability`, {
        method: 'PATCH', headers: { cookie: d.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ availability: 'maybe' }),
      }).then((r) => r.json());
      assert.strictEqual(res.ok, false);
    } finally { d.close(); }
  });
});

describe('she speaks instead of typing', () => {
  /** Her hands are busy; a voice note is the only realistic input. */
  function voiceRouter(heard) {
    const router = createRouter({
      client,
      agent: { reply: async () => ({ text: 'never', toolCalls: [] }) },
      services: { appointments, directory },
      notify: notifier,
      voice: { transcribe: async () => heard },
      business: 'studio',
    });
    router.init();
    return router;
  }
  const voiceNote = { key: { remoteJid: HER_JID, fromMe: false, id: 'v1' }, message: { audioMessage: { mimetype: 'audio/ogg' } } };

  beforeEach(() => { client.downloadMedia = async () => Buffer.from('audio'); });

  test('a spoken "besetzt" marks her busy', async () => {
    await voiceRouter('ich bin jetzt besetzt').handle(voiceNote);
    assert.strictEqual(isBusy(db.get('professionals', sofia.id), { timeZone: TZ }), true);
    assert.strictEqual(client.sent.length, 1, 'and she is told it registered');
  });

  test('a spoken extension moves the appointment', async () => {
    const created = await appointments.create({
      professional_id: sofia.id, service_id: service.id,
      date: todayIn(), start_time: clockIn(-20), customer_name: 'Marco', chatId: '4176@s.whatsapp.net',
    });
    const before = db.get('appointments', created.appointment_id).endTime;

    await voiceRouter('der kunde bleibt noch eine halbe stunde länger').handle(voiceNote);
    assert.ok(db.get('appointments', created.appointment_id).endTime > before);
  });

  test('an unreadable voice note does not change anything silently', async () => {
    const router = createRouter({
      client,
      agent: { reply: async () => ({ text: 'never', toolCalls: [] }) },
      services: { appointments, directory },
      notify: notifier,
      voice: { transcribe: async () => { throw new Error('whisper down'); } },
      business: 'studio',
    });
    router.init();
    await router.handle(voiceNote);

    assert.strictEqual(isBusy(db.get('professionals', sofia.id), { timeZone: TZ }), false);
    assert.strictEqual(client.sent.length, 1, 'she is told it could not be understood');
  });
});

describe('the afternoon this was built for', () => {
  test('a client who overruns means the next one is not sent in', async () => {
    // Booked for an hour, started twenty minutes ago.
    await appointments.create({
      professional_id: sofia.id, service_id: service.id,
      date: todayIn(), start_time: clockIn(-20), customer_name: 'Marco', chatId: '4176@s.whatsapp.net',
    });

    // She speaks, between clients, holding the phone in one hand.
    const router = createRouter({
      client,
      agent: { reply: async () => ({ text: 'should never be reached', toolCalls: [] }) },
      services: { appointments, directory },
      notify: notifier,
      business: 'studio',
    });
    router.init();
    await router.handle({
      key: { remoteJid: HER_JID, fromMe: false, id: 'v1' },
      message: { conversation: 'der kunde bleibt noch eine stunde länger' },
    });

    // The team hears about it without having to ask.
    assert.ok(notifier.sent.some((s) => s.to === 'team' && /Sofia/.test(s.text)), 'the team must be told');
    // And the bot will not put anybody else into that room today.
    const res = await calendar.checkSlotAvailability({
      professionalId: sofia.id, professionalName: 'Sofia',
      date: todayIn(), startTime: clockIn(45), durationMin: 60,
    });
    assert.strictEqual(res.available, false, 'this is the double booking, and it must not happen');
  });
});
