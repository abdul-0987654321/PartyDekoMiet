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

/**
 * Renders the business facts for the system prompt.
 *
 * Every block is optional, because this file serves BOTH bots: the rental shop
 * has pickup/rental/deposit facts, the Studio has none of them (its services,
 * prices, addresses and hours live in the dashboard tables and reach the model
 * through the agent tools instead). Reading `b.pickup.address` unconditionally
 * threw "Cannot read properties of undefined" on every single Studio message.
 */
function renderBusiness(b) {
  const blocks = [];

  blocks.push([
    `Name: ${b.name}${b.website ? ` (${b.website})` : ''}`,
    `Angebot: ${b.whatWeDo}`,
    b.catalogUrl ? `Katalog: ${b.catalogUrl}` : null,
  ]);

  const place = [];
  if (b.pickup) {
    place.push(
      `Abholung: ausschliesslich Selbstabholung, ${b.pickup.address}` +
        `${b.pickup.addressDetail ? ` (${b.pickup.addressDetail})` : ''}.`,
      `Abholzeitpunkt: ${
        b.pickup.hours
          ? `moegliche Zeiten ${b.pickup.hours}; der genaue Zeitpunkt wird vorab vereinbart.`
          : 'wird immer vorab vereinbart. Nenne keine festen Zeiten, du kennst die Oeffnungszeiten nicht.'
      }`
    );
    if (b.pickup.vehicleNote) place.push(`Fahrzeug: ${b.pickup.vehicleNote}`);
  }
  if (b.showroom) place.push(`Showroom/Atelier: ${b.showroom.address}. ${b.showroom.note}`);
  blocks.push(place);

  const terms = [];
  if (b.rental) terms.push(`Mietdauer: ${b.rental.daysLabel} (${b.rental.days} Tage).`);
  if (b.money) {
    const m = b.money;
    if (m.depositChf !== undefined) {
      terms.push(`Kaution: CHF ${m.depositChf}.- , zurueck nach ${m.depositRefundCondition}.`);
    }
    if (m.lateFeeChfPerStartedDay !== undefined) {
      terms.push(`Verspaetung: CHF ${m.lateFeeChfPerStartedDay}.- pro angefangenem Tag.`);
    }
    if (m.paymentNote) terms.push(`Zahlung: ${m.paymentNote}`);
  }
  blocks.push(terms);

  blocks.push([
    b.notOffered?.length ? `Nicht im Angebot: ${b.notOffered.join(', ')}.` : null,
  ]);

  // Drop empty blocks, then separate the surviving ones with a blank line.
  return blocks
    .map((lines) => lines.filter((l) => l !== null && l !== undefined))
    .filter((lines) => lines.length)
    .map((lines) => lines.join('\n'))
    .join('\n\n');
}

/**
 * The tools and request flow, from the business's own knowledge folder.
 * `{{depositChf}}` is the one value the text needs from business.json.
 */
function renderWorkflow(workflow, business) {
  if (!workflow) return '';
  return workflow.replace(/\{\{depositChf\}\}/g, business?.money?.depositChf ?? '');
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
  const { business, faq, rules, persona, damagePrices, workflow } = knowledge;
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
${damagePrices ? `
# Schadensliste (offiziell, vom Inhaber)
Fragt jemand, was ein Schaden oder Verlust kostet, nenne den Betrag aus dieser Liste
("laut unserer Schadensliste ..."), immer mit dem Hinweis, dass das Team den
endgueltigen Betrag nach der Kontrolle festlegt. Nenne nie einen Betrag, der nicht
in der Liste steht. Ist wirklich etwas kaputt oder fehlt, gib den Fall danach mit
handoff_to_human weiter.

${damagePrices}` : ''}

${renderWorkflow(workflow, business)}`;
}

module.exports = { buildSystemPrompt, renderBusiness, renderFaq, renderWorkflow };
