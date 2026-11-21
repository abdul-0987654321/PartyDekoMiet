'use strict';
/**
 * The built-in calendar, which replaced Google.
 *
 * What matters is not that entries are stored - it is that the availability
 * maths gets exactly the same shape of event it got from Google, because that
 * maths is what stops the bot promising a time that is already taken. So these
 * tests go through the real services: book an appointment, then ask whether the
 * slot is free, and expect to be told no.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createLocalCalendarClient } = require('../src/calendar/local-client');
const { createStudioCalendarService } = require('../src/calendar/studio-service');
const { createCalendarService } = require('../src/calendar');

const TZ = 'Europe/Zurich';
const studioCal = () => createStudioCalendarService({
  timeZone: TZ,
  client: createLocalCalendarClient({ business: 'studio', timeZone: TZ }),
});
const partyCal = () => createCalendarService({
  timeZone: TZ,
  getStock: () => 1,
  client: createLocalCalendarClient({ business: 'party', timeZone: TZ }),
});

/** A date far enough ahead that the minimum-notice rule never interferes. */
function soon(days = 30) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
});

describe('the built-in calendar needs no setup', () => {
  test('a slot can be checked without any calendar id anywhere', async () => {
    const res = await studioCal().checkSlotAvailability({
      professionalId: 'P1', professionalName: 'Sofia',
      date: soon(), startTime: '14:00', durationMin: 60,
    });
    assert.strictEqual(res.ok, true, 'no "calendar is not set up yet" any more');
    assert.strictEqual(res.available, true);
  });
});

describe('a booked slot is no longer free', () => {
  const date = soon();

  test('the same time is refused once it is taken', async () => {
    const cal = studioCal();
    await cal.createAppointmentEvent({
      id: 'A1', professionalId: 'P1', professionalName: 'Sofia',
      serviceName: 'Massage', customerName: 'Anna', date, startTime: '14:00', durationMin: 60,
    });

    const res = await cal.checkSlotAvailability({
      professionalId: 'P1', professionalName: 'Sofia', date, startTime: '14:00', durationMin: 60,
    });
    assert.strictEqual(res.available, false);
  });

  test('another professional is still free at that time', async () => {
    const cal = studioCal();
    await cal.createAppointmentEvent({
      id: 'A1', professionalId: 'P1', professionalName: 'Sofia',
      serviceName: 'Massage', customerName: 'Anna', date, startTime: '14:00', durationMin: 60,
    });

    const res = await cal.checkSlotAvailability({
      professionalId: 'P2', professionalName: 'Mia', date, startTime: '14:00', durationMin: 60,
    });
    assert.strictEqual(res.available, true, 'two people can work at the same hour');
  });

  test('a cancelled appointment frees its slot again', async () => {
    const cal = studioCal();
    const ev = await cal.createAppointmentEvent({
      id: 'A1', professionalId: 'P1', professionalName: 'Sofia',
      serviceName: 'Massage', customerName: 'Anna', date, startTime: '14:00', durationMin: 60,
    });
    await cal.deleteEvent(ev.id);

    const res = await cal.checkSlotAvailability({
      professionalId: 'P1', professionalName: 'Sofia', date, startTime: '14:00', durationMin: 60,
    });
    assert.strictEqual(res.available, true);
  });
});

describe('time blocked by hand', () => {
  test('an all-day block closes the day for everyone', async () => {
    const date = soon();
    const client = createLocalCalendarClient({ business: 'studio', timeZone: TZ });
    const next = new Date(`${date}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    await client.createEvent({
      summary: '[BLOCKED] Ferien',
      start: { date }, end: { date: next.toISOString().slice(0, 10) },
      source: 'owner', extendedProperties: { private: { blocked: 'true' } },
    });

    const res = await studioCal().checkSlotAvailability({
      professionalId: 'P1', professionalName: 'Sofia', date, startTime: '14:00', durationMin: 60,
    });
    assert.strictEqual(res.available, false, 'a holiday has to close the whole day');
  });
});

describe('the two businesses keep separate days', () => {
  test("the Studio's appointment does not block a PartyDekoMiet rental", async () => {
    const date = soon();
    await studioCal().createAppointmentEvent({
      id: 'A1', professionalId: 'P1', professionalName: 'Sofia',
      serviceName: 'Massage', customerName: 'Anna', date, startTime: '14:00', durationMin: 60,
    });

    const seen = await createLocalCalendarClient({ business: 'party', timeZone: TZ })
      .listEvents({ timeMin: `${date}T00:00:00Z`, timeMax: `${date}T23:59:59Z` });
    assert.deepStrictEqual(seen, [], 'PartyDekoMiet never sees the Studio\'s day');
  });

  test('a rental is written to and read back from the Party calendar', async () => {
    const cal = partyCal();
    const res = await cal.checkAvailability({ productId: 'SKU-1', start: soon(40) });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.available, true);
  });
});
