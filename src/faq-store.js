'use strict';
/**
 * Owner-editable FAQ, for both businesses.
 *
 * Why this exists: every answer the bot gives has to come from somewhere the
 * owner controls. Services, prices, professionals and locations already do -
 * they are dashboard tables. The FAQ did not: it lived in knowledge/faq.json,
 * which only a developer can change. So every "the bot should also say X" came
 * back to the developer, and until it was deployed the bot handed the question
 * to a human instead.
 *
 * Entries written here are merged into the system prompt alongside the file
 * FAQ, and read on every reply, so a correction is live as soon as it is saved.
 *
 * Mirrors src/studio/directory.js's shape on purpose: same id scheme, same
 * validate-then-write flow, same thin API layer on top.
 */

const db = require('./store/db');

const BUSINESSES = new Set(['party', 'studio']);

function newId() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `F${d}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

const nowIso = () => new Date().toISOString();
const clean = (v) => String(v ?? '').trim();

/** @returns {string|null} an error, or null when the record is usable */
function validate(entry) {
  if (!clean(entry.question)) return 'question is required';
  // An entry with no answer at all would put a question into the prompt with
  // nothing to answer it, which is worse than having no entry.
  if (!clean(entry.answerDe) && !clean(entry.answerEn)) {
    return 'at least one answer (German or English) is required';
  }
  if (entry.business !== undefined && entry.business !== '' && !BUSINESSES.has(entry.business)) {
    return `business must be one of: ${[...BUSINESSES].join(', ')}`;
  }
  return null;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.business]  'party' | 'studio'; omitted returns both
 * @param {boolean} [opts.activeOnly]
 */
function list({ business = null, activeOnly = false } = {}) {
  return db
    .all('faq')
    .filter((f) => !business || (f.business || 'party') === business)
    .filter((f) => !activeOnly || f.active !== false)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

function get(id) {
  return db.get('faq', id) || null;
}

/**
 * The active entries for one business, in the shape the knowledge pack and the
 * prompt already use ({ q, a_de, a_en }), so nothing downstream needs to know
 * whether an answer came from a file or from the dashboard.
 *
 * A missing translation falls back to the other language rather than being left
 * blank: the prompt states both, and an empty one reads to the model as "there
 * is no answer in this language", which is not what the owner meant by leaving
 * one box empty.
 */
function forPrompt(business) {
  return list({ business, activeOnly: true }).map((f) => ({
    q: f.question,
    a_de: clean(f.answerDe) || clean(f.answerEn),
    a_en: clean(f.answerEn) || clean(f.answerDe),
  }));
}

/** Every answer text for one business - the guards' verbatim whitelist. */
function answersFor(business) {
  return forPrompt(business).flatMap((e) => [e.a_de, e.a_en]).filter(Boolean);
}

async function create(args = {}) {
  const problem = validate(args);
  if (problem) return { ok: false, error: problem };
  const record = {
    id: newId(),
    business: BUSINESSES.has(args.business) ? args.business : 'party',
    active: args.active !== false,
    question: clean(args.question),
    answerDe: clean(args.answerDe),
    answerEn: clean(args.answerEn),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.put('faq', record);
  await db.flush();
  return { ok: true, entry: record };
}

async function update(id, patch = {}) {
  const existing = get(id);
  if (!existing) return { ok: false, error: `FAQ entry ${id} not found` };
  const merged = { ...existing, ...patch };
  const problem = validate(merged);
  if (problem) return { ok: false, error: problem };
  const record = {
    ...merged,
    id: existing.id,
    createdAt: existing.createdAt,
    business: BUSINESSES.has(merged.business) ? merged.business : existing.business || 'party',
    question: clean(merged.question),
    answerDe: clean(merged.answerDe),
    answerEn: clean(merged.answerEn),
    updatedAt: nowIso(),
  };
  db.put('faq', record);
  await db.flush();
  return { ok: true, entry: record };
}

async function remove(id) {
  if (!get(id)) return { ok: false, error: `FAQ entry ${id} not found` };
  db.remove('faq', id);
  await db.flush();
  return { ok: true };
}

module.exports = { list, get, forPrompt, answersFor, create, update, remove, validate };
