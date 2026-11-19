'use strict';
/**
 * The owner's own description, and the reply-length rules that go with it.
 *
 * Why both live in one test file: they are one complaint. The client said the
 * bot answers "what do you offer?" by reading out every service with every
 * price, and that he wants to hand it information in his own words rather than
 * invent a question for every fact. Before this, the only text he could enter
 * was FAQ question/answer pairs - so the model had nothing short to say, and a
 * tool that returned the whole catalogue read like an instruction to recite it.
 *
 * The Studio persona has asked for "1 to 3 sentences" since the first build and
 * was ignored, which is why the rule is now in the prompt itself, last, and why
 * these tests assert on the built prompt rather than on the persona file.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { load } = require('../src/knowledge/from-files');
const { buildSystemPrompt, renderAbout, LENGTH_RULES } = require('../src/agent/prompt');

const CTX = { lang: 'de', today: '2026-11-20' };
const STUDIO_TEXT = 'Wir sind ein Studio mit mehreren Professionals in Zuerich. Termine nach Vereinbarung.';
const PARTY_TEXT = 'Wir vermieten Partydekoration in Zuerich. Abholung bei uns, Rueckgabe nach drei Tagen.';

describe('renderAbout', () => {
  test('nothing written yet produces no section at all', () => {
    // An empty heading would tell the model a description exists and is blank.
    for (const empty of ['', '   ', '\n', undefined, null]) {
      assert.strictEqual(renderAbout(empty), '', `${JSON.stringify(empty)} must render nothing`);
    }
  });

  test('the text goes in verbatim - these are his words, not ours', () => {
    const out = renderAbout(`  ${STUDIO_TEXT}  `);
    assert.ok(out.includes(STUDIO_TEXT), 'the owner text must appear unchanged');
    assert.doesNotMatch(out, /^\s/, 'leading whitespace is trimmed');
  });

  test('it tells the model this is the answer, and not to list the offer', () => {
    const out = renderAbout(STUDIO_TEXT);
    assert.match(out, /nicht das Angebot auf/i, 'must forbid reciting the offer');
    assert.match(out, /nicht steht/i, 'must forbid adding facts that are not in the text');
  });
});

describe('the built prompt', () => {
  test('Studio carries the description and the length rules', () => {
    const prompt = buildSystemPrompt({ ...load({ dir: 'knowledge-studio' }), about: STUDIO_TEXT }, CTX);
    assert.ok(prompt.includes(STUDIO_TEXT));
    assert.ok(prompt.includes(LENGTH_RULES), 'the length rules must reach the model');
  });

  test('Party carries them too - one prompt builder, both bots', () => {
    const prompt = buildSystemPrompt({ ...load(), about: PARTY_TEXT }, CTX);
    assert.ok(prompt.includes(PARTY_TEXT));
    assert.ok(prompt.includes(LENGTH_RULES));
  });

  test('the length rules are the last thing the model reads', () => {
    // Recency is the point: the workflow section above it is long, and an
    // instruction buried before it is what got ignored for weeks.
    const prompt = buildSystemPrompt({ ...load({ dir: 'knowledge-studio' }), about: STUDIO_TEXT }, CTX);
    assert.ok(prompt.trimEnd().endsWith(LENGTH_RULES.trimEnd()));
  });

  test('a bot with no description still builds, and says nothing about one', () => {
    const prompt = buildSystemPrompt(load({ dir: 'knowledge-studio' }), CTX);
    assert.doesNotMatch(prompt, /eigene Worte/, 'no empty description section');
    assert.ok(prompt.includes(LENGTH_RULES), 'the length rules do not depend on it');
  });

  test('the rules forbid the whole list but allow two or three examples', () => {
    assert.match(LENGTH_RULES, /Zaehle NIE das ganze Angebot/);
    assert.match(LENGTH_RULES, /Zwei oder drei konkrete Beispiele/);
  });

  test('neither business inherits the other description', () => {
    const studio = buildSystemPrompt({ ...load({ dir: 'knowledge-studio' }), about: STUDIO_TEXT }, CTX);
    assert.ok(!studio.includes(PARTY_TEXT), 'the Studio must never describe the rental shop');

    const party = buildSystemPrompt({ ...load(), about: PARTY_TEXT }, CTX);
    assert.ok(!party.includes(STUDIO_TEXT), 'and the rental shop must never describe the Studio');
  });
});

describe('the dashboard field', () => {
  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
  });

  test('both businesses have their own, and it is a multi-line box', () => {
    const fields = settings.describe();
    for (const key of ['aboutText', 'studioAboutText']) {
      const field = fields.find((f) => f.key === key);
      assert.ok(field, `${key} must be on the settings form`);
      assert.strictEqual(field.type, 'text', 'one-line inputs are what he complained about');
      assert.ok(field.help.de && field.help.en, 'he reads DE, we read EN');
    }
  });

  test('it starts empty rather than with words he did not write', () => {
    assert.strictEqual(settings.get('aboutText'), '');
    assert.strictEqual(settings.get('studioAboutText'), '');
  });

  test('saving one leaves the other untouched', async () => {
    assert.strictEqual((await settings.update({ studioAboutText: STUDIO_TEXT })).ok, true);
    assert.strictEqual(settings.get('studioAboutText'), STUDIO_TEXT);
    assert.strictEqual(settings.get('aboutText'), '', 'the Studio text must not land on Party');

    assert.strictEqual((await settings.update({ aboutText: PARTY_TEXT })).ok, true);
    assert.strictEqual(settings.get('studioAboutText'), STUDIO_TEXT, 'and Party must not overwrite the Studio');
  });

  test('several lines survive the round trip', async () => {
    const multi = 'Zeile eins.\nZeile zwei.\n\nZeile vier.';
    await settings.update({ studioAboutText: multi });
    assert.strictEqual(settings.get('studioAboutText'), multi, 'newlines must not be stripped');
  });

  test('it can be emptied again', async () => {
    await settings.update({ studioAboutText: STUDIO_TEXT });
    assert.strictEqual((await settings.update({ studioAboutText: '' })).ok, true);
    assert.strictEqual(settings.get('studioAboutText'), '');
    assert.strictEqual(renderAbout(settings.get('studioAboutText')), '', 'and then the section disappears');
  });
});
