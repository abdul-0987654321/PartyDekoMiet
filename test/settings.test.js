'use strict';
/** Settings validation. A bad value saved here would mis-price or mis-date bookings. */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');

beforeEach(async () => {
  await db.init(createMemoryBackend());
  settings.load();
});

describe('defaults', () => {
  test('match the AGB', () => {
    assert.strictEqual(settings.get('rentalDays'), 3);
    assert.strictEqual(settings.get('depositChf'), 50);
    assert.strictEqual(settings.get('lateFeeChf'), 50);
    assert.strictEqual(settings.get('returnDayOffset'), 2);
    assert.strictEqual(settings.get('botEnabled'), true);
  });

  test('describe() reports where each value came from', () => {
    const rows = settings.describe();
    const row = rows.find((r) => r.key === 'rentalDays');
    assert.ok(['env', 'default'].includes(row.source));
    assert.ok(row.label.de && row.label.en, 'every setting needs both languages');
    for (const r of rows) {
      assert.ok(r.label.de, `${r.key} is missing a German label`);
      assert.ok(r.label.en, `${r.key} is missing an English label`);
    }
  });
});

describe('saving', () => {
  test('stores a change and reports it', async () => {
    const res = await settings.update({ depositChf: 60 });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.changed, ['depositChf']);
    assert.strictEqual(settings.get('depositChf'), 60);
  });

  test('survives a reload from storage', async () => {
    await settings.update({ pickupHours: 'Mo-Fr 17:00-19:00' });
    settings.load();
    assert.strictEqual(settings.get('pickupHours'), 'Mo-Fr 17:00-19:00');
  });

  test('reset brings the default back', async () => {
    await settings.update({ depositChf: 99 });
    await settings.reset('depositChf');
    assert.strictEqual(settings.get('depositChf'), 50);
  });

  test('notifies listeners only on a real change', async () => {
    const seen = [];
    settings.onChange((changed) => seen.push(changed));
    await settings.update({ bufferDays: 1 });
    await settings.update({ bufferDays: 1 });
    assert.strictEqual(seen.length, 1);
  });
});

describe('validation', () => {
  test('rejects an unknown key', async () => {
    const res = await settings.update({ nonsense: 1 });
    assert.strictEqual(res.ok, false);
  });

  test('rejects a number outside its range', async () => {
    assert.strictEqual((await settings.update({ bufferDays: 99 })).ok, false);
    assert.strictEqual((await settings.update({ takeoverPauseHours: 0 })).ok, false);
  });

  test('cleans a pasted owner number instead of rejecting it', async () => {
    assert.strictEqual((await settings.update({ ownerWhatsapp: '+41 79 123 45 67' })).ok, true);
    assert.strictEqual(settings.get('ownerWhatsapp'), '41791234567', 'stored without + and spaces');
    assert.strictEqual((await settings.update({ ownerWhatsapp: '41791234567' })).ok, true);
  });

  test('still rejects something that cannot be a phone number', async () => {
    assert.strictEqual((await settings.update({ ownerWhatsapp: '079' })).ok, false);
    assert.strictEqual((await settings.update({ ownerWhatsapp: 'nope' })).ok, false);
  });

  test('rejects an invalid enum value', async () => {
    assert.strictEqual((await settings.update({ botLanguage: 'klingon' })).ok, false);
    assert.strictEqual((await settings.update({ botLanguage: 'en' })).ok, true);
  });

  test('rejects typing min above max', async () => {
    assert.strictEqual((await settings.update({ typingMinMs: 9000, typingMaxMs: 1000 })).ok, false);
  });

  test('requires a deposit link when the mode is "separate"', async () => {
    assert.strictEqual((await settings.update({ depositMode: 'separate' })).ok, false);
    assert.strictEqual(
      (await settings.update({ depositMode: 'separate', depositProductUrl: 'https://x.ch/p/kaution' })).ok,
      true
    );
  });

  test('saves nothing at all when one value in the batch is bad', async () => {
    const before = settings.get('depositChf');
    const res = await settings.update({ depositChf: 77, bufferDays: 999 });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(settings.get('depositChf'), before, 'a rejected batch must not partly apply');
  });
});

describe('alert numbers', () => {
  test('accept one or several international numbers', async () => {
    assert.strictEqual((await settings.update({ alertNumbers: '41791234567' })).ok, true);
    assert.strictEqual((await settings.update({ alertNumbers: '41791234567, 923001234567' })).ok, true);
  });

  test('clean pasted numbers and keep the list', async () => {
    assert.strictEqual((await settings.update({ alertNumbers: '+41 79 123 45 67, +92 300 1234567' })).ok, true);
    assert.strictEqual(settings.get('alertNumbers'), '41791234567, 923001234567');
  });

  test('reject an entry that cannot be a phone number', async () => {
    assert.strictEqual((await settings.update({ alertNumbers: '41791234567, 079' })).ok, false);
  });

  test('empty is allowed - it falls back to the owner number', async () => {
    assert.strictEqual((await settings.update({ alertNumbers: '' })).ok, true);
  });
});
