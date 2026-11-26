'use strict';
/**
 * Every message the owner receives, in both languages.
 *
 * They were written in German inline across four files, so an owner working in
 * English got a German alert. The language follows the dashboard setting, which
 * is the one the owner actually picks.
 */

const settings = require('../settings');

/** The language the owner reads, not the one the customer writes. */
function ownerLang() {
  try {
    const l = settings.get('dashboardLanguage');
    return l === 'en' ? 'en' : 'de';
  } catch {
    return 'de';
  }
}

/** A chat's number as the owner can use it: the real phone, not WhatsApp's hidden id. */
const short = (jid) => {
  if (!jid) return '';
  try {
    return require('../contacts').phoneOf(null, jid);
  } catch {
    return String(jid).split('@')[0];
  }
};
const cut = (s, n = 300) => String(s || '').slice(0, n);

const T = {
  de: {
    bookingTitle: 'NEUE BUCHUNGSANFRAGE',
    bookingFields: {
      customer: 'Kunde', whatsapp: 'WhatsApp', set: 'Set', pickup: 'Abholung',
      ret: 'Rueckgabe', price: 'Preis', occasion: 'Anlass', age: 'Alter',
      theme: 'Motto', photo: 'Referenzbild', shop: 'Shop', calendar: 'Kalender', open: 'Dashboard',
    },
    photoYes: 'ja',
    bookingFooter: 'Noch nicht bestaetigt. Wenn die Zahlung da ist: im Dashboard unter Buchungen auf "Bestaetigen" tippen - der Kalender wird automatisch nachgefuehrt.',

    appointmentTitle: 'NEUE TERMINANFRAGE',
    appointmentFields: {
      customer: 'Kunde', whatsapp: 'WhatsApp', professional: 'Professional', service: 'Leistung',
      price: 'Preis', date: 'Datum', time: 'Zeit', source: 'Quelle', calendar: 'Kalender', open: 'Dashboard',
    },
    appointmentFooter: 'Noch nicht bestaetigt. Im Dashboard unter Termine auf "Bestaetigen" tippen - der Kalender wird automatisch nachgefuehrt.',

    // What the professional herself gets, on her own number. Deliberately
    // short: she is reading it between clients, and the only thing she has to
    // do is answer J or N.
    proRequest: (a, forName) =>
      `NEUE ANFRAGE FUER ${String(forName || a.professionalName || '').toUpperCase() || 'DICH'}\n\n` +
      `${a.serviceName}\nKunde: ${a.customerName}\n` +
      `${a.date} um ${a.startTime}${a.endTime ? `-${a.endTime}` : ''}\n\n` +
      'Antworte J zum Bestaetigen oder N zum Absagen.\n' +
      `(Diese Nachricht geht an die WhatsApp-Nummer, die im Dashboard unter Professionals bei ${forName || a.professionalName} eingetragen ist. ` +
      'Nummer dort leeren = keine solchen Nachrichten mehr.)\n' +
      `Code: ${a.id}`,
    proConfirmed: (a) => `Bestaetigt: ${a.serviceName}, ${a.date} um ${a.startTime}. Danke!`,
    proCancelled: (a) => `Abgesagt: ${a.serviceName}, ${a.date} um ${a.startTime}. Das Team wird informiert.`,
    proNothingOpen: 'Du hast gerade keine offene Anfrage.',
    proConfirmedWord: 'bestaetigt', proCancelledWord: 'abgesagt',

    // Busy / free, said by voice between clients. Short on purpose: she is
    // holding the phone with one hand.
    proNowBusy: (min) =>
      min ? `Alles klar - du bist als besetzt eingetragen (ca. ${min} Min.). Sag Bescheid, wenn du frei bist.`
          : 'Alles klar - du bist als besetzt eingetragen. Sag "frei", wenn du wieder kannst.',
    proNowFree: 'Alles klar - du bist wieder als frei eingetragen.',

    // Sent to the CUSTOMER when the owner presses Bestaetigen. Written as a
    // person would write it - no bell, no status codes, no internal wording.
    // To the team, after somebody pressed Confirm or Cancel in the dashboard.
    // Says whether the customer was told, because that is the next question.
    bookingStatusChanged: (b, status, customerTold) =>
      `${status === 'CONFIRMED' ? 'BESTAETIGT' : 'ABGESAGT'}: ${b.productTitle}\n\n` +
      `Kunde:     ${b.customerName || '-'}\nWhatsApp:  ${b.phone || '-'}\n` +
      `Abholung:  ${b.pickupDate}\nRueckgabe: ${b.returnDate}\n\n` +
      (customerTold ? 'Der Kunde wurde automatisch informiert.' : 'Der Kunde konnte NICHT informiert werden - bitte selbst melden.'),
    appointmentStatusChanged: (a, status, customerTold) =>
      `${status === 'CONFIRMED' ? 'BESTAETIGT' : 'ABGESAGT'}: ${a.serviceName}\n\n` +
      `Kunde:  ${a.customerName || '-'}\nWhatsApp: ${a.phone || '-'}\n` +
      `${a.date} um ${a.startTime}${a.professionalName ? `\nBei: ${a.professionalName}` : ''}\n\n` +
      (customerTold ? 'Der Kunde wurde automatisch informiert.' : 'Der Kunde konnte NICHT informiert werden - bitte selbst melden.'),
    bookingConfirmedCustomer: (b) =>
      `Deine Buchung ist bestaetigt. \n\n${b.productTitle}\n` +
      `Abholung: ${b.pickupDate}\nRueckgabe: ${b.returnDate}\n\n` +
      'Wir melden uns mit allen Details zur Abholung. Bis bald!',
    bookingCancelledCustomer: (b) =>
      `Deine Anfrage fuer ${b.productTitle} konnten wir leider nicht bestaetigen. ` +
      'Melde dich gerne, wenn du etwas anderes suchst - wir finden sicher etwas.',
    appointmentConfirmedCustomer: (a) =>
      `Dein Termin ist bestaetigt.\n\n${a.serviceName}\n` +
      `${a.date} um ${a.startTime}${a.endTime ? `-${a.endTime}` : ''}\n` +
      `${a.professionalName ? `Bei: ${a.professionalName}\n` : ''}\nBis bald!`,
    appointmentCancelledCustomer: (a) =>
      `Dein Terminwunsch am ${a.date} um ${a.startTime} hat leider nicht geklappt. ` +
      'Melde dich gerne fuer einen anderen Termin.',
    proExtended: (a, min) =>
      `Verlaengert um ${min} Min. - der Termin geht jetzt bis ${a.endTime}. Das Team ist informiert.`,
    proNoRunningAppointment: 'Ich finde gerade keinen laufenden Termin von dir. Sag "besetzt", dann weiss das Team Bescheid.',
    proStatusUnclear: 'Das habe ich nicht sicher verstanden. Sag einfach "besetzt" oder "frei".',
    proStatusHelp: 'Sag "besetzt", "frei", oder z.B. "der Kunde bleibt noch eine halbe Stunde".',
    proToldTeamBusy: (p) => `${p.name} ist jetzt besetzt.`,
    proToldTeamFree: (p) => `${p.name} ist wieder frei.`,
    proToldTeamExtended: (p, a, min) =>
      `${p.name}: der Kunde bleibt ${min} Min. laenger.\n\n${a.serviceName}\nKunde: ${a.customerName}\nNeu bis ${a.endTime}`,
    proWhich: (list) =>
      'Du hast mehrere offene Anfragen. Antworte mit J oder N und dem Code:\n\n' +
      list.map((a) => `${a.id} - ${a.serviceName}, ${a.date} ${a.startTime}`).join('\n'),
    proUnknownCode: (code) => `Code ${code} gehoert zu keiner offenen Anfrage von dir.`,
    proHelp: 'Antworte J zum Bestaetigen oder N zum Absagen. Bei mehreren Anfragen: J und den Code, z.B. "J A20261121-AB12C".',
    proToldTeam: (a, what) =>
      `${a.professionalName} hat den Termin ${what}.\n\n${a.serviceName}\nKunde: ${a.customerName}\n${a.date} um ${a.startTime}\nCode: ${a.id}`,

    customerWaiting: (reason, jid, text) =>
      `KUNDE WARTET\n\n${reason}\n\nChat: ${short(jid)}\nNachricht: ${cut(text) || '[Bild]'}`,
    skipReasons: {
      bot_off: 'Der Bot ist ausgeschaltet.',
      paused: 'Der Chat ist pausiert - jemand hat ihn uebernommen.',
      rate_limit: 'Stundenlimit fuer diesen Chat erreicht.',
      no_agent: 'Kein OPENAI_API_KEY gesetzt - der Bot kann nicht antworten.',
    },

    aiDown: (hint, error, count, jid) =>
      `BOT ANTWORTET NICHT\n\n${hint}\n\nFehler: ${error}\n` +
      `Betroffene Nachrichten seit dem ersten Fehler: ${count}\nChat: ${short(jid)}`,
    aiHints: {
      401: 'Der OpenAI-Schluessel wird abgelehnt (401). Bitte in Render einen neuen OPENAI_API_KEY setzen.',
      429: 'OpenAI-Limit erreicht (429). Guthaben oder Rate Limit pruefen.',
      other: 'Die KI ist gerade nicht erreichbar.',
    },

    stepLimit: (jid, text, failed) =>
      `BOT KAM NICHT WEITER\n\nEr hat die Unterhaltung abgebrochen und an einen Menschen uebergeben.\n` +
      `Chat: ${short(jid)}\nLetzte Nachricht: ${cut(text)}\n` +
      (failed ? `\nFehlgeschlagene Werkzeuge:\n${failed}` : ''),

    handoff: (jid, text) => `Uebergabe noetig im Chat mit ${short(jid)}\nLetzte Nachricht: ${cut(text)}`,
    handoffTool: (reason, jid, summary) =>
      `Uebergabe an Mensch (${reason})\nChat: ${short(jid) || 'n/a'}\n${summary || ''}`,
    guardBlocked: (codes, jid) =>
      `Eine Antwort wurde von den Regeln blockiert (${codes}).\nChat: ${short(jid)}`,
    otherBusiness: (jid, text) => `Anfrage zum anderen Betrieb von ${short(jid)}\nNachricht: ${cut(text)}`,
    referencePhoto: (jid, text) => `Referenzbild von ${short(jid)}${text ? `\nText: ${cut(text)}` : ''}`,
    calendarFailed: (id) =>
      `ACHTUNG: Buchung ${id} konnte nicht in den Kalender geschrieben werden. Bitte von Hand eintragen.`,

    // Voice replies dictated by the owner
    voicePreview: (jid, langName, heard, message) =>
      `VORSCHAU an ${short(jid)} (${langName})\n\n${message}\n\n` +
      `Verstanden: "${cut(heard, 200)}"\n\nAntworte *ok* zum Senden oder *nein* zum Verwerfen.`,
    voiceSent: (jid) => `Gesendet an ${short(jid)}. Der Bot pausiert in diesem Chat, damit er dir nicht dazwischenredet.`,
    voiceCancelled: 'Verworfen, nichts gesendet.',
    voiceNoTarget:
      'An wen soll das gehen? Antworte auf (zitiere) eine Benachrichtigung des Bots zu dem Kunden, ' +
      'oder nenne die Nummer, z.B. "41791234567 Das Set ist frei, auf Italienisch".',
    voiceFailed: (err) => `Die Sprachnachricht konnte nicht verarbeitet werden (${cut(err, 120)}). Bitte nochmals oder als Text.`,
    voiceNoAi: 'Sprachbefehle brauchen einen gueltigen OpenAI-Schluessel. Er fehlt gerade.',
    customerVoiceFailed: (jid) =>
      `Sprachnachricht von ${short(jid)} konnte nicht abgehoert werden. Der Kunde wurde gebeten, kurz zu schreiben.`,
  },

  en: {
    bookingTitle: 'NEW BOOKING REQUEST',
    bookingFields: {
      customer: 'Customer', whatsapp: 'WhatsApp', set: 'Set', pickup: 'Pickup',
      ret: 'Return', price: 'Price', occasion: 'Occasion', age: 'Age',
      theme: 'Theme', photo: 'Reference photo', shop: 'Shop', calendar: 'Calendar', open: 'Dashboard',
    },
    photoYes: 'yes',
    bookingFooter: 'Not confirmed yet. Once the payment arrives, tap "Confirm" under Bookings in the dashboard - the calendar follows automatically.',

    appointmentTitle: 'NEW APPOINTMENT REQUEST',
    appointmentFields: {
      customer: 'Customer', whatsapp: 'WhatsApp', professional: 'Professional', service: 'Service',
      price: 'Price', date: 'Date', time: 'Time', source: 'Source', calendar: 'Calendar', open: 'Dashboard',
    },
    appointmentFooter: 'Not confirmed yet. Tap "Confirm" under Appointments in the dashboard - the calendar follows automatically.',

    proRequest: (a, forName) =>
      `NEW REQUEST FOR ${String(forName || a.professionalName || '').toUpperCase() || 'YOU'}\n\n` +
      `${a.serviceName}\nCustomer: ${a.customerName}\n` +
      `${a.date} at ${a.startTime}${a.endTime ? `-${a.endTime}` : ''}\n\n` +
      'Reply Y to confirm or N to decline.\n' +
      `(This goes to the WhatsApp number saved for ${forName || a.professionalName} on the Professionals page. ` +
      'Clear that number and these messages stop.)\n' +
      `Code: ${a.id}`,
    proConfirmed: (a) => `Confirmed: ${a.serviceName}, ${a.date} at ${a.startTime}. Thank you!`,
    proCancelled: (a) => `Declined: ${a.serviceName}, ${a.date} at ${a.startTime}. The team has been told.`,
    proNothingOpen: 'You have no open request right now.',
    proConfirmedWord: 'confirmed', proCancelledWord: 'declined',

    proNowBusy: (min) =>
      min ? `Got it - you are marked busy (about ${min} min). Tell me when you are free.`
          : 'Got it - you are marked busy. Say "free" when you can take someone again.',
    proNowFree: 'Got it - you are marked free again.',

    bookingStatusChanged: (b, status, customerTold) =>
      `${status === 'CONFIRMED' ? 'CONFIRMED' : 'CANCELLED'}: ${b.productTitle}\n\n` +
      `Customer: ${b.customerName || '-'}\nWhatsApp: ${b.phone || '-'}\n` +
      `Pickup:   ${b.pickupDate}\nReturn:   ${b.returnDate}\n\n` +
      (customerTold ? 'The customer has been told automatically.' : 'The customer could NOT be told - please get in touch yourself.'),
    appointmentStatusChanged: (a, status, customerTold) =>
      `${status === 'CONFIRMED' ? 'CONFIRMED' : 'CANCELLED'}: ${a.serviceName}\n\n` +
      `Customer: ${a.customerName || '-'}\nWhatsApp: ${a.phone || '-'}\n` +
      `${a.date} at ${a.startTime}${a.professionalName ? `\nWith: ${a.professionalName}` : ''}\n\n` +
      (customerTold ? 'The customer has been told automatically.' : 'The customer could NOT be told - please get in touch yourself.'),
    bookingConfirmedCustomer: (b) =>
      `Your booking is confirmed.\n\n${b.productTitle}\n` +
      `Pickup: ${b.pickupDate}\nReturn: ${b.returnDate}\n\n` +
      'We will be in touch with the pickup details. See you soon!',
    bookingCancelledCustomer: (b) =>
      `Unfortunately we could not confirm your request for ${b.productTitle}. ` +
      'Do get in touch if you are looking for something else - we will find something.',
    appointmentConfirmedCustomer: (a) =>
      `Your appointment is confirmed.\n\n${a.serviceName}\n` +
      `${a.date} at ${a.startTime}${a.endTime ? `-${a.endTime}` : ''}\n` +
      `${a.professionalName ? `With: ${a.professionalName}\n` : ''}\nSee you soon!`,
    appointmentCancelledCustomer: (a) =>
      `Unfortunately your appointment request for ${a.date} at ${a.startTime} did not work out. ` +
      'Do get in touch for another time.',
    proExtended: (a, min) =>
      `Extended by ${min} min - the appointment now runs until ${a.endTime}. The team has been told.`,
    proNoRunningAppointment: 'I cannot find a running appointment for you. Say "busy" and the team will know.',
    proStatusUnclear: 'I did not catch that for certain. Just say "busy" or "free".',
    proStatusHelp: 'Say "busy", "free", or for example "the client stays another half hour".',
    proToldTeamBusy: (p) => `${p.name} is now busy.`,
    proToldTeamFree: (p) => `${p.name} is free again.`,
    proToldTeamExtended: (p, a, min) =>
      `${p.name}: the client stays ${min} min longer.\n\n${a.serviceName}\nCustomer: ${a.customerName}\nNow until ${a.endTime}`,
    proWhich: (list) =>
      'You have several open requests. Reply with Y or N and the code:\n\n' +
      list.map((a) => `${a.id} - ${a.serviceName}, ${a.date} ${a.startTime}`).join('\n'),
    proUnknownCode: (code) => `Code ${code} does not belong to an open request of yours.`,
    proHelp: 'Reply Y to confirm or N to decline. With several requests: Y and the code, e.g. "Y A20261121-AB12C".',
    proToldTeam: (a, what) =>
      `${a.professionalName} ${what} the appointment.\n\n${a.serviceName}\nCustomer: ${a.customerName}\n${a.date} at ${a.startTime}\nCode: ${a.id}`,

    customerWaiting: (reason, jid, text) =>
      `CUSTOMER IS WAITING\n\n${reason}\n\nChat: ${short(jid)}\nMessage: ${cut(text) || '[image]'}`,
    skipReasons: {
      bot_off: 'The bot is switched off.',
      paused: 'The chat is paused - somebody took it over.',
      rate_limit: 'Hourly limit for this chat reached.',
      no_agent: 'No OPENAI_API_KEY is set - the bot cannot answer.',
    },

    aiDown: (hint, error, count, jid) =>
      `BOT IS NOT ANSWERING\n\n${hint}\n\nError: ${error}\n` +
      `Messages affected since the first failure: ${count}\nChat: ${short(jid)}`,
    aiHints: {
      401: 'The OpenAI key is being rejected (401). Set a new OPENAI_API_KEY in Render.',
      429: 'OpenAI limit reached (429). Check the balance or the rate limit.',
      other: 'The AI cannot be reached right now.',
    },

    stepLimit: (jid, text, failed) =>
      `BOT GOT STUCK\n\nIt ended the conversation and handed it to a human.\n` +
      `Chat: ${short(jid)}\nLast message: ${cut(text)}\n` +
      (failed ? `\nTools that failed:\n${failed}` : ''),

    handoff: (jid, text) => `A human is needed in the chat with ${short(jid)}\nLast message: ${cut(text)}`,
    handoffTool: (reason, jid, summary) =>
      `Handed to a human (${reason})\nChat: ${short(jid) || 'n/a'}\n${summary || ''}`,
    guardBlocked: (codes, jid) =>
      `A reply was blocked by the rules (${codes}).\nChat: ${short(jid)}`,
    otherBusiness: (jid, text) => `Question about the other business from ${short(jid)}\nMessage: ${cut(text)}`,
    referencePhoto: (jid, text) => `Reference photo from ${short(jid)}${text ? `\nText: ${cut(text)}` : ''}`,
    calendarFailed: (id) =>
      `WARNING: booking ${id} could not be written to the calendar. Please add it by hand.`,

    voicePreview: (jid, langName, heard, message) =>
      `PREVIEW to ${short(jid)} (${langName})\n\n${message}\n\n` +
      `I heard: "${cut(heard, 200)}"\n\nReply *ok* to send or *no* to discard.`,
    voiceSent: (jid) => `Sent to ${short(jid)}. The bot is paused in that chat so it does not talk over you.`,
    voiceCancelled: 'Discarded, nothing was sent.',
    voiceNoTarget:
      'Who should this go to? Reply to (quote) one of the bot\'s notifications about that customer, ' +
      'or say the number, e.g. "41791234567 the set is free, in Italian".',
    voiceFailed: (err) => `The voice message could not be processed (${cut(err, 120)}). Please try again or type it.`,
    voiceNoAi: 'Voice commands need a valid OpenAI key. It is missing right now.',
    customerVoiceFailed: (jid) =>
      `Voice message from ${short(jid)} could not be transcribed. The customer was asked to type instead.`,
  },
};

/** @returns the message pack in the owner's language */
const m = () => T[ownerLang()];

module.exports = { m, ownerLang, T };
