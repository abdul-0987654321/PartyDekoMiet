'use strict';
/**
 * Data layer: everything is held in memory for speed and written through to the
 * Google Sheet (apps-script/Code.gs), because Render's free instances have no
 * persistent disk - the container is wiped on every restart and deploy.
 *
 * Writes are batched: changes are queued and flushed every FLUSH_DELAY_MS in one
 * request, which keeps us inside the Apps Script quotas. On SIGTERM (Render deploy
 * or restart) index.js calls flush() before exiting. The WhatsApp session is the
 * one exception and is flushed immediately, because losing it costs a QR scan.
 *
 * Ported from the united / groupswatsapp bots, where this has been running in
 * production; only the table definitions below are specific to PartyDekoMiet.
 */

const log = require('../log');

const FLUSH_DELAY_MS = Number(process.env.STORAGE_FLUSH_MS || 1500);
const MAX_CELL = 45000; // Google Sheets allows 50,000 characters per cell
const CHUNK_SEP = '__';

/**
 * Table definitions. `key` is the unique column. `view` produces the human-readable
 * columns shown in the sheet; the full record is always stored as JSON in `_json`
 * (except for the session table, which stores Baileys data as-is in `value`).
 */
/**
 * Table definitions. `key` is the unique column. `view` produces the human-readable
 * columns the owner sees in the sheet; the full record is always stored as JSON in
 * `_json`. A `raw` table stores an opaque string in `value` instead (used for the
 * Baileys session and for internal bot state).
 */
/**
 * `business` tags which board a row belongs to: 'party' (PartyDekoMiet) or
 * 'studio' (the massage studio). Both bots write into the same Google Sheet,
 * so every row that can exist for either business carries this tag; the
 * dashboard filters by it, and a row with no tag is treated as 'party' for
 * backward compatibility with data written before this field existed.
 */
const TABLES = {
  session: { key: 'key', raw: true },
  state: { key: 'key', raw: true },
  customers: {
    key: 'jid',
    view: (c) => ({
      jid: c.jid,
      business: c.business || 'party',
      phone: c.phone,
      name: c.name,
      pushName: c.pushName,
      lang: c.lang,
      occasion: c.occasion,
      theme: c.theme,
      childAge: c.childAge,
      partyDate: c.partyDate,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }),
  },
  bookings: {
    key: 'id',
    view: (b) => ({
      id: b.id,
      business: b.business || 'party',
      status: b.status, // PENDING | CONFIRMED | CANCELLED
      jid: b.jid,
      phone: b.phone,
      customerName: b.customerName,
      productId: b.productId,
      productTitle: b.productTitle,
      productUrl: b.productUrl,
      priceChf: b.priceChf,
      pickupDate: b.pickupDate,
      returnDate: b.returnDate,
      occasion: b.occasion,
      childAge: b.childAge,
      themeNotes: b.themeNotes,
      referencePhotoFileId: b.referencePhotoFileId,
      calendarEventId: b.calendarEventId,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    }),
  },
  chat: {
    key: 'id',
    view: (m) => ({
      id: m.id,
      business: m.business || 'party',
      at: m.at,
      jid: m.jid,
      direction: m.direction,
      text: m.text,
      image: m.image || '',
    }),
  },
  // ── Studio (massage studio): editable from the dashboard, no redeploy needed ──
  professionals: {
    key: 'id',
    view: (p) => ({
      id: p.id,
      active: p.active !== false,
      name: p.name,
      age: p.age || '',
      languages: Array.isArray(p.languages) ? p.languages.join(', ') : p.languages || '',
      locationId: p.locationId || '',
      photoFileId: p.photoFileId || '',
      workingHours: p.workingHours || '', // free text per day, owner-edited
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }),
  },
  services: {
    key: 'id',
    view: (s) => ({
      id: s.id,
      professionalId: s.professionalId || '', // empty = offered by every professional
      active: s.active !== false,
      name: s.name,
      durationMin: s.durationMin || '',
      priceChf: s.priceChf || '',
      notes: s.notes || '', // e.g. what a package includes; never invented by the bot
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }),
  },
  // Owner-written question/answer pairs, per business. The knowledge/ folder
  // holds the answers agreed at build time; this table is how the owner adds
  // and corrects answers afterwards without anyone touching the repo. Both
  // sources are merged into the prompt, these last so they win.
  faq: {
    key: 'id',
    view: (f) => ({
      id: f.id,
      business: f.business || 'party',
      active: f.active !== false,
      question: f.question,
      answerDe: f.answerDe || '',
      answerEn: f.answerEn || '',
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    }),
  },
  locations: {
    key: 'id',
    view: (l) => ({
      id: l.id,
      active: l.active !== false,
      name: l.name,
      address: l.address || '',
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
    }),
  },
  appointments: {
    key: 'id',
    view: (a) => ({
      id: a.id,
      status: a.status, // PENDING | CONFIRMED | CANCELLED
      jid: a.jid,
      phone: a.phone,
      customerName: a.customerName,
      professionalId: a.professionalId,
      professionalName: a.professionalName,
      serviceId: a.serviceId,
      serviceName: a.serviceName,
      priceChf: a.priceChf,
      date: a.date, // YYYY-MM-DD
      startTime: a.startTime, // HH:MM, local (Europe/Zurich)
      endTime: a.endTime,
      calendarEventId: a.calendarEventId,
      sourcePortal: a.sourcePortal || '', // which ad/portal the lead came from, if known
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }),
  },
};

