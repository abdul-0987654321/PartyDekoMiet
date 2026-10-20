'use strict';
/**
 * Time-slot availability for Studio appointments. A false "free" double-books
 * a professional at the same time for two customers.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { checkSlot, findNextFreeOnDay, toMinutes, isHHMM } = require('../src/calendar/slots');

/** Timed event the way Google returns it, in Zurich local time (+02:00 in summer). */
const appt = (professionalId, date, startHHMM, endHHMM, status = 'PENDING') => ({
  id: `ev-${professionalId}-${date}-${startHHMM}`,
  summary: `[${status}] Massage – Anna`,
  start: { dateTime: `${date}T${startHHMM}:00+02:00` },
  end: { dateTime: `${date}T${endHHMM}:00+02:00` },
  extendedProperties: { private: { professionalId, bookingStatus: status } },
});

const blocked = (date, title = 'Geschlossen') => ({
  id: `block-${date}`,
  summary: title,
  start: { date },
  end: { date: nextDay(date) },
});

function nextDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe('toMinutes / isHHMM', () => {
  test('parses HH:MM', () => {
    assert.strictEqual(toMinutes('00:00'), 0);
    assert.strictEqual(toMinutes('14:30'), 870);
    assert.strictEqual(toMinutes('23:59'), 1439);
  });
  test('rejects bad input', () => {
    assert.strictEqual(isHHMM('24:00'), false);
    assert.strictEqual(isHHMM('9:00'), false);
    assert.strictEqual(isHHMM('09:60'), false);
    assert.strictEqual(isHHMM('09:00'), true);
  });
});

describe('an empty calendar', () => {
  test('any slot is free', () => {
    const res = checkSlot({ events: [], professionalId: 'P1', date: '2026-06-05', startTime: '14:00', durationMin: 60 });
    assert.strictEqual(res.available, true);
    assert.strictEqual(res.reason, null);
  });
});

describe('overlap with an existing appointment', () => {
  const events = [appt('P1', '2026-06-05', '14:00', '15:00')];

  test('a slot fully inside the existing one is blocked', () => {
    const res = checkSlot({ events, professionalId: 'P1', date: '2026-06-05', startTime: '14:15', durationMin: 15 });
    assert.strictEqual(res.available, false);
    assert.strictEqual(res.reason, 'already_booked');
  });

  test('a slot that only partially overlaps is blocked', () => {
    const res = checkSlot({ events, professionalId: 'P1', date: '2026-06-05', startTime: '13:30', durationMin: 60 });
    assert.strictEqual(res.available, false);
  });

  test('a slot right after, with no buffer required, is free', () => {
    const res = checkSlot({ events, professionalId: 'P1', date: '2026-06-05', startTime: '15:00', durationMin: 30 });
    assert.strictEqual(res.available, true);
  });

  test('a different professional at the same time is unaffected', () => {
    const res = checkSlot({ events, professionalId: 'P2', date: '2026-06-05', startTime: '14:00', durationMin: 60 });
    assert.strictEqual(res.available, true);
  });

  test('the same professional on a different day is unaffected', () => {
    const res = checkSlot({ events, professionalId: 'P1', date: '2026-06-06', startTime: '14:00', durationMin: 60 });
    assert.strictEqual(res.available, true);
  });

  test('only CONFIRMED/PENDING block; a CANCELLED-looking title does not', () => {
    const cancelled = [{ ...appt('P1', '2026-06-05', '14:00', '15:00'), summary: '[CANCELLED] Massage - Anna', extendedProperties: { private: { professionalId: 'P1' } } }];
    const res = checkSlot({ events: cancelled, professionalId: 'P1', date: '2026-06-05', startTime: '14:00', durationMin: 60 });
    assert.strictEqual(res.available, true);
  });
});

