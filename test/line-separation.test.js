'use strict';
/**
 * The pieces that still said "studio" out loud after the professionals got
 * their own numbers.
 *
 * Each of these was written when there were exactly two numbers, and each one
 * quietly filed a professional's number's data under the Studio: her sent
 * photos landed in the Studio's conversation list, and her appointment alerts
 * carried a WhatsApp id instead of a phone number the owner can call.
 *
 * Also here: the Studio's own alert-number fields, which were never validated
 * the way PartyDekoMiet's are, so a typo saved without complaint.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createPhotos } = require('../src/studio/photos');
const { createAppointments } = require('../src/appointments');
const customers = require('../src/customers');

const CHAT = '41791234567@s.whatsapp.net';
const LID = '150375495651422@lid';

function photoClient() {
  const sent = [];
  return { sent, forwardImage: async (jid, buffer, caption) => sent.push({ jid, caption }) };
}

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
});

describe("a professional's photo on her own number", () => {
  beforeEach(async () => {
    await db.init(createMemoryBackend());
    db._testFile = await db.putFile('sofia.jpg', 'image/jpeg', Buffer.from('not-really-a-jpeg'));
  });

  const sofia = () => ({ id: 'P1', name: 'Sofia', photoFileId: db._testFile });

  test('is written into her chat, not the Studio\'s', async () => {
    const photos = createPhotos({ client: photoClient(), business: 'pro-sofia' });
    await photos.sendProfessional(CHAT, sofia(), 'Sofia');

    const rows = db.all('chat').filter((m) => m.image);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].business, 'pro-sofia');
  });

  test("the Studio's own number still files under the Studio", async () => {
    const photos = createPhotos({ client: photoClient(), business: 'studio' });
    await photos.sendProfessional(CHAT, sofia(), 'Sofia');

    assert.strictEqual(db.all('chat').find((m) => m.image).business, 'studio');
  });

  test('"already sent" is per number: her line sends it even if the Studio did', async () => {
    const studio = createPhotos({ client: photoClient(), business: 'studio' });
    await studio.sendProfessional(CHAT, sofia(), 'Sofia', { once: true });

    const client = photoClient();
    const hers = createPhotos({ client, business: 'pro-sofia' });
    const res = await hers.sendProfessional(CHAT, sofia(), 'Sofia', { once: true });

    assert.strictEqual(res.skipped, undefined, 'her own line had not sent it yet');
    assert.strictEqual(client.sent.length, 1);
  });

  test('and does not send twice on the same number', async () => {
    const client = photoClient();
    const hers = createPhotos({ client, business: 'pro-sofia' });
    await hers.sendProfessional(CHAT, sofia(), 'Sofia', { once: true });
    const second = await hers.sendProfessional(CHAT, sofia(), 'Sofia', { once: true });

    assert.ok(second.skipped, 'the same photo must not go out twice in one chat');
    assert.strictEqual(client.sent.length, 1);
  });
});

describe('an appointment request taken on her own number', () => {
  const args = {
    professional_id: 'P1',
    service_id: 'S1',
    date: '2026-12-01',
    start_time: '14:00',
    customer_name: 'Anna',
    chatId: LID,
  };

  beforeEach(() => {
    db.put('professionals', { id: 'P1', name: 'Sofia', active: true });
    db.put('services', { id: 'S1', name: 'Massage', durationMin: 60, priceChf: 150, active: true });
    // WhatsApp addressed this person by a hidden id; the real number is on her
    // own customer record, because that is the number she wrote to.
    customers.save('pro-sofia', LID, { phone: '41791234567' });
  });

  test('carries the phone number from her own customer record', async () => {
    const appointments = createAppointments({ business: 'pro-sofia', notify: null, calendar: null });
    const res = await appointments.create(args);

    assert.strictEqual(res.ok, true);
    assert.strictEqual(db.all('appointments')[0].phone, '41791234567');
  });

  test('saves the customer under her own number, not the Studio', async () => {
    const appointments = createAppointments({ business: 'pro-sofia', notify: null, calendar: null });
    await appointments.create({ ...args, customer_name: 'Anna' });

    assert.strictEqual(customers.get('pro-sofia', LID)?.name, 'Anna');
    assert.strictEqual(customers.get('studio', LID), null, 'the Studio keeps no record of her customer');
  });

  test("does not read the Studio's record for the same person", async () => {
    customers.save('studio', LID, { phone: '41760000000' });
    const appointments = createAppointments({ business: 'pro-sofia', notify: null, calendar: null });
    await appointments.create(args);

    assert.strictEqual(db.all('appointments')[0].phone, '41791234567');
  });
});

describe('alert numbers are validated on both sides', () => {
  for (const key of ['alertNumbers', 'studioAlertNumbers']) {
    test(`${key} refuses a number that is too short`, async () => {
      const res = await settings.update({ [key]: '41791234567, 123' });
      assert.strictEqual(res.ok, false);
      assert.match(res.errors.join(' '), /123/);
    });

    test(`${key} cleans a pasted number`, async () => {
      const res = await settings.update({ [key]: '+41 79 123 45 67' });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(settings.get(key), '41791234567');
    });
  }

  for (const key of ['ownerWhatsapp', 'studioOwnerWhatsapp']) {
    test(`${key} refuses nonsense`, async () => {
      const res = await settings.update({ [key]: 'nummer folgt' });
      assert.strictEqual(res.ok, false);
    });
  }
});
