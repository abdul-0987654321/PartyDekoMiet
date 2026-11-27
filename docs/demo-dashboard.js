'use strict';
/* A demo instance of the dashboard, only for photographing the manual.
   Express cannot be installed in this container, so the pages are served
   statically and the API answers with realistic German demo data. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = '/home/claude/partydekomiet/public';
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

const db = require('/home/claude/partydekomiet/src/store/db');
const { createMemoryBackend } = require('/home/claude/partydekomiet/src/store/backend-memory');
const settingsMod = require('/home/claude/partydekomiet/src/settings');
let SCHEMA = [];

const LOCATIONS = [
  { id: 'l1', name: 'Studio Zürich West', address: 'Hardstrasse 219, 8005 Zürich', active: true },
  { id: 'l2', name: 'Studio Oerlikon', address: 'Schaffhauserstrasse 120, 8302 Kloten', active: true },
];
const PROS = [
  { id: 'p1', name: 'Sofia', active: true, languages: 'Deutsch, Englisch, Portugiesisch', workingHours: 'Mo–Fr 10:00–13:00', whatsapp: '41791112233', locationId: 'l1', availability: 'free', photoFileId: '', notes: '' },
  { id: 'p2', name: 'Gabriela', active: true, languages: 'Deutsch, Italienisch', workingHours: 'Di–Sa 14:00–20:00', whatsapp: '41794445566', locationId: 'l1', availability: 'busy', busySince: new Date(Date.now() - 40 * 60000).toISOString(), busyNote: 'noch ca. 30 Min.', photoFileId: '', notes: '' },
  { id: 'p3', name: 'Lena', active: true, languages: 'Deutsch', workingHours: 'Mi–So 12:00–18:00', whatsapp: '41797778899', locationId: 'l2', availability: 'free', photoFileId: '', notes: '' },
];
const SERVICES = [
  { id: 's1', name: 'Klassische Massage 60 Min.', professionalId: '', durationMin: 60, priceChf: 180, active: true, notes: 'Ganzkörpermassage mit warmem Öl. Ruhiger Raum, Dusche vorhanden. Bitte 5 Minuten früher da sein.' },
  { id: 's2', name: 'Klassische Massage 90 Min.', professionalId: '', durationMin: 90, priceChf: 250, active: true, notes: 'Wie die 60-Minuten-Massage, mit mehr Zeit für Rücken und Schultern.' },
  { id: 's3', name: 'Hot Stone 90 Min.', professionalId: 'p1', durationMin: 90, priceChf: 260, active: true, notes: 'Mit erwärmten Basaltsteinen. Nur bei Sofia.' },
  { id: 's4', name: 'Rückenmassage 30 Min.', professionalId: '', durationMin: 30, priceChf: 95, active: true, notes: 'Kurz und gezielt, gut in der Mittagspause.' },
  { id: 's5', name: 'Aromaöl-Massage 60 Min.', professionalId: 'p2', durationMin: 60, priceChf: 200, active: true, notes: 'Mit Duftölen nach Wahl. Nur bei Gabriela.' },
];
const FAQ = [
  { id: 'f1', question: 'Habt ihr Parkplätze?', answerDe: 'Ja, direkt vor dem Haus und in der Tiefgarage nebenan.', answerEn: 'Yes, right outside and in the car park next door.', business: 'studio', active: true },
  { id: 'f2', question: 'Kann ich mit Karte bezahlen?', answerDe: 'Ja, Karte und Twint gehen beide. Barzahlung ebenfalls.', answerEn: 'Yes, card and Twint both work. Cash too.', business: 'studio', active: true },
  { id: 'f3', question: 'Wie kurzfristig kann ich buchen?', answerDe: 'Eine Stunde vorher reicht meistens. Am Wochenende besser früher.', answerEn: 'An hour ahead is usually enough. Earlier at weekends.', business: 'studio', active: true },
];
const LINES = [
  { id: 'party', name: 'PartyDekoMiet', builtIn: true, active: true, connected: true, status: 'connected', professionalId: '', alertNumbers: '' },
  { id: 'studio', name: 'Studio', builtIn: true, active: true, connected: true, status: 'connected', professionalId: '', alertNumbers: '' },
  { id: 'pro-sofia', name: 'Sofia', builtIn: false, active: true, connected: true, status: 'connected', professionalId: 'p1', alertNumbers: '' },
  { id: 'pro-gabriela', name: 'Gabriela', builtIn: false, active: true, connected: true, status: 'connected', professionalId: 'p2', alertNumbers: '' },
  { id: 'pro-lena', name: 'Lena', builtIn: false, active: true, connected: false, status: 'disconnected', professionalId: 'p3', alertNumbers: '' },
];

const iso = (daysFromNow, hhmm = '12:00') => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${d.toISOString().slice(0, 10)}T${hhmm}:00.000Z`;
};
const day = (n) => iso(n).slice(0, 10);

const APPTS = [
  { id: 'A1', status: 'PENDING', customerName: 'Marco Brunner', phone: '41761234567', professionalId: 'p1', professionalName: 'Sofia', serviceName: 'Klassische Massage 60 Min.', priceChf: 180, date: day(1), startTime: '11:00', endTime: '12:00', createdAt: iso(0, '08:12') },
  { id: 'A2', status: 'PENDING', customerName: 'Thomas Keller', phone: '41769876543', professionalId: 'p2', professionalName: 'Gabriela', serviceName: 'Aromaöl-Massage 60 Min.', priceChf: 200, date: day(2), startTime: '15:00', endTime: '16:00', createdAt: iso(0, '09:40') },
  { id: 'A3', status: 'CONFIRMED', customerName: 'Daniel Weber', phone: '41765551122', professionalId: 'p1', professionalName: 'Sofia', serviceName: 'Hot Stone 90 Min.', priceChf: 260, date: day(3), startTime: '10:00', endTime: '11:30', createdAt: iso(-1, '17:05') },
  { id: 'A4', status: 'CANCELLED', customerName: 'Peter Lang', phone: '41763334455', professionalId: 'p3', professionalName: 'Lena', serviceName: 'Rückenmassage 30 Min.', priceChf: 95, date: day(1), startTime: '13:00', endTime: '13:30', createdAt: iso(-2, '11:20') },
];
const BOOKINGS = [
  { id: 'B1', status: 'PENDING', customerName: 'Familie Studer', phone: '41762223344', productTitle: 'Ballonbogen Pastell', priceChf: 180, startDate: day(5), endDate: day(8), occasion: 'Geburtstag', createdAt: iso(0, '07:50') },
  { id: 'B2', status: 'CONFIRMED', customerName: 'Nadine Frei', phone: '41768887766', productTitle: 'Candy Bar Deluxe', priceChf: 240, startDate: day(9), endDate: day(12), occasion: 'Hochzeit', createdAt: iso(-1, '14:02') },
];
const CHATS = [
  { jid: '41761234567@s.whatsapp.net', phone: '41761234567', name: 'Marco Brunner', lastAt: iso(0, '08:12'), lastText: 'Super, dann morgen um 11. Danke!', lastDirection: 'in', messages: 14, paused: false },
  { jid: '41769876543@s.whatsapp.net', phone: '41769876543', name: 'Thomas Keller', lastAt: iso(0, '09:40'), lastText: 'Ich habe deine Anfrage ans Team weitergegeben, du hörst gleich von uns.', lastDirection: 'out', messages: 9, paused: false },
  { jid: '41765551122@s.whatsapp.net', phone: '41765551122', name: 'Daniel Weber', lastAt: iso(-1, '17:05'), lastText: 'Passt, bis Donnerstag.', lastDirection: 'in', messages: 21, paused: true },
];
const MESSAGES = [
  { id: 'm1', jid: '41761234567@s.whatsapp.net', at: iso(0, '07:58'), direction: 'in', text: 'Guten Morgen, habt ihr morgen Vormittag etwas frei?' },
  { id: 'm2', jid: '41761234567@s.whatsapp.net', at: iso(0, '07:58'), direction: 'out', text: 'Guten Morgen! Ja, morgen Vormittag geht einiges. Suchst du etwas Bestimmtes, oder soll ich dir kurz sagen, wer da ist?' },
  { id: 'm3', jid: '41761234567@s.whatsapp.net', at: iso(0, '08:02'), direction: 'in', text: 'Eine normale Massage, eine Stunde.' },
  { id: 'm4', jid: '41761234567@s.whatsapp.net', at: iso(0, '08:03'), direction: 'out', text: 'Die klassische Massage 60 Minuten kostet CHF 180. Sofia hätte morgen um 11:00 Zeit. Passt dir das?' },
  { id: 'm5', jid: '41761234567@s.whatsapp.net', at: iso(0, '08:10'), direction: 'in', text: 'Ja gerne. Marco Brunner.' },
  { id: 'm6', jid: '41761234567@s.whatsapp.net', at: iso(0, '08:11'), direction: 'out', text: 'Danke Marco. Ich habe die Anfrage für morgen 11:00 bei Sofia angelegt. Das Team bestätigt sie dir gleich.' },
  { id: 'm7', jid: '41761234567@s.whatsapp.net', at: iso(0, '08:12'), direction: 'in', text: 'Super, dann morgen um 11. Danke!' },
];

const status = (biz) => {
  const line = LINES.find((l) => l.id === biz) || LINES[0];
  const her = PROS.find((p) => p.id === line.professionalId) || null;
  const isStudio = biz !== 'party';
  return {
    ok: true,
    biz,
    line: { id: line.id, name: line.name, professionalId: line.professionalId },
    professional: her ? {
      id: her.id, name: her.name, active: true, languages: her.languages,
      workingHours: her.workingHours, whatsapp: her.whatsapp,
      availability: her.availability, busySince: her.busySince || '', busyNote: her.busyNote || '',
      photoFileId: '', locationName: LOCATIONS.find((l) => l.id === her.locationId)?.name || '',
      locationAddress: LOCATIONS.find((l) => l.id === her.locationId)?.address || '',
    } : null,
    ready: true,
    startedAt: iso(-1, '06:00'),
    uptimeSeconds: 93600,
    storage: { backend: 'sheets', pendingWrites: 0, lastFlushAt: iso(0, '09:58'), lastFlushError: null },
    storageError: null, storageWarning: null, calendarError: null, bootError: null,
    knowledge: { source: 'files', faqEntries: FAQ.length },
    catalog: isStudio ? null : { count: 46, lastError: null },
    ai: { lastError: null, count: 0 },
    skipped: { last: null, counts: {} },
    whatsapp: { status: line.connected ? 'connected' : 'disconnected', me: { id: '41786353632:12@s.whatsapp.net' } },
    pausedChats: [{ jid: '41765551122@s.whatsapp.net', until: iso(0, '20:00'), reason: 'owner replied manually' }],
    lang: 'de',
    directory: isStudio ? {
      locations: LOCATIONS.length, professionals: PROS.length, services: SERVICES.length,
      servicesWithDetails: SERVICES.filter((s) => s.notes).length, photos: 2, faq: FAQ.length,
    } : null,
    config: {
      model: 'gpt-4o-mini', hasOpenAiKey: true, hasServiceAccount: true, hasSheet: true,
      calendarConfigured: true, calendarSource: 'dashboard', serviceAccountEmail: null,
      botEnabled: true, botLanguage: 'auto', ownerNumber: '…3632',
    },
  };
};

const calendarEntries = () => {
  const out = [];
  for (const a of APPTS) {
    if (a.status === 'CANCELLED') continue;
    out.push({
      id: a.id, allDay: false, startDate: a.date, endDate: a.date,
      startTime: a.startTime, endTime: a.endTime,
      title: `${a.professionalName} · ${a.serviceName}`, status: a.status, source: 'booking',
      appointmentId: a.id, professionalId: a.professionalId, professionalName: a.professionalName, phone: a.phone,
    });
  }
  out.push({
    id: 'blk1', allDay: true, startDate: day(4), endDate: day(4), startTime: '', endTime: '',
    title: 'Geschlossen – Feiertag', status: null, source: 'owner',
  });
  return out;
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const biz = url.searchParams.get('biz') || 'party';
  const send = (code, body, type) => {
    res.writeHead(code, { 'content-type': type || 'application/json' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  if (url.pathname.startsWith('/api/')) {
    const p = url.pathname;
    if (p === '/api/status') return send(200, status(biz));
    if (p === '/api/lines') return send(200, { ok: true, max: 7, lines: LINES });
    if (p === '/api/bookings') {
      if (biz === 'party') return send(200, { ok: true, bookings: BOOKINGS });
      const her = LINES.find((l) => l.id === biz)?.professionalId;
      return send(200, { ok: true, appointments: her ? APPTS.filter((a) => a.professionalId === her) : APPTS });
    }
    if (p === '/api/chats') return send(200, { ok: true, chats: CHATS });
    if (p.startsWith('/api/chats/')) {
      const jid = decodeURIComponent(p.slice('/api/chats/'.length));
      return send(200, { ok: true, jid, phone: jid.split('@')[0], customer: { name: 'Marco Brunner' }, paused: null, messages: MESSAGES });
    }
    if (p === '/api/studio/professionals') return send(200, { ok: true, professionals: PROS });
    if (p === '/api/studio/services') return send(200, { ok: true, services: SERVICES });
    if (p === '/api/studio/locations') return send(200, { ok: true, locations: LOCATIONS });
    if (p === '/api/studio/roster') {
      return send(200, { ok: true, roster: PROS.map((x) => ({
        id: x.id, name: x.name,
        busy: x.availability === 'busy',
        since: x.busySince || '', until: '', note: x.busyNote || '',
        hasOwnNumber: Boolean(x.whatsapp),
      })) });
    }
    if (p === '/api/faq') return send(200, { ok: true, entries: FAQ });
    if (p === '/api/settings') return send(200, { ok: true, settings: SCHEMA, schema: SCHEMA });
    if (p === '/api/alerts/where') return send(200, { ok: true, numbers: ['41786353632'], source: 'linked', key: null });
    if (p === '/api/calendar') return send(200, { ok: true, entries: calendarEntries(), today: day(0) });
    if (p === '/api/whatsapp') return send(200, { ok: true, status: 'connected', me: { id: '41786353632:12@s.whatsapp.net' } });
    return send(200, { ok: true, items: [] });
  }

  let p = url.pathname === '/' ? '/status.html' : url.pathname;
  if (!path.extname(p)) p += '.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) return send(404, 'not found', 'text/plain');
  send(200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
}).listen(4330, async () => {
  await db.init(createMemoryBackend());
  settingsMod.load();
  SCHEMA = settingsMod.describe();
  console.log('demo on 4330, settings fields:', SCHEMA.length);
});
