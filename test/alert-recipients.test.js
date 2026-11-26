'use strict';
/**
 * Who an alert actually reaches.
 *
 * One answer: the phone this number is connected on. There used to be a chain
 * of four - her own list, the business list, the owner number, then the linked
 * phone - and three of them were typed in by hand. Every alert confusion of
 * the last month came out of that chain, so the three typed rungs are gone and
 * these tests exist to keep them gone.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createNotifier, explainRecipients } = require('../src/notify/owner');

const LINKED = '41781112233';

function client() {
  const sent = [];
  return {
    sent,
    getStatus: () => ({ status: 'connected', me: { id: `${LINKED}:17@s.whatsapp.net` } }),
    isConnected: () => true,
    sendText: async (jid, text) => { sent.push({ jid, text }); return {}; },
  };
}

const to = (c) => c.sent.map((m) => m.jid.replace(/@.*/, ''));

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
});

describe('alert recipients', () => {
  test('the connected phone is told, with nothing filled in anywhere', async () => {
    const c = client();
    await createNotifier({ client: c, business: 'pro-sofia' }).owner('x');
    assert.deepStrictEqual(to(c), [LINKED], 'her own phone, because her number is connected on it');
  });

  test('the same holds for the built-in numbers', async () => {
    const c = client();
    await createNotifier({ client: c, business: 'party' }).owner('x');
    assert.deepStrictEqual(to(c), [LINKED]);
  });

  test('an owner number saved long ago cannot take over', async () => {
    // This is the trap the chain used to set: a number typed into the dashboard
    // months earlier quietly beat everything, including the one on Render, and
    // emptying the field it came from changed nothing.
    const c = client();
    await settings.update({ ownerWhatsapp: '41790000003', studioOwnerWhatsapp: '41790000009' });
    await createNotifier({ client: c, business: 'party' }).owner('x');
    await createNotifier({ client: c, business: 'studio' }).owner('y');
    assert.deepStrictEqual(to(c), [LINKED, LINKED]);
  });

  test('an unlinked number sends nothing rather than guessing', async () => {
    const c = client();
    c.getStatus = () => ({ status: 'qr', me: null });
    const res = await createNotifier({ client: c, business: 'pro-sofia' }).owner('x');
    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual(to(c), []);
  });

  test('the dashboard is told which state it is in', () => {
    assert.deepStrictEqual(
      explainRecipients({ self: `${LINKED}:17@s.whatsapp.net`.replace(/\D/g, '').slice(0, 11) }),
      { numbers: [LINKED], source: 'linked', key: null }
    );
    assert.deepStrictEqual(explainRecipients({ self: '' }), { numbers: [], source: 'offline', key: null });
  });

  test('the device suffix never reaches the recipient list', async () => {
    // me.id is "<number>:<device>@s.whatsapp.net". Sending to 41781112233:17
    // reaches nobody and fails silently.
    const c = client();
    await createNotifier({ client: c, business: 'party' }).owner('x');
    assert.strictEqual(c.sent[0].jid, `${LINKED}@s.whatsapp.net`);
  });
});
