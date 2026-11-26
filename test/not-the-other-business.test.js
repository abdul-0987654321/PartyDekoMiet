'use strict';
/**
 * Sending a customer away by mistake.
 *
 * "I need boling for birthday party on 16 December" - a typo for booking, and
 * exactly what this bot is for - was answered with "I only handle party
 * decoration here, I'll pass your question to the team". The keywords that
 * deflect to the other business were matched as substrings, so one of them was
 * sitting inside "boling". The customer was told he was in the wrong chat while
 * asking for the one thing on sale.
 *
 * Whole words only now. And the matched keyword is returned rather than a bare
 * true, so the log can say which word did it - the field is hidden on most
 * dashboards and there was no way to find out otherwise.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { matchesOtherBusiness } = require('../src/whatsapp/router');

const KEYWORDS = 'massage, nails, wimpern, kosmetik, termin beim studio, oli';

describe('a customer in the right chat stays there', () => {
  for (const said of [
    'I need boling for birthday party on 16 December',
    'I need booking for birthday',
    'Habt ihr Ballons fuer Samstag?',
    'Brauche Deko fuer den 10. Dezember',
    'Ich haette gern das Einhorn Set',
  ]) {
    test(`"${said.slice(0, 44)}" is not deflected`, () => {
      assert.strictEqual(matchesOtherBusiness(said, KEYWORDS), false);
    });
  }
});

describe('a customer in the wrong chat is still deflected', () => {
  for (const [said, expected] of [
    ['Ich haette gern eine Massage', 'massage'],
    ['massage bitte', 'massage'],
    ['Macht ihr auch Nails?', 'nails'],
    ['Ich moechte einen Termin beim Studio', 'termin beim studio'],
  ]) {
    test(`"${said.slice(0, 44)}" matches ${expected}`, () => {
      assert.strictEqual(matchesOtherBusiness(said, KEYWORDS), expected);
    });
  }

  test('the matched word is returned, so the log can say why', () => {
    assert.strictEqual(typeof matchesOtherBusiness('Massage bitte', KEYWORDS), 'string');
  });
});

describe('an empty keyword list deflects nobody', () => {
  for (const kw of ['', '   ', ',,,', 'a, b, cc']) {
    test(`${JSON.stringify(kw)} matches nothing`, () => {
      assert.strictEqual(matchesOtherBusiness('Ich haette gern eine Massage', kw), false);
    });
  }
});

describe('punctuation and case do not hide a word', () => {
  for (const said of ['MASSAGE!', 'massage?', '(massage)', 'Massage.']) {
    test(`"${said}" still matches`, () => {
      assert.strictEqual(matchesOtherBusiness(said, KEYWORDS), 'massage');
    });
  }
});
