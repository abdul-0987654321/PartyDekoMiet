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

const read = (key) => {
  const row = db.get('session', key);
  return row?.value ? JSON.parse(row.value, BufferJSON.reviver) : null;
};
const write = (key, value) => db.put('session', { key, value: JSON.stringify(value, BufferJSON.replacer) });

function useSheetAuthState() {
  const creds = read('creds') || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              if (value) write(`${type}-${id}`, value);
              else db.remove('session', `${type}-${id}`);
            }
          }
        },
      },
    },
    saveCreds: async () => {
      write('creds', creds);
      await db.flush(); // creds changes (e.g. after QR scan) are critical — persist immediately
    },
  };
}

/** Wipes the stored WhatsApp session (after logout), so the next start shows a fresh QR. */
async function clearSession() {
  for (const row of db.all('session')) db.remove('session', row.key);
  await db.flush();
}

function hasSession() {
  return Boolean(read('creds')?.me);
}

module.exports = { useSheetAuthState, clearSession, hasSession };