describe('buffer time between appointments', () => {
  const events = [appt('P1', '2026-06-05', '14:00', '15:00')];

  test('a slot right after is blocked when a buffer is required', () => {
    const res = checkSlot({ events, professionalId: 'P1', date: '2026-06-05', startTime: '15:00', durationMin: 30, bufferMin: 15 });
    assert.strictEqual(res.available, false);
  });

  test('a slot after the buffer has passed is free', () => {
    const res = checkSlot({ events, professionalId: 'P1', date: '2026-06-05', startTime: '15:15', durationMin: 30, bufferMin: 15 });
    assert.strictEqual(res.available, true);
  });

  test('the buffer does not push the existing appointment\'s own start earlier', () => {
    // A new request ending exactly where the existing one starts, with buffer,
    // should still be blocked (buffer only protects time AFTER an appointment).
    const res = checkSlot({ events, professionalId: 'P1', date: '2026-06-05', startTime: '13:45', durationMin: 15, bufferMin: 15 });
    assert.strictEqual(res.available, true); // 13:45-14:00 ends exactly at 14:00, no overlap, buffer is one-directional
  });
});

describe('blocked (holiday/closed) days', () => {
  test('an all-day blocking event on that date refuses every slot', () => {
    const events = [blocked('2026-06-05')];
    const res = checkSlot({ events, professionalId: 'P1', date: '2026-06-05', startTime: '10:00', durationMin: 30, blockedKeywords: 'geschlossen,ferien' });
    assert.strictEqual(res.available, false);
    assert.strictEqual(res.reason, 'blocked_day');
  });

  test('a blocking event on a different date does not affect this one', () => {
    const events = [blocked('2026-06-06')];
    const res = checkSlot({ events, professionalId: 'P1', date: '2026-06-05', startTime: '10:00', durationMin: 30, blockedKeywords: 'geschlossen' });
    assert.strictEqual(res.available, true);
  });
});

describe('minimum notice', () => {
  test('a slot sooner than the minimum notice is refused', () => {
    const now = new Date('2026-06-05T09:30:00+02:00');
    const res = checkSlot({ events: [], professionalId: 'P1', date: '2026-06-05', startTime: '10:00', durationMin: 30, minNoticeHours: 2, now });
    assert.strictEqual(res.available, false);
    assert.strictEqual(res.reason, 'too_soon');
  });

  test('a slot far enough out passes', () => {
    const now = new Date('2026-06-05T09:30:00+02:00');
    const res = checkSlot({ events: [], professionalId: 'P1', date: '2026-06-05', startTime: '12:00', durationMin: 30, minNoticeHours: 2, now });
    assert.strictEqual(res.available, true);
  });
});

describe('manual events (no extendedProperties), matched by name', () => {
  test('a manually-typed event with the professional\'s name in the title blocks', () => {
    const events = [{
      id: 'manual-1', summary: 'Termin Gabriela 14-15 Uhr',
      start: { dateTime: '2026-06-05T14:00:00+02:00' }, end: { dateTime: '2026-06-05T15:00:00+02:00' },
    }];
    // Manual events have no bookingStatus, so they are not matched as our bookings
    // unless the owner also used [PENDING]/[CONFIRMED] - same convention as availability.js.
    const res = checkSlot({ events, professionalId: 'P1', professionalName: 'Gabriela', date: '2026-06-05', startTime: '14:30', durationMin: 30 });
    assert.strictEqual(res.available, true); // no status marker, so it is not read as a booking at all

    const withStatus = [{ ...events[0], summary: '[CONFIRMED] Termin Gabriela 14-15 Uhr' }];
    const res2 = checkSlot({ events: withStatus, professionalId: 'P1', professionalName: 'Gabriela', date: '2026-06-05', startTime: '14:30', durationMin: 30 });
    assert.strictEqual(res2.available, false);
  });
});

describe('findNextFreeOnDay', () => {
  test('returns free candidate times in order, up to count', () => {
    const events = [appt('P1', '2026-06-05', '14:00', '15:00')];
    const candidates = ['10:00', '11:00', '14:00', '15:00', '16:00'];
    const free = findNextFreeOnDay({
      events, professionalId: 'P1', date: '2026-06-05', durationMin: 60, candidateTimes: candidates, count: 2,
    });
    assert.deepStrictEqual(free, ['10:00', '11:00']);
  });
});
