'use strict';
/**
 * The FAQ table is the owner's own answers. Two things matter most: the two
 * businesses never see each other's entries (the Studio must not inherit
 * rental answers, which is the same separation prompt-businesses.test.js
 * enforces for tools), and an entry is never put into the prompt with a
 * question but no answer.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const faq = require('../src/faq-store');

const QA = { question: 'Habt ihr Parkplaetze?', answerDe: 'Ja, direkt vor dem Haus.', answerEn: 'Yes, right outside.' };

beforeEach(async () => {
  await db.init(createMemoryBackend());
});

describe('validation', () => {
  test('a question with no answer in either language is refused', async () => {
    const res = await faq.create({ question: 'Was kostet das?' });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /at least one answer/);
  });

  test('one language is enough', async () => {
    const res = await faq.create({ question: 'Parking?', answerEn: 'Yes.' });
    assert.strictEqual(res.ok, true);
  });

  test('an empty question is refused', async () => {
    assert.strictEqual((await faq.create({ question: '   ', answerEn: 'Yes.' })).ok, false);
  });

  test('an unknown business is refused rather than silently filed under party', async () => {
    const res = await faq.create({ ...QA, business: 'restaurant' });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /business must be one of/);
  });
});

describe('the two businesses stay separate', () => {
  beforeEach(async () => {
    await faq.create({ ...QA, business: 'party' });
    await faq.create({ question: 'Wie lange dauert eine Massage?', answerDe: '60 Minuten.', business: 'studio' });
  });

  test('each business sees only its own entries', () => {
    assert.deepStrictEqual(faq.list({ business: 'party' }).map((f) => f.question), ['Habt ihr Parkplaetze?']);
    assert.deepStrictEqual(faq.list({ business: 'studio' }).map((f) => f.question), ['Wie lange dauert eine Massage?']);
  });

  test('forPrompt returns the knowledge-pack shape, per business', () => {
    const [entry] = faq.forPrompt('studio');
    assert.deepStrictEqual(entry, {
      q: 'Wie lange dauert eine Massage?',
      a_de: '60 Minuten.',
      a_en: '60 Minuten.', // falls back rather than reaching the model blank
    });
  });

  test('an entry with no business is treated as party, not lost', async () => {
    await faq.create({ question: 'Alt?', answerDe: 'Ja.' });
    assert.strictEqual(faq.list({ business: 'party' }).length, 2);
    assert.strictEqual(faq.list({ business: 'studio' }).length, 1);
  });
});

describe('editing', () => {
  test('a deactivated entry stays in the table but leaves the prompt', async () => {
    const { entry } = await faq.create({ ...QA, business: 'studio' });
    assert.strictEqual(faq.forPrompt('studio').length, 1);

    await faq.update(entry.id, { active: false });
    assert.strictEqual(faq.forPrompt('studio').length, 0, 'the bot must stop saying it');
    assert.strictEqual(faq.list({ business: 'studio' }).length, 1, 'the owner can still see and re-enable it');
  });

  test('an update cannot empty both answers', async () => {
    const { entry } = await faq.create(QA);
    const res = await faq.update(entry.id, { answerDe: '', answerEn: '' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(faq.get(entry.id).answerDe, QA.answerDe, 'the stored entry is untouched');
  });

  test('an update keeps the id and creation time', async () => {
    const { entry } = await faq.create(QA);
    const res = await faq.update(entry.id, { answerEn: 'Yes, plenty.' });
    assert.strictEqual(res.entry.id, entry.id);
    assert.strictEqual(res.entry.createdAt, entry.createdAt);
    // Not "different": an edit a millisecond later is still a valid edit.
    assert.ok(res.entry.updatedAt >= entry.createdAt);
    assert.strictEqual(res.entry.answerEn, 'Yes, plenty.');
  });

  test('updating or removing something that is not there is an error, not a crash', async () => {
    assert.strictEqual((await faq.update('nope', { answerEn: 'x' })).ok, false);
    assert.strictEqual((await faq.remove('nope')).ok, false);
  });

  test('remove really removes it', async () => {
    const { entry } = await faq.create(QA);
    assert.strictEqual((await faq.remove(entry.id)).ok, true);
    assert.strictEqual(faq.list().length, 0);
  });
});

describe('answersFor', () => {
  test('returns every answer text for the guards whitelist, and no blanks', async () => {
    await faq.create({ question: 'A?', answerDe: 'Antwort A.', business: 'studio' });
    await faq.create({ ...QA, business: 'party' });
    const answers = faq.answersFor('studio');
    assert.ok(answers.includes('Antwort A.'));
    assert.ok(!answers.includes(''));
    assert.ok(!answers.some((a) => /Parkplaetze|right outside/i.test(a)), 'no cross-business leakage');
  });
});
