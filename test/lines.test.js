'use strict';
/**
 * Six WhatsApp numbers in one process.
 *
 * PartyDekoMiet and the Studio were hardcoded. The client bought four more -
 * one per professional - because each woman wants clients writing to her own
 * phone. A line is a number, and a line id is what the rest of the code has
 * always called `business`.
 *
 * What must hold, and what these tests pin:
 *
 *   - the two built-in numbers cannot be deleted or renamed away
 *   - every number's WhatsApp session stays its own, including the session of
 *     a number that has since been deleted
 *   - a professional's number sees her and the studio's shared services, never
 *     another woman's
 *   - her customers are her own, not PartyDekoMiet's
 *
 * Baileys is never required here, so this runs with no node_modules.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const lines = require('../src/lines');
const customers = require('../src/customers');
const { keyPrefix, ownedBy } = require('../src/whatsapp/session-keys');
const { scopeToProfessional } = require('../src/studio/scope');

beforeEach(async () => {
  await db.init(createMemoryBackend());
});

describe('the registry', () => {
  test('the two built-in numbers are always there', () => {
    assert.deepStrictEqual(lines.all().map((l) => l.id), ['party', 'studio']);
    assert.ok(lines.all().every((l) => l.builtIn));
  });

  test('a new number gets an id derived from the name', async () => {
    const { line } = await lines.create({ name: 'Sofia' });
    assert.strictEqual(line.id, 'pro-sofia');
    assert.strictEqual(line.name, 'Sofia');
    assert.strictEqual(line.active, true);
  });

  test('accents and punctuation do not end up in the id', async () => {
    const { line } = await lines.create({ name: 'Rení M.' });
    assert.strictEqual(line.id, 'pro-reni-m');
  });

  test('two professionals with the same name get different numbers', async () => {
    const a = await lines.create({ name: 'Sofia' });
    const b = await lines.create({ name: 'Sofia' });
    assert.notStrictEqual(a.line.id, b.line.id);
    assert.strictEqual(b.line.id, 'pro-sofia-2');
  });

  test('a name is required', async () => {
    assert.strictEqual((await lines.create({ name: '   ' })).ok, false);
  });

  test('the built-in numbers cannot be changed or deleted', async () => {
    for (const id of ['party', 'studio']) {
      assert.strictEqual((await lines.remove(id)).ok, false, `${id} must not be deletable`);
      assert.strictEqual((await lines.update(id, { name: 'X' })).ok, false);
    }
    assert.deepStrictEqual(lines.all().map((l) => l.id), ['party', 'studio']);
  });

  test('there is a ceiling, because every number costs memory', async () => {
    for (let n = 0; n < lines.MAX_PRO_LINES; n += 1) {
      assert.strictEqual((await lines.create({ name: `Nr ${n}` })).ok, true);
    }
    const over = await lines.create({ name: 'one too many' });
    assert.strictEqual(over.ok, false);
    assert.match(over.error, /at most/);
  });

  test('switching a number off keeps it, and takes it out of the active list', async () => {
    const { line } = await lines.create({ name: 'Gabriela' });
    await lines.update(line.id, { active: false });
    assert.ok(lines.all().some((l) => l.id === line.id), 'the owner can still see it');
    assert.ok(!lines.active().some((l) => l.id === line.id), 'but nothing connects it');
  });

  test('a built-in number is never switched off by the active filter', () => {
    assert.deepStrictEqual(lines.active().map((l) => l.id), ['party', 'studio']);
  });

  test('her own alert numbers are cleaned, and nonsense is refused', async () => {
    const { line } = await lines.create({ name: 'Sofia' });
    const ok = await lines.update(line.id, { alertNumbers: '+41 79 123 45 67, 0041760000000' });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.line.alertNumbers, '41791234567, 0041760000000');

    const bad = await lines.update(line.id, { alertNumbers: '123' });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(lines.get(line.id).alertNumbers, '41791234567, 0041760000000', 'the stored value is untouched');
  });

  test('removing one really removes it', async () => {
    const { line } = await lines.create({ name: 'Sofia' });
    assert.strictEqual((await lines.remove(line.id)).ok, true);
    assert.strictEqual(lines.get(line.id), null);
    assert.strictEqual((await lines.remove(line.id)).ok, false, 'and twice is an error, not a crash');
  });
});

describe('session rows stay with their own number', () => {
  test('each number has its own prefix, and Party keeps none', () => {
    assert.strictEqual(keyPrefix('party'), '');
    assert.strictEqual(keyPrefix(undefined), '', 'the old unprefixed session must keep working');
    assert.strictEqual(keyPrefix('studio'), 'studio:');
    assert.strictEqual(keyPrefix('pro-sofia'), 'pro-sofia:');
  });

  test('a row belongs to exactly one number', () => {
    const rows = ['creds', 'studio:creds', 'pro-sofia:creds', 'pro-gabriela:app-state-sync-key-1'];
    for (const row of rows) {
      const owners = ['party', 'studio', 'pro-sofia', 'pro-gabriela'].filter((b) => ownedBy(row, b));
      assert.deepStrictEqual(owners.length, 1, `${row} is claimed by ${owners.join(', ') || 'nobody'}`);
    }
  });

  test('clearing Party does not sweep up anybody else', () => {
    assert.strictEqual(ownedBy('studio:creds', 'party'), false);
    assert.strictEqual(ownedBy('pro-sofia:creds', 'party'), false);
    assert.strictEqual(ownedBy('creds', 'party'), true);
  });

  test('a deleted number leaves rows that Party still will not claim', () => {
    // This is the trap: the line is gone from the table, so "is it a known
    // line" is false - and the rows would fall to Party on the next re-link.
    assert.strictEqual(lines.get('pro-weg'), null);
    assert.strictEqual(ownedBy('pro-weg:creds', 'party'), false);
  });

  test('a prefix that is not a line id is Party\'s, so nothing is stranded', () => {
    assert.strictEqual(ownedBy('app-state-sync-key-AAA', 'party'), true);
    assert.strictEqual(ownedBy('pre-key-7', 'party'), true, 'pre-key must not read as a pro- prefix');
  });
});

describe('a professional only sees her own work', () => {
  const PROS = [
    { id: 'p1', name: 'Sofia', active: true },
    { id: 'p2', name: 'Gabriela', active: true },
  ];
  const SERVICES = [
    { id: 's1', name: 'Sofia 60', professionalId: 'p1', priceChf: 180, active: true },
    { id: 's2', name: 'Gabriela 60', professionalId: 'p2', priceChf: 200, active: true },
    { id: 's3', name: 'Studio-Standard', professionalId: '', priceChf: 150, active: true },
  ];
  const fake = {
    listProfessionals: () => [...PROS],
    getProfessional: (id) => PROS.find((p) => p.id === id) || null,
    listServices: ({ professionalId = null } = {}) =>
      SERVICES.filter((s) => !professionalId || s.professionalId === professionalId),
    getService: (id) => SERVICES.find((s) => s.id === id) || null,
    profileFor: (id) => ({ professional: PROS.find((p) => p.id === id) || null }),
    listLocations: () => [{ id: 'l1', name: 'Zuerich' }],
  };
  const sofia = scopeToProfessional(fake, 'p1');

  test('the team is just her', () => {
    assert.deepStrictEqual(sofia.listProfessionals().map((p) => p.name), ['Sofia']);
    assert.strictEqual(sofia.getProfessional('p2'), null, 'another woman must not be readable');
    assert.strictEqual(sofia.profileFor('p2'), null);
  });

  test('she keeps the studio-wide services, and loses the other woman\'s', () => {
    assert.deepStrictEqual(sofia.listServices().map((s) => s.id).sort(), ['s1', 's3']);
    assert.strictEqual(sofia.getService('s3').priceChf, 150, 'the shared service is hers to offer');
    assert.strictEqual(sofia.getService('s2'), null, "and her colleague's price is not");
  });

  test('asking for someone else by name returns nothing, not everything', () => {
    assert.deepStrictEqual(sofia.listServices({ professionalId: 'p2' }), []);
  });

  test('the Studio number itself is not scoped', () => {
    const studio = scopeToProfessional(fake, '');
    assert.strictEqual(studio, fake, 'no wrapper at all, so nothing can go wrong there');
    assert.strictEqual(studio.listProfessionals().length, 2);
  });
});

describe('the scoping reaches the tools the model actually calls', () => {
  // The filter above is only worth having if it survives the tool layer: the
  // model asks for "the service list" and must get hers, whatever it intended.
  const { runTool } = require('../src/agent/tools/studio');

  const PROS = [
    { id: 'p1', name: 'Sofia', active: true, languages: 'de', workingHours: '', locationId: '' },
    { id: 'p2', name: 'Gabriela', active: true, languages: 'pt', workingHours: '', locationId: '' },
  ];
  const SERVICES = [
    { id: 's1', name: 'Sofia 60', professionalId: 'p1', priceChf: 180, durationMin: 60, active: true, notes: '' },
    { id: 's2', name: 'Gabriela 60', professionalId: 'p2', priceChf: 200, durationMin: 60, active: true, notes: '' },
    { id: 's3', name: 'Standard', professionalId: '', priceChf: 150, durationMin: 60, active: true, notes: '' },
  ];
  const fake = {
    listProfessionals: () => [...PROS],
    getProfessional: (id) => PROS.find((p) => p.id === id) || null,
    listServices: ({ professionalId = null } = {}) =>
      SERVICES.filter((s) => !professionalId || s.professionalId === professionalId),
    getService: (id) => SERVICES.find((s) => s.id === id) || null,
    profileFor: (id) => {
      const professional = PROS.find((p) => p.id === id);
      return professional ? { professional, services: fake.listServices({ professionalId: id }), location: null } : null;
    },
    listLocations: () => [],
  };
  const ctx = () => ({ directory: scopeToProfessional(fake, 'p1'), photos: null, chatId: 'test:1' });

  test('list_services on her number never returns a colleague\'s price', async () => {
    const out = await runTool('list_services', {}, ctx());
    assert.strictEqual(out.ok, true);
    const names = out.services.map((s) => s.name);
    assert.ok(names.includes('Sofia 60') && names.includes('Standard'));
    assert.ok(!names.includes('Gabriela 60'), 'another woman\'s service must not be offered here');
    assert.ok(!JSON.stringify(out).includes('200'), 'nor her price, in any shape');
  });

  test('list_professionals on her number is just her', async () => {
    const out = await runTool('list_professionals', {}, ctx());
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.professionals.map((p) => p.name), ['Sofia']);
  });

  test('asking for a colleague by name is refused, not answered', async () => {
    const out = await runTool('get_professional_profile', { professional_id: 'Gabriela' }, ctx());
    assert.strictEqual(out.ok, false, 'she must not be readable from this number');
    assert.ok(!JSON.stringify(out).includes('200'));
  });
});

describe('customers belong to the number they wrote to', () => {
  const JID = '41791234567@s.whatsapp.net';

  test('a professional\'s client is not a PartyDekoMiet customer', () => {
    customers.save('pro-sofia', JID, { name: 'Marco' });
    assert.strictEqual(customers.get('pro-sofia', JID).name, 'Marco');
    assert.strictEqual(customers.get('party', JID), null);
    assert.strictEqual(customers.get('studio', JID), null);
  });

  test('two professionals keep two records for the same person', () => {
    customers.save('pro-sofia', JID, { name: 'Marco' });
    customers.save('pro-gabriela', JID, { name: 'M.' });
    assert.strictEqual(customers.get('pro-sofia', JID).name, 'Marco');
    assert.strictEqual(customers.get('pro-gabriela', JID).name, 'M.');
    assert.strictEqual(db.all('customers').length, 2);
  });

  test('a deleted number keeps its own customers rather than donating them to Party', () => {
    customers.save('pro-weg', JID, { name: 'Alt' });
    assert.strictEqual(customers.get('party', JID), null);
    assert.strictEqual(customers.get('pro-weg', JID).name, 'Alt');
  });

  test('something that is not a number at all still lands on Party', () => {
    customers.save('nonsense', JID, { name: 'X' });
    assert.strictEqual(customers.get('party', JID).name, 'X');
  });
});
