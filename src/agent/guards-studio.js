'use strict';
/**
 * Deterministic safety net for the Studio bot's outgoing messages.
 *
 * Same idea as `guards.js` for PartyDekoMiet: the prompt states the rules, this
 * file enforces them, because a prompt can be talked around by a persistent
 * customer and a regex cannot. These rules come directly from what the client
 * agreed to (Fiverr chat, 17-18 Oct): the bot is a receptionist, never the
 * professional herself, and it never offers or negotiates anything beyond the
 * official service list.
 *
 *   - never speak in the first person as if it were the professional
 *   - never offer, negotiate or confirm anything sexual beyond the price list
 *   - never quote a price that isn't an active service's own price
 *   - never present an appointment as confirmed before the owner has it
 *
 * Design notes
 * ------------
 * Checks run per sentence, same as guards.js, with the same escape for
 * negation/conditions ("wir bieten das nicht an" must not be flagged). This
 * file deliberately does not try to enumerate explicit sexual-service slang in
 * detail; a short set of plain, common words is enough to catch the bot
 * breaking character, and the first-person-as-her and price-list checks catch
 * the rest structurally rather than by vocabulary.
 */

const { sentences, normalise, fold } = require('./guards');

const CONDITIONAL = /\b(sobald|wenn|erst|nachdem|falls|sofern|bevor|once|as soon as|after|if|until)\b/i;
const NEGATION = /\b(kein|keine|keinen|keinem|keiner|nicht|nein|ohne das|leider|no|not|don't|do not|doesn't|cannot|can't)\b/i;

const RULES = [
  {
    code: 'SPEAKS_AS_PROFESSIONAL',
    hint: 'The bot is the studio receptionist, never the professional herself. Write "sie ist / she is", never "ich bin / I am", about a named professional.',
    patterns: [
      /\bich bin\b[^.!?]{0,25}\b(jahre alt|aus|jahre)\b/i,
      /\bi am\b[^.!?]{0,25}\b(years old|from)\b/i,
      /\bi'm\b[^.!?]{0,25}\b(years old|from)\b/i,
      // "I don't speak German, I use a translator" said as the professional herself.
      /\bich spreche\b[^.!?]{0,20}\bkein deutsch\b/i,
      /\bi don't speak\b[^.!?]{0,20}\bgerman\b/i,
    ],
  },
  {
    code: 'SEXUAL_EXTRA_OFFERED',
    hint: 'Only the official service list may be named. Anything beyond it - intimate extras, special wishes - is discussed by the professional in person, never by the bot.',
    escape: NEGATION,
    patterns: [
      /\b(intime? optionen|intimere optionen|sonderwuensche|extras?)\b[^.!?]{0,30}\b(bieten wir|anbieten|moeglich|verfuegbar|kannst du|koennen wir)\b/i,
      /\b(bieten wir|anbieten|moeglich)\b[^.!?]{0,30}\b(intime? optionen|intimere optionen|sonderwuensche|extras?)\b/i,
      /\b(intimate options|special requests?|extras?)\b[^.!?]{0,30}\b(we offer|available|possible|we can)\b/i,
      /\b(we offer|available|we can)\b[^.!?]{0,30}\b(intimate options|special requests?|extras?)\b/i,
      /\b(ohne gummi|without a condom|bareback)\b/i,
      /\b(happy ending)\b/i,
    ],
  },
  {
    code: 'CONFIRMED_APPOINTMENT',
    hint: 'An appointment may never be presented as confirmed before the owner has it. Say the time looks free and the request was passed on.',
    escape: CONDITIONAL,
    patterns: [
      /\b(termin|appointment)\b[^.!?]{0,30}\b(ist|is|wurde|was)\b[^.!?]{0,20}\b(best(?:ae|a)tigt|confirmed|fix|sicher)\b/i,
      /\b(ich habe|wir haben)\b[^.!?]{0,30}\b(dir|fuer dich)\b[^.!?]{0,20}\b(gebucht|reserviert|fix eingetragen)\b/i,
      /\b(i have|we have|i've|we've)\b[^.!?]{0,20}\bbooked\b[^.!?]{0,15}\bfor you\b/i,
    ],
  },
];

/**
 * A price mentioned in the reply must belong to an active service for the
 * business (or the named professional, if known). Anything else is an
 * invented price - exactly the risk the PartyDekoMiet guard already covers
 * for damage costs, generalised here to every service price.
 */
function invalidPriceRule(sentence, ctx) {
  const re = /(?:chf|fr\.?|franken)\s*([0-9]+(?:[.,][0-9]{1,2})?)|([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:chf|fr\.?|franken)/gi;
  const amounts = [];
  let m;
  while ((m = re.exec(sentence))) amounts.push(Number(String(m[1] ?? m[2]).replace(',', '.')));
  if (!amounts.length) return false;
  const allowed = new Set((ctx.allowedPrices || []).map(Number));
  return amounts.some((a) => !allowed.has(a));
}

/**
 * @param {object} opts
 * @param {string[]} [opts.faqAnswers]     verbatim client answers - always allowed
 * @param {number[]} [opts.allowedPrices]  every active service's priceChf, across all professionals
 */
function createStudioGuards({ faqAnswers = [], allowedPrices = [] } = {}) {
  const allowed = new Set();
  for (const answer of faqAnswers) {
    for (const s of sentences(answer)) allowed.add(normalise(s));
  }
  // Read at check time, not at construction. The whole point of the dashboard
  // is that the owner edits services while the bot is running; a list captured
  // at boot makes every service added since then an "invented price", and the
  // bot's own correct answer - read straight out of the directory by
  // list_services - gets blocked. That happened live: the agent quoted CHF 100
  // from the directory and the guard, still holding boot's empty list, killed it.
  const readPrices = typeof allowedPrices === 'function' ? allowedPrices : () => allowedPrices;

  function autofix(text) {
    let out = String(text).replace(/ß/g, 'ss');
    out = out.replace(/\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/g, '$1: $2');
    out = out.replace(/\*\*([^*\n]{1,120})\*\*/g, '*$1*');
    return out;
  }

  function check(text) {
    const found = [];
    let prices;
    try {
      prices = readPrices() || [];
    } catch (err) {
      // A directory that cannot be read must not open the gate: with no known
      // prices, every price is unknown, which is what an empty list means.
      prices = [];
    }
    const ctx = { allowedPrices: prices };
    for (const sentence of sentences(autofix(text))) {
      if (allowed.has(normalise(sentence))) continue;
      const probe = fold(sentence);

      if (invalidPriceRule(probe, ctx)) {
        found.push({ code: 'INVENTED_PRICE', hint: 'Only an active service\'s own price may be quoted.', sentence });
      }
      for (const rule of RULES) {
        const hit = rule.patterns.some((p) => p.test(probe));
        if (!hit) continue;
        if (rule.escape && rule.escape.test(sentence)) continue;
        found.push({ code: rule.code, hint: rule.hint, sentence });
      }
    }
    return found;
  }

  const FALLBACK = {
    de: 'Das frage ich lieber direkt im Team nach - ich gebe deine Frage weiter.',
    en: 'Let me check that with the team - I am forwarding your question.',
  };

  function enforce(text, { lang = 'de' } = {}) {
    const original = String(text ?? '');
    const fixed = autofix(original);
    const violations = check(fixed);
    if (violations.length) {
      return { text: FALLBACK[lang] || FALLBACK.de, violations, blocked: true, sharpSFixed: fixed !== original };
    }
    return { text: fixed, violations: [], blocked: false, sharpSFixed: fixed !== original };
  }

  return { check, enforce, autofix };
}

module.exports = { createStudioGuards };
