'use strict';
/**
 * The bot does not ask for money.
 *
 * Taken from a real conversation. The customer picked a set and was told:
 * "Please complete the payment through this link. The total is CHF 60.–,
 * including a deposit of CHF 50.–. Your booking will be confirmed once the
 * payment is processed."
 *
 * Three things wrong in three sentences. The bot asked for payment, which is
 * not its job - the team checks the request and invoices. It said paying
 * confirms the booking, which is a promise nobody authorised and the one that
 * costs real money when it turns out the set was already gone. And it put the
 * deposit inside the rental price, which is simply wrong arithmetic.
 *
 * The last one had been escaping the existing guard on purpose: sentences with
 * "once" or "sobald" were exempted so that honest caveats ("verbindlich erst
 * nach Pruefung") could be said. "Confirmed once you pay" walked straight
 * through that door.
 *
 * These sentences are stripped rather than blocking the message, because the
 * rest of that reply was correct and useful.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createGuards } = require('../src/agent/guards');

const guards = createGuards({ depositChf: 50, lateFeeChf: 50 });
const send = (text, lang = 'en') => guards.enforce(text, { lang });

describe('the message from that conversation', () => {
  const real = "I've created a booking request for the Gold Ring 2 Meter Hintergrund. "
    + 'Please complete the payment here: https://partydekomiet.ch/products/deko-gold-ring-2-meter. '
    + 'The total is CHF 60.-, which includes the CHF 50.- deposit. '
    + 'Your booking will be confirmed once the payment is processed. '
    + 'Let me know if you need anything else!';

  test('keeps the part that was right', () => {
    assert.match(send(real).text, /created a booking request/);
  });

  test('loses the request to pay', () => {
    assert.ok(!/payment/i.test(send(real).text));
  });

  test('loses the promise that paying confirms it', () => {
    assert.ok(!/confirmed/i.test(send(real).text));
  });

  test('loses the deposit arithmetic', () => {
    assert.ok(!/includes/i.test(send(real).text));
  });

  test('does not hand the whole chat to a human over it', () => {
    assert.strictEqual(send(real).blocked, false, 'the rest of the message was fine');
  });

  test('says which rules caught it, for the log', () => {
    const codes = send(real).stripped.map((s) => s.code).sort();
    assert.deepStrictEqual(codes, ['CONFIRM_ON_PAYMENT', 'DEPOSIT_INCLUDED', 'PAYMENT_REQUESTED']);
  });
});

describe('the same in German', () => {
  for (const said of [
    'Bitte schliesse die Zahlung ueber diesen Link ab.',
    'Bezahle bitte hier im Shop.',
    'Bitte bezahle den Betrag.',
  ]) {
    test(`"${said}" is removed`, () => {
      assert.ok(!/bezahl|zahlung/i.test(send(said, 'de').text));
    });
  }

  for (const said of [
    'Deine Buchung ist bestaetigt, sobald die Zahlung eingegangen ist.',
    'Sobald du bezahlt hast, ist der Termin fix.',
  ]) {
    test(`"${said}" is removed`, () => {
      assert.ok(!/best(ae|ä)tigt|fix/i.test(send(said, 'de').text));
    });
  }

  test('a stripped message that leaves nothing gets an honest sentence instead', () => {
    const res = send('Bitte schliesse die Zahlung ab.', 'de');
    assert.match(res.text, /Team weitergegeben/);
    assert.strictEqual(res.blocked, false);
  });
});

describe('what must still be allowed', () => {
  test('sending the product link while the customer is choosing', () => {
    const text = 'Hier das Set: https://partydekomiet.ch/products/deko-gold-ring-2-meter - CHF 60.- plus CHF 50.- Kaution.';
    assert.strictEqual(send(text, 'de').text, text, 'that is the catalogue, not a demand for money');
  });

  test('saying the deposit is charged on top', () => {
    const text = 'Die Miete ist CHF 60.-, dazu kommt eine Kaution von CHF 50.-.';
    assert.strictEqual(send(text, 'de').text, text);
  });

  test('the honest caveat about what is binding', () => {
    const text = 'Das ist noch keine Bestaetigung - verbindlich wird es erst nach Pruefung durch das Team.';
    assert.strictEqual(send(text, 'de').text, text);
  });

  test('passing the request on', () => {
    const text = 'Ich habe die Anfrage ans Team weitergegeben - sie melden sich bei dir.';
    assert.strictEqual(send(text, 'de').text, text);
  });

  test('an ordinary answer is untouched', () => {
    const text = 'Ja, das Set ist fuer den 1. Dezember frei. Abholung waere am 30. November.';
    assert.strictEqual(send(text, 'de').text, text);
  });
});
