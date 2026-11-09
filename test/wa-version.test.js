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
  isOlderThan,
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

describe('the version must never go backwards', () => {
  // Live, 8 Nov: web.whatsapp.com served 2.3000.1041589577 after serving
  // 2.3000.1053619311 for hours - twelve million builds backwards. WhatsApp
  // then rejected its own stale answer with 405 on every attempt. Both numbers
  // went down and the reconnect cap stopped them until someone clicked Connect.
  const WORKING = [2, 3000, 1053619311];
  const STALE_LIVE = [2, 3000, 1041589577];

  test('an older live answer is refused in favour of what actually connected', async () => {
    const res = await resolveWaVersion({
      fetchWaWeb: ok(STALE_LIVE),
      knownGood: WORKING,
      env: {},
    });
    assert.deepStrictEqual(res.version, WORKING);
    assert.strictEqual(res.source, 'known-good');
  });

  test('a newer live answer is still accepted', async () => {
    const newer = [2, 3000, 1060000000];
    const res = await resolveWaVersion({ fetchWaWeb: ok(newer), knownGood: WORKING, env: {} });
    assert.deepStrictEqual(res.version, newer);
    assert.strictEqual(res.source, 'wa-web');
  });

  test('the same version is not treated as backwards', async () => {
    const res = await resolveWaVersion({ fetchWaWeb: ok([...WORKING]), knownGood: WORKING, env: {} });
    assert.strictEqual(res.source, 'wa-web');
  });

  test('a stale Baileys list answer is refused too', async () => {
    const res = await resolveWaVersion({
      fetchWaWeb: boom('offline'),
      fetchBaileys: ok(STALE_LIVE),
      knownGood: WORKING,
      env: {},
    });
    assert.deepStrictEqual(res.version, WORKING);
    assert.strictEqual(res.source, 'known-good');
  });

  test('with both lookups down, a proven version beats the compiled-in constant', async () => {
    const res = await resolveWaVersion({
      fetchWaWeb: boom('offline'),
      fetchBaileys: boom('offline'),
      knownGood: WORKING,
      env: {},
    });
    assert.deepStrictEqual(res.version, WORKING);
  });

  test('a hand-set WHATSAPP_VERSION still wins - that is how you roll back on purpose', async () => {
    const res = await resolveWaVersion({
      knownGood: WORKING,
      env: { WHATSAPP_VERSION: '2.3000.1041589577' },
    });
    assert.deepStrictEqual(res.version, STALE_LIVE);
    assert.strictEqual(res.source, 'env');
  });

  test('nothing changes when no version has connected yet', async () => {
    const res = await resolveWaVersion({ fetchWaWeb: ok(STALE_LIVE), env: {} });
    assert.deepStrictEqual(res.version, STALE_LIVE);
    assert.strictEqual(res.source, 'wa-web');
  });

  test('a corrupt stored value is ignored rather than blocking every version', async () => {
    for (const junk of [null, 'nope', [2, 3000], undefined]) {
      const res = await resolveWaVersion({ fetchWaWeb: ok(STALE_LIVE), knownGood: junk, env: {} });
      assert.strictEqual(res.source, 'wa-web', `knownGood ${JSON.stringify(junk)} must not block`);
    }
  });

  test('the caller cannot mutate the stored known-good array', async () => {
    const stored = [...WORKING];
    const res = await resolveWaVersion({ fetchWaWeb: ok(STALE_LIVE), knownGood: stored, env: {} });
    res.version[2] = 1;
    assert.deepStrictEqual(stored, WORKING);
  });
});

describe('isOlderThan', () => {
  test('compares part by part, not as one number', () => {
    assert.ok(isOlderThan([2, 3000, 1041589577], [2, 3000, 1053619311]));
    assert.ok(!isOlderThan([2, 3000, 1053619311], [2, 3000, 1041589577]));
    assert.ok(isOlderThan([2, 2999, 9999999999], [2, 3000, 1]));
    assert.ok(!isOlderThan([2, 3000, 5], [2, 3000, 5]));
  });

  test('anything malformed is never "older", so it cannot trigger a refusal', () => {
    assert.ok(!isOlderThan(null, [2, 3000, 1]));
    assert.ok(!isOlderThan([2, 3000, 1], null));
    assert.ok(!isOlderThan('2.3000.1', [2, 3000, 2]));
  });
});
