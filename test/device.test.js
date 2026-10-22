'use strict';
/**
 * Pairing by phone number failed on every number tried, on both accounts, with
 * "check the phone number is correct on your device" - while the QR worked
 * fine. The number was never the problem: we were sending a made-up platform
 * name ('PartyDekoMiet') in the browser triple, and WhatsApp's pairing-code
 * endpoint checks that slot against known operating systems. QR login does not.
 *
 * These tests pin the platform to a real OS name and keep the business name in
 * the slot the owner actually reads, so the fix cannot be undone by someone
 * putting the brand back in the first position.
 *
 * Baileys is never required here, so this runs with no node_modules.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  browserTriple, deviceLabel, KNOWN_PLATFORMS, KNOWN_BROWSERS, DEFAULT_PLATFORM, PAIRING_BROWSER,
} = require('../src/whatsapp/device');

describe('the platform slot', () => {
  test('is a real OS name for both businesses - this is the whole bug', () => {
    for (const business of ['party', 'studio']) {
      const [platform] = browserTriple({ business, env: {} });
      assert.ok(
        KNOWN_PLATFORMS.includes(platform),
        `${business} sends "${platform}", which pairing-code login rejects`
      );
    }
  });

  test('is never the business name', () => {
    for (const business of ['party', 'studio']) {
      const [platform, name] = browserTriple({ business, env: {} });
      assert.notStrictEqual(platform, name);
      assert.ok(!/partydekomiet|studio/i.test(platform), `"${platform}" is a brand, not an OS`);
    }
  });

  test('a recognised override is used, case-insensitively', () => {
    assert.strictEqual(browserTriple({ env: { WHATSAPP_PLATFORM: 'macos' } })[0], 'macOS');
    assert.strictEqual(browserTriple({ env: { WHATSAPP_PLATFORM: 'Windows' } })[0], 'Windows');
  });

  test('an unrecognised override is ignored, not passed through', () => {
    // Letting this through would reintroduce the bug by configuration.
    for (const bad of ['MyBot', '', '   ', 'Ubuntu Linux']) {
      assert.strictEqual(browserTriple({ env: { WHATSAPP_PLATFORM: bad } })[0], DEFAULT_PLATFORM);
    }
  });
});

describe('what the owner sees under Linked devices', () => {
  test('each business is named on a QR link, so two numbers can be told apart', () => {
    assert.strictEqual(deviceLabel(browserTriple({ business: 'party', env: {} })), 'PartyDekoMiet (Ubuntu)');
    assert.strictEqual(deviceLabel(browserTriple({ business: 'studio', env: {} })), 'Studio (Ubuntu)');
  });

  test('the name is overridable per business without touching the platform', () => {
    const triple = browserTriple({ business: 'studio', env: { STUDIO_DEVICE_NAME: 'Wellness Zuerich' } });
    assert.strictEqual(deviceLabel(triple), 'Wellness Zuerich (Ubuntu)');
    assert.strictEqual(triple[0], DEFAULT_PLATFORM);
  });

  test('an unknown business falls back to a name rather than undefined', () => {
    assert.strictEqual(browserTriple({ business: 'nope', env: {} })[1], 'PartyDekoMiet');
  });

  test('always three strings - Baileys takes a fixed triple', () => {
    const triple = browserTriple({ env: {} });
    assert.strictEqual(triple.length, 3);
    for (const part of triple) assert.strictEqual(typeof part, 'string');
    assert.ok(triple.every((p) => p.length));
  });
});


describe('pairing mode: the browser name decides whether the phone accepts it', () => {
  // Baileys turns the BROWSER name into a numeric companion platform id for the
  // pairing request. An unrecognised name becomes OTHER_WEB_CLIENT and the phone
  // refuses the link - on every number, which is exactly what was happening.
  test('pairing never sends the business name as the browser', () => {
    for (const business of ['party', 'studio']) {
      const [, browser] = browserTriple({ business, mode: 'pairing', env: {} });
      assert.ok(
        KNOWN_BROWSERS.includes(browser),
        `pairing sends "${browser}", which maps to OTHER_WEB_CLIENT and is rejected`
      );
      assert.ok(!/partydekomiet|studio/i.test(browser));
    }
  });

  test('pairing defaults to Chrome, and the platform is still a real OS', () => {
    const triple = browserTriple({ mode: 'pairing', env: {} });
    assert.deepStrictEqual(triple, ['Ubuntu', PAIRING_BROWSER, '22.04.4']);
  });

  test('a per-business name override cannot leak into the pairing browser', () => {
    const env = { STUDIO_DEVICE_NAME: 'Wellness Zuerich' };
    assert.strictEqual(browserTriple({ business: 'studio', mode: 'pairing', env })[1], PAIRING_BROWSER);
    // ...but it still names the device on the QR link the owner keeps.
    assert.strictEqual(browserTriple({ business: 'studio', mode: 'qr', env })[1], 'Wellness Zuerich');
  });

  test('an unrecognised pairing-browser override is ignored', () => {
    for (const bad of ['Studio', 'MyBot', '', 'Chromium']) {
      assert.strictEqual(browserTriple({ mode: 'pairing', env: { WHATSAPP_PAIRING_BROWSER: bad } })[1], PAIRING_BROWSER);
    }
  });

  test('a recognised one is honoured, case-insensitively', () => {
    assert.strictEqual(browserTriple({ mode: 'pairing', env: { WHATSAPP_PAIRING_BROWSER: 'safari' } })[1], 'Safari');
  });

  test('qr mode is the default, so nothing silently links as Chrome', () => {
    assert.strictEqual(browserTriple({ business: 'studio', env: {} })[1], 'Studio');
  });
});
