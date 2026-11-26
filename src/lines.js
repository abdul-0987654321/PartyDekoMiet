'use strict';
/**
 * The WhatsApp numbers this process connects.
 *
 * There used to be exactly two, hardcoded: 'party' and 'studio'. The client
 * bought six - PartyDekoMiet, the Studio's own number, and one number per
 * professional, because each woman wants clients writing to her own phone
 * rather than to a shared line.
 *
 * A "line" is one number. Everywhere else in this codebase the variable is
 * still called `business`, because that is what it has always been threaded
 * through as: the auth session prefix, the `business` column on customers,
 * chats and FAQ rows, the device name on the phone. A line id IS a business
 * id. Nothing about the separation rules changes - a professional's line sees
 * her chats and her customers, never the Studio's and never PartyDekoMiet's.
 *
 * Two rules the rest of the code relies on:
 *
 *   1. 'party' and 'studio' are built in. They are not rows, they cannot be
 *      deleted, and 'party' keeps the unprefixed session keys it has used
 *      since the first deploy - renaming those would log the number out.
 *   2. Every other id starts with `pro-`. auth-state.js uses that prefix to
 *      tell whose session rows are whose, including rows left behind by a line
 *      that has since been deleted.
 */

const db = require('./store/db');

const PRO_PREFIX = 'pro-';
/** An id that is a professional line, whether or not that line still exists. */
const PRO_ID = /^pro-[a-z0-9][a-z0-9-]*$/;

/**
 * Five numbers on the Numbers page, and not a sixth.
 *
 * Counted the way the page counts them, PartyDekoMiet and the Studio included:
 * the owner looked at a page showing those two and said two are made and three
 * more should fit, to five. So three professionals can have their own number.
 * The page prints the count next to the button, so if he meant five on top of
 * the built-in two he can see that at a glance and say so.
 *
 * More numbers in one process also means more memory, and the whole thing runs
 * in one 512 MB box.
 */
const MAX_LINES = 5;

const BUILT_IN = Object.freeze([
  Object.freeze({ id: 'party', name: 'PartyDekoMiet', kind: 'party', builtIn: true, active: true, professionalId: '' }),
  Object.freeze({ id: 'studio', name: 'Studio', kind: 'studio', builtIn: true, active: true, professionalId: '' }),
]);
const BUILT_IN_IDS = Object.freeze(BUILT_IN.map((l) => l.id));

const nowIso = () => new Date().toISOString();

/** `Sofia M.` -> `pro-sofia-m`, with a counter if that is taken. */
function idFor(name, taken) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const stem = PRO_PREFIX + (base || 'nummer');
  if (!taken.has(stem)) return stem;
  for (let n = 2; n < 100; n += 1) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
  return `${stem}-${Date.now()}`;
}

function stored() {
  return db.all('lines').map((l) => ({ ...l, kind: 'pro', builtIn: false, active: l.active !== false }));
}

/** Every line, built-in first, in the order the dashboard should show them. */
function all() {
  return [...BUILT_IN.map((l) => ({ ...l })), ...stored()];
}

/** The lines to actually connect. A built-in is never switched off here. */
function active() {
  return all().filter((l) => l.builtIn || l.active);
}

function get(id) {
  return all().find((l) => l.id === id) || null;
}

function isBuiltIn(id) {
  return BUILT_IN_IDS.includes(id);
}

/** True for any id this app may legitimately use as a `business` value. */
function isKnown(id) {
  return isBuiltIn(id) || Boolean(get(id));
}

/**
 * True for an id SHAPED like a professional line, even if the line is gone.
 * auth-state.js needs this: a deleted line's session rows must not be swept up
 * the next time PartyDekoMiet's session is cleared.
 */
function looksLikePro(id) {
  return PRO_ID.test(String(id || ''));
}

/** The name shown on the phone under Linked devices, and in the dashboard. */
function nameOf(id) {
  return get(id)?.name || 'PartyDekoMiet';
}

/** @returns {{ok:true, line:object}|{ok:false, error:string}} */
async function create({ name, professionalId = '' } = {}) {
  const clean = String(name || '').trim();
  if (!clean) return { ok: false, error: 'name is required' };
  if (all().length >= MAX_LINES) {
    // Says the number as well as the limit, because "at most 5" with five
    // already on screen reads like the app has lost count.
    return { ok: false, error: `${MAX_LINES} numbers is the limit, and all ${MAX_LINES} are in use. Delete one to add another.` };
  }
  const taken = new Set(all().map((l) => l.id));
  const line = {
    id: idFor(clean, taken),
    name: clean,
    professionalId: String(professionalId || ''),
    active: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.put('lines', line);
  await db.flush();
  return { ok: true, line: { ...line, kind: 'pro', builtIn: false } };
}

async function update(id, patch = {}) {
  if (isBuiltIn(id)) return { ok: false, error: 'this number is built in' };
  const existing = db.get('lines', id);
  if (!existing) return { ok: false, error: 'not found' };

  const next = { ...existing };
  if (patch.name !== undefined) {
    const clean = String(patch.name).trim();
    if (!clean) return { ok: false, error: 'name is required' };
    next.name = clean;
  }
  if (patch.professionalId !== undefined) next.professionalId = String(patch.professionalId || '');
  if (patch.active !== undefined) next.active = Boolean(patch.active);
  next.updatedAt = nowIso();

  db.put('lines', next);
  await db.flush();
  return { ok: true, line: { ...next, kind: 'pro', builtIn: false } };
}

/**
 * Removing a line is not enough on its own: its WhatsApp session has to go
 * too, or the rows sit in the sheet forever and a new line with the same name
 * would inherit them. The caller (the HTTP layer) stops the client and clears
 * the session; this only drops the row.
 */
async function remove(id) {
  if (isBuiltIn(id)) return { ok: false, error: 'this number is built in' };
  if (!db.get('lines', id)) return { ok: false, error: 'not found' };
  db.remove('lines', id);
  await db.flush();
  return { ok: true };
}

module.exports = {
  all, active, get, create, update, remove,
  isBuiltIn, isKnown, looksLikePro, nameOf,
  BUILT_IN_IDS, PRO_PREFIX, MAX_LINES,
};
