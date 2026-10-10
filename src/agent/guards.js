'use strict';
/**
 * Deterministic safety net for every outgoing message.
 *
 * The system prompt tells the model the rules; this file enforces them. A prompt
 * can be talked around by a persistent customer, a regex cannot. The rules come
 * from the AGB and "Teil 3 - Interne Hinweise fuer den Chatbot":
 *
 *   - never present a booking as confirmed (only availability checked + payment received)
 *   - never offer delivery, setup or teardown
 *   - never invent repair / cleaning / replacement prices
 *   - never ask for payment details or a delivery address
 *   - Swiss orthography (no sharp s)
 *
 * Design notes
 * ------------
 * Checks run per sentence, not per message, so a sentence that *denies* something
 * ("wir bieten keinen Lieferservice an") is not confused with one that offers it.
 * The client's own FAQ answers are whitelisted verbatim: if the model quotes the
 * AGB wording exactly, that can never be a violation. This matters because some
 * FAQ answers legitimately contain the words that the patterns look for.
 */

const SHARP_S = 'ß';

/** Splits into sentences, keeping it simple: terminators and line breaks. */
function sentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Folds German umlauts to their two-letter form, so one pattern matches both
 * "bestaetigt" and "bestätigt". Models produce either, depending on the keyboard
 * they imagine they have. Every pattern below is written in the folded form
 * (ae / oe / ue / ss).
 */
const fold = (s) =>
  String(s)
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    .replace(new RegExp(SHARP_S, 'g'), 'ss');

