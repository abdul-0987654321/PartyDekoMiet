'use strict';
/**
 * Runtime settings, editable from the dashboard.
 *
 * Three layers, highest wins:
 *   1. the schema default below
 *   2. the environment variable (bootstrap: what a fresh deploy starts with)
 *   3. the value the owner saved in the dashboard (stored in the Google Sheet)
 *
 * So .env still configures a new deploy, but day-to-day changes - owner number,
 * pickup hours, deposit handling, bot language - happen in the dashboard and
 * survive restarts without a redeploy.
 *
 * Secrets deliberately stay env-only. An API key written into a Google Sheet is
 * readable by anyone the sheet is ever shared with, and it would sit in the
 * sheet's revision history forever. The dashboard shows whether a secret is set,
 * never its value.
 */

const log = require('./log');
const db = require('./store/db');

const STATE_KEY = 'settings';

/**
 * type: string | text | number | boolean | enum
 * env:  environment variable used as the bootstrap default
 */
const SCHEMA = [
  // ── Bot ──────────────────────────────────────────────────────────────────
  {
    key: 'botEnabled', group: 'bot', type: 'boolean', default: true,
    label: { de: 'Bot aktiv', en: 'Bot active' },
    help: {
      de: 'Aus: der Bot liest Nachrichten, antwortet aber nicht. Notbremse.',
      en: 'Off: the bot reads messages but does not answer. Emergency switch.',
    },
  },
  {
    key: 'botLanguage', group: 'bot', type: 'enum', default: 'auto',
    options: ['auto', 'de', 'en'],
    label: { de: 'Sprache des Bots', en: 'Bot language' },
    help: {
      de: 'auto: antwortet in der Sprache des Kunden. de/en: immer diese Sprache.',
      en: 'auto: replies in the customer language. de/en: always that language.',
    },
  },
  {
    key: 'takeoverPauseHours', group: 'bot', type: 'number', default: 12, min: 1, max: 168,
    env: 'TAKEOVER_PAUSE_HOURS',
    label: { de: 'Pause nach manueller Antwort (Std.)', en: 'Pause after a manual reply (hours)' },
    help: {
      de: 'Antwortet der Inhaber selbst im Chat, schweigt der Bot so lange in diesem Chat.',
      en: 'If the owner answers in a chat, the bot stays quiet in that chat for this long.',
    },
  },
  {
    key: 'maxMsgsPerChatPerHour', group: 'bot', type: 'number', default: 30, min: 1, max: 200,
    env: 'MAX_MSGS_PER_CHAT_PER_HOUR',
    label: { de: 'Max. Nachrichten pro Chat / Stunde', en: 'Max messages per chat / hour' },
    help: { de: 'Schutz vor Schleifen und Spam.', en: 'Protection against loops and spam.' },
  },
  {
    key: 'typingMinMs', group: 'bot', type: 'number', default: 2000, min: 0, max: 15000,
    env: 'TYPING_MIN_MS',
    label: { de: 'Tippdauer min. (ms)', en: 'Typing delay min (ms)' },
    help: {
      de: 'Der Bot zeigt vorher "tippt..." - wirkt menschlicher und senkt das Sperr-Risiko.',
      en: 'The bot shows "typing..." first - looks human and lowers the ban risk.',
    },
  },
  {
    key: 'typingMaxMs', group: 'bot', type: 'number', default: 5000, min: 0, max: 30000,
    env: 'TYPING_MAX_MS',
    label: { de: 'Tippdauer max. (ms)', en: 'Typing delay max (ms)' },
  },

  // ── Contacts ─────────────────────────────────────────────────────────────
  {
    key: 'ownerWhatsapp', group: 'contacts', type: 'string', default: '', env: 'OWNER_WHATSAPP',
    placeholder: '41791234567',
    label: { de: 'WhatsApp des Inhabers', en: 'Owner WhatsApp number' },
    help: {
      de: 'Bekommt alle Buchungsanfragen und Meldungen. International, ohne + und ohne Leerzeichen.',
      en: 'Receives all booking requests and alerts. International format, no + and no spaces.',
    },
  },
  {
    key: 'handoffPhone', group: 'contacts', type: 'string', default: '', env: 'HANDOFF_PHONE',
    label: { de: 'Telefon für Übergaben', en: 'Phone for handovers' },
    help: {
      de: 'Optional. Wird dem Kunden genannt, wenn ein Mensch übernehmen muss.',
      en: 'Optional. Given to the customer when a human has to take over.',
    },
  },

  // ── Business rules ───────────────────────────────────────────────────────
  {
    key: 'rentalDays', group: 'business', type: 'number', default: 3, min: 1, max: 30,
    env: 'RENTAL_DAYS',
    label: { de: 'Mietdauer (Tage)', en: 'Rental period (days)' },
    help: { de: 'Laut AGB: drei aufeinanderfolgende Tage.', en: 'Per the AGB: three consecutive days.' },
  },
  {
    key: 'returnDayOffset', group: 'business', type: 'number', default: 2, min: 1, max: 29,
    env: 'RETURN_DAY_OFFSET',
    label: { de: 'Rückgabe = Abholung + X Tage', en: 'Return = pickup + X days' },
    help: {
      de: '2 = Abholung Freitag, Rückgabe Sonntag (Abholtag zählt als Tag 1). 3 = Rückgabe Montag.',
      en: '2 = pickup Friday, return Sunday (pickup day counts as day 1). 3 = return Monday.',
    },
  },
  {
    key: 'bufferDays', group: 'business', type: 'number', default: 0, min: 0, max: 7,
    env: 'BUFFER_DAYS',
    label: { de: 'Puffertage nach Rückgabe', en: 'Buffer days after return' },
    help: {
      de: 'Tage zum Kontrollieren und Reinigen, bevor das Set wieder abgeholt werden kann.',
      en: 'Days for checking and cleaning before the set can go out again.',
    },
  },
  {
    key: 'defaultStock', group: 'business', type: 'number', default: 1, min: 1, max: 50,
    label: { de: 'Exemplare pro Set (Standard)', en: 'Copies per set (default)' },
    help: {
      de: 'Wie oft ein Set gleichzeitig vermietet werden kann. Einzelne Sets können abweichen.',
      en: 'How many times a set can be rented at once. Individual sets can differ.',
    },
  },
  {
    key: 'depositChf', group: 'business', type: 'number', default: 50, min: 0, max: 1000,
    env: 'DEPOSIT_CHF',
    label: { de: 'Kaution (CHF)', en: 'Deposit (CHF)' },
  },
  {
    key: 'lateFeeChf', group: 'business', type: 'number', default: 50, min: 0, max: 1000,
    env: 'LATE_FEE_CHF',
    label: { de: 'Verspätungsgebühr pro Tag (CHF)', en: 'Late fee per started day (CHF)' },
  },
  {
    key: 'depositMode', group: 'business', type: 'enum', default: 'included',
    options: ['included', 'separate', 'manual'],
    label: { de: 'Wie wird die Kaution bezahlt?', en: 'How is the deposit paid?' },
    help: {
      de: 'included: im Shop-Preis enthalten. separate: eigenes Kautions-Produkt im Shop. manual: bei der Abholung.',
      en: 'included: already in the shop price. separate: its own deposit product. manual: at pickup.',
    },
  },
  {
    key: 'depositProductUrl', group: 'business', type: 'string', default: '', env: 'DEPOSIT_PRODUCT_URL',
    label: { de: 'Link zum Kautions-Produkt', en: 'Deposit product link' },
    help: { de: 'Nur nötig, wenn oben "separate" gewählt ist.', en: 'Only needed when "separate" is selected above.' },
  },
  {
    key: 'pickupAddress', group: 'business', type: 'string', default: 'Langstrasse 175, 8004 Zürich (SBB-Bürogebäude, Erdgeschoss)',
    env: 'PICKUP_ADDRESS',
    label: { de: 'Abholadresse', en: 'Pickup address' },
  },
  {
    key: 'pickupHours', group: 'business', type: 'string', default: '', env: 'PICKUP_HOURS',
    placeholder: 'Mo-Fr 17:00-19:00, Sa 10:00-14:00',
    label: { de: 'Mögliche Abholzeiten', en: 'Possible pickup times' },
    help: {
      de: 'Leer lassen, wenn es keine festen Zeiten gibt - der Bot nennt dann keine.',
      en: 'Leave empty if there are no fixed times - the bot will then not name any.',
    },
  },

  // ── Shop ─────────────────────────────────────────────────────────────────
  {
    key: 'shopUrl', group: 'shop', type: 'string', default: 'https://partydekomiet.ch', env: 'SHOP_URL',
    label: { de: 'Shop-Adresse', en: 'Shop URL' },
  },
  {
    key: 'catalogRefreshHours', group: 'shop', type: 'number', default: 6, min: 1, max: 168,
    env: 'CATALOG_REFRESH_HOURS',
    label: { de: 'Katalog neu laden alle (Std.)', en: 'Reload catalog every (hours)' },
  },

  // ── Calendar ─────────────────────────────────────────────────────────────
  {
    key: 'calendarId', group: 'calendar', type: 'string', default: '', env: 'GOOGLE_CALENDAR_ID',
    placeholder: 'xxxx@group.calendar.google.com',
    label: { de: 'Kalender-ID', en: 'Calendar ID' },
    help: {
      de: 'Aus den Kalender-Einstellungen bei Google. Siehe docs/GOOGLE_CALENDAR_SETUP.md.',
      en: 'From the calendar settings in Google. See docs/GOOGLE_CALENDAR_SETUP.md.',
    },
  },
  {
    key: 'blockedKeywords', group: 'calendar', type: 'string', default: 'blocked,geschlossen,ferien,closed,urlaub',
    label: { de: 'Stichwörter für Sperrtage', en: 'Keywords for blocked days' },
    help: {
      de: 'Ganztägige Termine mit einem dieser Wörter im Titel sperren alle Sets an dem Tag.',
      en: 'All-day events with one of these words in the title block every set that day.',
    },
  },

  // ── Dashboard ────────────────────────────────────────────────────────────
  {
    key: 'dashboardLanguage', group: 'dashboard', type: 'enum', default: 'de', options: ['de', 'en'],
    label: { de: 'Sprache des Dashboards', en: 'Dashboard language' },
  },
];

