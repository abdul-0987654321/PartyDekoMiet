'use strict';
/**
 * Which number an alert goes to, and whether the dashboard can say why.
 *
 * The owner emptied every alert field he could find - on this page and in
 * Render - and the alerts kept arriving at a number he had not set. They were
 * coming from OWNER_WHATSAPP, which is a different variable with a different
 * name, is not shown on the settings page, and sits in the middle of a chain of
 * four fallbacks. From where he sat the system was ignoring him.
 *
 * The chain itself is fine and deliberate. What was missing was any way to see
 * it, so these tests pin both the order and the explanation.
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
  await settings.update({
    ownerWhatsapp: '', alertNumbers: '', studioOwnerWhatsapp: '', studioAlertNumbers: '',
  });
});

describe('the order the sources are tried in', () => {
  test("a line's own numbers win", async () => {
    await settings.update({ alertNumbers: '41790000002', ownerWhatsapp: '41790000003' });
    const r = explainRecipients({ business: 'pro-sofia', ownNumbers: () => '41790000001', self: LINKED });
    assert.deepStrictEqual(r.numbers, ['41790000001']);
    assert.strictEqual(r.source, 'line');
  });

  test('then the field on the settings page', async () => {
    await settings.update({ alertNumbers: '41790000002', ownerWhatsapp: '41790000003' });
    const r = explainRecipients({ business: 'party', self: LINKED });
    assert.deepStrictEqual(r.numbers, ['41790000002']);
    assert.strictEqual(r.source, 'settings');
  });

  test('then OWNER_WHATSAPP - the one nothing on the page shows', async () => {
    await settings.update({ ownerWhatsapp: '41790000003' });
    const r = explainRecipients({ business: 'party', self: LINKED });
    assert.deepStrictEqual(r.numbers, ['41790000003']);
    assert.strictEqual(r.source, 'owner');
    assert.strictEqual(r.key, 'ownerWhatsapp', 'the dashboard needs the key to offer to clear it');
  });

  test('and finally the linked phone', () => {
    const r = explainRecipients({ business: 'party', self: LINKED });
    assert.deepStrictEqual(r.numbers, [LINKED]);
    assert.strictEqual(r.source, 'linked');
  });

  test('with nothing anywhere, nobody - and it says so', () => {
    const r = explainRecipients({ business: 'party', self: '' });
    assert.deepStrictEqual(r.numbers, []);
    assert.strictEqual(r.source, 'none');
  });

  test('the Studio reads its own fields, not Party\'s', async () => {
    await settings.update({ alertNumbers: '41790000002', studioOwnerWhatsapp: '41790000009' });
    const r = explainRecipients({ business: 'studio', self: LINKED });
    assert.deepStrictEqual(r.numbers, ['41790000009']);
  });
});

describe('what actually gets sent', () => {
  function client() {
    const sent = [];
    return {
      sent,
      getStatus: () => ({ status: 'connected', me: { id: `${LINKED}:1@s.whatsapp.net` } }),
      isConnected: () => true,
      sendText: async (jid, text) => { sent.push(jid.replace(/@.*/, '')); return {}; },
    };
  }

  test('the explanation and the delivery agree', async () => {
    await settings.update({ ownerWhatsapp: '41790000003' });
    const c = client();
    await createNotifier({ client: c, business: 'party' }).owner('test');

    const explained = explainRecipients({ business: 'party', self: LINKED });
    assert.deepStrictEqual(c.sent, explained.numbers, 'the page must not describe a different reality');
  });

  test('clearing the hidden number moves alerts to the visible field', async () => {
    await settings.update({ ownerWhatsapp: '41790000003', alertNumbers: '41790000002' });
    await settings.reset('ownerWhatsapp');

    const c = client();
    await createNotifier({ client: c, business: 'party' }).owner('test');
    assert.deepStrictEqual(c.sent, ['41790000002']);
  });

  test('a number listed twice is written to once', async () => {
    await settings.update({ alertNumbers: '41790000002, 41 79 000 00 02' });
    const c = client();
    await createNotifier({ client: c, business: 'party' }).owner('test');
    assert.deepStrictEqual(c.sent, ['41790000002']);
  });
});
