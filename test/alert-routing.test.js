'use strict';
/**
 * Which number an alert goes to, and whether the dashboard can say so.
 *
 * The owner emptied every alert field he could find - on the settings page and
 * in Render - and the alerts kept arriving at a number he had not set. They
 * were coming from OWNER_WHATSAPP, a different variable with a different name,
 * shown nowhere, sitting in the middle of a chain of four fallbacks. From
 * where he sat the system was ignoring him.
 *
 * The chain is gone. Alerts go to the phone the number is connected on, and
 * these tests pin that no saved value can take it over again.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { explainRecipients, createNotifier } = require('../src/notify/owner');

const LINKED = '41781112233';

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
});

describe('where an alert goes', () => {
  test('the connected phone, and the page says exactly that', () => {
    const r = explainRecipients({ self: LINKED });
    assert.deepStrictEqual(r.numbers, [LINKED]);
    assert.strictEqual(r.source, 'linked');
    assert.strictEqual(r.key, null, 'there is no setting to offer to clear');
  });

  test('not connected means nobody, and it says so', () => {
    const r = explainRecipients({ self: '' });
    assert.deepStrictEqual(r.numbers, []);
    assert.strictEqual(r.source, 'offline');
  });

  test('no saved number can take over, on either side', async () => {
    await settings.update({
      ownerWhatsapp: '41790000003',
      studioOwnerWhatsapp: '41790000009',
    });
    assert.deepStrictEqual(explainRecipients({ self: LINKED }).numbers, [LINKED]);
  });

  test('the same number twice is written to once', () => {
    assert.deepStrictEqual(
      explainRecipients({ self: `${LINKED}, 41 78 111 22 33` }).numbers,
      [LINKED]
    );
  });
});

describe('what actually gets sent', () => {
  function client() {
    const sent = [];
    return {
      sent,
      getStatus: () => ({ status: 'connected', me: { id: `${LINKED}:1@s.whatsapp.net` } }),
      isConnected: () => true,
      sendText: async (jid) => { sent.push(jid.replace(/@.*/, '')); return {}; },
    };
  }

  test('the explanation and the delivery agree', async () => {
    await settings.update({ ownerWhatsapp: '41790000003' });
    const c = client();
    await createNotifier({ client: c, business: 'party' }).owner('test');
    assert.deepStrictEqual(
      c.sent,
      explainRecipients({ self: LINKED }).numbers,
      'the page must not describe a different reality'
    );
  });

  test('both built-in numbers and a professional line behave alike', async () => {
    for (const business of ['party', 'studio', 'pro-sofia']) {
      const c = client();
      await createNotifier({ client: c, business }).owner('test');
      assert.deepStrictEqual(c.sent, [LINKED], business);
    }
  });
});

describe('the same alert twice in a minute', () => {
  function client() {
    const sent = [];
    return {
      sent,
      getStatus: () => ({ status: 'connected', me: { id: `${LINKED}:1@s.whatsapp.net` } }),
      isConnected: () => true,
      sendText: async (jid, text) => { sent.push(text); return {}; },
    };
  }

  // A customer writing two awkward messages in a row produced two identical
  // "somebody needs you" alerts. Two buzzes for one situation is how people
  // start ignoring the buzz.
  test('only goes out once', async () => {
    const c = client();
    const notify = createNotifier({ client: c, business: 'studio' });

    await notify.owner('Ein Kunde braucht jemanden.', { kind: 'handoff', jid: '4179@s.whatsapp.net' });
    await notify.owner('Ein Kunde braucht jemanden.', { kind: 'handoff', jid: '4179@s.whatsapp.net' });

    assert.strictEqual(c.sent.length, 1);
  });

  test('a different customer still gets through', async () => {
    const c = client();
    const notify = createNotifier({ client: c, business: 'studio' });

    await notify.owner('x', { kind: 'handoff', jid: '4179@s.whatsapp.net' });
    await notify.owner('y', { kind: 'handoff', jid: '4176@s.whatsapp.net' });

    assert.strictEqual(c.sent.length, 2, 'two people waiting is two things to know about');
  });

  test('a different kind of alert about the same chat still gets through', async () => {
    const c = client();
    const notify = createNotifier({ client: c, business: 'studio' });

    await notify.owner('x', { kind: 'handoff', jid: '4179@s.whatsapp.net' });
    await notify.owner('y', { kind: 'appointment_request', jid: '4179@s.whatsapp.net' });

    assert.strictEqual(c.sent.length, 2);
  });

  test('an alert with no chat behind it is never suppressed', async () => {
    const c = client();
    const notify = createNotifier({ client: c, business: 'party' });

    await notify.owner('Speicher voll', { kind: 'storage_error' });
    await notify.owner('Speicher voll', { kind: 'storage_error' });

    assert.strictEqual(c.sent.length, 2, 'a system fault is not a chat and must not be swallowed');
  });
});
