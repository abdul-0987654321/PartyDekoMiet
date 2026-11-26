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

  test('blocks a term that is in no service the owner has written', () => {
    assert.ok(codes('Ein Happy Ending ist moeglich.').includes('SEXUAL_EXTRA_OFFERED'));
  });

  test('allows a clear decline', () => {
    assert.deepStrictEqual(codes('Sonderwuensche bieten wir nicht an, nur die Services aus der Liste.'), []);
  });
});

/**
 * "Beyond the price list" is measured against the list, and the list is
 * whatever the owner typed into Services.
 *
 * This blocked him live. He filled his services in - "1 Stunde Service:
 * Wellness Massage mit Happy End." - a customer asked what was on offer, and
 * every answer came back as "Let me check that with the team". The list said
 * one thing and the bot was forbidden from saying it, which is not a safety
 * net, it is a bot that cannot describe the business it answers for.
 */
describe('the owner\'s own service list is the list', () => {
  const HIS_LIST = [
    'Sofia',
    '1 Stunde Service:\nWellness Massage mit Happy End.\nWelness Massage, Bj, 69 eventuell Sex',
  ];
  const withList = (texts) => createStudioGuards({ allowedPrices: [200], serviceTexts: () => texts });
  const codesWith = (texts, text) => withList(texts).check(text).map((v) => v.code);

  test('what he wrote into a service may be said back', () => {
    for (const reply of [
      'Our one hour service includes a wellness massage with happy ending.',
      'Wir bieten eine Wellness Massage mit Happy End an, 1 Stunde, CHF 200.',
      'Sofia offers a 60 minute massage for CHF 200 with happy ending.',
    ]) {
      assert.deepStrictEqual(codesWith(HIS_LIST, reply), [], reply);
    }
  });

  test('the same sentence is blocked when no service says it', () => {
    assert.ok(
      codesWith([], 'Our one hour service includes a wellness massage with happy ending.')
        .includes('SEXUAL_EXTRA_OFFERED'),
      'with nothing on the list, the bot is inventing the offer'
    );
  });

  test('something he did not write is still blocked, list or no list', () => {
    // He wrote nothing about intimate options or unnamed extras, so offering
    // them is the bot going past his list - which is the whole rule.
    assert.ok(codesWith(HIS_LIST, 'We also offer intimate options.').includes('SEXUAL_EXTRA_OFFERED'));
    assert.ok(codesWith(HIS_LIST, 'Extras are possible, just ask her.').includes('SEXUAL_EXTRA_OFFERED'));
  });

  test('taking the service down takes the permission with it', () => {
    const texts = [...HIS_LIST];
    const g = createStudioGuards({ allowedPrices: [200], serviceTexts: () => texts });
    const line = 'Our one hour service includes a happy ending.';
    assert.deepStrictEqual(g.check(line).map((v) => v.code), []);
    texts.length = 0; // he deactivates the service mid-shift
    assert.ok(g.check(line).map((v) => v.code).includes('SEXUAL_EXTRA_OFFERED'), 'read per reply, not at boot');
  });

  test('naming it in passing without offering it is not an offer', () => {
    assert.deepStrictEqual(codesWith([], 'Happy end.'), []);
  });
});

