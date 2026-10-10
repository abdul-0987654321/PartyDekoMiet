'use strict';
/**
 * In-memory backend with the same interface as the Sheets backend.
 * Used for tests and local development when SHEET_WEBHOOK_URL is not set.
 * Rows are kept in the same flat string form that Apps Script stores, so the
 * serialization path is exercised exactly as in production.
 */

const crypto = require('crypto');

function createMemoryBackend() {
  const tables = new Map(); // table -> Map(key -> flat row)
  const files = new Map();

  return {
    name: 'memory',
    tables,
    async load(names) {
      const data = {};
      for (const n of names) data[n] = Array.from((tables.get(n) || new Map()).values()).map((r) => ({ ...r }));
      return data;
    },
    async write(ops) {
      for (const op of ops) {
        if (!tables.has(op.table)) tables.set(op.table, new Map());
        const t = tables.get(op.table);
        for (const row of op.upsert || []) {
          const flat = {};
          for (const [k, v] of Object.entries(row)) flat[k] = v == null ? '' : String(v);
          t.set(flat[op.key], { ...(t.get(flat[op.key]) || {}), ...flat });
        }
        for (const k of op.remove || []) t.delete(String(k));
      }
    },
    async putFile(name, mimeType, buffer) {
      const id = crypto.randomUUID();
      files.set(id, { mimeType, buffer: Buffer.from(buffer) });
      return id;
    },
    async getFile(id) {
      const f = files.get(id);
      if (!f) throw new Error('file not found');
      return f;
    },
  };
}

module.exports = { createMemoryBackend };
