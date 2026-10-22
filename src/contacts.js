'use strict';
/**
 * WhatsApp increasingly addresses people by a hidden id ("LID", e.g.
 * 150375495651422@lid) instead of their phone number. Replies still work with
 * that id, but the owner cannot call it, so alerts, bookings and the dashboard
 * showed a number that is not a phone number.
 *
 * Baileys gives the real number alongside (senderPn / remoteJidAlt) when it
 * knows it. It is saved on the customer row and shown wherever a number is shown.
 */

const db = require('./store/db');
const customers = require('./customers');

const digits = (s) => String(s || '').replace(/[^0-9]/g, '');
const userPart = (jid) => String(jid || '').split('@')[0].split(':')[0];

/** The real phone number carried by an incoming message, if WhatsApp sent one. */
function phoneFromMessage(msg) {
  const key = msg?.key || {};
  for (const alt of [key.senderPn, key.remoteJidAlt, key.participantPn, key.participantAlt]) {
    if (typeof alt === 'string' && alt.endsWith('@s.whatsapp.net')) return digits(userPart(alt));
  }
  const jid = key.remoteJid || '';
  return jid.endsWith('@s.whatsapp.net') ? digits(userPart(jid)) : null;
}

/** Saves the phone number and WhatsApp name of the person behind a chat. */
/**
 * @param {'party'|'studio'} business whose customer this is. It used to default
 *   to 'party' for every message, on both bots, so a studio client was filed
 *   under the rental shop the moment they said hello.
 */
function remember(business, msg) {
  try {
    const jid = msg?.key?.remoteJid;
    if (!jid || msg.key.fromMe) return;
    const phone = phoneFromMessage(msg);
    const pushName = msg.pushName || null;
    const row = customers.get(business, jid);
    if (row && (!phone || row.phone === phone) && (!pushName || row.pushName === pushName)) return;
    customers.save(business, jid, {
      ...(phone ? { phone } : {}),
      ...(pushName ? { pushName } : {}),
    });
  } catch {
    /* storage not ready: showing the id is the fallback */
  }
}

/** The number to show for a chat: the real phone when known, else the id. */
function phoneOf(business, jid) {
  try {
    // A caller that does not know the business (alert formatting, say) passes
    // null: the phone number is the same person either way, so look in both
    // rather than guessing one and showing a raw WhatsApp id.
    const rows = business
      ? [customers.get(business, jid)]
      : [customers.get('party', jid), customers.get('studio', jid)];
    const row = rows.find((r) => r?.phone);
    if (row?.phone && /^\d{8,15}$/.test(String(row.phone))) return String(row.phone);
  } catch {
    /* no storage */
  }
  return userPart(jid);
}

module.exports = { phoneFromMessage, remember, phoneOf };
