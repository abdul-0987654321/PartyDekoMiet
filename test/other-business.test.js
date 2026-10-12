'use strict';
/**
 * The same WhatsApp number may serve a second business. A question about it
 * must never reach the model: it would be answered with the rental rules,
 * confidently and wrongly, and no guard would fire because no rule is broken.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { matchesOtherBusiness, flatten } = require('../src/whatsapp/router');

const KW = 'hochzeitsplanung, eventplanung, catering';

describe('detecting the other business', () => {
  test('matches a configured keyword', () => {
    assert.ok(matchesOtherBusiness('Macht ihr auch Hochzeitsplanung?', KW));
    assert.ok(matchesOtherBusiness('Ich brauche Catering für 50 Personen', KW));
  });

  test('survives umlauts, case and punctuation', () => {
    assert.ok(matchesOtherBusiness('EVENTPLANUNG?!', KW));
    assert.ok(matchesOtherBusiness('hochzeitsplanung...', KW));
    assert.ok(matchesOtherBusiness('Grüezi, Catering möglich?', KW));
  });

  test('leaves normal rental questions alone', () => {
    for (const msg of [
      'Habt ihr Einhorn Deko?',
      'Wie hoch ist die Kaution?',
      'Wo kann ich abholen?',
      'Liefert ihr auch?',
    ]) {
      assert.strictEqual(matchesOtherBusiness(msg, KW), false, `should not match: ${msg}`);
    }
  });

  test('is off when no keywords are configured', () => {
    assert.strictEqual(matchesOtherBusiness('Hochzeitsplanung?', ''), false);
    assert.strictEqual(matchesOtherBusiness('Hochzeitsplanung?', undefined), false);
  });

  test('ignores keywords too short to be meaningful', () => {
    // a two-letter keyword would match half the dictionary
    assert.strictEqual(matchesOtherBusiness('Ich bin da', 'da, ab'), false);
  });

  test('handles an empty or missing message', () => {
    assert.strictEqual(matchesOtherBusiness('', KW), false);
    assert.strictEqual(matchesOtherBusiness(undefined, KW), false);
  });

  test('flatten folds umlauts the way the matcher needs', () => {
    assert.strictEqual(flatten('Grüezi, Hochzeit!'), 'grueezi hochzeit');
  });
});
