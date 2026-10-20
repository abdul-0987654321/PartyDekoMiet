'use strict';
/**
 * The two WhatsApp numbers (Party, Studio) share one `session` table/sheet, so
 * Studio's keys must be namespaced or its login would overwrite Party's, and
 * clearing one session must never wipe the other.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const { useSheetAuthState, clearSession, hasSession } = require('../src/whatsapp/auth-state');

beforeEach(async () => {
  await db.init(createMemoryBackend());
});

describe('business-namespaced session keys', () => {
  test('Party keeps its original, unprefixed creds key', async () => {
    const { saveCreds } = useSheetAuthState('party');
    await saveCreds();
    assert.ok(db.get('session', 'creds'), 'Party creds must be stored under the plain "creds" key');
  });

  test('Studio creds are namespaced so they cannot collide with Party\'s', async () => {
    const { saveCreds } = useSheetAuthState('studio');
    await saveCreds();
    assert.ok(db.get('session', 'studio:creds'));
    assert.strictEqual(db.get('session', 'creds'), null);
  });

  test('each business only sees its own session', async () => {
    await useSheetAuthState('party').saveCreds();
    await useSheetAuthState('studio').saveCreds();
    assert.strictEqual(hasSession('party'), false); // initAuthCreds() has no .me yet
    assert.strictEqual(hasSession('studio'), false);
    assert.ok(db.get('session', 'creds'));
    assert.ok(db.get('session', 'studio:creds'));
  });

  test('clearing the Studio session leaves Party untouched, and vice versa', async () => {
    await useSheetAuthState('party').saveCreds();
    await useSheetAuthState('studio').saveCreds();

    await clearSession('studio');
    assert.ok(db.get('session', 'creds'), 'Party session must survive clearing Studio');
    assert.strictEqual(db.get('session', 'studio:creds'), null);

    await useSheetAuthState('studio').saveCreds();
    await clearSession('party');
    assert.strictEqual(db.get('session', 'creds'), null);
    assert.ok(db.get('session', 'studio:creds'), 'Studio session must survive clearing Party');
  });

  test('clearSession() with no argument defaults to Party, unchanged from before', async () => {
    await useSheetAuthState('party').saveCreds();
    await useSheetAuthState('studio').saveCreds();
    await clearSession();
    assert.strictEqual(db.get('session', 'creds'), null);
    assert.ok(db.get('session', 'studio:creds'));
  });
});
