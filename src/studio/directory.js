'use strict';
/**
 * Studio directory: professionals, services and locations.
 *
 * All of this is owner-editable from the dashboard, on purpose. The client does
 * not have fixed hours, a final price list, or a final roster yet, and asking
 * him to resend that information every time it changes is worse than giving him
 * a page to edit it himself. Nothing here is hardcoded in knowledge/ - the agent
 * reads these records through the directory tools at reply time.
 *
 * Mirrors the table + id pattern already used by bookings.js, so the dashboard
 * API and the agent tools stay consistent with the rest of the project.
 */

const db = require('../store/db');

function newId(prefix) {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${prefix}${d}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function nowIso() {
  return new Date().toISOString();
}

// ---------- validation ----------

/** @returns {string|null} an error, or null when the record is usable */
function validateProfessional(p) {
  if (!p.name || !String(p.name).trim()) return 'name is required';
  if (p.age !== undefined && p.age !== '' && p.age !== null) {
    const age = Number(p.age);
    if (!Number.isFinite(age) || age < 18 || age > 99) return 'age must be between 18 and 99';
  }
  return null;
}

function validateService(s) {
  if (!s.name || !String(s.name).trim()) return 'name is required';
  if (s.durationMin !== undefined && s.durationMin !== '' && s.durationMin !== null) {
    const d = Number(s.durationMin);
    if (!Number.isFinite(d) || d <= 0 || d > 480) return 'durationMin must be between 1 and 480';
  }
  if (s.priceChf !== undefined && s.priceChf !== '' && s.priceChf !== null) {
    const price = Number(s.priceChf);
    if (!Number.isFinite(price) || price < 0) return 'priceChf must be a positive number';
  }
  return null;
}

function validateLocation(l) {
  if (!l.name || !String(l.name).trim()) return 'name is required';
  return null;
}

// ---------- professionals ----------

function listProfessionals({ activeOnly = false } = {}) {
  return db
    .all('professionals')
    .filter((p) => !activeOnly || p.active !== false)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function getProfessional(id) {
  return db.get('professionals', id) || null;
}

async function createProfessional(args) {
  const problem = validateProfessional(args);
  if (problem) return { ok: false, error: problem };
  const record = {
    id: newId('P'),
    active: args.active !== false,
    name: String(args.name).trim(),
    age: args.age || '',
    languages: Array.isArray(args.languages) ? args.languages : String(args.languages || '').split(',').map((s) => s.trim()).filter(Boolean),
    locationId: args.locationId || '',
    photoFileId: args.photoFileId || '',
    workingHours: args.workingHours || '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.put('professionals', record);
  await db.flush();
  return { ok: true, professional: record };
}

async function updateProfessional(id, patch) {
  const existing = getProfessional(id);
  if (!existing) return { ok: false, error: `professional ${id} not found` };
  const next = { ...existing, ...patch };
  const problem = validateProfessional(next);
  if (problem) return { ok: false, error: problem };
  if (patch.languages !== undefined) {
    next.languages = Array.isArray(patch.languages)
      ? patch.languages
      : String(patch.languages || '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  next.updatedAt = nowIso();
  db.put('professionals', next);
  await db.flush();
  return { ok: true, professional: next };
}

async function removeProfessional(id) {
  if (!getProfessional(id)) return { ok: false, error: `professional ${id} not found` };
  db.remove('professionals', id);
  await db.flush();
  return { ok: true };
}

// ---------- services ----------

function listServices({ professionalId = null, activeOnly = false } = {}) {
  return db
    .all('services')
    .filter((s) => !activeOnly || s.active !== false)
    // A service with no professionalId is offered by everyone, so it always matches.
    .filter((s) => !professionalId || !s.professionalId || s.professionalId === professionalId)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function getService(id) {
  return db.get('services', id) || null;
}

async function createService(args) {
  const problem = validateService(args);
  if (problem) return { ok: false, error: problem };
  const record = {
    id: newId('S'),
    professionalId: args.professionalId || '',
    active: args.active !== false,
    name: String(args.name).trim(),
    durationMin: args.durationMin || '',
    priceChf: args.priceChf || '',
    notes: args.notes || '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.put('services', record);
  await db.flush();
  return { ok: true, service: record };
}

async function updateService(id, patch) {
  const existing = getService(id);
  if (!existing) return { ok: false, error: `service ${id} not found` };
  const next = { ...existing, ...patch };
  const problem = validateService(next);
  if (problem) return { ok: false, error: problem };
  next.updatedAt = nowIso();
  db.put('services', next);
  await db.flush();
  return { ok: true, service: next };
}

async function removeService(id) {
  if (!getService(id)) return { ok: false, error: `service ${id} not found` };
  db.remove('services', id);
  await db.flush();
  return { ok: true };
}

// ---------- locations ----------

function listLocations({ activeOnly = false } = {}) {
  return db
    .all('locations')
    .filter((l) => !activeOnly || l.active !== false)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function getLocation(id) {
  return db.get('locations', id) || null;
}

async function createLocation(args) {
  const problem = validateLocation(args);
  if (problem) return { ok: false, error: problem };
  const record = {
    id: newId('L'),
    active: args.active !== false,
    name: String(args.name).trim(),
    address: args.address || '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.put('locations', record);
  await db.flush();
  return { ok: true, location: record };
}

async function updateLocation(id, patch) {
  const existing = getLocation(id);
  if (!existing) return { ok: false, error: `location ${id} not found` };
  const next = { ...existing, ...patch };
  const problem = validateLocation(next);
  if (problem) return { ok: false, error: problem };
  next.updatedAt = nowIso();
  db.put('locations', next);
  await db.flush();
  return { ok: true, location: next };
}

async function removeLocation(id) {
  if (!getLocation(id)) return { ok: false, error: `location ${id} not found` };
  db.remove('locations', id);
  await db.flush();
  return { ok: true };
}

/**
 * Everything the agent needs about one professional in one call: her own record
 * plus the services that apply to her (her own + the ones offered by everyone)
 * and her location's address. This is the shape the "always check her profile
 * first" rule reads from - nothing about a professional is ever answered from
 * the model's own memory of an earlier message.
 */
function profileFor(professionalId) {
  const professional = getProfessional(professionalId);
  if (!professional) return null;
  const services = listServices({ professionalId, activeOnly: true });
  const location = professional.locationId ? getLocation(professional.locationId) : null;
  return { professional, services, location };
}

module.exports = {
  listProfessionals, getProfessional, createProfessional, updateProfessional, removeProfessional,
  listServices, getService, createService, updateService, removeService,
  listLocations, getLocation, createLocation, updateLocation, removeLocation,
  profileFor,
  validateProfessional, validateService, validateLocation,
};
