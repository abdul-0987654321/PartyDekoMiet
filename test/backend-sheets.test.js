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

describe('redirects are followed by hand, keeping the POST a POST', () => {
  // The live outage: `redirect: 'follow'` turns a 302 into a GET with no body
  // (fetch spec), so when Google redirected one /exec URL to another, the GET
  // ran doGet() instead of doPost(). The script answered 200 ok:true with no
  // data and nothing in the response said a redirect had happened at all.
  const EXEC = 'https://script.example/exec';
  const OTHER_EXEC = 'https://script.google.com/macros/s/REAL/exec';
  const ECHO = 'https://script.googleusercontent.com/macros/echo?user_content_key=k';
  const DATA = { ok: true, data: { customers: [], bookings: [] } };

  /** Walks a scripted list of replies and records every request made. */
  function scriptFetch(steps) {
    const calls = [];
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
      const step = steps[calls.length - 1];
      assert.ok(step, `unexpected request #${calls.length} to ${url}`);
      if (step.to) {
        return {
          status: step.status || 302,
          headers: { get: (h) => (h.toLowerCase() === 'location' ? step.to : null) },
          text: async () => '',
        };
      }
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(step.body) };
    };
    return calls;
  }

  const sheets = () => createSheetsBackend({ url: EXEC, secret: 's' });

  test('a redirect to another /exec URL is re-POSTed with the body intact', async () => {
    const calls = scriptFetch([{ to: OTHER_EXEC }, { body: DATA }]);
    await sheets().load(TABLES);

    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1].url, OTHER_EXEC);
    assert.strictEqual(calls[1].method, 'POST', 'a GET here runs doGet() - this was the outage');
    assert.deepStrictEqual(JSON.parse(calls[1].body), {
      secret: 's',
      action: 'load',
      tables: TABLES,
    });
  });

  test('the echo redirect is fetched with GET - the POST already ran', async () => {
    const calls = scriptFetch([{ to: ECHO }, { body: DATA }]);
    await sheets().load(TABLES);

    assert.strictEqual(calls[1].url, ECHO);
    assert.strictEqual(calls[1].method, 'GET');
    assert.strictEqual(calls[1].body, undefined);
  });

  test('the canonical URL is remembered, so the detour is paid once', async () => {
    const calls = scriptFetch([{ to: OTHER_EXEC }, { body: DATA }, { body: DATA }]);
    const backend = sheets();
    await backend.load(TABLES);
    await backend.load(TABLES);

    assert.strictEqual(calls.length, 3, 'the second load must not redirect again');
    assert.strictEqual(calls[2].url, OTHER_EXEC);
    assert.strictEqual(calls[2].method, 'POST');
  });

  test('a redirect loop is cut off, and not retried - it cannot heal', async () => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return {
        status: 302,
        headers: { get: (h) => (h.toLowerCase() === 'location' ? OTHER_EXEC : null) },
        text: async () => '',
      };
    };
    await assert.rejects(() => sheets().load(TABLES), /redirected more than/);
    assert.ok(requests <= 6, `should stop at the hop cap, made ${requests} requests`);
  });

  test('a redirect with no Location is reported, not silently swallowed', async () => {
    globalThis.fetch = async () => ({ status: 302, headers: { get: () => null }, text: async () => '' });
    await assert.rejects(() => sheets().load(TABLES), /without a Location header/);
  });

  test('a normal 200 still goes straight through', async () => {
    const calls = scriptFetch([{ body: DATA }]);
    await sheets().load(TABLES);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'POST');
  });
});

describe('backend construction', () => {
  test('missing config fails immediately with a named variable', () => {
    assert.throws(() => createSheetsBackend({ secret: 's' }), /SHEET_WEBHOOK_URL/);
    assert.throws(() => createSheetsBackend({ url: 'u' }), /SHEET_SECRET/);
  });
});
