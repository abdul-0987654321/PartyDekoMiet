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
    g_calendar: 'Kalender', g_studio: 'Studio', g_dashboard: 'Dashboard',
    src_env: 'aus .env', src_dashboard: 'hier geändert', src_default: 'Standard',
    settings_intro: 'Änderungen gelten sofort, ohne neuen Deploy. Secrets (API-Schlüssel) bleiben bewusst in den Render-Umgebungsvariablen.',
    qr_title: 'WhatsApp verbinden', qr_scan: 'QR-Code mit WhatsApp scannen: Einstellungen → Verknüpfte Geräte → Gerät verknüpfen.',
    qr_wait: 'Warte auf QR-Code…', qr_connected: 'Verbunden. Kein QR-Code nötig.',
    wa_blocked: 'Blockiert', qr_blocked: 'WhatsApp hat mehrere Verbindungsversuche in Folge abgelehnt. Automatische Versuche wurden gestoppt, damit die Nummer nicht weiter auffällt. Ein paar Stunden warten, dann unten auf „Verbinden" klicken.',
    connect: 'Verbinden', relink: 'Neu verknüpfen (neuer QR)', relink_confirm: 'Wirklich abmelden? Es wird ein neuer QR-Code nötig.',
    no_bookings: 'Noch keine Buchungsanfragen.',
    b_id: 'Nr.', b_status: 'Status', b_customer: 'Kunde', b_product: 'Set', b_pickup: 'Abholung', b_return: 'Rückgabe', b_created: 'Erstellt',
    cal_hint: 'Kalender teilen mit:', copy: 'Kopieren', copied: 'Kopiert ✓',
    cal_not_ready: 'Kalender-Zugang ist noch nicht eingerichtet (GOOGLE_SERVICE_ACCOUNT_JSON_B64 fehlt in Render). Bitte den Entwickler fragen.',
    cal_steps: '1) Neuen Google-Kalender erstellen (calendar.google.com). 2) Einstellungen und Freigabe → Für bestimmte Personen freigeben → diese Adresse einfügen → Berechtigung «Termine ändern» wählen → Senden. 3) Weiter unten unter «Kalender integrieren» die Kalender-ID kopieren und unten in das Feld einfügen.',
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
    fix_ai: 'OpenAI-Schlüssel wird abgelehnt – neuen Schlüssel in Render setzen',
    ai_ok: 'antwortet', ai_bad: 'Fehler',
    b_action: 'Status ändern', b_confirm: 'Bestätigen', b_cancel: 'Stornieren', b_pending: 'Zurück auf offen',
    b_confirm_q: 'Zahlung ist eingegangen? Die Buchung wird auf CONFIRMED gesetzt.',
    b_cancel_q: 'Buchung stornieren? Der Kalendereintrag wird gelöscht und die Tage werden wieder frei.',
    b_cal_warn: 'Buchung geändert, aber der Kalender konnte nicht aktualisiert werden:',
    last_skip: 'Zuletzt nicht beantwortet',
    sk_paused: 'Chat pausiert', sk_bot_off: 'Bot ausgeschaltet',
    sk_rate_limit: 'Stundenlimit', sk_no_agent: 'kein OpenAI-Schlüssel',
    b_intro: 'Neue Anfragen sind offen, bis die Zahlung im Shop eingegangen ist. Dann auf «Bestätigen» tippen.',
    b_f_open: 'Offen', b_f_conf: 'Bestätigt', b_f_canc: 'Storniert', b_f_all: 'Alle',
    b_s_pending: 'Offen', b_s_confirmed: 'Bestätigt', b_s_cancelled: 'Storniert',
    b_open_chat: 'Chat öffnen',
    s_adv: 'Erweitert', s_unsaved: 'Ungespeicherte Änderungen',

    biz_party: 'PartyDeko', biz_studio: 'Studio',
    lb_ok: 'OK', lb_yes: 'Ja, weiter', lb_cancel: 'Abbrechen',
    setup: 'Einrichtung', setup_done_title: 'Einrichtung abgeschlossen', su_optional: '(optional)',
    su_location: 'Standort anlegen',
    su_service: 'Services mit Dauer und Preis anlegen',
    su_details: 'Bei jedem Service eintragen, was er beinhaltet',
    su_pro: 'Professionals anlegen',
    su_photo: 'Fotos hochladen',
    su_hours: 'Kalender verbinden',
    su_alert: 'Nummer fuer Benachrichtigungen eintragen',
    su_wa: 'WhatsApp-Nummer verknuepfen',
    su_faq: 'Haeufige Fragen beantworten',
    nav_faq: 'Fragen & Antworten',
    empty_add: 'Jetzt anlegen',
    no_locations_yet: 'Noch kein Standort angelegt.',
    no_services_yet: 'Noch kein Service angelegt.',
    pick_none: 'Noch keine vorhanden',
    add_first: 'Zuerst anlegen',
    chat_search: 'Suchen', chat_no_match: 'Nichts gefunden.',
    chat_delete: 'Verlauf loeschen',
    chat_delete_q: 'Den gespeicherten Verlauf mit {who} loeschen? Das betrifft nur dieses Dashboard - auf WhatsApp bleibt die Unterhaltung bestehen.',
    l_no_address: 'Adresse fehlt',
    s_no_price: 'Kein Preis', s_no_notes: 'Beschreibung fehlt',
    p_no_location: 'Kein Standort', p_no_photo: 'Kein Foto',
    s_notes_help: 'Was dieser Service beinhaltet. Genau das erzaehlt der Bot, wenn ein Kunde nach Details fragt - bleibt das Feld leer, sagt er, dass er dazu nichts weiss.',
    f_intro: 'Eigene Fragen und Antworten. Der Bot benutzt sie woertlich - er formuliert sie nicht um.',
    no_faq: 'Noch keine Fragen hinterlegt.',
    f_question: 'Frage des Kunden', f_answer_de: 'Antwort (Deutsch)', f_answer_en: 'Antwort (Englisch)',
    f_q_help: 'Worum es geht, in den Worten eines Kunden. Z.B. "Habt ihr Parkplaetze?"',
    f_a_help: 'Eine Sprache reicht - die andere wird dann auch damit beantwortet.',
    nav_appointments: 'Termine', nav_professionals: 'Professionals', nav_services: 'Services', nav_locations: 'Standorte',
    add: 'Hinzufügen', edit: 'Bearbeiten', delete: 'Löschen', delete_confirm: 'Wirklich löschen?',
    active: 'Aktiv', inactive: 'Inaktiv', name: 'Name', photo: 'Foto', upload_photo: 'Foto hochladen',
    p_age: 'Alter', p_languages: 'Sprachen (Komma-getrennt)', p_lang_short: 'Sprachen', p_hours: 'Arbeitszeiten', p_location: 'Standort',
    p_none_lang: 'keine', p_none_hours: 'noch nicht eingetragen', p_intro: 'Professionals - vom Team selbst gepflegt. Nichts hier ist im Code fest eingetragen.',
    no_professionals: 'Noch keine Professionals angelegt.',
    s_name: 'Service', s_for: 'Für', s_for_all: 'Alle Professionals', s_duration: 'Dauer (Min.)', s_price: 'Preis (CHF)', s_notes: 'Hinweise',
    s_intro: 'Services und Preise - das Einzige, was der Bot je nennen darf.',
    no_services: 'Noch keine Services angelegt.',
    l_name: 'Standort', l_address: 'Adresse',
    l_intro: 'Standorte der Professionals.',
    no_locations: 'Noch keine Standorte angelegt.',
    appt_intro: 'Neue Anfragen sind offen, bis das Team sie bestätigt.',
    a_professional: 'Professional', a_service: 'Service', a_date: 'Datum', a_time: 'Zeit',
    no_appointments: 'Noch keine Terminanfragen.',
    save_err: 'Konnte nicht gespeichert werden',
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
    g_calendar: 'Calendar', g_studio: 'Studio', g_dashboard: 'Dashboard',
    src_env: 'from .env', src_dashboard: 'changed here', src_default: 'default',
    settings_intro: 'Changes apply immediately, with no redeploy. Secrets (API keys) deliberately stay in the Render environment variables.',
    qr_title: 'Connect WhatsApp', qr_scan: 'Scan the QR code with WhatsApp: Settings → Linked devices → Link a device.',
    qr_wait: 'Waiting for a QR code…', qr_connected: 'Connected. No QR code needed.',
    wa_blocked: 'Blocked', qr_blocked: 'WhatsApp rejected several connection attempts in a row. Automatic retries were stopped so the number doesn\'t get flagged further. Wait a few hours, then click "Connect" below.',
    connect: 'Connect', relink: 'Re-link (new QR)', relink_confirm: 'Really log out? A new QR scan will be needed.',
    no_bookings: 'No booking requests yet.',
    b_id: 'No.', b_status: 'Status', b_customer: 'Customer', b_product: 'Set', b_pickup: 'Pickup', b_return: 'Return', b_created: 'Created',
    cal_hint: 'Share the calendar with:', copy: 'Copy', copied: 'Copied ✓',
    cal_not_ready: 'Calendar access is not set up yet (GOOGLE_SERVICE_ACCOUNT_JSON_B64 is missing in Render). Ask the developer.',
    cal_steps: '1) Create a new Google Calendar (calendar.google.com). 2) Settings and sharing → Share with specific people → paste this address → choose "Make changes to events" → Send. 3) Further down under "Integrate calendar", copy the Calendar ID and paste it into the field below.',
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
    fix_ai: 'OpenAI key is being rejected – set a new key in Render',
    ai_ok: 'answering', ai_bad: 'failing',
    b_action: 'Change status', b_confirm: 'Confirm', b_cancel: 'Cancel', b_pending: 'Back to pending',
    b_confirm_q: 'Payment received? The booking will be set to CONFIRMED.',
    b_cancel_q: 'Cancel this booking? The calendar entry is deleted and the days become free again.',
    b_cal_warn: 'Booking changed, but the calendar could not be updated:',
    last_skip: 'Last message not answered',
    sk_paused: 'chat paused', sk_bot_off: 'bot switched off',
    sk_rate_limit: 'hourly limit', sk_no_agent: 'no OpenAI key',
    b_intro: 'New requests stay open until the payment arrives in the shop. Then tap "Confirm".',
    b_f_open: 'Open', b_f_conf: 'Confirmed', b_f_canc: 'Cancelled', b_f_all: 'All',
    b_s_pending: 'Open', b_s_confirmed: 'Confirmed', b_s_cancelled: 'Cancelled',
    b_open_chat: 'open chat',
    s_adv: 'Advanced', s_unsaved: 'Unsaved changes',

    biz_party: 'PartyDeko', biz_studio: 'Studio',
    lb_ok: 'OK', lb_yes: 'Yes, continue', lb_cancel: 'Cancel',
    setup: 'Setup', setup_done_title: 'Setup complete', su_optional: '(optional)',
    su_location: 'Add a location',
    su_service: 'Add services with duration and price',
    su_details: 'Say what each service includes',
    su_pro: 'Add professionals',
    su_photo: 'Upload photos',
    su_hours: 'Connect the calendar',
    su_alert: 'Set a number for alerts',
    su_wa: 'Link the WhatsApp number',
    su_faq: 'Answer common questions',
    nav_faq: 'Questions & answers',
    empty_add: 'Add one now',
    no_locations_yet: 'No location added yet.',
    no_services_yet: 'No service added yet.',
    pick_none: 'None yet',
    add_first: 'Add one first',
    chat_search: 'Search', chat_no_match: 'Nothing found.',
    chat_delete: 'Delete history',
    chat_delete_q: 'Delete the stored history with {who}? This only affects this dashboard - the conversation stays on WhatsApp.',
    l_no_address: 'Address missing',
    s_no_price: 'No price', s_no_notes: 'Description missing',
    p_no_location: 'No location', p_no_photo: 'No photo',
    s_notes_help: 'What this service includes. This is exactly what the bot tells a customer who asks for details - leave it empty and it will say it does not know.',
    f_intro: 'Your own questions and answers. The bot uses them word for word - it does not rewrite them.',
    no_faq: 'No questions added yet.',
    f_question: "Customer's question", f_answer_de: 'Answer (German)', f_answer_en: 'Answer (English)',
    f_q_help: 'How a customer would ask it. E.g. "Do you have parking?"',
    f_a_help: 'One language is enough - the other will use the same answer.',
    nav_appointments: 'Appointments', nav_professionals: 'Professionals', nav_services: 'Services', nav_locations: 'Locations',
    add: 'Add', edit: 'Edit', delete: 'Delete', delete_confirm: 'Really delete this?',
    active: 'Active', inactive: 'Inactive', name: 'Name', photo: 'Photo', upload_photo: 'Upload photo',
    p_age: 'Age', p_languages: 'Languages (comma-separated)', p_lang_short: 'Languages', p_hours: 'Working hours', p_location: 'Location',
    p_none_lang: 'none', p_none_hours: 'not entered yet', p_intro: 'Professionals - maintained by the team themselves. Nothing here is hardcoded.',
    no_professionals: 'No professionals yet.',
    s_name: 'Service', s_for: 'For', s_for_all: 'Every professional', s_duration: 'Duration (min)', s_price: 'Price (CHF)', s_notes: 'Notes',
    s_intro: 'Services and prices - the only things the bot may ever name.',
    no_services: 'No services yet.',
    l_name: 'Location', l_address: 'Address',
    l_intro: 'The professionals\' locations.',
    no_locations: 'No locations yet.',
    appt_intro: 'New requests stay open until the team confirms them.',
    a_professional: 'Professional', a_service: 'Service', a_date: 'Date', a_time: 'Time',
    no_appointments: 'No appointment requests yet.',
    save_err: 'Could not save',
  },
};

