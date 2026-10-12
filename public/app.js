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
    nav_chats: 'Chats', tab_qr: 'QR-Code', tab_pair: 'Mit Nummer',
    pair_title: 'Mit Telefonnummer verbinden',
    pair_hint: 'Nummer des Bot-Telefons eingeben (international, ohne +). Dann am Telefon: WhatsApp → Einstellungen → Verknüpfte Geräte → Gerät verknüpfen → «Stattdessen mit Telefonnummer verknüpfen».',
    pair_btn: 'Code anfordern', pair_wait: 'Code wird angefordert…',
    pair_enter: 'Diesen Code am Telefon eingeben:', pair_cancel: 'Abbrechen',
    chat_none: 'Noch keine Chats.', chat_pick: 'Links einen Chat auswählen.',
    chat_send: 'Senden', chat_ph: 'Nachricht schreiben…',
    chat_paused: 'Bot pausiert', chat_back: 'Zurück',
    chat_sent_note: 'Wenn du hier schreibst, pausiert der Bot in diesem Chat.',
    resume_bot: 'Bot wieder aktivieren',
    nav_test: 'Testen', test_intro: 'Mit dem echten Bot schreiben, ohne WhatsApp. Kunden sehen davon nichts.',
    test_try: 'Schnell ausprobieren:', test_who: 'Test-Kunde', test_sub: 'nur zum Testen, kein echter Chat',
    test_reset: 'Neu starten', test_tools: 'Benutzte Werkzeuge',
    test_blocked: 'Antwort von den Regeln blockiert', test_handoff: 'wird an einen Menschen weitergegeben',
    test_other: 'anderer Betrieb – weitergegeben',
    hero_on: 'Bot ist aktiv', hero_off: 'Bot ist ausgeschaltet',
    hero_on_sub: 'Kunden bekommen automatisch Antworten.',
    hero_off_sub: 'Nachrichten werden gelesen, aber nicht beantwortet.',
    hero_nowa: 'WhatsApp nicht verbunden',
    hero_nowa_sub: 'Zuerst das Telefon verknüpfen, dann antwortet der Bot.',
    hero_boot: 'Startet…', hero_boot_sub: 'Einen Moment, der Bot fährt hoch.',
    q_test: 'Bot testen', q_chats: 'Chats lesen', q_book: 'Buchungen', q_set: 'Einstellungen',
    link_wa: 'Jetzt verknüpfen', problems: 'Zu erledigen', all_good: 'Alles eingerichtet.',
    fix_sheet: 'Google Sheet verbinden (SHEET_SECRET)',
    fix_key: 'OpenAI-Schlüssel eintragen',
    fix_cal: 'Kalender einrichten',
    fix_owner: 'Inhaber-Nummer eintragen',
    fix_wa: 'WhatsApp-Telefon verknüpfen',
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
    nav_chats: 'Chats', tab_qr: 'QR code', tab_pair: 'With number',
    pair_title: 'Connect with a phone number',
    pair_hint: 'Enter the bot phone\u2019s number (international, no +). Then on the phone: WhatsApp → Settings → Linked devices → Link a device → "Link with phone number instead".',
    pair_btn: 'Request code', pair_wait: 'Requesting the code…',
    pair_enter: 'Enter this code on the phone:', pair_cancel: 'Cancel',
    chat_none: 'No chats yet.', chat_pick: 'Pick a chat on the left.',
    chat_send: 'Send', chat_ph: 'Write a message…',
    chat_paused: 'Bot paused', chat_back: 'Back',
    chat_sent_note: 'Writing here pauses the bot in this chat.',
    resume_bot: 'Re-activate the bot',
    nav_test: 'Test', test_intro: 'Chat with the real bot, without WhatsApp. Customers never see this.',
    test_try: 'Try quickly:', test_who: 'Test customer', test_sub: 'testing only, not a real chat',
    test_reset: 'Restart', test_tools: 'Tools used',
    test_blocked: 'reply blocked by the rules', test_handoff: 'handed to a human',
    test_other: 'other business - handed over',
    hero_on: 'Bot is active', hero_off: 'Bot is switched off',
    hero_on_sub: 'Customers get answers automatically.',
    hero_off_sub: 'Messages are read but not answered.',
    hero_nowa: 'WhatsApp not connected',
    hero_nowa_sub: 'Link the phone first, then the bot can answer.',
    hero_boot: 'Starting…', hero_boot_sub: 'One moment, the bot is coming up.',
    q_test: 'Test the bot', q_chats: 'Read chats', q_book: 'Bookings', q_set: 'Settings',
    link_wa: 'Link now', problems: 'To do', all_good: 'Everything is set up.',
    fix_sheet: 'Connect the Google Sheet (SHEET_SECRET)',
    fix_key: 'Add the OpenAI key',
    fix_cal: 'Set up the calendar',
    fix_owner: 'Add the owner number',
    fix_wa: 'Link the WhatsApp phone',
  },
};

