'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createGuards } = require('../src/agent/guards');
const knowledge = require('../src/knowledge/from-files').load();

const guards = createGuards({
  faqAnswers: knowledge.faq.flatMap((e) => [e.a_de, e.a_en]),
  depositChf: 50,
  lateFeeChf: 50,
});

const codes = (text) => guards.check(text).map((v) => v.code);

describe('guards: the client\'s own answers are never flagged', () => {
  // The most important regression test here. Several official answers contain the
  // very words the patterns look for ("Lieferservice", "Buchung ist verbindlich",
  // "Reparatur- oder Ersatzkosten"). If a guard starts flagging these, it would
  // silence the bot on ordinary questions.
  for (const entry of knowledge.faq) {
    test(`FAQ "${entry.id}" passes clean`, () => {
      assert.deepStrictEqual(codes(entry.a_de), [], `German answer flagged: ${entry.a_de}`);
      assert.deepStrictEqual(codes(entry.a_en), [], `English answer flagged: ${entry.a_en}`);
    });
  }
});

describe('guards: confirmed bookings', () => {
  test('blocks an unconditional confirmation', () => {
    assert.ok(codes('Deine Buchung ist bestaetigt.').includes('CONFIRMED_BOOKING'));
    assert.ok(codes('Ich habe das Einhorn-Set fuer dich reserviert.').includes('CONFIRMED_BOOKING'));
    assert.ok(codes('Your booking is confirmed.').includes('CONFIRMED_BOOKING'));
    assert.ok(codes('Wir haben den Termin fix eingetragen.').includes('CONFIRMED_BOOKING'));
  });

  test('allows the conditional form from the AGB', () => {
    assert.deepStrictEqual(
      codes('Deine Buchung ist verbindlich, sobald wir die Verfuegbarkeit bestaetigt haben und die Zahlung eingegangen ist.'),
      []
    );
  });

  test('allows the correct phrasing after an availability check', () => {
    assert.deepStrictEqual(
      codes('Das Set sieht fuer deine Daten frei aus, ich habe die Anfrage weitergegeben.'),
      []
    );
  });
});

describe('guards: delivery, setup, teardown', () => {
  test('blocks offering delivery', () => {
    assert.ok(codes('Wir liefern die Deko gerne zu dir nach Hause.').includes('DELIVERY_OFFERED'));
    assert.ok(codes('Lieferung ist moeglich, kostet aber extra.').includes('DELIVERY_OFFERED'));
    assert.ok(codes('We can deliver it to the venue.').includes('DELIVERY_OFFERED'));
  });

  test('blocks offering setup at the venue', () => {
    assert.ok(codes('Der Aufbau ist inklusive.').includes('DELIVERY_OFFERED'));
    assert.ok(codes('Wir bauen die Deko bei dir auf.').includes('DELIVERY_OFFERED'));
  });

  test('allows denying delivery', () => {
    assert.deepStrictEqual(codes('Nein, wir bieten keinen Lieferservice an.'), []);
    assert.deepStrictEqual(codes('Wir liefern leider nicht, die Deko wird abgeholt.'), []);
    assert.deepStrictEqual(codes('Aufbau am Veranstaltungsort ist nicht inklusive.'), []);
  });
});

describe('guards: invented damage prices', () => {
  test('blocks a made-up repair price', () => {
    assert.ok(codes('Eine Reparatur kostet etwa CHF 120.').includes('INVENTED_PRICE'));
    assert.ok(codes('Fuer den Ersatz der Blumen verrechnen wir 80 CHF.').includes('INVENTED_PRICE'));
    assert.ok(codes('A replacement costs CHF 200.').includes('INVENTED_PRICE'));
  });

  test('allows the deposit and the late fee', () => {
    assert.deepStrictEqual(codes('Bei Schaden kann die Kaution von CHF 50 verrechnet werden.'), []);
    assert.deepStrictEqual(codes('Eine verspaetete Rueckgabe kostet CHF 50 pro angefangenem Tag.'), []);
  });

  test('allows talking about damage without a price', () => {
    assert.deepStrictEqual(codes('Melde den Schaden bitte direkt, das Team schaut sich das an.'), []);
  });
});

describe('guards: payment details and addresses', () => {
  test('blocks asking for payment credentials', () => {
    assert.ok(codes('Schick mir bitte deine Kartennummer.').includes('PAYMENT_DETAILS'));
    assert.ok(codes('Unsere IBAN lautet CH00 0000.').includes('PAYMENT_DETAILS'));
  });

  test('blocks asking for a delivery address', () => {
    assert.ok(codes('Wie lautet deine Adresse?').includes('ADDRESS_REQUESTED'));
    assert.ok(codes('Wohin sollen wir die Deko bringen?').includes('ADDRESS_REQUESTED'));
    assert.ok(codes('What is your address?').includes('ADDRESS_REQUESTED'));
  });

  test('allows giving out our own pickup address', () => {
    assert.deepStrictEqual(
      codes('Die Abholung ist an der Langstrasse 175, 8004 Zuerich, unten im SBB-Buerogebaeude.'),
      []
    );
  });
});

describe('guards: Swiss orthography', () => {
  test('autofixes the sharp s', () => {
    const out = guards.enforce('Die Strasse heißt Langstraße und ist größer.');
    assert.ok(!out.text.includes('ß'), 'sharp s should be gone');
    assert.ok(out.sharpSFixed);
    assert.ok(out.text.includes('heisst'));
    assert.ok(out.text.includes('groesser') || out.text.includes('grösser'));
  });
});

describe('guards: enforce()', () => {
  test('replaces a blocked message and asks for a handoff', () => {
    const out = guards.enforce('Deine Buchung ist bestaetigt!', { lang: 'de' });
    assert.ok(out.blocked);
    assert.ok(!out.text.includes('bestaetigt'));
    assert.match(out.text, /Team/);
  });

  test('uses English fallback for English chats', () => {
    const out = guards.enforce('Your booking is confirmed!', { lang: 'en' });
    assert.ok(out.blocked);
    assert.match(out.text, /colleague/);
  });

  test('passes a clean message through unchanged', () => {
    const text = 'Hoi! Wie alt wird das Geburtstagskind, und wann ist die Party?';
    const out = guards.enforce(text);
    assert.strictEqual(out.text, text);
    assert.strictEqual(out.blocked, false);
  });
});
