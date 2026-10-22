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

describe('service details and photos', () => {
  // Live chat: "Can you provide full details of home service" was answered with
  // "I'm unable to retrieve the full details" - twice. The details existed in
  // the service's notes field; the tools simply never returned it. And a photo
  // uploaded in the dashboard could not be sent at all, because no tool sent one.
  let pro, svc;

  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
    pro = (await directory.createProfessional({ name: 'Gabriela', workingHours: 'Mo-Fr 10-18' })).professional;
    svc = (await directory.createService({
      name: 'Home', durationMin: 60, priceChf: 100,
      notes: 'Ganzkoerpermassage mit warmem Oel, inkl. Dusche.',
    })).service;
  });

  test('list_services carries what the service includes', async () => {
    const res = await runTool('list_services', {}, { directory });
    assert.strictEqual(res.services[0].details, 'Ganzkoerpermassage mit warmem Oel, inkl. Dusche.');
  });

  test('get_professional_profile carries the details and the working hours', async () => {
    const res = await runTool('get_professional_profile', { professional_id: pro.id }, { directory });
    assert.strictEqual(res.services[0].details, svc.notes);
    assert.strictEqual(res.professional.workingHours, 'Mo-Fr 10-18');
  });

  test('a service with no notes reports an empty string, never undefined', async () => {
    const bare = (await directory.createService({ name: 'Bare', priceChf: 50 })).service;
    const res = await runTool('list_services', {}, { directory });
    assert.strictEqual(res.services.find((s) => s.id === bare.id).details, '');
  });

  test('hasPhoto is false until one is uploaded, then true', async () => {
    let res = await runTool('get_professional_profile', { professional_id: pro.id }, { directory });
    assert.strictEqual(res.professional.hasPhoto, false);

    await directory.updateProfessional(pro.id, { photoFileId: 'FILE123' });
    res = await runTool('get_professional_profile', { professional_id: pro.id }, { directory });
    assert.strictEqual(res.professional.hasPhoto, true);
  });

  test('send_professional_photo forwards the stored photo', async () => {
    await directory.updateProfessional(pro.id, { photoFileId: 'FILE123' });
    const sent = [];
    const photos = { sendProfessional: async (chatId, professional, note) => sent.push({ chatId, professional, note }) };
    const res = await runTool('send_professional_photo', { professional_id: pro.id, note: 'Das ist Gabriela' }, { directory, photos, chatId: 'c1' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(sent[0].professional.name, 'Gabriela');
    assert.strictEqual(sent[0].note, 'Das ist Gabriela');
  });

  test('with no photo on file it refuses, and tells the bot not to describe her', async () => {
    const res = await runTool('send_professional_photo', { professional_id: pro.id }, { directory, photos: {} });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /kein Foto/);
    assert.match(res.error, /beschreibe sie nicht/i);
  });
});

describe('a price can never be mixed up with a duration', () => {
  // Live: a CHF 1000 service was quoted to a customer as "15 minutes, 10 CHF",
  // and in the same conversation as "1000 CHF" from a different tool. Two bare
  // unlabelled numbers in the tool result were enough to swap them.
  let svc;

  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
    svc = (await directory.createService({ name: 'Sofia', durationMin: 15, priceChf: 1000 })).service;
  });

  test('list_services spells both out, and keeps the numbers too', async () => {
    const [s] = (await runTool('list_services', {}, { directory })).services;
    assert.strictEqual(s.price, 'CHF 1000.-');
    assert.strictEqual(s.duration, '15 Minuten');
    assert.strictEqual(s.priceChf, 1000);
    assert.strictEqual(s.durationMin, 15);
  });

  test('the spelled-out price never carries the duration digits', async () => {
    const [s] = (await runTool('list_services', {}, { directory })).services;
    assert.ok(!s.price.includes('15'), s.price);
    assert.ok(!s.duration.includes('1000'), s.duration);
  });

  test('a missing price says so instead of reading as zero or blank', async () => {
    await directory.updateService(svc.id, { priceChf: '' });
    const [s] = (await runTool('list_services', {}, { directory })).services;
    assert.match(s.price, /kein Preis/);
    assert.strictEqual(s.priceChf, null);
  });
});

describe('get_service: asking about one service by name', () => {
  // Live: "I want Sofia details" -> "It seems I'm unable to retrieve the
  // details for the Sofia service" - there was no tool that answered that.
  let pro, svc;

  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
    pro = (await directory.createProfessional({ name: 'Sofia', languages: 'en', workingHours: 'Mo-Do 9-10' })).professional;
    svc = (await directory.createService({
      name: 'Sofia', durationMin: 15, priceChf: 1000, notes: 'Ganzkoerper, 15 Minuten.',
    })).service;
  });

  test('returns the description, price and duration together', async () => {
    const res = await runTool('get_service', { service_id: svc.id }, { directory });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.service.details, 'Ganzkoerper, 15 Minuten.');
    assert.strictEqual(res.service.price, 'CHF 1000.-');
  });

  test('a service with no professional set is offered by everyone', async () => {
    const res = await runTool('get_service', { service_id: svc.id }, { directory });
    assert.deepStrictEqual(res.offeredBy.map((p) => p.name), ['Sofia']);
  });

  test('a service tied to one professional lists only her', async () => {
    await directory.createProfessional({ name: 'Gabriela' });
    await directory.updateService(svc.id, { professionalId: pro.id });
    const res = await runTool('get_service', { service_id: svc.id }, { directory });
    assert.deepStrictEqual(res.offeredBy.map((p) => p.name), ['Sofia']);
  });

  test('with no description it says so rather than inviting an invention', async () => {
    await directory.updateService(svc.id, { notes: '' });
    const res = await runTool('get_service', { service_id: svc.id }, { directory });
    assert.strictEqual(res.service.details, '');
    assert.match(res.note, /Erfinde keine Beschreibung/);
  });

  test('an unknown id is an error, not an empty answer', async () => {
    assert.strictEqual((await runTool('get_service', { service_id: 'nope' }, { directory })).ok, false);
  });
});

