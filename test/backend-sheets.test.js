'use strict';
/**
 * The Studio launch hit this on the live deploy: boot looped on
 *   "Google Sheet not reachable: Cannot convert undefined or null to object"
 * which names neither the real cause nor the fix. The cause was an Apps Script
 * deployment older than the app - Code.gs is NOT updated by deploying this repo,
 * it has to be pasted into the Apps Script editor by hand - so 'load' answered
 * ok:true with no data, and Object.entries(undefined) blew up three frames later.
 *
 * These tests pin the backend to failing loudly and accurately instead.
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { createSheetsBackend } = require('../src/store/backend-sheets');

const TABLES = ['customers', 'bookings'];
const realFetch = globalThis.fetch;

/** Replies to every Apps Script POST with the given object. */
function stubFetch(body) {
  globalThis.fetch = async () => ({ status: 200, text: async () => JSON.stringify(body) });
}

const backend = () => createSheetsBackend({ url: 'https://script.example/exec', secret: 's' });

beforeEach(() => stubFetch({ ok: true, data: {} }));
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('load() response validation', () => {
  test('a well-formed answer passes straight through', async () => {
    stubFetch({ ok: true, data: { customers: [{ jid: 'a' }], bookings: [] } });
    const data = await backend().load(TABLES);
    assert.deepStrictEqual(data.customers, [{ jid: 'a' }]);
    assert.deepStrictEqual(data.bookings, []);
  });

  test('ok:true with no data names the cause and the fix', async () => {
    stubFetch({ ok: true });
    await assert.rejects(() => backend().load(TABLES), (err) => {
      assert.match(err.message, /without a "data" object/);
      assert.match(err.message, /Apps Script/, 'must point at the Apps Script, not the network');
      assert.match(err.message, /paste/i, 'must say how to fix it');
      assert.doesNotMatch(err.message, /Cannot convert undefined/);
      return true;
    });
  });

  test('the doGet reply is called out as a URL problem, not a stale Code.gs', async () => {
    // Seen live: the POST landed on doGet(), so the answer was ok:true with no
    // data. Telling the owner to re-paste Code.gs there sends them to fix the
    // one thing that is not broken.
    stubFetch({ ok: true, service: 'partydekomiet-bot-storage' });
    await assert.rejects(() => backend().load(TABLES), (err) => {
      assert.match(err.message, /doGet/, 'must name what actually answered');
      assert.match(err.message, /SHEET_WEBHOOK_URL/, 'must name the variable to check');
      assert.match(err.message, /partydekomiet-bot-storage/, 'must echo the real reply');
      assert.doesNotMatch(err.message, /paste the current apps-script/, 'wrong fix for this cause');
      return true;
    });
  });

  test('a table missing from the answer is named', async () => {
    stubFetch({ ok: true, data: { customers: [] } });
    await assert.rejects(() => backend().load(TABLES), (err) => {
      assert.match(err.message, /no rows for: bookings/);
      return true;
    });
  });

  test('data of the wrong shape is rejected, not passed on', async () => {
    for (const bad of [null, 'nope', 42, []]) {
      stubFetch({ ok: true, data: bad });
      await assert.rejects(() => backend().load(TABLES), /data|rows/, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('an Apps Script error is still reported as its own error', async () => {
    stubFetch({ ok: false, error: 'unauthorized' });
    await assert.rejects(() => backend().load(TABLES), /unauthorized/);
  });
});

describe('backend construction', () => {
  test('missing config fails immediately with a named variable', () => {
    assert.throws(() => createSheetsBackend({ secret: 's' }), /SHEET_WEBHOOK_URL/);
    assert.throws(() => createSheetsBackend({ url: 'u' }), /SHEET_SECRET/);
  });
});
