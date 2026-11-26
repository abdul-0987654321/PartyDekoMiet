'use strict';
/**
 * Fetching a person is for a person's problem, not for a word the bot could
 * not read.
 *
 * Live, on the Studio number: the bot listed its massages, the customer wrote
 * "I need massga", and the answer was "Let me check that with the team - I am
 * forwarding your question." A misspelling of the thing he had just been
 * offered, and he was put in a queue for it.
 *
 * The rules file already said not to do this. It lost, because the tool's own
 * description said the opposite - "use for ... anything you are unsure about",
 * with `unclear` listed as a reason the model could give. A tool description
 * sits in front of the model on every call; a rules file does not. So the
 * description is narrowed and the tool itself turns these away.
 *
 * Turning them away is a blocklist, not a list of permitted reasons: a real
 * complaint with a word nobody anticipated has to get through. Wrongly
 * refusing a complaint costs far more than letting an oddly-worded one past.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { isVague } = require('../src/agent/handoff');
const studioTools = require('../src/agent/tools/studio');
const partyTools = require('../src/agent/tools/index');

const REGISTRIES = [['studio', studioTools], ['party', partyTools]];

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
});

describe('what counts as the model giving up', () => {
  for (const reason of [
    'unclear', 'Unclear', 'unsure', 'not sure', 'unknown', 'misunderstanding',
    'confused', "don't understand", 'unverstaendlich', 'keine Ahnung',
    'general question', 'frage', 'other', '',
  ]) {
    test(`"${reason}" is the model stuck, not a case for a person`, () => {
      assert.strictEqual(isVague(reason), true);
    });
  }

  for (const reason of [
    'complaint', 'cancellation', 'change', 'extension', 'damage', 'loss',
    'price_dispute', 'not_offered', 'Reklamation', 'Stornierung', 'Schaden',
    'customer wants a refund', 'she is ill and cannot come',
  ]) {
    test(`"${reason}" is a real handoff and goes through`, () => {
      assert.strictEqual(isVague(reason), false);
    });
  }
});

describe('the tool itself turns a confused handoff away', () => {
  for (const [name, tools] of REGISTRIES) {
    test(`${name}: no alert, and the model is told to ask instead`, async () => {
      const alerts = [];
      const handed = [];
      const res = await tools.runTool('handoff_to_human', { reason: 'unclear', summary: 'He wrote massga' }, {
        notify: { owner: async (text, meta) => alerts.push(meta) },
        chatId: '41790000111@s.whatsapp.net',
        onHandoff: (a) => handed.push(a),
      });

      assert.strictEqual(res.ok, false);
      assert.deepStrictEqual(alerts, [], 'nobody is buzzed for a typo');
      assert.deepStrictEqual(handed, [], 'and the conversation is not handed over');
      assert.match(res.error, /nachzufragen|nachfragen/, 'the model is told what to do instead');
    });

    test(`${name}: a real one still goes through`, async () => {
      const alerts = [];
      const handed = [];
      const res = await tools.runTool('handoff_to_human', { reason: 'complaint', summary: 'Kunde ist veraergert' }, {
        notify: { owner: async (text, meta) => alerts.push(meta) },
        chatId: '41790000111@s.whatsapp.net',
        onHandoff: (a) => handed.push(a),
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.handed_off, true);
      assert.strictEqual(alerts.length, 1);
      assert.strictEqual(alerts[0].kind, 'handoff');
      assert.strictEqual(handed.length, 1);
    });

    test(`${name}: the description no longer invites it`, () => {
      const d = tools.toolSchemas().find((s) => s.function.name === 'handoff_to_human');
      const text = d.function.description;
      assert.ok(!/unsure about/i.test(text), 'the sentence that caused this is gone');
      assert.ok(/Do NOT use it because a message was vague/i.test(text));
      assert.ok(!/unclear/i.test(d.function.parameters.properties.reason.description),
        'and it is not offered as a reason either');
    });
  }
});