describe('unprotected sex is never put in writing', () => {
  // The one line the service list does not move. A bot writing this is a
  // health question and a question of what the women are then expected to
  // agree to, and neither belongs in an automated message. The owner is
  // alerted instead, because that is what a person is for.
  const HIS_LIST = ['Alles ohne Gummi moeglich'];
  const codesWith = (texts, text) =>
    createStudioGuards({ allowedPrices: [], serviceTexts: () => texts }).check(text).map((v) => v.code);

  for (const reply of [
    'Yes, that is possible without a condom.',
    'Ohne Gummi ist das moeglich.',
    'Bareback is available.',
  ]) {
    test(`blocked: ${reply}`, () => {
      assert.ok(codesWith([], reply).includes('UNPROTECTED_OFFERED'));
    });
  }

  test('writing it into a service does not unlock it', () => {
    assert.ok(
      codesWith(HIS_LIST, 'Ohne Gummi ist das moeglich.').includes('UNPROTECTED_OFFERED'),
      'this is the one thing the list cannot permit'
    );
  });

  test('a clear no is still allowed', () => {
    assert.deepStrictEqual(codesWith([], 'Ohne Gummi geht das nicht.'), []);
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

describe('the allowed price list is read at reply time, not at boot', () => {
  // Live failure: the owner added a service in the dashboard after the bot had
  // started. list_services read it correctly, the model quoted it correctly,
  // and the guard - still holding the list captured at boot - blocked the reply
  // as INVENTED_PRICE. The dashboard is editable while the bot runs, so a
  // snapshot is always one edit away from being wrong.
  const LINE = 'We offer a service called "Home," which lasts for 10 minutes and costs CHF 100.';

  test('a price added after construction is accepted', () => {
    let prices = [];
    const g = createStudioGuards({ allowedPrices: () => prices, priceMode: 'block' });
    assert.strictEqual(g.enforce(LINE, { lang: 'en' }).blocked, true, 'unknown price must be blocked');

    prices = [100]; // the owner saves the service in the dashboard
    assert.strictEqual(g.enforce(LINE, { lang: 'en' }).blocked, false, 'it is a real price now');
  });

  test('a price removed after construction stops being accepted', () => {
    let prices = [100];
    const g = createStudioGuards({ allowedPrices: () => prices, priceMode: 'block' });
    assert.strictEqual(g.enforce(LINE, { lang: 'en' }).blocked, false);

    prices = []; // the owner deactivates it
    assert.strictEqual(g.enforce(LINE, { lang: 'en' }).blocked, true);
  });

  test('a plain array still works, so existing callers are unaffected', () => {
    assert.strictEqual(createStudioGuards({ allowedPrices: [100], priceMode: 'block' }).enforce(LINE, { lang: 'en' }).blocked, false);
    assert.strictEqual(createStudioGuards({ allowedPrices: [120], priceMode: 'block' }).enforce(LINE, { lang: 'en' }).blocked, true);
  });

  test('a directory that throws blocks the price, it does not open the gate', () => {
    const g = createStudioGuards({
      priceMode: 'block',
      allowedPrices: () => {
        throw new Error('Sheet unreachable');
      },
    });
    assert.strictEqual(g.enforce(LINE, { lang: 'en' }).blocked, true);
  });
});

describe('the price rule is the owner\'s call; the agreed rules are not', () => {
  // INVENTED_PRICE is an engineering safeguard, not something the client asked
  // for, and while the service list is incomplete it blocks correct answers.
  // The owner chooses warn or block. The three rules the client agreed to in
  // writing on 17-18 Oct always block, whatever this is set to.
  const PRICE_LINE = 'We offer a service called "Home," which lasts for 10 minutes and costs 100 CHF.';
  const EXTRA_LINE = 'We can offer intimate options as well.';
  const AS_HER_LINE = 'Ich bin Gabriela, 28 Jahre alt.';

  test('warn (the default): the reply goes out and the violation is reported', () => {
    const g = createStudioGuards({ allowedPrices: [] });
    const res = g.enforce(PRICE_LINE, { lang: 'en' });
    assert.strictEqual(res.blocked, false);
    assert.strictEqual(res.text, PRICE_LINE, 'the customer gets the real answer');
    assert.deepStrictEqual(res.warned.map((v) => v.code), ['INVENTED_PRICE']);
    assert.match(res.warned[0].hint, /no active service has a price/);
  });

  test('block: the reply is held back, as before', () => {
    const g = createStudioGuards({ allowedPrices: [], priceMode: 'block' });
    const res = g.enforce(PRICE_LINE, { lang: 'en' });
    assert.strictEqual(res.blocked, true);
    assert.notStrictEqual(res.text, PRICE_LINE);
  });

  test('the mode is read per reply, so the dashboard switch is immediate', () => {
    let mode = 'warn';
    const g = createStudioGuards({ allowedPrices: [], priceMode: () => mode });
    assert.strictEqual(g.enforce(PRICE_LINE, { lang: 'en' }).blocked, false);
    mode = 'block';
    assert.strictEqual(g.enforce(PRICE_LINE, { lang: 'en' }).blocked, true);
  });

  test('a real price is neither blocked nor warned about', () => {
    const g = createStudioGuards({ allowedPrices: [100] });
    const res = g.enforce(PRICE_LINE, { lang: 'en' });
    assert.strictEqual(res.blocked, false);
    assert.deepStrictEqual(res.warned, []);
  });

  for (const [name, line] of [['sexual extras', EXTRA_LINE], ['speaking as the professional', AS_HER_LINE]]) {
    test(`${name} is still blocked in warn mode`, () => {
      const g = createStudioGuards({ allowedPrices: [], priceMode: 'warn' });
      const res = g.enforce(line, { lang: line === EXTRA_LINE ? 'en' : 'de' });
      assert.strictEqual(res.blocked, true, 'this one is not the owner\'s to switch off');
    });
  }

  test('a blocking rule wins even when a price warning is present too', () => {
    const g = createStudioGuards({ allowedPrices: [], priceMode: 'warn' });
    const res = g.enforce(`${PRICE_LINE} ${EXTRA_LINE}`, { lang: 'en' });
    assert.strictEqual(res.blocked, true);
    assert.ok(res.violations.some((v) => v.code === 'SEXUAL_EXTRA_OFFERED'));
  });
});
