'use strict';
/**
 * A customer tapping reply on one of the sets.
 *
 * The bot sends five sets, one message each. On WhatsApp the natural way to
 * pick one is to long-press it and answer "das hier" - which, as plain text,
 * names nothing. The quote was being read for the owner's dictated replies and
 * discarded for customers, so the model received two words with no subject and
 * asked again which theme was meant. From the customer's side that is the bot
 * not reading what they pointed at.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createRouter } = require('../src/whatsapp/router');

const JID = '41791234567@s.whatsapp.net';
const SET = 'KinderGeburtstag deko Super Mario\nCHF 690.- + CHF 50.- Kaution\nhttps://partydekomiet.ch/products/super-mario';

function client() {
  return {
    sent: [],
    getStatus: () => ({ status: 'connected', me: { id: '41780000000:1@s.whatsapp.net' } }),
    isConnected: () => true,
    sendText: async function (jid, text) { this.sent.push({ jid, text }); return {}; },
  };
}

/** A customer message quoting an earlier message from the bot. */
const replyTo = (quoted, text) => ({
  key: { remoteJid: JID, fromMe: false, id: 'q1' },
  message: {
    extendedTextMessage: {
      text,
      contextInfo: { quotedMessage: { conversation: quoted } },
    },
  },
});

let seen, router, c;

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  seen = [];
  c = client();
  router = createRouter({
    client: c,
    agent: { reply: async ({ message }) => { seen.push(message); return { text: 'ok', toolCalls: [] }; } },
    services: {},
    notify: { owner: async () => ({ ok: true }) },
    business: 'party',
  });
  router.init();
});

describe('what the model is given', () => {
  test('includes the message the customer replied to', async () => {
    await router.handle(replyTo(SET, 'das hier bitte'));
    assert.match(seen[0], /Super Mario/, 'otherwise "das hier" names nothing');
    assert.match(seen[0], /das hier bitte/);
  });

  test('works for a one-word answer too', async () => {
    await router.handle(replyTo(SET, 'ja'));
    assert.match(seen[0], /Super Mario/);
  });

  test('an ordinary message is unchanged', async () => {
    await router.handle({
      key: { remoteJid: JID, fromMe: false, id: 'p1' },
      message: { conversation: 'Hallo, habt ihr Ballons?' },
    });
    assert.strictEqual(seen[0], 'Hallo, habt ihr Ballons?', 'nothing added where nothing was quoted');
  });

  test('a very long quote is cut rather than sent whole', async () => {
    await router.handle(replyTo('x'.repeat(2000), 'das'));
    assert.ok(seen[0].length < 600);
  });

  test('the quote is marked as such, not merged into their words', async () => {
    await router.handle(replyTo(SET, 'das hier'));
    // The model must not read the quoted set as something the customer typed.
    assert.match(seen[0], /\[Der Kunde antwortet auf diese Nachricht von dir:/);
  });
});
