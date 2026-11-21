'use strict';
/**
 * One person writing to several numbers, one shared chat table.
 *
 * customers-separation.test.js covers the customer records. This covers the
 * conversation itself, which was the half that leaked: recentHistory() filtered
 * on the jid alone, so every number's rows for that person came back. The model
 * on Mia's line was handed what the customer had written to Sofia - and from the
 * customer's side that reads as the two women talking about him to each other.
 *
 * Party and Studio had the same leak, since they share the table too.
 *
 * These tests are the guarantee. If the business filter is ever dropped again,
 * they fail.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createRouter } = require('../src/whatsapp/router');

const JID = '41791234567@s.whatsapp.net';

/** A WhatsApp client that records what was sent and nothing else. */
function fakeClient() {
  const sent = [];
  return {
    sent,
    getStatus: () => ({ status: 'connected', me: { id: '41780000000:1@s.whatsapp.net' } }),
    isConnected: () => true,
    sendText: async (jid, text) => {
      sent.push({ jid, text });
      return {};
    },
  };
}

/** Remembers the history each reply was built from. */
function recordingAgent() {
  const calls = [];
  return {
    calls,
    reply: async ({ history, message }) => {
      calls.push({ history: history.map((h) => h.content), message });
      return { text: 'ok', toolCalls: [] };
    },
  };
}

const incoming = (text, id) => ({
  key: { remoteJid: JID, fromMe: false, id },
  message: { conversation: text },
});

function routerFor(business, agent) {
  const router = createRouter({
    client: fakeClient(),
    agent,
    services: {},
    notify: { owner: async () => ({ ok: true }) },
    business,
  });
  router.init();
  return router;
}

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
});

describe('conversation history per number', () => {
  test("one professional's line never sees another's chat", async () => {
    const agent = recordingAgent();
    await routerFor('pro-sofia', agent).handle(incoming('nur fuer Sofia', 'a1'));
    await routerFor('pro-mia', agent).handle(incoming('hallo Mia', 'b1'));

    const miaSaw = agent.calls[1].history.join(' | ');
    assert.ok(!miaSaw.includes('nur fuer Sofia'), "Mia's line must not see Sofia's chat");
    assert.deepStrictEqual(agent.calls[1].history, [], 'a first message has no history on her line');
  });

  test('the Studio never sees what the same person wrote to PartyDekoMiet', async () => {
    const agent = recordingAgent();
    await routerFor('party', agent).handle(incoming('Ballons fuer Samstag', 'a1'));
    await routerFor('studio', agent).handle(incoming('Termin bitte', 'b1'));

    assert.ok(
      !agent.calls[1].history.join(' | ').includes('Ballons'),
      'the Studio must not see the rental conversation'
    );
  });

  test('a line does see its own earlier turns', async () => {
    const agent = recordingAgent();
    const sofia = routerFor('pro-sofia', agent);
    await sofia.handle(incoming('erste Frage', 'a1'));
    await sofia.handle(incoming('zweite Frage', 'a2'));

    assert.deepStrictEqual(agent.calls[1].history, ['erste Frage', 'ok']);
  });

  test('untagged rows written before the business column still belong to Party', async () => {
    db.put('chat', { id: 'old-1', at: '2026-01-01T00:00:00.000Z', jid: JID, direction: 'in', text: 'alte Zeile' });
    const agent = recordingAgent();
    await routerFor('party', agent).handle(incoming('neue Frage', 'a1'));

    assert.ok(agent.calls[0].history.includes('alte Zeile'), 'an untagged row reads as Party');
  });
});
