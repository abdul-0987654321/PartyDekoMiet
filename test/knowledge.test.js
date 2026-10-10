'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { load } = require('../src/knowledge/from-files');
const { buildSystemPrompt } = require('../src/agent/prompt');

const knowledge = load();

describe('knowledge pack', () => {
  test('loads all four parts', () => {
    assert.ok(knowledge.business.name);
    assert.ok(knowledge.rules.length > 200);
    assert.ok(knowledge.persona.length > 200);
    assert.strictEqual(knowledge.faq.length, 15, 'the PDF has 15 FAQ entries');
  });

  test('every FAQ entry is complete', () => {
    for (const e of knowledge.faq) {
      assert.ok(e.id, 'id');
      assert.ok(e.q, `question for ${e.id}`);
      assert.ok(e.a_de, `German answer for ${e.id}`);
      assert.ok(e.a_en, `English answer for ${e.id}`);
      assert.ok(Array.isArray(e.keywords) && e.keywords.length, `keywords for ${e.id}`);
    }
  });

  test('the business facts match the AGB', () => {
    const b = knowledge.business;
    assert.strictEqual(b.rental.days, 3);
    assert.strictEqual(b.money.depositChf, 50);
    assert.strictEqual(b.money.lateFeeChfPerStartedDay, 50);
    assert.strictEqual(b.pickup.selfPickupOnly, true);
    assert.match(b.pickup.address, /Langstrasse 175/);
    assert.match(b.pickup.address, /8004/);
    for (const item of ['Lieferservice', 'Aufbau am Veranstaltungsort', 'Abbau am Veranstaltungsort']) {
      assert.ok(b.notOffered.includes(item), `notOffered should list ${item}`);
    }
  });

  test('customer-facing knowledge uses Swiss orthography', () => {
    // rules.md and persona.md contain the instruction *about* the sharp s, so they
    // are excluded here; these are the strings a customer can actually receive.
    const customerFacing = JSON.stringify(knowledge.faq) + JSON.stringify(knowledge.business);
    assert.ok(!customerFacing.includes('ß'), 'no sharp s in customer-facing text');
  });
});

describe('system prompt', () => {
  const prompt = buildSystemPrompt(knowledge, { today: '2026-05-01' });

  test('contains the facts the bot must never get wrong', () => {
    assert.match(prompt, /Langstrasse 175/);
    assert.match(prompt, /Selbstabholung/);
    assert.match(prompt, /CHF 50/);
    assert.match(prompt, /drei aufeinanderfolgende Tage/);
    assert.match(prompt, /2026-05-01/);
  });

  test('includes every official answer verbatim', () => {
    for (const e of knowledge.faq) {
      assert.ok(prompt.includes(e.a_de), `prompt should quote "${e.id}" verbatim`);
    }
  });

  test('names all five tools', () => {
    for (const t of [
      'search_products',
      'send_product',
      'check_availability',
      'create_booking_request',
      'handoff_to_human',
    ]) {
      assert.ok(prompt.includes(t), `prompt should mention ${t}`);
    }
  });

  test('tells the model not to invent pickup times while hours are unknown', () => {
    assert.ok(knowledge.business.pickup.hours === null, 'hours are still unknown');
    assert.match(prompt, /Nenne keine festen Zeiten/);
  });
});
