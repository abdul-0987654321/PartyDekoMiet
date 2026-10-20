'use strict';
/**
 * Studio guards: the bot must stay a receptionist, bound to the official
 * price list. This is the code-level enforcement behind what the client
 * agreed to in the Fiverr chat - a prompt alone was rejected on purpose
 * because a persistent customer can talk a prompt around.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createStudioGuards } = require('../src/agent/guards-studio');

const guards = createStudioGuards({ allowedPrices: [250, 350, 150, 120] });
const codes = (text) => guards.check(text).map((v) => v.code);

describe('the bot must never speak as the professional herself', () => {
  test('blocks first-person age/origin claims', () => {
    assert.ok(codes('Ich bin Gabriela, ich bin 28 Jahre alt.').includes('SPEAKS_AS_PROFESSIONAL'));
    assert.ok(codes("Hi, I'm Sofia, I am 26 years old.").includes('SPEAKS_AS_PROFESSIONAL'));
  });

  test('blocks the bot claiming it personally does not speak German', () => {
    assert.ok(codes('Ich spreche leider kein Deutsch, ich nutze einen Uebersetzer.').includes('SPEAKS_AS_PROFESSIONAL'));
  });

  test('allows the receptionist describing her in the third person', () => {
    assert.deepStrictEqual(codes('Gabriela ist 28 und spricht Portugiesisch und Deutsch.'), []);
    assert.deepStrictEqual(codes('Sofia spricht leider kein Deutsch, ich schreibe fuer sie.'), []);
  });
});

describe('the bot must never offer or negotiate sexual extras', () => {
  test('blocks offering intimate options / extras', () => {
    assert.ok(codes('Ja, intime Optionen bieten wir auch an.').includes('SEXUAL_EXTRA_OFFERED'));
    assert.ok(codes('Yes, we offer special requests too.').includes('SEXUAL_EXTRA_OFFERED'));
  });

  test('blocks explicit terms outright', () => {
    assert.ok(codes('Ein Happy Ending ist moeglich.').includes('SEXUAL_EXTRA_OFFERED'));
  });

  test('allows a clear decline', () => {
    assert.deepStrictEqual(codes('Sonderwuensche bieten wir nicht an, nur die Services aus der Liste.'), []);
  });
});

describe('prices must come from the active service list', () => {
  test('an allowed price passes', () => {
    assert.deepStrictEqual(codes('Die Ganzkoerpermassage kostet CHF 250.-'), []);
  });

  test('a price not on the list is flagged', () => {
    assert.ok(codes('Das kostet CHF 80 extra.').includes('INVENTED_PRICE'));
  });
});

describe('appointments are never presented as confirmed up front', () => {
  test('blocks an unconditional confirmation', () => {
    assert.ok(codes('Dein Termin ist bestaetigt.').includes('CONFIRMED_APPOINTMENT'));
    assert.ok(codes('Your appointment is confirmed.').includes('CONFIRMED_APPOINTMENT'));
  });

  test('allows saying the time looks free and was passed on', () => {
    assert.deepStrictEqual(codes('Die Zeit sieht frei aus, ich habe die Anfrage ans Team weitergegeben.'), []);
  });
});

describe('enforce(): a violation is replaced, never sent as-is', () => {
  test('blocked text comes back as the neutral fallback', () => {
    const res = guards.enforce('Ich bin Gabriela, 28 Jahre alt.', { lang: 'de' });
    assert.strictEqual(res.blocked, true);
    assert.ok(!/Gabriela/.test(res.text));
  });

  test('clean text passes through unchanged (besides autofix)', () => {
    const res = guards.enforce('Gabriela ist heute ab 14 Uhr frei.', { lang: 'de' });
    assert.strictEqual(res.blocked, false);
    assert.strictEqual(res.text, 'Gabriela ist heute ab 14 Uhr frei.');
  });

  test('the client\'s own whitelisted FAQ wording is never flagged', () => {
    const g2 = createStudioGuards({
      faqAnswers: ['Ein Termin ist bestaetigt, sobald das Team ihn bestaetigt hat.'],
      allowedPrices: [],
    });
    assert.deepStrictEqual(g2.check('Ein Termin ist bestaetigt, sobald das Team ihn bestaetigt hat.'), []);
  });
});