let LANG = localStorage.getItem('dashLang') || 'de';

/**
 * One dashboard, two businesses. The selected one is a per-browser choice
 * (like the language), never sent anywhere until a page's own script reads
 * it - this file only needs to carry it through every API call and draw the
 * switch, so every page's logic stays oblivious to the other business.
 */
let BIZ = localStorage.getItem('dashBiz') || 'party';
function setBiz(biz) {
  if (biz === BIZ) return;
  BIZ = biz;
  localStorage.setItem('dashBiz', biz);
  location.reload();
}

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
const NAV_LINKS = {
  party: [
    ['/', 'nav_status', '◉'],
    ['/chats', 'nav_chats', '💬'],
    ['/bookings', 'nav_bookings', '🗓'],
    ['/whatsapp', 'nav_whatsapp', '🔗'],
    ['/faq', 'nav_faq', '❓'],
    ['/settings', 'nav_settings', '⚙'],
  ],
  studio: [
    ['/', 'nav_status', '◉'],
    ['/chats', 'nav_chats', '💬'],
    ['/bookings', 'nav_appointments', '🗓'],
    ['/whatsapp', 'nav_whatsapp', '🔗'],
    ['/professionals', 'nav_professionals', '👤'],
    ['/services', 'nav_services', '📋'],
    ['/locations', 'nav_locations', '📍'],
    ['/faq', 'nav_faq', '❓'],
    ['/settings', 'nav_settings', '⚙'],
  ],
};