const BY_KEY = new Map(SCHEMA.map((s) => [s.key, s]));

let overrides = {};
const listeners = [];

function envDefault(def) {
  if (!def.env) return undefined;
  const raw = process.env[def.env];
  if (raw === undefined || raw === '') return undefined;
  return coerce(def, raw);
}

function coerce(def, raw) {
  switch (def.type) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      return typeof raw === 'boolean' ? raw : /^(1|true|yes|on)$/i.test(String(raw));
    case 'enum':
      return def.options.includes(String(raw)) ? String(raw) : undefined;
    default:
      return String(raw);
  }
}

/** @returns {{ok:true,value:any}|{ok:false,error:string}} */
function validate(def, raw) {
  const value = coerce(def, raw);
  if (value === undefined) return { ok: false, error: `${def.key}: invalid value` };
  if (def.type === 'number') {
    if (def.min !== undefined && value < def.min) return { ok: false, error: `${def.key}: minimum is ${def.min}` };
    if (def.max !== undefined && value > def.max) return { ok: false, error: `${def.key}: maximum is ${def.max}` };
  }
  if (def.key === 'ownerWhatsapp' && value && !/^[0-9]{8,15}$/.test(value)) {
    return { ok: false, error: 'ownerWhatsapp: digits only, international format, no + and no spaces' };
  }
  return { ok: true, value };
}

