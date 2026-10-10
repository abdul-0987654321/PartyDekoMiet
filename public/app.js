/**
 * Shared dashboard code: translations, navigation, small helpers.
 *
 * The dashboard language is a saved setting, but a per-browser override is kept
 * in localStorage so the developer can read it in English while the client's
 * dashboard stays German.
 */

const T = {
  de: {
    nav_status: 'Status', nav_settings: 'Einstellungen', nav_whatsapp: 'WhatsApp', nav_bookings: 'Buchungen',
    logout: 'Abmelden', save: 'Speichern', saving: 'Speichert…', saved: 'Gespeichert', reset: 'Zurücksetzen',
    refresh: 'Aktualisieren', loading: 'Lädt…', none: 'keine', yes: 'ja', no: 'nein',
    unreachable: 'Server nicht erreichbar.',
    bot: 'Bot', whatsapp: 'WhatsApp', storage: 'Speicher (Google Sheet)', pending_writes: 'Offene Schreibvorgänge',
    last_saved: 'Zuletzt gespeichert', started: 'Gestartet', catalog: 'Katalog', calendar: 'Kalender',
    model: 'KI-Modell', openai_key: 'OpenAI-Schlüssel', knowledge: 'Wissensbasis', owner_number: 'Inhaber-Nummer',
    paused_chats: 'Pausierte Chats', products: 'Produkte', never: 'noch nie',
    ready: 'bereit', starting: 'startet…', connected: 'verbunden', set: 'gesetzt', missing: 'fehlt',
    not_wired: 'noch nicht angebunden', not_configured: 'noch nicht eingerichtet', error: 'Fehler',
    g_bot: 'Bot-Verhalten', g_contacts: 'Kontakte', g_business: 'Geschäftsregeln', g_shop: 'Shop',
    g_calendar: 'Kalender', g_dashboard: 'Dashboard',
    src_env: 'aus .env', src_dashboard: 'hier geändert', src_default: 'Standard',
    settings_intro: 'Änderungen gelten sofort, ohne neuen Deploy. Secrets (API-Schlüssel) bleiben bewusst in den Render-Umgebungsvariablen.',
    qr_title: 'WhatsApp verbinden', qr_scan: 'QR-Code mit WhatsApp scannen: Einstellungen → Verknüpfte Geräte → Gerät verknüpfen.',
    qr_wait: 'Warte auf QR-Code…', qr_connected: 'Verbunden. Kein QR-Code nötig.',
    connect: 'Verbinden', relink: 'Neu verknüpfen (neuer QR)', relink_confirm: 'Wirklich abmelden? Es wird ein neuer QR-Code nötig.',
    no_bookings: 'Noch keine Buchungsanfragen.',
    b_id: 'Nr.', b_status: 'Status', b_customer: 'Kunde', b_product: 'Set', b_pickup: 'Abholung', b_return: 'Rückgabe', b_created: 'Erstellt',
    cal_hint: 'Kalender teilen mit:',
  },
  en: {
    nav_status: 'Status', nav_settings: 'Settings', nav_whatsapp: 'WhatsApp', nav_bookings: 'Bookings',
    logout: 'Log out', save: 'Save', saving: 'Saving…', saved: 'Saved', reset: 'Reset',
    refresh: 'Refresh', loading: 'Loading…', none: 'none', yes: 'yes', no: 'no',
    unreachable: 'Server unreachable.',
    bot: 'Bot', whatsapp: 'WhatsApp', storage: 'Storage (Google Sheet)', pending_writes: 'Pending writes',
    last_saved: 'Last saved', started: 'Started', catalog: 'Catalog', calendar: 'Calendar',
    model: 'AI model', openai_key: 'OpenAI key', knowledge: 'Knowledge base', owner_number: 'Owner number',
    paused_chats: 'Paused chats', products: 'products', never: 'never',
    ready: 'ready', starting: 'starting…', connected: 'connected', set: 'set', missing: 'missing',
    not_wired: 'not wired yet', not_configured: 'not set up yet', error: 'error',
    g_bot: 'Bot behaviour', g_contacts: 'Contacts', g_business: 'Business rules', g_shop: 'Shop',
    g_calendar: 'Calendar', g_dashboard: 'Dashboard',
    src_env: 'from .env', src_dashboard: 'changed here', src_default: 'default',
    settings_intro: 'Changes apply immediately, with no redeploy. Secrets (API keys) deliberately stay in the Render environment variables.',
    qr_title: 'Connect WhatsApp', qr_scan: 'Scan the QR code with WhatsApp: Settings → Linked devices → Link a device.',
    qr_wait: 'Waiting for a QR code…', qr_connected: 'Connected. No QR code needed.',
    connect: 'Connect', relink: 'Re-link (new QR)', relink_confirm: 'Really log out? A new QR scan will be needed.',
    no_bookings: 'No booking requests yet.',
    b_id: 'No.', b_status: 'Status', b_customer: 'Customer', b_product: 'Set', b_pickup: 'Pickup', b_return: 'Return', b_created: 'Created',
    cal_hint: 'Share the calendar with:',
  },
};

let LANG = localStorage.getItem('dashLang') || 'de';
const t = (k) => (T[LANG] && T[LANG][k]) || T.de[k] || k;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pill = (text, kind) => `<span class="pill ${kind}">${esc(text)}</span>`;
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(LANG === 'en' ? 'en-GB' : 'de-CH') : t('never'));

function setLang(lang) {
  LANG = lang;
  localStorage.setItem('dashLang', lang);
  location.reload();
}

/** Renders the nav bar and the language switch into <header id="nav">. */
function renderNav(active) {
  const links = [
    ['/', 'nav_status'], ['/whatsapp', 'nav_whatsapp'], ['/bookings', 'nav_bookings'], ['/settings', 'nav_settings'],
  ];
  $('nav').innerHTML = `
    <nav>
      ${links.map(([href, key]) =>
        `<a href="${href}" class="${href === active ? 'on' : ''}">${t(key)}</a>`).join('')}
      <span class="spacer"></span>
      <span class="langswitch">
        <button class="${LANG === 'de' ? 'on' : ''}" onclick="setLang('de')">DE</button>
        <button class="${LANG === 'en' ? 'on' : ''}" onclick="setLang('en')">EN</button>
      </span>
      <form method="post" action="/logout" style="display:inline">
        <button class="link" type="submit">${t('logout')}</button>
      </form>
    </nav>`;
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    location.replace('/login');
    throw new Error('unauthorised');
  }
  return res.json();
}
