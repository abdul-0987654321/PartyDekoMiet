'use strict';
/**
 * The router's `business` param (default 'party'): Party's behaviour must be
 * completely unchanged, and a second, Studio router instance must not collide
 * with Party's pause state, chat tags, or owner-number/calendar settings even
 * though both write into the same shared `state`/`chat` tables.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createRouter } = require('../src/whatsapp/router');

const JID = '41790000888@s.whatsapp.net';
const incoming = (text) => ({
  key: { remoteJid: JID, fromMe: false, id: 'm' + Math.random() },
  message: { conversation: text },
});

let sent, alerts;
const client = {
  sendText: async (jid, text) => sent.push({ jid, text }),
  getStatus: () => ({ status: 'connected' }),
};
const notify = { owner: async (text, meta) => alerts.push({ text, meta }) };
const agent = { reply: async () => ({ text: 'ok', toolCalls: [], handoff: false, blocked: false }) };

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  await settings.update({
    ownerWhatsapp: '41791111111', botEnabled: true,
    studioOwnerWhatsapp: '41799999999', studioCalendarId: 'studio-cal@group.calendar.google.com',
  });
  sent = [];
  alerts = [];
});

describe('defaulting business leaves Party unchanged', () => {
  test('chat rows are tagged business: "party"', async () => {
    const r = createRouter({ client, agent, services: {}, notify });
    r.init();
    await r.handle(incoming('hallo'));
    const rows = db.all('chat').filter((m) => m.jid === JID);
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((row) => row.business === 'party'));
  });

  test('isOwner still reads the plain ownerWhatsapp setting', async () => {
    const r = createRouter({ client, agent, services: {}, notify });
    r.init();
    const ownerMsg = { key: { remoteJid: '41791111111@s.whatsapp.net', fromMe: false, id: 'o1' }, message: { conversation: '/status' } };
    await r.handle(ownerMsg);
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].text, /Bot: AN/);
  });
});

describe('a Studio router instance', () => {
  test('tags its chat rows business: "studio"', async () => {
    const r = createRouter({ client, agent, services: {}, notify, business: 'studio' });
    r.init();
    await r.handle(incoming('hallo'));
    const rows = db.all('chat').filter((m) => m.jid === JID);
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((row) => row.business === 'studio'));
  });

  test('isOwner reads studioOwnerWhatsapp, not the Party owner number', async () => {
    const r = createRouter({ client, agent, services: {}, notify, business: 'studio' });
    r.init();
    // Party's owner number must NOT be treated as the Studio owner.
    await r.handle({ key: { remoteJid: '41791111111@s.whatsapp.net', fromMe: false, id: 'p1' }, message: { conversation: 'hi' } });
    assert.strictEqual(sent.length, 1, 'answered as a normal customer, not routed to owner commands');

    sent = [];
    // The Studio owner number IS recognised.
    await r.handle({ key: { remoteJid: '41799999999@s.whatsapp.net', fromMe: false, id: 'p2' }, message: { conversation: '/status' } });
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].text, /Kalender: eingerichtet/, 'must read studioCalendarId, not the Party calendarId');
  });

  test('pause state does not collide with a Party router on the same chat table', async () => {
    const party = createRouter({ client, agent, services: {}, notify, business: 'party' });
    const studio = createRouter({ client, agent, services: {}, notify, business: 'studio' });
    party.init();
    studio.init();

    party.pause(JID, 12, 'test');
    assert.strictEqual(party.isPaused(JID), true);
    assert.strictEqual(studio.isPaused(JID), false, 'Studio must not see Party\'s pause state');
  });
});
