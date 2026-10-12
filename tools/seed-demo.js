#!/usr/bin/env node
'use strict';
/**
 * Fills the dashboard with believable demo data for a screenshot or a screen
 * recording.
 *
 *   node tools/seed-demo.js            dry run: shows what it would write
 *   node tools/seed-demo.js --write    actually writes
 *   node tools/seed-demo.js --clear    removes only the rows it created
 *
 * Why this exists: the real dashboard shows customers' phone numbers and their
 * conversations. Recording that for a sales demo would publish personal data.
 * Everything written here is invented, and every row is marked so --clear can
 * remove it again without touching a real customer.
 *
 * It refuses to write over real data unless --force is given.
 */

require('dotenv').config();
const db = require('../src/store/db');
const { createSheetsBackend } = require('../src/store/backend-sheets');
const { createMemoryBackend } = require('../src/store/backend-memory');
const { config } = require('../src/config');

const MARK = 'demo'; // every seeded row carries this, so --clear is precise
const WRITE = process.argv.includes('--write');
const CLEAR = process.argv.includes('--clear');
const FORCE = process.argv.includes('--force');

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

const CUSTOMERS = [
  { jid: '41790000101@s.whatsapp.net', name: 'Anna Keller', occasion: '5. Geburtstag', childAge: '5', theme: 'Einhorn, rosa/gold' },
  { jid: '41790000102@s.whatsapp.net', name: 'Marco Bianchi', occasion: '7. Geburtstag', childAge: '7', theme: 'Dino, gruen' },
  { jid: '41790000103@s.whatsapp.net', name: 'Sarah Meier', occasion: 'Taufe', childAge: '', theme: 'Pastell, Blumen' },
];

const CHATS = [
  ['41790000101@s.whatsapp.net', [
    ['in', 'Hoi! Habt ihr Deko für einen Einhorn-Geburtstag?', 240],
    ['out', 'Hoi! Ja, da haben wir mehrere Einhorn-Sets. Wie alt wird das Geburtstagskind, und an welchem Datum ist die Party?', 239],
    ['in', 'Sie wird 5, die Party ist am Samstag in zwei Wochen', 236],
    ['out', 'Schön! Ich schaue kurz, was für die Daten frei ist.', 235],
    ['out', 'Das Einhorn Set Rosa sieht für deine Daten frei aus. Abholung Freitag, Rückgabe Sonntag. Ich habe die Anfrage ans Team weitergegeben – verbindlich wird sie, sobald wir die Verfügbarkeit bestätigt haben und die Zahlung im Shop eingegangen ist.', 234],
    ['in', 'Super, danke! Wo muss ich das abholen?', 230],
    ['out', 'An der Langstrasse 175, 8004 Zürich, unten im SBB-Bürogebäude. Den genauen Abholzeitpunkt vereinbaren wir mit dir. Bring bitte ein möglichst leeres Fahrzeug mit.', 229],
  ]],
  ['41790000102@s.whatsapp.net', [
    ['in', 'Guten Tag, liefern Sie die Dekoration auch nach Hause?', 95],
    ['out', 'Nein, wir bieten keinen Lieferservice an. Die Dekoration wird ausschliesslich zur Selbstabholung bereitgestellt – an der Langstrasse 175 in Zürich.', 94],
    ['in', 'Alles klar. Und wie lange kann ich das Set behalten?', 92],
    ['out', 'Die reguläre Mietdauer beträgt drei aufeinanderfolgende Tage. Den genauen Rückgabezeitpunkt vereinbaren wir bei der Buchung.', 91],
  ]],
  ['41790000103@s.whatsapp.net', [
    ['in', 'Hallo, bei der letzten Miete ist leider ein Vorhang eingerissen. Was kostet das?', 20],
    ['out', 'Das schaut sich am besten jemand aus dem Team direkt an – ich gebe deine Nachricht gleich weiter. Generell gilt: Reparatur- oder Ersatzkosten können mit der Kaution von CHF 50.– verrechnet werden.', 19],
  ]],
];