/** The selected business's own name. Every place the brand is shown reads this. */
function brandName() {
  return BIZ === 'studio' ? 'Studio' : 'PartyDekoMiet';
}

function renderNav(active) {
  const links = NAV_LINKS[BIZ] || NAV_LINKS.party;
  // Each page ships a static <title> with the party name in it. The browser tab
  // is the one label that is visible on every page and in every bookmark, so it
  // has to follow the switch like the sidebar does.
  const pageKey = links.find(([h]) => h === active)?.[1] || 'nav_status';
  document.title = `${t(pageKey)} – ${brandName()}`;
  const langBtns = `<span class="langswitch">
      <button class="${LANG === 'de' ? 'on' : ''}" onclick="setLang('de')">DE</button>
      <button class="${LANG === 'en' ? 'on' : ''}" onclick="setLang('en')">EN</button>
    </span>`;
  const bizBtns = `<span class="langswitch bizswitch">
      <button class="${BIZ === 'party' ? 'on' : ''}" onclick="setBiz('party')">${t('biz_party')}</button>
      <button class="${BIZ === 'studio' ? 'on' : ''}" onclick="setBiz('studio')">${t('biz_studio')}</button>
    </span>`;

  const side = document.createElement('aside');
  side.className = 'side';
  side.innerHTML = `
    <div class="brand">${brandName()}<small>WhatsApp Assistant</small></div>
    ${bizBtns}
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

  // Phones hide the sidebar foot, so the language and business switches move
  // to a top bar.
  const bar = document.createElement('div');
  bar.className = 'mobile-bar';
  bar.innerHTML = `<span class="t">${t(links.find(([h]) => h === active)?.[1] || 'nav_status')}</span>${bizBtns}${langBtns}
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

/**
 * Business-aware API paths get `?biz=studio` added automatically (or `&biz=`
 * if the path already has a query string), so every page's own script just
 * calls api('/api/status') and never has to know BIZ exists. Paths that are
 * not business-specific (settings, catalog) simply ignore the extra param.
 */
const BIZ_AWARE_PREFIXES = ['/api/status', '/api/whatsapp', '/api/chats', '/api/bookings', '/api/test/chat'];
function withBiz(path) {
  if (BIZ === 'party') return path; // party is the default on every endpoint - no param needed
  if (!BIZ_AWARE_PREFIXES.some((p) => path.startsWith(p))) return path;
  return path + (path.includes('?') ? '&' : '?') + 'biz=' + BIZ;
}

async function api(path, options) {
  const res = await fetch(withBiz(path), {
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

/* ---------------------------------------------------------------------------
 * Lightbox: our own modal, in place of the browser's alert() and confirm().
 *
 * The native ones are the browser's chrome, not ours - unstyled, impossible to
 * make mobile-friendly, and on a phone they read like a browser warning rather
 * than part of this dashboard. They also block the page thread entirely, which
 * on WhatsApp pages can stall a poll mid-flight.
 *
 * Both return promises: say(...) resolves when dismissed, ask(...) resolves
 * true/false, so a call site changes from `if (!confirm(q)) return;` to
 * `if (!(await ask(q))) return;` and nothing else moves.
 * ------------------------------------------------------------------------- */

function closeBox(box, resolve, value) {
  box.classList.remove('on');
  // Let the fade finish before the node goes, or it vanishes mid-animation.
  setTimeout(() => box.remove(), 140);
  document.removeEventListener('keydown', box._onKey);
  resolve(value);
}

function lightbox({ title = '', message = '', confirmLabel, cancelLabel = null, danger = false }) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = `
      <div class="lb-card" role="dialog" aria-modal="true">
        ${title ? `<h3>${escapeHtml(title)}</h3>` : ''}
        <p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>
        <div class="lb-actions">
          ${cancelLabel ? `<button class="ghost" data-act="cancel">${escapeHtml(cancelLabel)}</button>` : ''}
          <button class="${danger ? 'danger' : ''}" data-act="ok">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;

    box._onKey = (e) => {
      if (e.key === 'Escape') closeBox(box, resolve, false);
      if (e.key === 'Enter') closeBox(box, resolve, true);
    };
    box.querySelector('[data-act="ok"]').onclick = () => closeBox(box, resolve, true);
    const cancel = box.querySelector('[data-act="cancel"]');
    if (cancel) cancel.onclick = () => closeBox(box, resolve, false);
    // Clicking the backdrop is a cancel, but only the backdrop itself - a click
    // that started inside the card and drifted out must not dismiss it.
    box.onmousedown = (e) => { if (e.target === box) closeBox(box, resolve, false); };

    document.addEventListener('keydown', box._onKey);
    document.body.appendChild(box);
    requestAnimationFrame(() => box.classList.add('on'));
    box.querySelector('[data-act="ok"]').focus();
  });
}

/** Message with a single OK. Replaces alert(). */
function say(message, { title = '', danger = false } = {}) {
  return lightbox({ title, message, confirmLabel: t('lb_ok'), danger });
}

/** Yes/no question. Replaces confirm() - resolves true only on confirm. */
function ask(message, { title = '', confirmLabel = null, danger = true } = {}) {
  return lightbox({
    title,
    message,
    confirmLabel: confirmLabel || t('lb_yes'),
    cancelLabel: t('lb_cancel'),
    danger,
  });
}

/** Anything from the server goes through here before it reaches innerHTML. */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * An empty list is a dead end unless it says what to do next. Every list page
 * uses this instead of a bare "nothing here" line, so the way forward is always
 * one tap away - including when the missing thing lives on another page.
 *
 * @param {object} o
 * @param {string} o.icon
 * @param {string} o.title
 * @param {string} [o.text]
 * @param {string} [o.actionLabel]
 * @param {string} [o.href]    another page; omit for an on-page button
 * @param {string} [o.onclick] name of a global function, for an on-page action
 */
function emptyState({ icon = '○', title, text = '', actionLabel = '', href = '', onclick = '' }) {
  const action = !actionLabel
    ? ''
    : href
      ? `<a class="primary" href="${href}">${escapeHtml(actionLabel)}</a>`
      : `<button class="primary" onclick="${escapeHtml(onclick)}()">${escapeHtml(actionLabel)}</button>`;
  return `<div class="card emptybox">
    <div class="ic">${icon}</div>
    <h3>${escapeHtml(title)}</h3>
    ${text ? `<p>${escapeHtml(text)}</p>` : ''}
    ${action}
  </div>`;
}

/**
 * A <select> over records from another page. When there are none, the dropdown
 * is useless on its own - it offers one empty choice and no way to fix that -
 * so this renders the hint and the link to the page that fills it.
 */
function pickerWithLink({ id, items, selected = '', href, addLabel, emptyText }) {
  const options = [`<option value="">–</option>`]
    .concat(items.map((i) => `<option value="${escapeHtml(i.id)}"${i.id === selected ? ' selected' : ''}>${escapeHtml(i.name)}</option>`))
    .join('');
  const hint = items.length
    ? `<div class="pickhint"><a href="${href}">+ ${escapeHtml(addLabel)}</a></div>`
    : `<div class="pickhint">${escapeHtml(emptyText)} <a href="${href}">${escapeHtml(addLabel)} →</a></div>`;
  return `<select id="${id}">${options}</select>${hint}`;
}
