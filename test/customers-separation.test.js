'use strict';
/**
 * One person, two businesses, one shared Google Sheet.
 *
 * The owner's requirement, in his words: the same contact may write to both
 * numbers, but the two sets of data must never run into each other - the
 * decoration side stays on the decoration side, the studio side on the studio
 * side.
 *
 * It did not hold. `customers` was keyed by jid alone, so one phone number was
 * ONE row: whichever bot wrote last owned the name, and the `business` tag
 * flipped under the other one. A studio client's name could overwrite a party
 * customer's, and the studio's dashboard would show an occasion and a party
 * date that belong to the rental shop.
 *
 * These tests are the guarantee. If the key ever goes back to a bare jid, they
 * fail.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const customers = require('../src/customers');
const contacts = require('../src/contacts');

const JID = '41791234567@s.whatsapp.net';

beforeEach(async () => {
  await db.init(createMemoryBackend());
});

describe('the same person on both numbers', () => {
  test('is two records, not one', () => {
    customers.save('party', JID, { name: 'Anna (Deko)', occasion: 'Geburtstag' });
    customers.save('studio', JID, { name: 'Anna (Studio)' });

    assert.strictEqual(customers.get('party', JID).name, 'Anna (Deko)');
    assert.strictEqual(customers.get('studio', JID).name, 'Anna (Studio)');
    assert.strictEqual(db.all('customers').length, 2);
  });

  test('writing one never touches the other', () => {
    customers.save('party', JID, { name: 'Anna', occasion: 'Geburtstag', partyDate: '2026-11-01' });
    customers.save('studio', JID, { name: 'A.' });

    const party = customers.get('party', JID);
    assert.strictEqual(party.occasion, 'Geburtstag');
    assert.strictEqual(party.partyDate, '2026-11-01');
    assert.strictEqual(party.name, 'Anna', 'the studio must not have renamed the party customer');
  });

  test('party details never appear on the studio record', () => {
    customers.save('party', JID, { name: 'Anna', occasion: 'Geburtstag', childAge: 6, partyDate: '2026-11-01' });
    customers.save('studio', JID, { name: 'Anna' });

    const studio = customers.get('studio', JID);
    for (const field of ['occasion', 'childAge', 'partyDate']) {
      assert.strictEqual(studio[field], undefined, `the studio record must not carry ${field}`);
    }
  });

  test('each business lists only its own', () => {
    customers.save('party', JID, { name: 'Anna' });
    customers.save('studio', JID, { name: 'Anna' });
    customers.save('studio', '41760000000@s.whatsapp.net', { name: 'Bea' });

    assert.deepStrictEqual(customers.list('party').map((c) => c.name), ['Anna']);
    assert.deepStrictEqual(customers.list('studio').map((c) => c.name).sort(), ['Anna', 'Bea']);
  });

  test('the business tag cannot be flipped by the other side', () => {
    customers.save('party', JID, { name: 'Anna' });
    customers.save('studio', JID, { name: 'Anna' });
    assert.strictEqual(customers.get('party', JID).business, 'party');
    assert.strictEqual(customers.get('studio', JID).business, 'studio');
  });
});

describe('remembering a contact files it under the right bot', () => {
  const msg = (jid, pushName) => ({ key: { remoteJid: jid, fromMe: false }, pushName });

  test('a studio message does not create a party customer', () => {
    contacts.remember('studio', msg(JID, 'Anna'));
    assert.strictEqual(customers.get('studio', JID).pushName, 'Anna');
    assert.strictEqual(customers.get('party', JID), null, 'saying hello to the studio is not a party customer');
  });

  test('both bots can remember the same person independently', () => {
    contacts.remember('party', msg(JID, 'Anna'));
    contacts.remember('studio', msg(JID, 'Anna S.'));
    assert.strictEqual(customers.get('party', JID).pushName, 'Anna');
    assert.strictEqual(customers.get('studio', JID).pushName, 'Anna S.');
  });
});

describe('rows written before the key changed', () => {
  test('an old record with no id lands under its own business', async () => {
    // Drain anything the previous test left queued, so it cannot be written
    // into the backend this test is about to create.
    await db.flush();
    // What the Sheet already holds: keyed by jid, with a business field.
    const backend = createMemoryBackend();
    await db.init(backend);
    db.put('customers', { jid: JID, business: 'studio', name: 'Alt', createdAt: 'x' });
    await db.flush();
    await db.init(backend); // reload, as a restart would

    assert.strictEqual(customers.get('studio', JID).name, 'Alt');
    assert.strictEqual(customers.get('party', JID), null, 'it must not be read as a party customer');
  });

  test('an old record with no business at all is treated as party', async () => {
    await db.flush();
    const backend = createMemoryBackend();
    await db.init(backend);
    db.put('customers', { jid: JID, name: 'Ur-Kunde' });
    await db.flush();
    await db.init(backend);

    assert.strictEqual(customers.get('party', JID).name, 'Ur-Kunde');
    assert.strictEqual(customers.get('studio', JID), null);
  });
});

describe('everything else that is shared stays separated too', () => {
  test('chat rows carry the business they belong to', () => {
    for (const business of ['party', 'studio']) {
      db.put('chat', { id: `c-${business}`, business, jid: JID, at: '2026-10-23T00:00:00Z', direction: 'in', text: business });
    }
    const forStudio = db.all('chat').filter((m) => (m.business || 'party') === 'studio' && m.jid === JID);
    assert.deepStrictEqual(forStudio.map((m) => m.text), ['studio']);
  });
});