let backend = null;
const cache = {}; // table -> Map(key -> record)
const queue = {}; // table -> { upsert: Map(key -> record), remove: Set(key) }
const chunkedCols = {}; // table -> Set(column) that have ever been split
let timer = null;
let flushing = null;
let lastFlushError = null;
let lastFlushAt = null;

for (const t of Object.keys(TABLES)) {
  cache[t] = new Map();
  queue[t] = { upsert: new Map(), remove: new Set() };
  chunkedCols[t] = new Set();
}

// ---------- (de)serialization ----------

function toFlat(table, record) {
  const def = TABLES[table];
  const flat = def.raw ? { key: record.key, value: record.value } : { ...def.view(record), _json: JSON.stringify(record) };
  const out = {};
  for (const [col, val] of Object.entries(flat)) {
    const s = val == null ? '' : String(val);
    if (s.length <= MAX_CELL) {
      out[col] = s;
      if (chunkedCols[table].has(col)) out[col + CHUNK_SEP + 2] = ''; // terminate stale chunks
      continue;
    }
    chunkedCols[table].add(col);
    const parts = Math.ceil(s.length / MAX_CELL);
    for (let i = 0; i < parts; i++) {
      out[i === 0 ? col : col + CHUNK_SEP + (i + 1)] = s.slice(i * MAX_CELL, (i + 1) * MAX_CELL);
    }
    out[col + CHUNK_SEP + (parts + 1)] = '';
  }
  return out;
}

function joinChunks(table, row, col) {
  let s = row[col] || '';
  for (let i = 2; row[col + CHUNK_SEP + i]; i++) {
    chunkedCols[table].add(col);
    s += row[col + CHUNK_SEP + i];
  }
  return s;
}

function fromFlat(table, row) {
  const def = TABLES[table];
  if (def.raw) return { key: row.key, value: joinChunks(table, row, 'value') };
  const json = joinChunks(table, row, '_json');
  if (!json) return null;
  return JSON.parse(json);
}

// ---------- public API ----------

async function init(b) {
  backend = b;
  const data = await backend.load(Object.keys(TABLES));
  for (const [table, rows] of Object.entries(data)) {
    cache[table].clear();
    for (const row of rows) {
      try {
        const rec = fromFlat(table, row);
        if (rec) cache[table].set(String(rec[TABLES[table].key]), rec);
      } catch (err) {
        log.warn(`Skipping unreadable ${table} row: ${err.message}`);
      }
    }
  }
  log.info(
    `Loaded from ${backend.name}: ` + Object.keys(TABLES).map((t) => `${t}=${cache[t].size}`).join(', ')
  );
}

function get(table, key) {
  return cache[table].get(String(key)) || null;
}

function all(table) {
  return Array.from(cache[table].values());
}

function put(table, record) {
  const key = String(record[TABLES[table].key]);
  cache[table].set(key, record);
  queue[table].upsert.set(key, record);
  queue[table].remove.delete(key);
  schedule();
  return record;
}

function remove(table, key) {
  key = String(key);
  cache[table].delete(key);
  queue[table].upsert.delete(key);
  queue[table].remove.add(key);
  schedule();
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_DELAY_MS);
}

function pendingCount() {
  return Object.values(queue).reduce((n, q) => n + q.upsert.size + q.remove.size, 0);
}

/** Sends all queued changes. Safe to call concurrently; resolves when everything queued so far is written. */
async function flush() {
  while (flushing) await flushing; // one request at a time keeps writes in order
  if (!backend || pendingCount() === 0) return;

  const ops = [];
  const sent = {};
  for (const table of Object.keys(TABLES)) {
    const q = queue[table];
    if (!q.upsert.size && !q.remove.size) continue;
    sent[table] = { upsert: new Map(q.upsert), remove: new Set(q.remove) };
    q.upsert.clear();
    q.remove.clear();
    ops.push({
      table,
      key: TABLES[table].key,
      upsert: Array.from(sent[table].upsert.values()).map((r) => toFlat(table, r)),
      remove: Array.from(sent[table].remove),
    });
  }

  flushing = (async () => {
    try {
      await backend.write(ops);
      lastFlushAt = new Date().toISOString();
      lastFlushError = null;
    } catch (err) {
      lastFlushError = err.message;
      log.error(`Saving to ${backend.name} failed, will retry: ${err.message}`);
      // Put back whatever wasn't changed again in the meantime.
      for (const [table, s] of Object.entries(sent)) {
        const q = queue[table];
        for (const [k, r] of s.upsert) if (!q.upsert.has(k) && !q.remove.has(k)) q.upsert.set(k, r);
        for (const k of s.remove) if (!q.upsert.has(k) && !q.remove.has(k)) q.remove.add(k);
      }
      setTimeout(schedule, 5000).unref?.();
    }
  })();
  try {
    await flushing;
  } finally {
    flushing = null;
  }
}

function status() {
  return { backend: backend?.name || null, pending: pendingCount(), lastFlushAt, lastFlushError };
}

async function putFile(name, mimeType, buffer) {
  return backend.putFile(name, mimeType, buffer);
}

async function getFile(id) {
  return backend.getFile(id);
}

module.exports = { TABLES, init, get, all, put, remove, flush, status, putFile, getFile, _toFlat: toFlat, _fromFlat: fromFlat };
