'use strict';
/**
 * The 405 that stopped both numbers logging in: WhatsApp rejects a stale
 * protocol version before it ever issues a QR code. These tests pin down the
 * lookup order that gets past it - live web.whatsapp.com build first, the
 * Baileys hardcoded list second, a constant only as a last resort.
 *
 * Baileys itself is never required here, so this runs with no node_modules.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  resolveWaVersion,
  parseVersionEnv,
  isValidVersion,
  PINNED_FALLBACK,
} = require('../src/whatsapp/wa-version');

const LIVE = [2, 3000, 1044015310];
const STALE = [2, 3000, 1035194821]; // the build the bug reports call broken
const ok = (version, extra = {}) => async () => ({ version, isLatest: true, ...extra });
const boom = (msg) => async () => {
  throw new Error(msg);
};

describe('version shape', () => {
  test('accepts three whole numbers, rejects anything else', () => {
    assert.ok(isValidVersion([2, 3000, 1044015310]));
    assert.ok(!isValidVersion([2, 3000]));
    assert.ok(!isValidVersion(['2', '3000', '1']));
    assert.ok(!isValidVersion([2, 3000, 1.5]));
    assert.ok(!isValidVersion(null));
    assert.ok(!isValidVersion('2.3000.1'));
  });

  test('the pinned fallback is newer than the version reported broken', () => {
    assert.ok(
      PINNED_FALLBACK[2] > STALE[2],
      `pinned ${PINNED_FALLBACK.join('.')} must be newer than the broken ${STALE.join('.')}`
    );
  });
});

describe('WHATSAPP_VERSION override', () => {
  test('accepts JSON, and the dotted form people paste from logs', () => {
    assert.deepStrictEqual(parseVersionEnv('[2,3000,1044015310]'), LIVE);
    assert.deepStrictEqual(parseVersionEnv('2.3000.1044015310'), LIVE);
  });

  test('ignores junk instead of passing it to WhatsApp', () => {
    for (const raw of ['', null, undefined, 'latest', '{"a":1}', '[2,3000]']) {
      assert.strictEqual(parseVersionEnv(raw), null, `should reject: ${raw}`);
    }
  });

  test('an override wins without any network lookup', async () => {
    let called = false;
    const res = await resolveWaVersion({
      fetchWaWeb: async () => {
        called = true;
        return { version: STALE, isLatest: true };
      },
      env: { WHATSAPP_VERSION: '2.3000.1044015310' },
    });
    assert.deepStrictEqual(res.version, LIVE);
    assert.strictEqual(res.source, 'env');
    assert.ok(!called, 'no lookup should happen when the version is pinned by hand');
  });
});

describe('lookup order', () => {
  test('the live web.whatsapp.com build wins', async () => {
    const res = await resolveWaVersion({
      fetchWaWeb: ok(LIVE),
      fetchBaileys: ok(STALE),
      env: {},
    });
    assert.deepStrictEqual(res.version, LIVE);
    assert.strictEqual(res.source, 'wa-web');
  });

  test('falls back to the Baileys list when the live lookup throws', async () => {
    const res = await resolveWaVersion({
      fetchWaWeb: boom('getaddrinfo ENOTFOUND web.whatsapp.com'),
      fetchBaileys: ok([2, 3000, 1042466098]),
      env: {},
    });
    assert.deepStrictEqual(res.version, [2, 3000, 1042466098]);
    assert.strictEqual(res.source, 'baileys');
  });

  test('isLatest:false is treated as a failure, not an answer', async () => {
    // This is the exact trap: fetchLatestBaileysVersion resolves successfully
    // with the stale bundled version when its own fetch fails.
    const res = await resolveWaVersion({
      fetchWaWeb: boom('offline'),
      fetchBaileys: async () => ({ version: STALE, isLatest: false }),
      env: {},
    });
    assert.deepStrictEqual(res.version, [...PINNED_FALLBACK]);
    assert.strictEqual(res.source, 'pinned');
  });

  test('both lookups down -> the pinned fallback', async () => {
    const res = await resolveWaVersion({
      fetchWaWeb: boom('offline'),
      fetchBaileys: boom('offline'),
      env: {},
    });
    assert.deepStrictEqual(res.version, [...PINNED_FALLBACK]);
    assert.strictEqual(res.source, 'pinned');
  });

  test('an old fork with no fetchLatestWaWebVersion still resolves', async () => {
    const res = await resolveWaVersion({ fetchWaWeb: null, fetchBaileys: ok(LIVE), env: {} });
    assert.deepStrictEqual(res.version, LIVE);
    assert.strictEqual(res.source, 'baileys');
  });

  test('no fetchers at all still returns something usable', async () => {
    const res = await resolveWaVersion({ env: {} });
    assert.ok(isValidVersion(res.version));
    assert.strictEqual(res.source, 'pinned');
  });

  test('a malformed live answer does not poison the result', async () => {
    const res = await resolveWaVersion({
      fetchWaWeb: async () => ({ version: 'nope' }),
      fetchBaileys: ok(LIVE),
      env: {},
    });
    assert.deepStrictEqual(res.version, LIVE);
    assert.strictEqual(res.source, 'baileys');
  });

  test('the caller cannot mutate the shared pinned constant', async () => {
    const res = await resolveWaVersion({ env: {} });
    res.version[2] = 1;
    assert.strictEqual(PINNED_FALLBACK[2], 1044015310);
  });
});
