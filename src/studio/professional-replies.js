'use strict';
/**
 * A professional answering an alert about her own appointment.
 *
 * She is told on her own WhatsApp that a request has come in, and answers J or
 * N. That answer must do two things and nothing else: change the appointment,
 * and tell her it worked. In particular it must never reach the customer, and
 * must never be handed to the model - she is not a customer, and a sentence
 * like "nein, ich kann nicht" answered by a sales assistant would be absurd.
 *
 * So this is a parser with a very small vocabulary and no cleverness. Anything
 * it does not recognise is answered with one line explaining the two words it
 * does, and nothing else happens. Guessing at intent here would mean cancelling
 * somebody's appointment on a maybe.
 *
 * Identifying which appointment: every alert carries the appointment's code, and
 * an answer may name it. When it does not, and exactly one request of hers is
 * open, that is the one - which is the normal case. When several are open she is
 * asked which, with the codes listed, rather than the newest being assumed.
 */

const db = require('../store/db');

const YES = new Set(['j', 'ja', 'y', 'yes', 'ok', 'okay', 'jap', 'jo', 'si', 'oui', '✅', '👍']);
const NO = new Set(['n', 'nein', 'no', 'nope', 'nee', 'non', '❌', '👎']);

/** Appointment codes look like A20261121-AB12C. */
const CODE = /\b(A\d{8}-[A-Z0-9]{5})\b/i;

/**
 * @param {string} text what she wrote
 * @returns {{action: 'confirm'|'cancel'|null, code: string|null}}
 */
function parseReply(text) {
  const raw = String(text || '').trim();
  const code = (raw.match(CODE) || [])[1] || null;

  // The code is removed before looking for the word, so "J A2026..." is a plain
  // yes. Punctuation goes too: "Ja!" and "ja." are the same answer.
  const words = raw
    .replace(CODE, ' ')
    .toLowerCase()
    .replace(/[.,!?;:"']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  // Only a short answer counts. A sentence that happens to contain "ja" is a
  // sentence, not a command, and must not cancel anybody's appointment.
  if (words.length === 0 || words.length > 2) return { action: null, code };
  const first = words[0];
  if (YES.has(first)) return { action: 'confirm', code };
  if (NO.has(first)) return { action: 'cancel', code };
  return { action: null, code };
}

/** Her still-open requests, newest first. */
function openFor(professionalId) {
  return db
    .all('appointments')
    .filter((a) => a.status === 'PENDING' && a.professionalId === professionalId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * Carries out what she answered.
 *
 * @param {object} deps
 * @param {object} deps.professional her record
 * @param {string} deps.text
 * @param {object} deps.appointments the appointments service (setStatus)
 * @param {object} deps.m the message texts in the dashboard's language
 * @returns {Promise<{reply: string, changed: object|null, action: string|null}>}
 *   `reply` is what to send her. Always something: silence after answering an
 *   alert is indistinguishable from the thing being broken.
 */
async function applyReply({ professional, text, appointments, m }) {
  const { action, code } = parseReply(text);
  if (!action) return { reply: m.proHelp, changed: null, action: null };

  const open = openFor(professional.id);
  if (!open.length) return { reply: m.proNothingOpen, changed: null, action: null };

  let appt;
  if (code) {
    appt = open.find((a) => a.id.toUpperCase() === code.toUpperCase());
    if (!appt) return { reply: m.proUnknownCode(code), changed: null, action: null };
  } else if (open.length === 1) {
    appt = open[0];
  } else {
    return { reply: m.proWhich(open), changed: null, action: null };
  }

  const status = action === 'confirm' ? 'CONFIRMED' : 'CANCELLED';
  const res = await appointments.setStatus(appt.id, status);
  if (!res.ok) return { reply: m.proHelp, changed: null, action: null };

  const updated = res.appointment;
  return {
    reply: action === 'confirm' ? m.proConfirmed(updated) : m.proCancelled(updated),
    changed: updated,
    action,
  };
}

module.exports = { parseReply, openFor, applyReply, YES, NO };