describe('a tool call that names the record instead of its id', () => {
  // Live, twice: "Sofia detail" -> "I'm currently unable to retrieve the
  // details for the Sofia service". get_service existed and worked; the model
  // passed "Sofia" where an id like S20261022-4F2QX was expected, and a strict
  // lookup turned a record that was on screen into "not found".
  let sofia, gabriela;

  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
    gabriela = (await directory.createProfessional({ name: 'Gabriela' })).professional;
    sofia = (await directory.createService({ name: 'Sofia', durationMin: 15, priceChf: 1000, notes: 'Ganzkoerper.' })).service;
  });

  test('get_service accepts the service name', async () => {
    const res = await runTool('get_service', { service_id: 'Sofia' }, { directory });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.service.details, 'Ganzkoerper.');
  });

  test('the id still works, and wins over a name', async () => {
    const res = await runTool('get_service', { service_id: sofia.id }, { directory });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.service.id, sofia.id);
  });

  test('matching is case-insensitive and tolerates a partial name', async () => {
    assert.strictEqual((await runTool('get_service', { service_id: 'sofia' }, { directory })).ok, true);
    assert.strictEqual((await runTool('get_service', { service_id: 'Sof' }, { directory })).ok, true);
  });

  test('get_professional_profile accepts her name', async () => {
    const res = await runTool('get_professional_profile', { professional_id: 'Gabriela' }, { directory });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.professional.name, 'Gabriela');
  });

  test('an ambiguous name asks which one, rather than guessing', async () => {
    await directory.createService({ name: 'Sofia Deluxe', priceChf: 2000 });
    const res = await runTool('get_service', { service_id: 'Sofia' }, { directory });
    // "Sofia" is still an exact match for exactly one of them, so that resolves...
    assert.strictEqual(res.ok, true);

    const vague = await runTool('get_service', { service_id: 'Sofi' }, { directory });
    assert.strictEqual(vague.ok, false);
    assert.match(vague.error, /mehrere/);
    assert.match(vague.error, /Sofia, Sofia Deluxe/);
  });

  test('a name that really is not there lists what does exist', async () => {
    const res = await runTool('get_service', { service_id: 'Massage' }, { directory });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /Vorhanden: Sofia/);
  });

  test('an empty directory says so instead of listing nothing', async () => {
    await directory.removeService(sofia.id);
    const res = await runTool('get_service', { service_id: 'Sofia' }, { directory });
    assert.match(res.error, /noch kein Service/i);
  });

  test('send_professional_photo resolves a name too', async () => {
    await directory.updateProfessional(gabriela.id, { photoFileId: 'F1' });
    const sent = [];
    const photos = { sendProfessional: async (c, p) => sent.push(p.name) };
    const res = await runTool('send_professional_photo', { professional_id: 'Gabriela' }, { directory, photos, chatId: 'c1' });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(sent, ['Gabriela']);
  });
});

describe('the photo is sent by the lookup, not left to the model', () => {
  // Live, twice: asked for a professional's details, got text and no picture -
  // the model skipped the instruction to send one. Telling it harder is not a
  // fix, so the lookup sends the photo itself.
  let pro, svc, sent, photos;

  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
    pro = (await directory.createProfessional({ name: 'Sofia', photoFileId: 'F1' })).professional;
    svc = (await directory.createService({ name: 'Sofia', priceChf: 1000, notes: 'Ganzkoerper.' })).service;
    sent = [];
    photos = { sendForAnswer: async (chatId, people) => { sent.push(...people.map((p) => p.name)); return people.map((p) => p.name); } };
  });

  test('get_professional_profile sends her photo without being asked', async () => {
    const res = await runTool('get_professional_profile', { professional_id: 'Sofia' }, { directory, photos, chatId: 'c1' });
    assert.deepStrictEqual(sent, ['Sofia']);
    assert.deepStrictEqual(res.photoSent, ['Sofia']);
  });

  test('get_service sends it when the service belongs to one person', async () => {
    await directory.updateService(svc.id, { professionalId: pro.id });
    const res = await runTool('get_service', { service_id: 'Sofia' }, { directory, photos, chatId: 'c1' });
    assert.deepStrictEqual(res.photoSent, ['Sofia']);
    assert.match(res.note, /NICHT noch einmal/);
  });

  test('a service everyone offers does not fire off every photo', async () => {
    await directory.createProfessional({ name: 'Gabriela', photoFileId: 'F2' });
    const res = await runTool('get_service', { service_id: 'Sofia' }, { directory, photos, chatId: 'c1' });
    assert.deepStrictEqual(sent, [], 'a pile of pictures nobody asked for');
    assert.deepStrictEqual(res.photoSent, []);
    assert.match(res.note, /Mehrere Personen/);
  });

  test('the answer still comes back when sending the photo fails', async () => {
    const broken = { sendForAnswer: async () => { throw new Error('WhatsApp down'); } };
    await assert.rejects(() => broken.sendForAnswer(), /WhatsApp down/); // the stub really does throw
    const forgiving = { sendForAnswer: async () => [] };
    const res = await runTool('get_professional_profile', { professional_id: 'Sofia' }, { directory, photos: forgiving, chatId: 'c1' });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.photoSent, []);
  });

  test('with no photos wired at all the lookup still answers', async () => {
    const res = await runTool('get_professional_profile', { professional_id: 'Sofia' }, { directory });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.photoSent, []);
  });
});