const normalise = (s) =>
  fold(String(s))
    .toLowerCase()
    .replace(/[\s–—.,;:!?()"'-]+/g, ' ')
    .trim();

/** A sentence that states a condition is describing the rule, not claiming a fact. */
const CONDITIONAL = /\b(sobald|wenn|erst|nachdem|falls|sofern|bevor|once|as soon as|after|if|until)\b/i;
/** A sentence that negates is denying the thing, not offering it. */
const NEGATION = /\b(kein|keine|keinen|keinem|keiner|nicht|nein|ohne|leider|no|not|don't|do not|doesn't|cannot|can't)\b/i;

const RULES = [
  {
    code: 'CONFIRMED_BOOKING',
    hint: 'A booking may never be presented as confirmed. Say the item looks available and the request was passed on.',
    escape: CONDITIONAL,
    patterns: [
      /\b(buchung|reservierung|reservation|termin)\b[^.!?]{0,40}\b(ist|sind|wurde|wurden|haben wir)\b[^.!?]{0,25}\b(best(?:ae|a)tigt|verbindlich|fix|sicher|reserviert|gebucht|geblockt)\b/i,
      /\b(ich habe|wir haben|hab ich|haben wir dir)\b[^.!?]{0,35}\b(reserviert|geblockt|fix eingetragen|definitiv gebucht)\b/i,
      /\b(fuer dich)\b[^.!?]{0,20}\b(reserviert|geblockt|freigehalten)\b/i,
      /\b(booking|reservation|slot)\b[^.!?]{0,30}\b(is|has been|was)\b[^.!?]{0,20}\b(confirmed|secured|guaranteed|booked|reserved)\b/i,
      /\b(i have|we have|i've|we've)\b[^.!?]{0,30}\b(reserved|blocked|booked)\b[^.!?]{0,20}\bfor you\b/i,
    ],
  },
  {
    code: 'DELIVERY_OFFERED',
    hint: 'Self-pickup only. Never offer delivery, setup or teardown.',
    escape: NEGATION,
    patterns: [
      /\b(wir|ich)\b[^.!?]{0,25}\b(liefern|liefere|bringen|bringe|vorbeibringen)\b/i,
      /\b(lieferung|lieferservice|anlieferung|zustellung|aufbauservice)\b[^.!?]{0,35}\b(moeglich|an|anbieten|inklusive|kostet|machen wir)\b/i,
      /\b(aufbau|abbau|montage)\b[^.!?]{0,30}\b(inklusive|moeglich|dabei|uebernehmen wir|machen wir)\b/i,
      /\bwir (bauen|stellen)\b[^.!?]{0,25}\b(auf|hin)\b/i,
      /\bwe (can |could |will |would )?(deliver|bring it|set it up|come to)\b/i,
      /\b(delivery|setup|set-up|teardown)\b[^.!?]{0,25}\b(is|are)\b[^.!?]{0,15}\b(possible|available|included|an option)\b/i,
    ],
  },
  {
    code: 'INVENTED_PRICE',
    hint: 'Never state a repair, cleaning or replacement price. Only CHF 50 deposit and CHF 50 per started late day are allowed. Hand damage cases to a human.',
    // Handled by a custom test below, because it needs the amount, not just a match.
    patterns: [],
    custom: (sentence, ctx) => {
      const damage =
        /\b(reparatur|ersatz|ersatzkosten|schaden|schaeden|beschaedig|verschmutz|fleck|verlust|fehlend|repair|replacement|damage|cleaning|reinigung|stain|lost|missing)\b/i;
      if (!damage.test(sentence)) return false;
      const allowed = new Set([ctx.depositChf, ctx.lateFeeChf].map(Number));
      const amounts = [];
      const re = /(?:chf|fr\.?|franken)\s*([0-9]+(?:[.,][0-9]{1,2})?)|([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:chf|fr\.?|franken)/gi;
      let m;
      while ((m = re.exec(sentence))) {
        amounts.push(Number(String(m[1] ?? m[2]).replace(',', '.')));
      }
      return amounts.some((a) => !allowed.has(a));
    },
  },
  {
    code: 'PAYMENT_DETAILS',
    hint: 'Payment happens only in the Shopify shop. Never request or hand out payment credentials.',
    patterns: [
      /\b(iban|kontonummer|kartennummer|kreditkarte|cvv|cvc|card number|account number|sort code)\b/i,
      /\b(schick|senden? sie|send)\b[^.!?]{0,25}\b(geld|zahlung|betrag|money|payment)\b[^.!?]{0,20}\b(an mich|an uns|to me|to us)\b/i,
    ],
  },
  {
    code: 'ADDRESS_REQUESTED',
    hint: 'Never ask where the customer lives or where to deliver. Pickup is at our address.',
    patterns: [
      /\b(lieferadresse|delivery address)\b/i,
      /\b(deine|ihre|eure) adresse\b/i,
      /\bwohin (soll|sollen|d(u|ü)rfen wir)\b/i,
      /\bwo (wohnst du|wohnen sie)\b[^.!?]{0,30}\b(liefern|bringen)\b/i,
      /\bwhat(?:'s| is) your address\b/i,
    ],
  },
];

/**
 * @param {object} opts
 * @param {string[]} opts.faqAnswers  verbatim client answers - always allowed
 * @param {number} opts.depositChf
 * @param {number} opts.lateFeeChf
 */
function createGuards({ faqAnswers = [], depositChf = 50, lateFeeChf = 50 } = {}) {
  // Whitelist every sentence of every official answer.
  const allowed = new Set();
  for (const answer of faqAnswers) {
    for (const s of sentences(answer)) allowed.add(normalise(s));
  }
  const ctx = { depositChf, lateFeeChf };

  /** Fixes what can be fixed safely, without changing meaning. */
  function autofix(text) {
    return String(text).replace(new RegExp(SHARP_S, 'g'), 'ss');
  }

  /** @returns {{code:string,hint:string,sentence:string}[]} */
  function check(text) {
    const found = [];
    for (const sentence of sentences(autofix(text))) {
      if (allowed.has(normalise(sentence))) continue; // client's own wording
      const probe = fold(sentence); // patterns are written in the folded form
      for (const rule of RULES) {
        const hit = rule.custom
          ? rule.custom(probe, ctx)
          : rule.patterns.some((p) => p.test(probe));
        if (!hit) continue;
        if (rule.escape && rule.escape.test(sentence)) continue;
        found.push({ code: rule.code, hint: rule.hint, sentence });
      }
    }
    return found;
  }

  const FALLBACK = {
    de: 'Das schaue ich lieber mit jemandem aus dem Team an - ich gebe deine Frage direkt weiter.',
    en: 'Let me pass this to a colleague - I am forwarding your question to the team.',
  };

  /**
   * Runs autofix, then the checks. If a hard rule is still broken the message is
   * replaced with a safe sentence and the caller must hand the chat to a human.
   *
   * @returns {{text:string, violations:object[], blocked:boolean, sharpSFixed:boolean}}
   */
  function enforce(text, { lang = 'de' } = {}) {
    const original = String(text ?? '');
    const fixed = autofix(original);
    const violations = check(fixed);
    if (violations.length) {
      return {
        text: FALLBACK[lang] || FALLBACK.de,
        violations,
        blocked: true,
        sharpSFixed: fixed !== original,
      };
    }
    return { text: fixed, violations: [], blocked: false, sharpSFixed: fixed !== original };
  }

  return { check, enforce, autofix };
}

module.exports = { createGuards, sentences, normalise, fold };
