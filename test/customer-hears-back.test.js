'use strict';
/**
 * The one person actually waiting.
 *
 * He pressed Confirm. The status changed, the calendar updated, his own alert
 * arrived - and the customer heard nothing. Everything looked right from the
 * dashboard, and the only thing that had failed was the thing the whole
 * feature exists for.
 *
 * WhatsApp now addresses most people by a hidden id (a LID, like
 * 150375495651422@lid) rather than by their phone number. The confirmation
 * took that chat id apart and rebuilt it as "150375495651422@s.whatsapp.net",
 * which belongs to nobody. Every confirmation and every cancellation, on both
 * sides, went to an address that does not exist - and the log line said it had
 * been sent.
 *
 * The chat id we already have is the right address. It is the chat the
 * conversation happened in.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const directory = require('../src/studio/directory');
const { createAppointments } = require('../src/appointments');
const { createBookings } = require('../src/bookings');
const { createNotifier } = require('../src/notify/owner');
const { createLocalCalendarClient } = require('../src/calendar/local-client');
const { createStudioCalendarService } = require('../src/calendar/studio-service');

/** A working calendar, so a write failure does not look like a second alert. */
const studioCalendar = () => createStudioCalendarService({
  client: createLocalCalendarClient({ business: 'studio', timeZone: 'Europe/Zurich' }),
  directory,
});

const OWN = '41780001111';
const LID = '150375495651422@lid';
const PHONE_JID = '41761234567@s.whatsapp.net';

let sent, client, notify;

function makeClient() {
  sent = [];
  return {
    getStatus: () => ({ status: 'connected', me: { id: `${OWN}:1@s.whatsapp.net` } }),
    isConnected: () => true,
    sendText: async (jid, text) => { sent.push({ jid, text }); },
    forwardImage: async () => {},
  };
}

/** Everything that went anywhere other than the owner's own phone. */
const toCustomers = () => sent.filter((s) => !s.jid.startsWith(OWN));

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  client = makeClient();
  notify = createNotifier({ client, business: 'studio' });
});

describe('a confirmed appointment reaches the customer', () => {
  async function appointmentIn(chatId) {
    const pro = (await directory.createProfessional({ name: 'tst' })).professional;
    const svc = (await directory.createService({ name: 'Massage 60', durationMin: 60, priceChf: 200 })).service;
    const appointments = createAppointments({ calendar: studioCalendar(), notify, business: 'studio' });
    const created = await appointments.create({
      professional_id: pro.id, service_id: svc.id,
      date: '2026-12-02', start_time: '11:00', customer_name: 'Lia', chatId,
    });
    assert.strictEqual(created.ok, true, created.error);
    sent.length = 0;
    return { appointments, id: created.appointment_id };
  }

  test('in a chat addressed by a hidden id', async () => {
    const { appointments } = await appointmentIn(LID);
    await appointments.setStatus(db.all('appointments')[0].id, 'CONFIRMED');

    const mine = toCustomers();
    assert.strictEqual(mine.length, 1, 'exactly one message to the customer');
    assert.strictEqual(mine[0].jid, LID, 'into the chat we were already in, not a rebuilt number');
    assert.match(mine[0].text, /best(ae|ä)tigt/i);
    assert.ok(!mine[0].text.startsWith('\u{1F514}'), 'a customer never gets the internal bell');
  });

  test('and in a chat addressed by a phone number, same as before', async () => {
    const { appointments } = await appointmentIn(PHONE_JID);
    await appointments.setStatus(db.all('appointments')[0].id, 'CONFIRMED');

    const mine = toCustomers();
    assert.strictEqual(mine.length, 1);
    assert.strictEqual(mine[0].jid, PHONE_JID);
  });

  test('a cancellation reaches her too', async () => {
    const { appointments } = await appointmentIn(LID);
    await appointments.setStatus(db.all('appointments')[0].id, 'CANCELLED');
    assert.strictEqual(toCustomers()[0].jid, LID);
  });

  test('the owner is told whether the customer actually heard', async () => {
    const { appointments } = await appointmentIn(LID);
    await appointments.setStatus(db.all('appointments')[0].id, 'CONFIRMED');
    const his = sent.find((s) => s.jid.startsWith(OWN));
    assert.ok(his, 'he still gets his own alert');
    assert.ok(!/nicht erreicht|not reached/i.test(his.text), 'and it does not say the customer was missed');
  });
});

