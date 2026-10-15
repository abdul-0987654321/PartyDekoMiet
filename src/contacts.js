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
function remember(msg) {
  try {
    const jid = msg?.key?.remoteJid;
    if (!jid || msg.key.fromMe) return;
    const phone = phoneFromMessage(msg);
    const pushName = msg.pushName || null;
    const row = db.get('customers', jid);
    if (row && (!phone || row.phone === phone) && (!pushName || row.pushName === pushName)) return;
    db.put('customers', {
      ...(row || { jid, createdAt: new Date().toISOString() }),
      jid,
      ...(phone ? { phone } : {}),
      ...(pushName ? { pushName } : {}),
      updatedAt: new Date().toISOString(),
    });
  } catch {
    /* storage not ready: showing the id is the fallback */
  }
}

/** The number to show for a chat: the real phone when known, else the id. */
function phoneOf(jid) {
  try {
    const row = db.get('customers', jid);
    if (row?.phone && /^\d{8,15}$/.test(String(row.phone))) return String(row.phone);
  } catch {
    /* no storage */
  }
  return userPart(jid);
}

module.exports = { phoneFromMessage, remember, phoneOf };
