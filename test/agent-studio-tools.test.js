'use strict';
/**
 * Studio tool registry (agent/tools/studio.js) and agent.js's injectable `tools`
 * dependency. Mirrors agent.test.js's fake-model pattern so the Studio agent loop
 * is tested without an OpenAI key, and confirms create_appointment_request can
 * never be called before a professional and service are looked up.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const directory = require('../src/studio/directory');
const { createAppointments } = require('../src/appointments');
const studioTools = require('../src/agent/tools/studio');
const { runTool } = studioTools;
const { createAgent } = require('../src/agent/agent');
const { createGuards } = require('../src/agent/guards');
const knowledge = require('../src/knowledge/from-files').load();

const guards = createGuards({ faqAnswers: [], depositChf: 50, lateFeeChf: 50 });

const text = (content) => ({ role: 'assistant', content });
const call = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

function fakeModel(queue) {
  return {
    chat: {
      completions: {
        create: async () => {
          const next = queue.shift();
          if (!next) throw new Error('fake model ran out of scripted replies');
          return { choices: [{ message: next }] };
        },
      },
    },
  };
}

describe('studio tool registry', () => {
  let professional, service;

  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
    professional = (await directory.createProfessional({ name: 'Gabriela', languages: 'de, en' })).professional;
    service = (await directory.createService({ name: 'Massage 60min', durationMin: 60, priceChf: 120 })).service;
  });

  test('list_professionals only returns active ones', async () => {
    await directory.createProfessional({ name: 'Retired One', active: false });
    const res = await runTool('list_professionals', {}, { directory });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.professionals.map((p) => p.name), ['Gabriela']);
  });

  test('list_services answers the studio-wide "what do you offer?" question', async () => {
    // Live: "what's the service you provide?" was handed to a human, because
    // the only way to reach a service was through one named professional.
    await directory.createService({ name: 'Retired service', priceChf: 999, active: false });
    const res = await runTool('list_services', {}, { directory });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.services.map((s) => s.name), ['Massage 60min']);
    assert.strictEqual(res.services[0].priceChf, 120);
    assert.strictEqual(res.services[0].durationMin, 60);
  });

  test('list_services says so honestly when the directory is empty', async () => {
    await directory.removeService(service.id);
    const res = await runTool('list_services', {}, { directory });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.count, 0);
  });

  test('get_professional_profile returns her services and location', async () => {
    const res = await runTool('get_professional_profile', { professional_id: professional.id }, { directory });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.professional.name, 'Gabriela');
    assert.strictEqual(res.services[0].name, 'Massage 60min');
  });

  test('get_professional_profile refuses an unknown id instead of inventing one', async () => {
    const res = await runTool('get_professional_profile', { professional_id: 'nope' }, { directory });
    assert.strictEqual(res.ok, false);
  });

  test('check_appointment_slot reports unavailable tools honestly', async () => {
    const res = await runTool(
      'check_appointment_slot',
      { professional_id: professional.id, service_id: service.id, date: '2026-06-05', start_time: '14:00' },
      { directory }
    );
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /nicht angebunden/);
  });

  test('check_appointment_slot delegates to the calendar with the resolved names and duration', async () => {
    const seen = [];
    const calendar = { checkSlotAvailability: async (args) => { seen.push(args); return { ok: true, available: true }; } };
    const res = await runTool(
      'check_appointment_slot',
      { professional_id: professional.id, service_id: service.id, date: '2026-06-05', start_time: '14:00' },
      { directory, calendar }
    );
    assert.strictEqual(res.available, true);
    assert.strictEqual(seen[0].professionalName, 'Gabriela');
    assert.strictEqual(seen[0].durationMin, 60);
  });

  test('create_appointment_request reports the service as unavailable rather than crashing', async () => {
    const res = await runTool(
      'create_appointment_request',
      { professional_id: professional.id, service_id: service.id, date: '2026-06-05', start_time: '14:00', customer_name: 'Anna' },
      {}
    );
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /nicht angebunden/);
  });

  test('create_appointment_request creates a PENDING appointment when wired', async () => {
    const appointments = createAppointments({ calendar: null, notify: null });
    const res = await runTool(
      'create_appointment_request',
      { professional_id: professional.id, service_id: service.id, date: '2026-06-05', start_time: '14:00', customer_name: 'Anna Keller' },
      { appointments, chatId: '41790000000@s.whatsapp.net' }
    );
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'PENDING');
  });

  test('handoff_to_human flags the turn and notifies the owner', async () => {
    const notified = [];
    let handedOff = false;
    const res = await runTool(
      'handoff_to_human',
      { reason: 'complaint', summary: 'unhappy customer' },
      { notify: { owner: async (t) => notified.push(t) }, chatId: 'x', onHandoff: () => { handedOff = true; } }
    );
    assert.strictEqual(res.ok, true);
    assert.ok(handedOff);
    assert.strictEqual(notified.length, 1);
  });
});

describe('agent.js with the Studio tools injected', () => {
  test('uses the Studio schemas, not the Party ones', async () => {
    const seenTools = [];
    const openai = {
      chat: {
        completions: {
          create: async ({ tools }) => {
            seenTools.push(tools.map((t) => t.function.name));
            return { choices: [{ message: text('Hoi!') }] };
          },
        },
      },
    };
    const agent = createAgent({ openai, knowledge, guards, tools: studioTools, config: { maxRetries: 0 } });
    await agent.reply({ message: 'hallo' });
    assert.ok(seenTools[0].includes('check_appointment_slot'));
    assert.ok(!seenTools[0].includes('search_products'), 'Party-only tool must not leak into the Studio schema');
  });

  test('runs a Studio tool through the agent loop end to end', async () => {
    await db.init(createMemoryBackend());
    settings.load();
    const professional = (await directory.createProfessional({ name: 'Gabriela' })).professional;
    const queue = [
      call('list_professionals', {}),
      text('Gabriela ist verfuegbar.'),
    ];
    const openai = fakeModel(queue);
    const agent = createAgent({ openai, knowledge, guards, tools: studioTools, config: { maxRetries: 0 } });
    const out = await agent.reply({ message: 'wer ist da?', services: { directory } });
    assert.strictEqual(out.toolCalls[0].name, 'list_professionals');
    assert.strictEqual(out.toolCalls[0].result.ok, true);
    assert.strictEqual(out.toolCalls[0].result.professionals[0].name, 'Gabriela');
  });
});
