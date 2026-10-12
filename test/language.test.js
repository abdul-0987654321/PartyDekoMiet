'use strict';
/**
 * Reproduces the production bug: a customer wrote English, got two English
 * replies, then the bot drifted back to German for the rest of the chat.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { resolveLanguage, scoreText, languageInstruction } = require('../src/agent/language');
const { buildSystemPrompt } = require('../src/agent/prompt');
const knowledge = require('../src/knowledge/from-files').load();

describe('scoring a single message', () => {
  test('clear English', () => {
    for (const m of [
      'Hi where I can pick up the decorations',
      'Do you deliver to my address?',
      'How long can I rent a set for?',
      'How much is the deposit?',
    ]) assert.strictEqual(scoreText(m), 'en', m);
  });

  test('clear German', () => {
    for (const m of [
      'Hoi, habt ihr Einhorn Deko?',
      'Wie hoch ist die Kaution?',
      'Wo kann ich das abholen?',
    ]) assert.strictEqual(scoreText(m), 'de', m);
  });

  test('an umlaut settles it', () => {
    assert.strictEqual(scoreText('Grüezi'), 'de');
  });

  test('messages with no signal stay unclear', () => {
    for (const m of ['Hi', 'ok', '👍', '20.12.2026', '']) {
      assert.strictEqual(scoreText(m), null, `"${m}" should carry no signal`);
    }
  });
});

describe('the conversation that went wrong', () => {
  // Exactly the messages from the WhatsApp log.
  const messages = [
    'Hi',
    'Hi',
    'Hi where I can pick up the decorations',
    'Do you deliver to my address?',
    'How long can I rent a set for?',
    'How much is the deposit?',
  ];

  test('stays English once the customer has clearly written English', () => {
    const history = [];
    const langs = [];
    for (const m of messages) {
      langs.push(resolveLanguage({ message: m, history }).lang);
      history.push({ role: 'user', content: m }, { role: 'assistant', content: '...' });
    }
    // The last four were answered in German in production.
    assert.deepStrictEqual(langs.slice(2), ['en', 'en', 'en', 'en']);
  });

  test('an unclear follow-up keeps the established language', () => {
    const history = [
      { role: 'user', content: 'Do you deliver to my address?' },
      { role: 'assistant', content: 'No, we do not.' },
    ];
    assert.strictEqual(resolveLanguage({ message: 'ok', history }).lang, 'en');
    assert.strictEqual(resolveLanguage({ message: '👍', history }).lang, 'en');
  });

  test('a real switch to German is followed', () => {
    const history = [
      { role: 'user', content: 'How much is the deposit?' },
      { role: 'assistant', content: 'CHF 50.-' },
    ];
    assert.strictEqual(resolveLanguage({ message: 'Wie hoch ist die Kaution genau?', history }).lang, 'de');
  });

  test('German stays the default for a first unclear message', () => {
    assert.strictEqual(resolveLanguage({ message: 'Hi', history: [] }).lang, 'de');
  });
});

describe('the dashboard setting', () => {
  test('forcing English overrides a German message', () => {
    const r = resolveLanguage({ message: 'Wie hoch ist die Kaution?', setting: 'en' });
    assert.strictEqual(r.lang, 'en');
    assert.strictEqual(r.source, 'setting');
  });

  test('forcing German overrides an English message', () => {
    assert.strictEqual(resolveLanguage({ message: 'How much is the deposit?', setting: 'de' }).lang, 'de');
  });

  test('auto behaves like before', () => {
    assert.strictEqual(resolveLanguage({ message: 'How much is the deposit?', setting: 'auto' }).lang, 'en');
  });
});

describe('the instruction reaches the system prompt', () => {
  test('English is stated in English', () => {
    const p = buildSystemPrompt(knowledge, { lang: 'en', langSource: 'message' });
    assert.match(p, /Answer this conversation in ENGLISH/);
  });

  test('German is stated in German', () => {
    const p = buildSystemPrompt(knowledge, { lang: 'de', langSource: 'message' });
    assert.match(p, /auf DEUTSCH/);
  });

  test('a fixed setting is stated as fixed, not as a preference', () => {
    assert.match(languageInstruction('en', 'setting'), /even if the customer writes German/);
    assert.match(languageInstruction('de', 'setting'), /auch dann auf Deutsch/);
  });

  test('without a language the prompt is unchanged', () => {
    const p = buildSystemPrompt(knowledge, {});
    assert.ok(!p.includes('Answer this conversation in ENGLISH'));
  });
});
