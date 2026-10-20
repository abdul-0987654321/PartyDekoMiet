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
 * Both WhatsApp numbers (Party, Studio) share one `session` table/sheet, so each
 * business's rows need their own key namespace or Studio's login would overwrite
 * Party's (or clearing one session would wipe both). Party keeps its original,
 * unprefixed keys for backward compatibility with sessions already on disk/sheet;
 * Studio's are namespaced with `studio:`.
 */
function keyPrefix(business) {
  return business === 'studio' ? 'studio:' : '';
}

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

/** Wipes the stored WhatsApp session for one business (after logout), so the next start shows a fresh QR. */
async function clearSession(business = 'party') {
  const prefix = keyPrefix(business);
  for (const row of db.all('session')) {
    // Party (no prefix) must not sweep up Studio's `studio:`-prefixed rows, and vice versa.
    const owns = prefix ? row.key.startsWith(prefix) : !row.key.startsWith('studio:');
    if (owns) db.remove('session', row.key);
  }
  await db.flush();
}

function hasSession(business = 'party') {
  return Boolean(read('creds', business)?.me);
}

module.exports = { useSheetAuthState, clearSession, hasSession };
