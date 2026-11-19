'use strict';
/**
 * Baileys auth state stored in the `session` table of the Google Sheet instead of
 * local files (same layout as Baileys' useMultiFileAuthState: "creds" plus
 * "<type>-<id>" keys).
 *
 * Render's free instances have no persistent disk, so file-based auth would mean
 * a new QR scan after every deploy. Credential changes are flushed immediately
 * rather than batched, because losing them costs the owner a QR scan.
 */

const { initAuthCreds, BufferJSON, proto } = require('@itsliaaa/baileys');
const db = require('../store/db');

/**
 * Every WhatsApp number shares this one `session` table, so each number's rows
 * need their own key namespace - otherwise one login overwrites another, or
 * clearing one session wipes them all. The rules live in session-keys.js,
 * which has no dependencies and can be tested without Baileys installed.
 */
const { keyPrefix, ownedBy } = require('./session-keys');

const read = (key, business) => {
  const row = db.get('session', keyPrefix(business) + key);
  return row?.value ? JSON.parse(row.value, BufferJSON.reviver) : null;
};
const write = (key, value, business) =>
  db.put('session', { key: keyPrefix(business) + key, value: JSON.stringify(value, BufferJSON.replacer) });

/** @param {'party'|'studio'} [business] defaults to 'party' - existing callers are unaffected. */
function useSheetAuthState(business = 'party') {
  const creds = read('creds', business) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = read(`${type}-${id}`, business);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              if (value) write(`${type}-${id}`, value, business);
              else db.remove('session', keyPrefix(business) + `${type}-${id}`);
            }
          }
        },
      },
    },
    saveCreds: async () => {
      write('creds', creds, business);
      await db.flush(); // creds changes (e.g. after QR scan) are critical — persist immediately
    },
  };
}

/** Wipes the stored WhatsApp session for one number (after logout), so the next start shows a fresh QR. */
async function clearSession(business = 'party') {
  for (const row of db.all('session')) {
    if (ownedBy(row.key, business)) db.remove('session', row.key);
  }
  await db.flush();
}

function hasSession(business = 'party') {
  return Boolean(read('creds', business)?.me);
}

module.exports = { useSheetAuthState, clearSession, hasSession, keyPrefix, ownedBy };
