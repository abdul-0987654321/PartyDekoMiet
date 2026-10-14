'use strict';
const { languageInstruction } = require('./language');

/**
 * Builds the system prompt from the knowledge pack.
 *
 * Nothing about party decoration is hardcoded here - every fact comes from
 * knowledge/, so the massage-studio bot reuses this file untouched.
 */

/** The FAQ goes in verbatim: the client wrote these answers, we do not paraphrase them. */
function renderFaq(faq) {
  return faq
    .map((e) => `Q: ${e.q}\nA (DE, verbatim): ${e.a_de}\nA (EN): ${e.a_en}`)
    .join('\n\n');
}

function renderBusiness(b) {
  const lines = [
    `Name: ${b.name} (${b.website})`,
    `Angebot: ${b.whatWeDo}`,
    `Katalog: ${b.catalogUrl}`,
    '',
    `Abholung: ausschliesslich Selbstabholung, ${b.pickup.address} (${b.pickup.addressDetail}).`,
    `Abholzeitpunkt: ${
      b.pickup.hours
        ? `moegliche Zeiten ${b.pickup.hours}; der genaue Zeitpunkt wird vorab vereinbart.`
        : 'wird immer vorab vereinbart. Nenne keine festen Zeiten, du kennst die Oeffnungszeiten nicht.'
    }`,
    `Fahrzeug: ${b.pickup.vehicleNote}`,
    '',
    `Mietdauer: ${b.rental.daysLabel} (${b.rental.days} Tage).`,
    `Kaution: CHF ${b.money.depositChf}.- , zurueck nach ${b.money.depositRefundCondition}.`,
    `Verspaetung: CHF ${b.money.lateFeeChfPerStartedDay}.- pro angefangenem Tag.`,
    `Zahlung: ${b.money.paymentNote}`,
    '',
    `Nicht im Angebot: ${b.notOffered.join(', ')}.`,
  ];
  return lines.join('\n');
}

/**
 * @param {object} knowledge  from src/knowledge
 * @param {object} [ctx]
 * @param {string} [ctx.today]        ISO date, so the model can resolve "naechsten Samstag"
 * @param {string} [ctx.customerName]
 * @param {string} [ctx.lang]         'de' | 'en' - the language already decided for this turn
 * @param {string} [ctx.langSource]   why, so a fixed setting can be stated as fixed
 * @returns {string}
 */
function buildSystemPrompt(knowledge, ctx = {}) {
  const { business, faq, rules, persona } = knowledge;
  const today = ctx.today || new Date().toISOString().slice(0, 10);
  // The language is decided outside the model and stated here as an instruction.
  // Leaving it to the model meant it re-decided every turn and drifted back to
  // German mid-conversation.
  const langBlock = ctx.lang ? `\n${languageInstruction(ctx.lang, ctx.langSource)}\n` : '';

  return `${persona}
${langBlock}
# Heute
Heutiges Datum: ${today} (Zeitzone Europe/Zurich).
Rechne relative Datumsangaben ("naechsten Samstag", "in zwei Wochen") selbst aus und
bestaetige dem Kunden das konkrete Datum, damit keine Missverstaendnisse entstehen.
${ctx.customerName ? `Der Kunde heisst ${ctx.customerName}.` : ''}

# Betrieb
${renderBusiness(business)}

${rules}

# Offizielle Antworten (Wortlaut des Kunden - bevorzugt genau so verwenden)
${renderFaq(faq)}

# Werkzeuge
Du hast Werkzeuge. Benutze sie, statt zu raten:
- search_products: wenn der Kunde ein Thema, eine Farbe oder ein Set sucht. Nie Produkte
  aus dem Gedaechtnis nennen, nie Preise erfinden.
- send_product: schickt Bild, Name, Preis und Link. Hoechstens 3 Produkte pro Nachricht.
- check_availability: immer bevor du etwas ueber freie Daten sagst. Nie aus dem Bauch.
  Nenne dem Kunden genau das return_date aus dem Ergebnis als Rueckgabetag - es
  beruecksichtigt Ruhetage (z.B. Abholung Freitag, Rueckgabe Montag), rechne es nicht selbst.
- create_booking_request: erst wenn Produkt, Datum und Name des Kunden bekannt sind.
- handoff_to_human: bei Schaden, Storno, Aenderung, Ausnahme, Verlaengerung oder wenn du
  unsicher bist. Lieber einmal zu oft als einmal zu wenig.

Wenn ein Werkzeug fehlschlaegt oder nichts findet, sage das ehrlich und kurz. Erfinde nichts.

Eine Nachricht, die mit 🎤 beginnt, war eine Sprachnachricht und wurde automatisch
abgeschrieben. Beantworte sie normal als Text. Ist sie unklar, frag kurz nach.

# Ablauf einer Anfrage
1. Anlass, Motto/Farben, Alter des Geburtstagskinds und Partydatum erfragen (max. 2 Fragen pro Nachricht).
2. Passende Sets mit search_products suchen und mit send_product zeigen.
3. Mit check_availability den 3-Tage-Zeitraum pruefen.
4. Wenn frei: create_booking_request, dann den Shop-Link schicken und um die Zahlung
   im Shop bitten (Mietpreis + CHF ${business.money.depositChf}.- Kaution).
5. Klar sagen: die Anfrage ist weitergegeben, verbindlich wird sie erst nach Pruefung
   und Zahlungseingang. Nie "bestaetigt" sagen.`;
}

module.exports = { buildSystemPrompt, renderBusiness, renderFaq };
