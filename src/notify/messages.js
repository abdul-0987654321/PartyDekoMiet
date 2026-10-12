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

const short = (jid) => String(jid || '').split('@')[0];
const cut = (s, n = 300) => String(s || '').slice(0, n);

const T = {
  de: {
    bookingTitle: 'NEUE BUCHUNGSANFRAGE',
    bookingFields: {
      customer: 'Kunde', whatsapp: 'WhatsApp', set: 'Set', pickup: 'Abholung',
      ret: 'Rueckgabe', price: 'Preis', occasion: 'Anlass', age: 'Alter',
      theme: 'Motto', photo: 'Referenzbild', shop: 'Shop', calendar: 'Kalender',
    },
    photoYes: 'ja',
    bookingFooter: 'Status [PENDING]. Nach Zahlungseingang im Kalender auf [CONFIRMED] aendern.',

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
  },

  en: {
    bookingTitle: 'NEW BOOKING REQUEST',
    bookingFields: {
      customer: 'Customer', whatsapp: 'WhatsApp', set: 'Set', pickup: 'Pickup',
      ret: 'Return', price: 'Price', occasion: 'Occasion', age: 'Age',
      theme: 'Theme', photo: 'Reference photo', shop: 'Shop', calendar: 'Calendar',
    },
    photoYes: 'yes',
    bookingFooter: 'Status [PENDING]. Once the payment arrives, change it to [CONFIRMED] in the calendar.',

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
  },
};

/** @returns the message pack in the owner's language */
const m = () => T[ownerLang()];

module.exports = { m, ownerLang, T };
