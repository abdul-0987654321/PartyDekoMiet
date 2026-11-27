'use strict';
/**
 * The conversation that died at "ok do 12 PM".
 *
 * From the owner's own alert: the bot got stuck, ended the conversation and
 * handed the customer to a human. The failing tool was
 * create_appointment_request, and the error was "Professional TST nicht
 * gefunden" - TST being the name of the WhatsApp number it was answering on,
 * not a professional id.
 *
 * check_slot_availability had resolved names for a long time: it takes "Sofia"
 * or "massage" and finds the record. create_appointment_request, the tool that
 * actually writes the appointment down, demanded an exact id. So the bot could
 * check a slot by name and then be unable to book it - and because the tool
 * kept refusing, it retried, gave up, and handed a paying customer to a human
 * at five in the morning.
 *
 * These tests pin both halves: a name works, and on a professional's own
 * number the appointment can only ever be hers.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const directory = require('../src/studio/directory');
const { scopeToProfessional } = require('../src/studio/scope');
const { createAppointments } = require('../src/appointments');
const { runTool } = require('../src/agent/tools/studio');

const QUIET = {
  appointmentRequest: async () => ({ ok: true }),
  owner: async () => ({ ok: true }),
  toNumber: async () => ({ ok: true }),
  recipients: () => [],
};

let sofia;
let gabriela;
let massage;
let services;

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  await settings.update({ studioOpenTime: '10:00', studioCloseTime: '22:00' });

  sofia = (await directory.createProfessional({ name: 'Sofia' })).professional;
  gabriela = (await directory.createProfessional({ name: 'Gabriela' })).professional;
  massage = (await directory.createService({
    name: 'Massage 60', professionalId: sofia.id, durationMin: 60, priceChf: 200,
  })).service;
  await directory.createService({
    name: 'Gabriela Spezial', professionalId: gabriela.id, durationMin: 60, priceChf: 250,
  });

  services = {
    directory,
    appointments: createAppointments({ calendar: null, notify: QUIET, business: 'studio' }),
    chatId: '41790000000@s.whatsapp.net',
  };
});

const book = (over = {}, svc = services) => runTool('create_appointment_request', {
  professional_id: sofia.id,
  service_id: massage.id,
  date: '2026-12-01',
  start_time: '11:00',
  customer_name: 'Abdul',
  ...over,
}, svc);

describe('naming instead of giving an id', () => {
  test('her name works', async () => {
    const res = await book({ professional_id: 'Sofia' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(db.all('appointments')[0].professionalName, 'Sofia');
  });

  test('the service by name works too', async () => {
    const res = await book({ service_id: 'Massage 60' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(db.all('appointments')[0].serviceName, 'Massage 60');
  });

  test('a partial name works, the way the slot check already allowed', async () => {
    assert.strictEqual((await book({ service_id: 'massage' })).ok, true);
  });

  test('an exact name still wins over a longer one that contains it', async () => {
    await directory.createProfessional({ name: 'Sofia M' });
    const res = await book({ professional_id: 'Sofia' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(db.all('appointments')[0].professionalName, 'Sofia');
  });

  test('a name that fits two people is asked about, not guessed', async () => {
    await directory.createProfessional({ name: 'Anna B' });
    await directory.createProfessional({ name: 'Anna C' });
    const res = await book({ professional_id: 'Anna' });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /mehrere/);
    assert.strictEqual(db.all('appointments').length, 0, 'never book on a maybe');
  });

  test('a name nobody has is still refused on the Studio number', async () => {
    const res = await book({ professional_id: 'Jemand' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(db.all('appointments').length, 0);
  });
});

describe('on a professional\'s own number', () => {
  let herLine;

  beforeEach(() => {
    herLine = {
      directory: scopeToProfessional(directory, sofia.id),
      appointments: createAppointments({ calendar: null, notify: QUIET, business: 'pro-sofia' }),
      chatId: '41790000000@s.whatsapp.net',
    };
  });

  test('"TST" - the name of the number - books her instead of dying', async () => {
    // This is the exact failure: the model passed the line's name.
    const res = await book({ professional_id: 'TST' }, herLine);
    assert.strictEqual(res.ok, true, 'the conversation must not die here');
    assert.strictEqual(db.all('appointments')[0].professionalName, 'Sofia');
  });

  test('so does an empty one', async () => {
    const res = await book({ professional_id: '' }, herLine);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(db.all('appointments')[0].professionalName, 'Sofia');
  });

  test('naming a colleague books HER, never the colleague', async () => {
    const res = await book({ professional_id: 'Gabriela' }, herLine);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(
      db.all('appointments')[0].professionalName,
      'Sofia',
      "a colleague must never be bookable from somebody else's number"
    );
  });

  test('a colleague\'s service is refused outright', async () => {
    const res = await book({ service_id: 'Gabriela Spezial' }, herLine);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(db.all('appointments').length, 0);
  });
});
