'use strict';
/**
 * The eight-message loop.
 *
 * He named a service "Sofia" and wrote "Wellness Massage mit Happy End" in its
 * description. His one professional is called "tst". A customer wrote "What
 * service do you offer I need massage", and over eight replies the bot said
 * "It seems I made an error while checking the service", "It seems there was a
 * mix-up with the service name", "I apologize for the confusion" - while the
 * customer gave his name four times and never got an appointment.
 *
 * Nothing was wrong with the model's reasoning. Three things were wrong with
 * what we handed it:
 *
 *   1. `get_service('wellness massage')` failed, because the lookup only read
 *      the title - and the title was "Sofia". The one service it has, invisible
 *      under the only name a customer could possibly use for it.
 *   2. `get_professional_profile('Sofia')` failed with "there is no such
 *      professional", when Sofia is the name of a service. Nothing said so.
 *   3. Both failures read like something had broken, so the model told the
 *      customer something had broken. Every single time.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const directory = require('../src/studio/directory');
const tools = require('../src/agent/tools/studio');
const { createStudioGuards } = require('../src/agent/guards-studio');

const NOTES = '1 Stunde Service:\nWellness Massage mit Happy End.\nWelness Massage, Bj, 69 eventuell Sex';

let service;

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
  await directory.createProfessional({ name: 'tst', workingHours: 'Mo-Fr 10-13' });
  service = (await directory.createService({
    name: 'Sofia', durationMin: 60, priceChf: 200, notes: NOTES,
  })).service;
});

const ctx = () => ({ directory, chatId: 'c1' });

describe('finding the service a customer asked for', () => {
  for (const asked of ['massage', 'wellness massage', 'Wellness Massage', 'wellness']) {
    test(`"${asked}" finds it, because the description says so`, async () => {
      const res = await tools.runTool('get_service', { service_id: asked }, ctx());
      assert.strictEqual(res.ok, true, res.error);
      assert.strictEqual(res.service.id, service.id);
    });
  }

  test('the name still wins when it matches', async () => {
    const res = await tools.runTool('get_service', { service_id: 'Sofia' }, ctx());
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.service.name, 'Sofia');
  });

  test('something nobody offers is still a miss', async () => {
    const res = await tools.runTool('get_service', { service_id: 'pedicure' }, ctx());
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /Sofia/, 'and it names what there is');
  });

  test('a word that matches two services asks which one', async () => {
    await directory.createService({ name: 'Deluxe', notes: 'Lange Wellness Massage' });
    const res = await tools.runTool('get_service', { service_id: 'wellness' }, ctx());
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /Sofia/);
    assert.match(res.error, /Deluxe/);
  });

  test('a short word does not match half the directory by accident', async () => {
    // Three letters inside a longer word is how "bj" or "ein" would drag in
    // every service that happens to contain them.
    const res = await tools.runTool('get_service', { service_id: 'un' }, ctx());
    assert.strictEqual(res.ok, false);
  });
});

describe('a service named after a person, and a person who is not one', () => {
  test('asking for professional "Sofia" says what Sofia actually is', async () => {
    const res = await tools.runTool('get_professional_profile', { professional_id: 'Sofia' }, ctx());
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /kein Professional/);
    assert.match(res.error, /tst/, 'and names the one that exists');
  });

  test('asking for service "tst" says the same the other way round', async () => {
    const res = await tools.runTool('get_service', { service_id: 'tst' }, ctx());
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /kein Service/);
  });

  test('every miss tells the model to keep it to itself', async () => {
    for (const [tool, args] of [
      ['get_service', { service_id: 'tst' }],
      ['get_service', { service_id: 'pedicure' }],
      ['get_professional_profile', { professional_id: 'Sofia' }],
    ]) {
      const res = await tools.runTool(tool, args, ctx());
      assert.strictEqual(res.ok, false);
      assert.match(res.error, /erwaehne ihn dem Kunden gegenueber mit keinem Wort/, `${tool} ${JSON.stringify(args)}`);
    }
  });
});

describe('the bot never tells a customer about its own machinery', () => {
  const guards = () => createStudioGuards({
    allowedPrices: [200],
    serviceTexts: () => ['Sofia', NOTES],
  });

  // Taken from his transcript, word for word.
  const HIS = [
    'It seems I made an error while checking the service.',
    'It seems there was a mix-up with the service name.',
    'It seems there was a misunderstanding regarding the service.',
    'It looks like there was a mix-up with the service name again.',
    'I apologize for the confusion.',
    'I apologize for the confusion earlier.',
  ];

  for (const line of HIS) {
    test(`stripped: "${line}"`, () => {
      const out = guards().enforce(`${line} We offer a wellness massage for CHF 200.-, 60 minutes.`, { lang: 'en' });
      assert.ok(!out.text.includes('mix-up'), out.text);
      assert.ok(!/apologi[sz]e|an error|misunderstanding/i.test(out.text), out.text);
      assert.match(out.text, /wellness massage for CHF 200/, 'the real answer survives');
      assert.strictEqual(out.blocked, false, 'and nobody is fetched over it');
    });
  }

  test('when the apology was the whole message, it asks instead of fetching a person', () => {
    const out = guards().enforce('I apologize for the confusion.', { lang: 'en' });
    assert.ok(!/apologi[sz]e/i.test(out.text));
    assert.ok(!/team|colleague/i.test(out.text), 'a failed lookup is no reason for a handoff');
    assert.match(out.text, /\?$/, 'it asks him something');
  });

  test('an ordinary apology is not machine talk', () => {
    for (const fine of [
      'Sorry, we do not offer that.',
      'I am sorry to hear that.',
      'Unfortunately she is fully booked on Monday.',
    ]) {
      const out = guards().enforce(fine, { lang: 'en' });
      assert.strictEqual(out.text, fine);
      assert.strictEqual(out.stripped.length, 0);
    }
  });

  test('PartyDekoMiet is held to it too', () => {
    const { createGuards } = require('../src/agent/guards');
    const g = createGuards({ faqAnswers: [], depositChf: 50, lateFeeChf: 50 });
    const out = g.enforce('I apologize for the confusion. The Einhorn Set is CHF 150.-.', { lang: 'en' });
    assert.ok(!/apologi[sz]e/i.test(out.text), out.text);
    assert.match(out.text, /Einhorn Set/);
  });
});

describe('his conversation, replayed', () => {
  test('the first lookup now succeeds, so the loop never starts', async () => {
    const res = await tools.runTool('get_service', { service_id: 'wellness massage' }, ctx());
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.service.price, 'CHF 200.-');
    assert.strictEqual(res.service.duration, '60 Minuten');
    assert.match(res.service.details, /Wellness Massage mit Happy End/);
    assert.deepStrictEqual(res.offeredBy.map((p) => p.name), ['tst'], 'and it names who does it');
  });
});
