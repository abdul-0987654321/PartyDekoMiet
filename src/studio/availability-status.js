'use strict';
/**
 * Whether a professional is free right now, as she herself last said.
 *
 * This exists because of one afternoon: a client stayed an hour longer than
 * booked, nobody was told, the next client was sent anyway, and arrived to a
 * closed door. The calendar said she was free. She was not.
 *
 * So this is a second source of truth, and on purpose: the calendar holds what
 * was agreed, this holds what is actually happening in the room. When they
 * disagree, the room wins.
 *
 * Busy holds until she says she is free. No timer: the whole problem being
 * solved is a client staying longer than planned, and a timer would expire
 * exactly then and report her free while she is still working. The cost of
 * that choice is a forgotten "frei", which is why it clears overnight -
 * yesterday's forgotten status must never block today.
 */

const db = require('../store/db');
const log = require('../log');

const nowIso = () => new Date().toISOString();

/** Local calendar day in the studio's own zone. */
function dayIn(timeZone = 'Europe/Zurich', when = new Date()) {
  return when.toLocaleDateString('en-CA', { timeZone });
}

/**
 * Is she busy as far as we know?
 *
 * A status set on an earlier day is ignored: she went home, and nobody says
 * "frei" on the way out. Cleared lazily rather than by a nightly job - there is
 * no scheduler here, and a status is only ever interesting when someone asks.
 */
function isBusy(professional, { timeZone = 'Europe/Zurich', now = new Date() } = {}) {
  if (!professional || professional.availability !== 'busy') return false;
  if (!professional.busySince) return true;
  return String(professional.busySince).slice(0, 10) === dayIn(timeZone, now)
    || dayIn(timeZone, new Date(professional.busySince)) === dayIn(timeZone, now);
}

/**
 * @param {object} professional
 * @param {'busy'|'free'} state
 * @param {object} [opts]
 * @param {number|null} [opts.minutes] how long she said she would be
 * @param {string} [opts.note] what she actually said, kept for the dashboard
 * @returns {object} the updated record
 */
function setAvailability(professional, state, { minutes = null, note = '' } = {}) {
  const now = new Date();
  const patch = state === 'busy'
    ? {
        availability: 'busy',
        busySince: professional.availability === 'busy' && professional.busySince
          ? professional.busySince // already busy: keep when it started
          : now.toISOString(),
        busyUntil: minutes ? new Date(now.getTime() + minutes * 60000).toISOString() : '',
        busyNote: String(note || '').slice(0, 200),
      }
    : { availability: 'free', busySince: '', busyUntil: '', busyNote: '' };

  const updated = { ...professional, ...patch, updatedAt: nowIso() };
  db.put('professionals', updated);
  log.info(`[studio] ${professional.name} is now ${state}${minutes ? ` (~${minutes} min)` : ''}.`);
  return db.get('professionals', professional.id);
}

/** Everyone, with a flag saying whether she is working right now. */
function roster({ timeZone = 'Europe/Zurich', now = new Date() } = {}) {
  return db
    .all('professionals')
    .filter((p) => p.active !== false)
    .map((p) => ({
      id: p.id,
      name: p.name,
      busy: isBusy(p, { timeZone, now }),
      since: isBusy(p, { timeZone, now }) ? p.busySince : '',
      until: isBusy(p, { timeZone, now }) ? p.busyUntil : '',
      note: isBusy(p, { timeZone, now }) ? p.busyNote : '',
      hasOwnNumber: Boolean(p.whatsapp),
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** The ids of everyone currently in a room, for the availability check. */
function busyProfessionalIds(opts = {}) {
  return db
    .all('professionals')
    .filter((p) => isBusy(p, opts))
    .map((p) => p.id);
}

module.exports = { isBusy, setAvailability, roster, busyProfessionalIds, dayIn };
