/**
 * PartyDekoMiet – Storage API (Google Apps Script)
 * ================================================
 *
 * This file belongs in an Apps Script project bound to YOUR Google Sheet:
 *   open the Sheet -> Extensions -> Apps Script -> paste this file -> Deploy.
 * Full setup instructions: docs/GOOGLE_SHEET_SETUP.md
 *
 * Why a Google Sheet and not a local database?
 * Render wipes the container disk on every restart and deploy. Anything stored on
 * disk would be gone and the owner would have to scan a new WhatsApp QR code every
 * time. The Sheet is free, survives restarts, and the owner can read it directly.
 *
 * Tabs (created automatically on first write):
 *   session   – Baileys WhatsApp login, so no new QR code is needed after a restart
 *   customers – one row per customer (phone, name, occasion, theme, age, party date)
 *   bookings  – booking requests, status PENDING / CONFIRMED / CANCELLED
 *   chat      – conversation history
 *   state     – bot state: paused chats, catalog cache, owner takeover timestamps
 *   knowledge – optional, for the second bot: owner-editable FAQ and prices
 *
 * Customer reference photos are stored as files in a private Google Drive folder,
 * never shared publicly; only the file ID is kept in the Sheet.
 *
 * Every request must carry the secret from the SECRET script property.
 */

var FOLDER_NAME = 'PartyDekoMiet Referenzbilder';

// ─────────────────────────────── Web app entry points ───────────────────────

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!secret || req.secret !== secret) {
      out = { ok: false, error: 'unauthorized' };
    } else {
      out = handle_(req);
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** Plain GET is only used to check that the web app is deployed and reachable. */
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, service: 'partydekomiet-bot-storage' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handle_(req) {
  switch (req.action) {
    case 'ping':
      return { ok: true };
    case 'load':
      return { ok: true, data: load_(req.tables || []) };
    case 'write':
      return withLock_(function () {
        (req.ops || []).forEach(function (op) {
          if (op.upsert && op.upsert.length) upsert_(op.table, op.key, op.upsert);
          if (op.remove && op.remove.length) remove_(op.table, op.key, op.remove);
        });
        return { ok: true };
      });
    case 'putFile':
      return { ok: true, id: putFile_(req.name, req.mimeType, req.base64) };
    case 'getFile':
      return getFile_(req.id);
    default:
      return { ok: false, error: 'unknown action ' + req.action };
  }
}

/** Serialises writes so two concurrent requests cannot corrupt a row. */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ─────────────────────────────── Sheet helpers ──────────────────────────────

function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function headers_(sh) {
  var lastCol = sh.getLastColumn();
  if (lastCol === 0) return [];
  return sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
}

/** Ensures every column used by the incoming rows exists in the header row. */
function ensureHeaders_(sh, rows, key) {
  var headers = headers_(sh);
  var wanted = [key];
  rows.forEach(function (r) {
    Object.keys(r).forEach(function (k) {
      if (wanted.indexOf(k) === -1) wanted.push(k);
    });
  });
  var missing = wanted.filter(function (k) { return headers.indexOf(k) === -1; });
  if (missing.length) {
    sh.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    sh.setFrozenRows(1);
    headers = headers.concat(missing);
  }
  return headers;
}

function load_(tables) {
  var result = {};
  tables.forEach(function (name) {
    var sh = sheet_(name);
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    if (lastRow < 2 || lastCol === 0) { result[name] = []; return; }
    var values = sh.getRange(1, 1, lastRow, lastCol).getDisplayValues();
    var headers = values[0];
    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var row = {};
      var empty = true;
      for (var c = 0; c < headers.length; c++) {
        if (!headers[c]) continue;
        row[headers[c]] = values[i][c];
        if (values[i][c] !== '') empty = false;
      }
      if (!empty) rows.push(row);
    }
    result[name] = rows;
  });
  return result;
}

function upsert_(table, key, rows) {
  var sh = sheet_(table);
  var headers = ensureHeaders_(sh, rows, key);
  var keyCol = headers.indexOf(key);
  var lastRow = sh.getLastRow();
  var index = {};
  if (lastRow >= 2) {
    var keys = sh.getRange(2, keyCol + 1, lastRow - 1, 1).getDisplayValues();
    for (var i = 0; i < keys.length; i++) index[keys[i][0]] = i + 2;
  }
  var toAppend = [];
  rows.forEach(function (r) {
    var line = headers.map(function (h) { return r[h] === undefined || r[h] === null ? '' : String(r[h]); });
    var rowNum = index[String(r[key])];
    if (rowNum) {
      var range = sh.getRange(rowNum, 1, 1, headers.length);
      range.setNumberFormat('@');
      range.setValues([line]);
    } else {
      toAppend.push(line);
    }
  });
  if (toAppend.length) {
    var start = sh.getLastRow() + 1;
    var range = sh.getRange(start, 1, toAppend.length, headers.length);
    // Plain text: stops Sheets from turning phone numbers, dates and prices into
    // its own formats, which would corrupt the WhatsApp session data.
    range.setNumberFormat('@');
    range.setValues(toAppend);
  }
}

/**
 * Blanks out matching rows instead of deleting them. Google Sheets refuses a
 * deleteRow() call that would remove every remaining non-frozen row ("Sorry,
 * it is not possible to delete all non-frozen rows") - this happens for real
 * whenever the WhatsApp session is fully cleared (logout / new session), which
 * deletes every row in the session sheet in one call. Clearing content instead
 * of deleting rows sidesteps that limit entirely; load_() already treats a row
 * whose cells are all empty as deleted, so behaviour is unchanged for callers.
 */
function remove_(table, key, keys) {
  var sh = sheet_(table);
  var headers = headers_(sh);
  var keyCol = headers.indexOf(key);
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (keyCol === -1 || lastRow < 2) return;
  var wanted = {};
  keys.forEach(function (k) { wanted[String(k)] = true; });
  var values = sh.getRange(2, keyCol + 1, lastRow - 1, 1).getDisplayValues();
  for (var i = 0; i < values.length; i++) {
    if (wanted[values[i][0]]) sh.getRange(i + 2, 1, 1, lastCol).clearContent();
  }
}

// ─────────────────────────────── Reference photos ───────────────────────────

function folder_() {
  var it = DriveApp.getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
}

function putFile_(name, mimeType, base64) {
  var blob = Utilities.newBlob(Utilities.base64Decode(base64), mimeType || 'image/jpeg', name || 'referenzbild.jpg');
  return folder_().createFile(blob).getId();
}

function getFile_(id) {
  var file = DriveApp.getFileById(id);
  var blob = file.getBlob();
  return { ok: true, mimeType: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) };
}

// ─────────────────────────────── One-time setup ─────────────────────────────

/**
 * Run this once from the Apps Script editor (select setup -> Run).
 * It creates the tabs and generates the SECRET. Copy the secret from the
 * execution log into the bot's SHEET_SECRET environment variable.
 */
function setup() {
  ['session', 'customers', 'bookings', 'chat', 'state', 'knowledge'].forEach(function (name) {
    sheet_(name);
  });
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('SECRET', secret);
  }
  Logger.log('Tabs ready. SHEET_SECRET=' + secret);
  return secret;
}