const BOOKINGS = [
  {
    id: 'B20261012-DEMO1', status: 'CONFIRMED', jid: CUSTOMERS[0].jid, phone: '41790000101',
    customerName: 'Anna Keller', productId: 'demo-1', productHandle: 'einhorn-set-rosa',
    productTitle: 'Einhorn Set Rosa', productUrl: 'https://partydekomiet.ch/products/einhorn-set-rosa',
    priceChf: 89, pickupDate: day(9), returnDate: day(11),
    occasion: '5. Geburtstag', childAge: '5', themeNotes: 'rosa/gold, Ballonbogen',
  },
  {
    id: 'B20261012-DEMO2', status: 'PENDING', jid: CUSTOMERS[1].jid, phone: '41790000102',
    customerName: 'Marco Bianchi', productId: 'demo-2', productHandle: 'dino-set-gruen',
    productTitle: 'Dino Set Grün', productUrl: 'https://partydekomiet.ch/products/dino-set-gruen',
    priceChf: 95, pickupDate: day(16), returnDate: day(18),
    occasion: '7. Geburtstag', childAge: '7', themeNotes: 'grün, Dschungel',
  },
  {
    id: 'B20261012-DEMO3', status: 'PENDING', jid: CUSTOMERS[2].jid, phone: '41790000103',
    customerName: 'Sarah Meier', productId: 'demo-3', productHandle: 'pastell-blumen-set',
    productTitle: 'Pastell Blumen Set', productUrl: 'https://partydekomiet.ch/products/pastell-blumen-set',
    priceChf: 120, pickupDate: day(23), returnDate: day(25),
    occasion: 'Taufe', childAge: '', themeNotes: 'Pastell, Trockenblumen',
  },
];

async function connect() {
  const backend = config.storage.webhookUrl && config.storage.secret
    ? createSheetsBackend({ url: config.storage.webhookUrl, secret: config.storage.secret })
    : createMemoryBackend();
  await db.init(backend);
  return backend.name;
}

function realRowsExist() {
  const real = (rows, key) => rows.filter((r) => !String(r[key] || '').includes('DEMO') && r.source !== MARK);
  return (
    real(db.all('bookings'), 'id').length > 0 ||
    db.all('customers').filter((c) => c.source !== MARK).length > 0
  );
}

async function clear() {
  let n = 0;
  for (const t of ['chat', 'customers', 'bookings']) {
    for (const row of db.all(t)) {
      if (row.source === MARK) {
        db.remove(t, row[t === 'customers' ? 'jid' : 'id']);
        n++;
      }
    }
  }
  await db.flush();
  console.log(`Removed ${n} demo rows.`);
}

async function seed() {
  const now = new Date().toISOString();
  for (const c of CUSTOMERS) {
    db.put('customers', { ...c, phone: c.jid.split('@')[0], source: MARK, createdAt: now, updatedAt: now });
  }
  let i = 0;
  for (const [jid, messages] of CHATS) {
    for (const [direction, text, minutesAgo] of messages) {
      db.put('chat', { id: `demo-${++i}`, at: ago(minutesAgo), jid, direction, text, source: MARK });
    }
  }
  for (const b of BOOKINGS) {
    db.put('bookings', { ...b, source: MARK, createdAt: now, updatedAt: now });
  }
  await db.flush();
  console.log(`Wrote ${CUSTOMERS.length} customers, ${i} messages, ${BOOKINGS.length} bookings.`);
}

(async () => {
  const backend = await connect();
  console.log(`Storage: ${backend}`);

  if (CLEAR) return clear();

  if (realRowsExist() && !FORCE) {
    console.error(
      '\nThis storage already holds real data.\n' +
        'Seeding demo rows into a live client sheet is almost never what you want.\n' +
        'Use a separate sheet for the demo, or pass --force if you are sure.\n'
    );
    process.exit(1);
  }

  if (!WRITE) {
    console.log('\nDry run. Would write:');
    console.log(`  ${CUSTOMERS.length} customers, ${CHATS.reduce((n, [, m]) => n + m.length, 0)} messages, ${BOOKINGS.length} bookings`);
    console.log('\nRun again with --write to apply, or --clear to remove demo rows.\n');
    return;
  }
  await seed();
})().then(
  () => process.exit(0),
  (err) => {
    console.error(err.message);
    process.exit(1);
  }
);
