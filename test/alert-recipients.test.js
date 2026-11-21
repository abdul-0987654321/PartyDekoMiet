'use strict';
/**
 * Who an alert actually reaches.
 *
 * The chain is: this number's own alert list, then the business's alert list,
 * then the owner number - and, when every one of those is empty, the phone this
 * number is linked to. That last step is new, and it exists because the
 * alternative is a log line nobody reads: a request came in, nothing was
 * configured, so nobody was told. The phone that scanned the QR is somebody,
 * and for a professional's own number it is her.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createNotifier } = require('../src/notify/owner');

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
  await settings.update({ ownerWhatsapp: '', alertNumbers: '', studioOwnerWhatsapp: '', studioAlertNumbers: '' });
});

describe('alert recipients', () => {
  test("a number's own list wins", async () => {
    const c = client();
    await settings.update({ studioAlertNumbers: '41790000001' });
    await createNotifier({ client: c, business: 'pro-sofia', ownNumbers: () => '41790000002' }).owner('x');
    assert.deepStrictEqual(to(c), ['41790000002']);
  });

  test("falls back to the business's list", async () => {
    const c = client();
    await settings.update({ studioAlertNumbers: '41790000001' });
    await createNotifier({ client: c, business: 'pro-sofia', ownNumbers: () => '' }).owner('x');
    assert.deepStrictEqual(to(c), ['41790000001']);
  });

  test('with nothing configured, the linked phone is told', async () => {
    const c = client();
    await createNotifier({ client: c, business: 'pro-sofia', ownNumbers: () => '' }).owner('x');
    assert.deepStrictEqual(to(c), [LINKED], 'her own phone, without filling anything in');
  });

  test('the same holds for the built-in numbers', async () => {
    const c = client();
    await createNotifier({ client: c, business: 'party' }).owner('x');
    assert.deepStrictEqual(to(c), [LINKED]);
  });

  test('a configured number is never replaced by the linked phone', async () => {
    const c = client();
    await settings.update({ alertNumbers: '41790000003' });
    await createNotifier({ client: c, business: 'party' }).owner('x');
    assert.deepStrictEqual(to(c), ['41790000003']);
  });

  test('an unlinked number still sends nothing rather than guessing', async () => {
    const c = client();
    c.getStatus = () => ({ status: 'qr', me: null });
    const res = await createNotifier({ client: c, business: 'pro-sofia', ownNumbers: () => '' }).owner('x');
    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual(to(c), []);
  });
});