describe('a confirmed rental reaches the customer', () => {
  async function bookingIn(jid) {
    const bookings = createBookings({
      catalog: { all: () => [], find: () => null },
      calendar: null,
      notify,
    });
    db.put('bookings', {
      id: 'B1', business: 'party', status: 'PENDING', jid, phone: '',
      customerName: 'Anna', productTitle: 'Einhorn Set', priceChf: 150,
      pickupDate: '2026-12-02', returnDate: '2026-12-04', createdAt: new Date().toISOString(),
    });
    await db.flush();
    sent.length = 0;
    return bookings;
  }

  test('in a chat addressed by a hidden id', async () => {
    const bookings = await bookingIn(LID);
    await bookings.setStatus('B1', 'CONFIRMED');

    const mine = toCustomers();
    assert.strictEqual(mine.length, 1);
    assert.strictEqual(mine[0].jid, LID);
    assert.ok(!mine[0].text.startsWith('\u{1F514}'));
  });
});

describe('two messages about one appointment, in one chat', () => {
  test('her own number being this number does not produce a second message', async () => {
    // He put his own number into her profile while setting her up. One
    // appointment then produced two WhatsApp messages in the same chat - the
    // team alert and "a new request for you, reply J" - with nothing saying
    // which was which or why there were two.
    const pro = (await directory.createProfessional({ name: 'tst', whatsapp: OWN })).professional;
    const svc = (await directory.createService({ name: 'Massage 60', durationMin: 60, priceChf: 200 })).service;
    const appointments = createAppointments({ calendar: studioCalendar(), notify, business: 'studio' });

    await appointments.create({
      professional_id: pro.id, service_id: svc.id,
      date: '2026-12-02', start_time: '11:00', customer_name: 'Lia', chatId: LID,
    });

    const his = sent.filter((s) => s.jid.startsWith(OWN));
    assert.strictEqual(his.length, 1, 'one situation, one message');
    assert.match(his[0].text, /TERMINANFRAGE/);
  });

  test('a separate number for her still gets her own message, with her name on it', async () => {
    const pro = (await directory.createProfessional({ name: 'tst', whatsapp: '41791112233' })).professional;
    const svc = (await directory.createService({ name: 'Massage 60', durationMin: 60, priceChf: 200 })).service;
    const appointments = createAppointments({ calendar: studioCalendar(), notify, business: 'studio' });

    await appointments.create({
      professional_id: pro.id, service_id: svc.id,
      date: '2026-12-02', start_time: '11:00', customer_name: 'Lia', chatId: LID,
    });

    const hers = sent.find((s) => s.jid.startsWith('41791112233'));
    assert.ok(hers, 'she is told about her own appointment');
    assert.match(hers.text, /TST/, 'her name is in it, so it is clear who it is for');
    assert.match(hers.text, /Professionals/, 'and it says where the message comes from');
  });
});

describe('an alert says which number it is about', () => {
  test('so three numbers do not produce three identical-looking messages', async () => {
    await notify.owner('NEUE TERMINANFRAGE\n\nKunde: Lia', { kind: 'appointment_request' });
    assert.match(sent[0].text, /\[.+\]$/, 'it ends with the name of the number it concerns');
  });
});

describe('toChat', () => {
  test('writes to a chat id exactly as given', async () => {
    await notify.toChat(LID, 'hallo', { plain: true });
    assert.deepStrictEqual(sent, [{ jid: LID, text: 'hallo' }]);
  });

  test('still accepts a bare number, the way the old call sites passed one', async () => {
    await notify.toChat('41791112233', 'hallo', { plain: true });
    assert.strictEqual(sent[0].jid, '41791112233@s.whatsapp.net');
  });

  test('a send that fails is reported rather than swallowed', async () => {
    client.sendText = async () => { throw new Error('WhatsApp ist nicht verbunden'); };
    const res = await notify.toChat(LID, 'hallo', { plain: true });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /nicht verbunden/);
  });
});