let LANG = localStorage.getItem('dashLang') || 'de';

/**
 * Saves the chosen language on the server too, so the dashboard opens in the
 * same language on the phone and on the laptop, and so the setting shown under
 * Settings matches what the switch did.
 */
async function persistLang(lang) {
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dashboardLanguage: lang }),
    });
  } catch {
    /* the local choice already applies; a failed save is not worth an alert */
  }
}
const t = (k) => (T[LANG] && T[LANG][k]) || T.de[k] || k;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pill = (text, kind) => `<span class="pill ${kind}">${esc(text)}</span>`;
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(LANG === 'en' ? 'en-GB' : 'de-CH') : t('never'));

function setLang(lang) {
  LANG = lang;
  localStorage.setItem('dashLang', lang);
  persistLang(lang).finally(() => location.reload());
}

/**
 * Renders the shell: a sidebar on desktop, a bottom tab bar on phones.
 * The page's own markup goes inside <div id="content">.
 */
function renderNav(active) {
  const links = [
    ['/', 'nav_status', '◉'],
    ['/chats', 'nav_chats', '💬'],
    ['/bookings', 'nav_bookings', '🗓'],
    ['/whatsapp', 'nav_whatsapp', '🔗'],
    ['/settings', 'nav_settings', '⚙'],
  ];
  const langBtns = `<span class="langswitch">
      <button class="${LANG === 'de' ? 'on' : ''}" onclick="setLang('de')">DE</button>
      <button class="${LANG === 'en' ? 'on' : ''}" onclick="setLang('en')">EN</button>
    </span>`;

  const side = document.createElement('aside');
  side.className = 'side';
  side.innerHTML = `
    <div class="brand">PartyDekoMiet<small>WhatsApp Assistant</small></div>
    ${links.map(([href, key, ic]) =>
      `<a href="${href}" class="${href === active ? 'on' : ''}"><span class="ic">${ic}</span>${t(key)}</a>`).join('')}
    <div class="grow"></div>
    <div class="foot">
      ${langBtns}
      <form method="post" action="/logout" style="margin:0">
        <button class="link" type="submit">${t('logout')}</button>
      </form>
    </div>`;

  const shell = document.querySelector('.shell');
  shell.insertBefore(side, shell.firstChild);

  // Phones hide the sidebar foot, so the language switch moves to a top bar.
  const bar = document.createElement('div');
  bar.className = 'mobile-bar';
  bar.innerHTML = `<span class="t">${t(links.find(([h]) => h === active)?.[1] || 'nav_status')}</span>${langBtns}
    <form method="post" action="/logout" style="margin:0"><button class="link" type="submit">${t('logout')}</button></form>`;
  const content = document.getElementById('content');
  content.insertBefore(bar, content.firstChild);
}

/**
 * First visit on a new device: follow the language saved on the server instead of
 * defaulting to German. Runs once per tab and only when this browser has no
 * explicit choice of its own, so switching language here always wins afterwards.
 */
async function syncLangFromServer() {
  if (localStorage.getItem('dashLang')) return;      // this browser already chose
  if (sessionStorage.getItem('langSynced')) return;  // guard against a reload loop
  sessionStorage.setItem('langSynced', '1');
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const d = await res.json();
    if (d.lang && d.lang !== LANG) {
      localStorage.setItem('dashLang', d.lang);
      location.reload();
    }
  } catch {
    /* stay on the default */
  }
}
syncLangFromServer();

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
