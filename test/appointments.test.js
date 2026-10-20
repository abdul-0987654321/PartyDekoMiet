'use strict';
/** Appointment data validation and the status change from the dashboard. */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const directory = require('../src/studio/directory');
const { createAppointments, validateAppointmentArgs } = require('../src/appointments');

describe('rejecting unusable appointment data', () => {
  test('the placeholder name the model invented is rejected', () => {
    for (const name of ['Customer', 'kunde', 'N/A', '-', 'unknown', '', 'test']) {
      assert.ok(validateAppointmentArgs({ customer_name: name }), `"${name}" should be rejected`);
    }
  });

  test('a real name passes', () => {
    assert.strictEqual(validateAppointmentArgs({ customer_name: 'Anna Keller' }), null);
  });
});

describe('creating an appointment request', () => {
  let appointments, calendarCalls, professional, service;

  const calendar = {
    createAppointmentEvent: async (appt) => {
      calendarCalls.push({ op: 'create', appt });
      return { id: 'ev-1', htmlLink: 'https://calendar.example/ev-1', endTime: '15:30' };
    },
    patchEvent: async (id, patch) => calendarCalls.push({ op: 'patch', id, patch }),
    deleteEvent: async (id) => calendarCalls.push({ op: 'delete', id }),
  };

  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
    calendarCalls = [];
    const pro = await directory.createProfessional({ name: 'Gabriela' });
    professional = pro.professional;
    const svc = await directory.createService({ name: 'Massage 60min', durationMin: 60, priceChf: 120 });
    service = svc.service;
    appointments = createAppointments({ calendar, notify: null });
  });

  test('a real request is kept as PENDING and never promoted by this file', async () => {
    const res = await appointments.create({
      customer_name: 'Anna Keller',
      professional_id: professional.id,
      service_id: service.id,
      date: '2026-06-05',
      start_time: '14:30',
      chatId: '41790000000@s.whatsapp.net',
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'PENDING');
    const stored = db.get('appointments', res.appointment_id);
    assert.strictEqual(stored.status, 'PENDING');
    assert.strictEqual(stored.professionalName, 'Gabriela');
    assert.strictEqual(stored.serviceName, 'Massage 60min');
    assert.strictEqual(calendarCalls[0].op, 'create');
    assert.match(stored.calendarEventId, /ev-1/);
  });

  test('an unknown professional is refused before touching the calendar', async () => {
    const res = await appointments.create({
      customer_name: 'Anna', professional_id: 'nope', service_id: service.id,
      date: '2026-06-05', start_time: '14:30',
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(calendarCalls.length, 0);
  });

  test('an unknown service is refused before touching the calendar', async () => {
    const res = await appointments.create({
      customer_name: 'Anna', professional_id: professional.id, service_id: 'nope',
      date: '2026-06-05', start_time: '14:30',
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(calendarCalls.length, 0);
  });

  test('the appointment is still kept when the calendar call fails', async () => {
    const broken = createAppointments({
      notify: null,
      calendar: { createAppointmentEvent: async () => { throw new Error('calendar down'); } },
    });
    const res = await broken.create({
      customer_name: 'Anna', professional_id: professional.id, service_id: service.id,
      date: '2026-06-05', start_time: '14:30',
    });
    assert.strictEqual(res.ok, true);
    const stored = db.get('appointments', res.appointment_id);
    assert.strictEqual(stored.status, 'PENDING');
    assert.strictEqual(stored.calendarEventId, '');
  });
});

describe('changing an appointment status', () => {
  let appointments, calendarCalls;

  const calendar = {
    patchEvent: async (id, patch) => calendarCalls.push({ op: 'patch', id, patch }),
    deleteEvent: async (id) => calendarCalls.push({ op: 'delete', id }),
  };

  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
    calendarCalls = [];
    appointments = createAppointments({ calendar, notify: null });
    db.put('appointments', {
      id: 'A1', status: 'PENDING', jid: 'x@s.whatsapp.net', phone: '41790000000',
      customerName: 'Anna Keller', professionalName: 'Gabriela', serviceName: 'Massage 60min',
      date: '2026-06-05', startTime: '14:30', calendarEventId: 'ev-1',
    });
  });

  test('confirming retitles the calendar event', async () => {
    const res = await appointments.setStatus('A1', 'CONFIRMED');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.previous, 'PENDING');
    assert.strictEqual(db.get('appointments', 'A1').status, 'CONFIRMED');
    assert.strictEqual(calendarCalls[0].op, 'patch');
    assert.match(calendarCalls[0].patch.summary, /^\[CONFIRMED\]/);
  });

  test('cancelling deletes the event so the slot is free again', async () => {
    await appointments.setStatus('A1', 'CANCELLED');
    assert.strictEqual(calendarCalls[0].op, 'delete');
    assert.strictEqual(db.get('appointments', 'A1').calendarEventId, '');
    assert.strictEqual(db.get('appointments', 'A1').status, 'CANCELLED');
  });

  test('an unknown status is refused', async () => {
    const res = await appointments.setStatus('A1', 'MAYBE');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(db.get('appointments', 'A1').status, 'PENDING');
  });

  test('an unknown appointment is refused', async () => {
    assert.strictEqual((await appointments.setStatus('nope', 'CONFIRMED')).ok, false);
  });

  test('setting the status it already has does nothing', async () => {
    const res = await appointments.setStatus('A1', 'PENDING');
    assert.strictEqual(res.unchanged, true);
    assert.strictEqual(calendarCalls.length, 0);
  });
});

describe('listing appointments', () => {
  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
    db.put('appointments', { id: 'A1', status: 'PENDING', createdAt: '2026-01-01T00:00:00.000Z' });
    db.put('appointments', { id: 'A2', status: 'CONFIRMED', createdAt: '2026-01-02T00:00:00.000Z' });
  });

  test('filters by status and sorts newest first', () => {
    const appointments = createAppointments({ calendar: null, notify: null });
    const pending = appointments.list({ status: 'PENDING' });
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].id, 'A1');
    const all = appointments.list({});
    assert.deepStrictEqual(all.map((a) => a.id), ['A2', 'A1']);
  });
});
