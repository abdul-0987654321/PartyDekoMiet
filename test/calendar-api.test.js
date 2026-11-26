'use strict';
/**
 * The calendar page's API.
 *
 * The separation test here is not ceremony: the first version of this endpoint
 * was not on the dashboard's list of per-number endpoints, so the Studio's
 * calendar quietly drew PartyDekoMiet's rentals. It looked like a working
 * calendar. That is the failure mode worth a test - not a crash, but the wrong
 * business's days shown as if they were yours.
 */
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../src/http/server');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createLocalCalendarClient } = require('../src/calendar/local-client');
const { createStudioCalendarService } = require('../src/calendar/studio-service');

process.env.DASHBOARD_PASSWORD = 'test-password-123';

const TZ = 'Europe/Zurich';
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

let server, base, cookie;

before(async () => {
  await db.init(createMemoryBackend());
  settings.load();

  const app = createServer({
    config: { env: 'test', tz: TZ, openai: {}, calendar: {}, storage: {}, web: { dashboardPassword: 'test-password-123' } },
    state: { startedAt: 'x', ready: true },
    settings,
    whatsapp: { getStatus: () => ({ status: 'connected' }) },
    runtime: {},
    studio: { state: { ready: true }, runtime: {}, whatsapp: { getStatus: () => ({ status: 'connected' }) } },
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

const get = (p) => fetch(`${base}${p}`, { headers: { cookie } }).then((r) => r.json());
const post = (p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());
const del = (p) => fetch(`${base}${p}`, { method: 'DELETE', headers: { cookie } }).then((r) => r.json());

const month = () => `from=${day(-30)}&to=${day(60)}`;

beforeEach(async () => {
  for (const row of db.all('calendarEvents')) db.remove('calendarEvents', row.id);
  for (const row of db.all('bookings')) db.remove('bookings', row.id);
  for (const row of db.all('appointments')) db.remove('appointments', row.id);
  await db.flush();
});

describe('the calendar endpoint', () => {
  // The calendar is drawn from the bookings and appointments themselves, not
  // from the calendar entries written beside them. A booking that exists on the
  // Buchungen page but whose calendar entry was never written used to be
  // invisible here - an empty December while a request for the 9th sat in the
  // list, with nothing to say which page was wrong.
  test('a booking appears without needing a calendar entry', async () => {
    db.put('bookings', {
      id: 'B1', business: 'party', status: 'PENDING', customerName: 'Ana',
      productTitle: 'Baeren-Deko', pickupDate: day(2), returnDate: day(4),
    });
    const { entries } = await get(`/api/calendar?${month()}`);
    assert.strictEqual(entries.length, 1);
    assert.match(entries[0].title, /Baeren-Deko/);
    assert.strictEqual(entries[0].status, 'PENDING');
  });

  test('a rental covers every day from pickup to return', async () => {
    db.put('bookings', {
      id: 'B1', business: 'party', status: 'CONFIRMED', customerName: 'Ana',
      productTitle: 'Set', pickupDate: day(2), returnDate: day(4),
    });
    const { entries } = await get(`/api/calendar?${month()}`);
    // The end is exclusive, the way an all-day entry is written, so the return
    // day itself is still covered.
    assert.strictEqual(entries[0].startDate, day(2));
    assert.strictEqual(entries[0].endDate, day(5));
  });

  test('each business sees only its own days', async () => {
    db.put('bookings', {
      id: 'B1', business: 'party', status: 'PENDING', customerName: 'Ana',
      productTitle: 'Ballonbogen', pickupDate: day(2), returnDate: day(3),
    });
    db.put('appointments', {
      id: 'A1', status: 'CONFIRMED', customerName: 'Marco', serviceName: 'Massage',
      date: day(2), startTime: '14:00', endTime: '15:00',
    });

    const party = await get(`/api/calendar?${month()}`);
    const studio = await get(`/api/calendar?${month()}&biz=studio`);

    assert.deepStrictEqual(party.entries.map((e) => e.title), ['Ballonbogen - Ana']);
    assert.deepStrictEqual(studio.entries.map((e) => e.title), ['Massage - Marco']);
  });

  test('an appointment keeps the time it was booked for', async () => {
    db.put('appointments', {
      id: 'A1', status: 'PENDING', customerName: 'Marco', serviceName: 'Massage',
      date: day(2), startTime: '14:00', endTime: '15:00',
    });
    const { entries } = await get(`/api/calendar?${month()}&biz=studio`);
    assert.strictEqual(entries[0].startTime, '14:00');
    assert.strictEqual(entries[0].endTime, '15:00');
  });

  test('a cancelled booking leaves the calendar', async () => {
    db.put('bookings', {
      id: 'B1', business: 'party', status: 'CANCELLED', customerName: 'Ana',
      productTitle: 'Set', pickupDate: day(2), returnDate: day(3),
    });
    const { entries } = await get(`/api/calendar?${month()}`);
    assert.strictEqual(entries.length, 0);
  });

  test('the bot\'s own calendar entries are not drawn twice', async () => {
    db.put('bookings', {
      id: 'B1', business: 'party', status: 'PENDING', customerName: 'Ana',
      productTitle: 'Set', pickupDate: day(2), returnDate: day(3),
    });
    await createLocalCalendarClient({ business: 'party', timeZone: TZ }).createEvent({
      summary: '[PENDING] Set - Ana', start: { date: day(2) }, end: { date: day(4) },
      extendedProperties: { private: { bookingId: 'B1' } },
    });
    const { entries } = await get(`/api/calendar?${month()}`);
    assert.strictEqual(entries.length, 1, 'the booking and its entry are the same thing');
  });

  test('the bracketed status becomes a status, not part of the title', async () => {
    await post('/api/calendar/block?biz=studio', { date: day(3), note: 'Ferien' });
    const { entries } = await get(`/api/calendar?${month()}&biz=studio`);
    assert.strictEqual(entries[0].title, 'Ferien');
    assert.strictEqual(entries[0].source, 'owner');
    assert.strictEqual(entries[0].allDay, true);
  });
});

describe('blocking time', () => {
  test('a blocked day actually stops the bot offering it', async () => {
    const date = day(20);
    await post('/api/calendar/block?biz=studio', { date, note: 'Ferien' });

    const cal = createStudioCalendarService({
      timeZone: TZ, client: createLocalCalendarClient({ business: 'studio', timeZone: TZ }),
    });
    const res = await cal.checkSlotAvailability({
      professionalId: 'P1', professionalName: 'Sofia', date, startTime: '14:00', durationMin: 60,
    });
    assert.strictEqual(res.available, false, 'the page and the bot must agree');
  });

  test('an hour can be blocked instead of a whole day', async () => {
    const date = day(21);
    const res = await post('/api/calendar/block?biz=studio', { date, startTime: '09:00', endTime: '12:00', note: 'privat' });
    assert.strictEqual(res.ok, true);

    const { entries } = await get(`/api/calendar?${month()}&biz=studio`);
    const blocked = entries.find((e) => e.startDate === date);
    assert.strictEqual(blocked.allDay, false);
    assert.strictEqual(blocked.startTime, '09:00');
  });

  test('a block can be removed again', async () => {
    const { id } = await post('/api/calendar/block?biz=studio', { date: day(5), note: 'x' });
    const res = await del(`/api/calendar/block/${id}?biz=studio`);
    assert.strictEqual(res.ok, true);
    const { entries } = await get(`/api/calendar?${month()}&biz=studio`);
    assert.strictEqual(entries.length, 0);
  });

  test('an appointment cannot be deleted off the grid', async () => {
    const ev = await createLocalCalendarClient({ business: 'studio', timeZone: TZ }).createEvent({
      summary: '[PENDING] Massage', start: { dateTime: `${day(2)}T14:00:00`, timeZone: TZ },
      end: { dateTime: `${day(2)}T15:00:00`, timeZone: TZ },
    });
    const res = await del(`/api/calendar/block/${ev.id}?biz=studio`);
    assert.strictEqual(res.ok, false, 'cancelling tells the customer; deleting would not');
  });

  test('one business cannot delete the other one\'s entry', async () => {
    const { id } = await post('/api/calendar/block?biz=studio', { date: day(6), note: 'x' });
    const res = await del(`/api/calendar/block/${id}`); // party
    assert.strictEqual(res.ok, false);
  });

  test('a nonsense date is refused', async () => {
    const res = await post('/api/calendar/block?biz=studio', { date: 'tomorrow' });
    assert.strictEqual(res.ok, false);
  });

  test('an end before its start is refused', async () => {
    const res = await post('/api/calendar/block?biz=studio', { date: day(7), startTime: '14:00', endTime: '09:00' });
    assert.strictEqual(res.ok, false);
  });
});