/** Loads saved overrides from storage. Call after db.init(). */
function load() {
  try {
    const row = db.get('state', STATE_KEY);
    overrides = row?.value ? JSON.parse(row.value) : {};
  } catch (err) {
    log.warn(`Could not read saved settings, using defaults: ${err.message}`);
    overrides = {};
  }
  log.info(`Settings loaded (${Object.keys(overrides).length} saved overrides)`);
  return all();
}

function get(key) {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`Unknown setting: ${key}`);
  if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
  const fromEnv = envDefault(def);
  return fromEnv !== undefined ? fromEnv : def.default;
}

function all() {
  const out = {};
  for (const def of SCHEMA) out[def.key] = get(def.key);
  return out;
}

/** Schema for the dashboard, with the current value and where it came from. */
function describe() {
  return SCHEMA.map((def) => ({
    key: def.key,
    group: def.group,
    type: def.type,
    options: def.options,
    label: def.label,
    help: def.help,
    placeholder: def.placeholder,
    min: def.min,
    max: def.max,
    value: get(def.key),
    source: Object.prototype.hasOwnProperty.call(overrides, def.key)
      ? 'dashboard'
      : envDefault(def) !== undefined
        ? 'env'
        : 'default',
  }));
}

/**
 * Validates and saves a patch. All-or-nothing: one bad value saves nothing.
 * @returns {{ok:boolean, errors?:string[], changed?:string[]}}
 */
async function update(patch) {
  const errors = [];
  const accepted = {};

  for (const [key, raw] of Object.entries(patch || {})) {
    const def = BY_KEY.get(key);
    if (!def) {
      errors.push(`Unknown setting: ${key}`);
      continue;
    }
    const res = validate(def, raw);
    if (!res.ok) errors.push(res.error);
    else accepted[key] = res.value;
  }

  // Cross-field checks
  const next = { ...all(), ...accepted };
  if (next.typingMinMs > next.typingMaxMs) {
    errors.push('typingMinMs must not be larger than typingMaxMs');
  }
  if (next.returnDayOffset >= next.rentalDays + 1) {
    // pickup+offset should stay inside a sensible rental length
    if (next.returnDayOffset > next.rentalDays) {
      errors.push('returnDayOffset must not be larger than rentalDays');
    }
  }
  if (next.depositMode === 'separate' && !next.depositProductUrl) {
    errors.push('depositProductUrl is required when depositMode is "separate"');
  }

  if (errors.length) return { ok: false, errors };

  const changed = Object.keys(accepted).filter((k) => get(k) !== accepted[k]);
  overrides = { ...overrides, ...accepted };
  db.put('state', { key: STATE_KEY, value: JSON.stringify(overrides) });
  await db.flush();

  if (changed.length) {
    log.info(`Settings changed: ${changed.join(', ')}`);
    for (const fn of listeners) {
      try {
        fn(changed, all());
      } catch (err) {
        log.error(`Settings listener failed: ${err.message}`);
      }
    }
  }
  return { ok: true, changed };
}

/** Removes a dashboard override so the env / default value applies again. */
async function reset(key) {
  if (!BY_KEY.has(key)) return { ok: false, errors: [`Unknown setting: ${key}`] };
  delete overrides[key];
  db.put('state', { key: STATE_KEY, value: JSON.stringify(overrides) });
  await db.flush();
  log.info(`Setting reset to default: ${key}`);
  return { ok: true };
}

function onChange(fn) {
  listeners.push(fn);
}

module.exports = { SCHEMA, load, get, all, describe, update, reset, onChange, _validate: validate };
