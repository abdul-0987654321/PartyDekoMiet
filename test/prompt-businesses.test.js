'use strict';
/**
 * One prompt builder serves two businesses that share no tools and no facts.
 *
 * This caught a live outage: `renderBusiness` read `b.pickup.address`
 * unconditionally, and the Studio's business.json has no `pickup` at all (its
 * addresses live in the dashboard tables). Every Studio message therefore threw
 * "Cannot read properties of undefined (reading 'address')" and the customer got
 * the AI-failure fallback instead of an answer. `business.money.depositChf` in
 * the request-flow section was a second instance of the same bug.
 *
 * So: build BOTH prompts for real, and assert neither borrows the other's tools.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { load } = require('../src/knowledge/from-files');
const { buildSystemPrompt, renderBusiness, renderWorkflow } = require('../src/agent/prompt');

const CTX = { lang: 'de', today: '2026-10-22' };
const PARTY_TOOLS = ['search_products', 'send_product', 'check_availability', 'create_booking_request'];
const STUDIO_TOOLS = [
  'list_professionals',
  'get_professional_profile',
  'check_appointment_slot',
  'create_appointment_request',
];

describe('both businesses build a prompt', () => {
  test('Party builds and keeps its own tools and deposit', () => {
    const prompt = buildSystemPrompt(load(), CTX);
    for (const tool of PARTY_TOOLS) assert.match(prompt, new RegExp(tool), `missing ${tool}`);
    assert.match(prompt, /CHF 50\.- Kaution/, 'the deposit placeholder must be filled in');
    assert.doesNotMatch(prompt, /\{\{/, 'no unreplaced placeholder may reach the model');
  });

  test('Studio builds - the case that was throwing live', () => {
    const studio = load({ dir: 'knowledge-studio' });
    // The exact failure: no pickup object at all.
    assert.strictEqual(studio.business.pickup, undefined, 'fixture must keep the shape that broke');
    assert.strictEqual(studio.business.money, undefined);

    const prompt = buildSystemPrompt(studio, CTX); // threw before the fix
    for (const tool of STUDIO_TOOLS) assert.match(prompt, new RegExp(tool), `missing ${tool}`);
    assert.doesNotMatch(prompt, /\{\{/);
  });

  test('neither bot is told about the other one\'s tools', () => {
    const party = buildSystemPrompt(load(), CTX);
    const studio = buildSystemPrompt(load({ dir: 'knowledge-studio' }), CTX);
    for (const tool of STUDIO_TOOLS) assert.ok(!party.includes(tool), `Party leaked ${tool}`);
    for (const tool of PARTY_TOOLS) assert.ok(!studio.includes(tool), `Studio leaked ${tool}`);
  });

  test('rental facts never reach the Studio prompt', () => {
    const studio = buildSystemPrompt(load({ dir: 'knowledge-studio' }), CTX);
    for (const word of ['Kaution', 'Abholung', 'Mietdauer', 'Geburtstagskind']) {
      assert.ok(!studio.includes(word), `Studio prompt should not mention "${word}"`);
    }
  });

  test('the Studio keeps the rules that are the point of the whole bot', () => {
    const studio = buildSystemPrompt(load({ dir: 'knowledge-studio' }), CTX);
    assert.match(studio, /Rezeptionist|receptionist/i);
    assert.match(studio, /Intime Extras/, 'the price-list limit must survive into the prompt');
  });
});

describe('renderBusiness tolerates a sparse business', () => {
  test('the bare minimum does not throw', () => {
    const out = renderBusiness({ name: 'X', whatWeDo: 'Y' });
    assert.match(out, /Name: X/);
    assert.match(out, /Angebot: Y/);
    assert.ok(!out.includes('undefined'), out);
  });

  test('optional blocks appear only when their data does', () => {
    const bare = renderBusiness({ name: 'X', whatWeDo: 'Y' });
    assert.ok(!bare.includes('Abholung'));
    assert.ok(!bare.includes('Kaution'));

    const full = renderBusiness({
      name: 'X',
      whatWeDo: 'Y',
      pickup: { address: 'Street 1', addressDetail: 'ground floor' },
      money: { depositChf: 50, depositRefundCondition: 'clean return' },
    });
    assert.match(full, /Abholung: ausschliesslich Selbstabholung, Street 1 \(ground floor\)\./);
    assert.match(full, /Kaution: CHF 50\.- , zurueck nach clean return\./);
  });

  test('no stray blank lines when whole sections are missing', () => {
    assert.ok(!renderBusiness({ name: 'X', whatWeDo: 'Y' }).includes('\n\n\n'));
  });
});

describe('renderWorkflow', () => {
  test('fills the deposit placeholder from business.json', () => {
    const out = renderWorkflow('pay {{depositChf}}.- now', { money: { depositChf: 50 } });
    assert.strictEqual(out, 'pay 50.- now');
  });

  test('a business with no money block leaves no "undefined" in the prompt', () => {
    assert.strictEqual(renderWorkflow('pay {{depositChf}}.- now', {}), 'pay .- now');
  });

  test('no workflow file is not an error', () => {
    assert.strictEqual(renderWorkflow('', {}), '');
  });
});
