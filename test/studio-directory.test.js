'use strict';
/**
 * Studio directory: professionals, services and locations are owner-editable
 * records, not settings or knowledge files. These tests cover validation,
 * create/update/remove, and the combined profile the agent reads before
 * answering about any one professional.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const directory = require('../src/studio/directory');

beforeEach(async () => {
  await db.init(createMemoryBackend());
});

describe('professionals', () => {
  test('name is required', async () => {
    const res = await directory.createProfessional({});
    assert.strictEqual(res.ok, false);
  });

  test('age outside 18-99 is rejected', async () => {
    const res = await directory.createProfessional({ name: 'Gabriela', age: 15 });
    assert.strictEqual(res.ok, false);
  });

  test('create, list and update a professional', async () => {
    const created = await directory.createProfessional({
      name: 'Gabriela', age: 28, languages: 'Portuguese, German', locationId: 'L1',
    });
    assert.strictEqual(created.ok, true);
    assert.deepStrictEqual(created.professional.languages, ['Portuguese', 'German']);
    assert.strictEqual(created.professional.active, true);

    const list = directory.listProfessionals();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'Gabriela');

    const updated = await directory.updateProfessional(created.professional.id, { workingHours: 'Mo-Fr 10-18' });
    assert.strictEqual(updated.ok, true);
    assert.strictEqual(updated.professional.workingHours, 'Mo-Fr 10-18');
    // Unrelated fields survive a partial update.
    assert.strictEqual(updated.professional.name, 'Gabriela');
  });

  test('activeOnly filters out deactivated professionals', async () => {
    const a = await directory.createProfessional({ name: 'Sofia' });
    await directory.createProfessional({ name: 'Lula' });
    await directory.updateProfessional(a.professional.id, { active: false });

    const activeList = directory.listProfessionals({ activeOnly: true });
    assert.strictEqual(activeList.length, 1);
    assert.strictEqual(activeList[0].name, 'Lula');
  });

  test('updating an unknown id fails cleanly', async () => {
    const res = await directory.updateProfessional('nope', { name: 'X' });
    assert.strictEqual(res.ok, false);
  });

  test('removing a professional', async () => {
    const created = await directory.createProfessional({ name: 'Gabriela' });
    const res = await directory.removeProfessional(created.professional.id);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(directory.getProfessional(created.professional.id), null);
  });
});

describe('services', () => {
  test('name is required, duration and price are validated', async () => {
    assert.strictEqual((await directory.createService({})).ok, false);
    assert.strictEqual((await directory.createService({ name: 'Massage', durationMin: -5 })).ok, false);
    assert.strictEqual((await directory.createService({ name: 'Massage', priceChf: -10 })).ok, false);
  });

  test('a service with no professionalId applies to everyone', async () => {
    const p = await directory.createProfessional({ name: 'Gabriela' });
    await directory.createService({ name: 'Ganzkoerpermassage', durationMin: 60, priceChf: 250 });
    await directory.createService({
      name: 'Nur fuer Gabriela', professionalId: p.professional.id, durationMin: 30, priceChf: 100,
    });
    await directory.createService({ name: 'Nur fuer jemand anderes', professionalId: 'P-OTHER', durationMin: 30, priceChf: 100 });

    const hers = directory.listServices({ professionalId: p.professional.id });
    const names = hers.map((s) => s.name).sort();
    assert.deepStrictEqual(names, ['Ganzkoerpermassage', 'Nur fuer Gabriela']);
  });
});

describe('locations', () => {
  test('name is required', async () => {
    assert.strictEqual((await directory.createLocation({})).ok, false);
  });

  test('create and update', async () => {
    const created = await directory.createLocation({ name: 'Schaffhauserstrasse', address: 'Schaffhauserstrasse 280, 8050 Zuerich' });
    assert.strictEqual(created.ok, true);
    const updated = await directory.updateLocation(created.location.id, { address: 'Haringstrasse 19, 8002 Zuerich' });
    assert.strictEqual(updated.location.address, 'Haringstrasse 19, 8002 Zuerich');
  });
});

describe('profileFor: what the agent reads before answering about a professional', () => {
  test('combines her record, her services (own + shared) and her location', async () => {
    const loc = await directory.createLocation({ name: 'Haringstrasse', address: 'Haringstrasse 19, 8002 Zuerich' });
    const p = await directory.createProfessional({
      name: 'Sofia', age: 26, languages: 'Portuguese, Italian', locationId: loc.location.id,
    });
    await directory.createService({ name: 'Shared Massage', durationMin: 60, priceChf: 150 });
    await directory.createService({ name: 'Sofia Special', professionalId: p.professional.id, durationMin: 90, priceChf: 220 });
    await directory.createService({
      name: 'Inactive', professionalId: p.professional.id, durationMin: 30, priceChf: 50, active: false,
    });

    const profile = directory.profileFor(p.professional.id);
    assert.strictEqual(profile.professional.name, 'Sofia');
    assert.strictEqual(profile.location.address, 'Haringstrasse 19, 8002 Zuerich');
    const serviceNames = profile.services.map((s) => s.name).sort();
    // Inactive service must not appear - the bot must never offer it.
    assert.deepStrictEqual(serviceNames, ['Shared Massage', 'Sofia Special']);
  });

  test('an unknown professional id returns null, never invented data', () => {
    assert.strictEqual(directory.profileFor('nope'), null);
  });
});
