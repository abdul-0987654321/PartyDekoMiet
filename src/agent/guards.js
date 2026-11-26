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

/**
 * Sentences that are removed rather than blocking the whole message.
 *
 * The difference matters. A hard rule means the reply was dangerous and the
 * chat goes to a human. These are sentences that are simply not ours to say:
 * the rest of the message is correct and useful, and replacing all of it with
 * "I'll pass this to a colleague" would be a worse answer than the one with the
 * sentence taken out.
 *
 * All of them are about money. The bot's job ends at passing the request to the
 * team; the team checks it and sends the invoice. A bot that asks for payment
 * is promising that paying is what secures the set, which is not true and is
 * the one promise that costs real money when it is wrong.
 */
// Gaps here are written `.{0,n}` rather than `[^.!?]{0,n}`: these are matched
// against one sentence at a time, and a price like "CHF 60.-" contains a full
// stop, so a gap that forbids one silently fails to match the exact sentences
// this exists to catch.
const STRIP_RULES = [
  {
    code: 'PAYMENT_REQUESTED',
    hint: 'The bot never asks for payment and never sends a payment link. The team invoices after checking the request.',
    patterns: [
      /\b(complete|make|process|finish)\b.{0,20}\b(the )?payment\b/i,
      /\bpay\b.{0,25}\b(here|through this link|via this link|now|first)\b/i,
      /\bplease (pay|complete|proceed with)\b/i,
      /\b(zahlung|bezahlung)\b.{0,30}\b(ueber|via|hier|abschliessen|vornehmen|taetigen|durchfuehren)\b/i,
      /\b(bezahl|bezahle|bezahlen|zahl|zahle)\b.{0,25}\b(hier|bitte|ueber diesen link|im shop|zuerst|jetzt)\b/i,
      /\b(bitte)\b.{0,20}\b(bezahl\w*|zahlung)\b/i,
    ],
  },
  {
    code: 'CONFIRM_ON_PAYMENT',
    hint: 'Paying does not confirm anything. The team confirms, after checking.',
    // Both orders, and every form of the verb. The first version of this rule
    // wanted "confirmed" after "payment", and the very next reply said
    // "they'll confirm once the payment is processed" - same promise, other
    // word order, straight through. Confirming and paying must simply never
    // appear in one sentence.
    patterns: [
      /\b(confirm|confirms|confirmed|confirmation|secure|secured|guarantee\w*)\b.{0,60}\b(payment|paid|pay\b)/i,
      /\b(payment|paid|pay\b).{0,60}\b(confirm|confirms|confirmed|confirmation|secure|secured|booked)\b/i,
      /\b(best(?:ae|a)tig\w*|verbindlich|fix|gebucht|reserviert)\b.{0,60}\b(zahlung|bezahl\w*)\b/i,
      /\b(zahlung|bezahl\w*)\b.{0,60}\b(best(?:ae|a)tig\w*|verbindlich|fix|gebucht|reserviert)\b/i,
    ],
  },
  {
    code: 'DEPOSIT_INCLUDED',
    hint: 'The deposit is charged on top, never included in the rental price.',
    patterns: [
      /\b(total|gesamt\w*|summe|preis)\b.{0,40}\b(inklusive|inkl\.?|including|includes|enthaelt)\b.{0,25}\b(kaution|deposit)\b/i,
      /\b(kaution|deposit)\b.{0,25}\b(ist|sind|is|are)\b.{0,20}\b(inklusive|inbegriffen|included)\b/i,
    ],
  },
];

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
    hint: 'Never invent a repair, cleaning or replacement price. Only the CHF 50 deposit, CHF 50 per started late day and the amounts of the official damage list are allowed. Hand damage cases to a human.',
    // Handled by a custom test below, because it needs the amount, not just a match.
    patterns: [],
    custom: (sentence, ctx) => {
      const damage =
        /\b(reparatur\w*|ersatz\w*|schaden|schaeden|beschaedig\w*|verschmutz\w*|fleck\w*|verlust\w*|fehlend\w*|kaputt\w*|zerbroch\w*|gerissen\w*|reinigung\w*|repair\w*|replac\w*|damag\w*|broke\w*|torn|clean\w*|stain\w*|lost|missing)\b/i;
      if (!damage.test(sentence)) return false;
      const allowed = new Set([ctx.depositChf, ctx.lateFeeChf, ...(ctx.extraAllowedChf || [])].map(Number));
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
/**
 * Does this reply tell the customer their request has been passed on?
 *
 * Needed because the model can simply say so without having called the tool.
 * That happened: a customer picked a set, was told "your request is with the
 * team", and nothing reached anybody - no alert, no entry in the calendar, no
 * booking. From the customer's side a request was made. From the owner's side
 * it never existed. Of everything a chatbot can get wrong, telling somebody
 * their booking is in hand when it is not is the one that loses the customer
 * and the day.
 */
const CLAIMS_REQUEST_SENT = [
  /\b(anfrage|buchungsanfrage|anliegen)\b.{0,40}\b(weitergegeben|weitergeleitet|uebermittelt|ans team|beim team|erstellt|aufgenommen)\b/i,
  /\b(ich habe|wir haben|hab ich)\b.{0,30}\b(die anfrage|eine anfrage|das weitergegeben)\b/i,
  /\b(request|booking request)\b.{0,45}\b(with the team|passed on|sent to the team|forwarded|created|submitted|placed)\b/i,
  /\b(i(?:'ve| have)|we(?:'ve| have))\b.{0,30}\b(created|sent|passed|forwarded|placed|submitted)\b.{0,30}\b(request|booking)\b/i,
  /\b(das team|the team)\b.{0,30}\b(meldet sich|wird sich melden|will get back|will contact)\b/i,
];

const claimsRequestSent = (text) => {
  const probe = fold(String(text || ''));
  return CLAIMS_REQUEST_SENT.some((p) => p.test(probe));
};

/** Tool calls that actually put a request in front of a human. */
const REQUEST_TOOLS = new Set(['create_booking_request', 'create_appointment', 'handoff_to_human']);
const requestWasMade = (toolCalls = []) =>
  toolCalls.some((c) => REQUEST_TOOLS.has(c.name) && c.result?.ok !== false);

function createGuards({ faqAnswers = [], depositChf = 50, lateFeeChf = 50, damagePrices = '' } = {}) {
  // Whitelist every sentence of every official answer. Read per check, not
  // captured here: FAQ answers are dashboard-editable while the bot runs, and
  // a whitelist frozen at boot blocks an answer the owner has just written.
  const readAnswers = typeof faqAnswers === 'function' ? faqAnswers : () => faqAnswers;
  let whitelistKey = null;
  let whitelist = new Set();
  function allowedSentences() {
    const answers = readAnswers() || [];
    const key = answers.join('\u0000');
    if (key !== whitelistKey) {
      whitelistKey = key;
      whitelist = new Set();
      for (const answer of answers) {
        for (const s of sentences(answer)) whitelist.add(normalise(s));
      }
    }
    return whitelist;
  }
  // Amounts from the owner's official damage list may be quoted; any other
  // amount next to a damage word is still treated as invented.
  const extraAllowedChf = [];
  const amountRe = /(?:chf|fr\.?)\s*([0-9]+(?:[.,][0-9]{1,2})?)/gi;
  let am;
  while ((am = amountRe.exec(String(damagePrices)))) extraAllowedChf.push(Number(am[1].replace(',', '.')));
  const ctx = { depositChf, lateFeeChf, extraAllowedChf };

  /** Fixes what can be fixed safely, without changing meaning. */
  function autofix(text) {
    let out = String(text).replace(new RegExp(SHARP_S, 'g'), 'ss');
    // WhatsApp has no markdown links: [Einhorn Set](https://...) is shown with
    // the brackets and the URL twice. Keep the label, keep the link, drop the
    // syntax.
    out = out.replace(/\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/g, '$1: $2');
    // Markdown bold is **x** on the web but *x* on WhatsApp.
    out = out.replace(/\*\*([^*\n]{1,120})\*\*/g, '*$1*');
    return out;
  }

  /** @returns {{code:string,hint:string,sentence:string}[]} */
  function check(text) {
    const found = [];
    const allowed = allowedSentences();
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
  /**
   * Takes out the sentences that are not ours to say, keeps the rest.
   *
   * @returns {{text: string, stripped: object[]}}
   */
  function strip(text) {
    const allowed = allowedSentences();
    const stripped = [];
    const kept = [];
    for (const sentence of sentences(text)) {
      if (allowed.has(normalise(sentence))) { kept.push(sentence); continue; }
      const probe = fold(sentence);
      const rule = STRIP_RULES.find((r) => r.patterns.some((p) => p.test(probe)));
      if (rule) stripped.push({ code: rule.code, hint: rule.hint, sentence });
      else kept.push(sentence);
    }
    return { text: kept.join(' ').replace(/\s{2,}/g, ' ').trim(), stripped };
  }

  /** Said when stripping leaves nothing worth sending. */
  const AFTER_STRIP = {
    de: 'Ich habe deine Anfrage ans Team weitergegeben - sie melden sich bei dir.',
    en: 'I have passed your request to the team - they will get back to you.',
  };

  function enforce(text, { lang = 'de' } = {}) {
    const original = String(text ?? '');
    let fixed = autofix(original);

    // Strip first, then judge what is left: a message whose only problem was a
    // payment sentence is a good message once that sentence is gone, and
    // handing the whole chat to a human over it would be the wrong trade.
    const { text: withoutPayment, stripped } = strip(fixed);
    if (stripped.length) {
      fixed = withoutPayment.length >= 15 ? withoutPayment : (AFTER_STRIP[lang] || AFTER_STRIP.de);
    }

    const violations = check(fixed);
    if (violations.length) {
      return {
        text: FALLBACK[lang] || FALLBACK.de,
        violations,
        blocked: true,
        stripped,
        sharpSFixed: fixed !== original,
      };
    }
    return { text: fixed, violations: [], blocked: false, stripped, sharpSFixed: fixed !== original };
  }

  return { check, enforce, autofix, strip };
}

module.exports = { createGuards, sentences, normalise, fold, STRIP_RULES, claimsRequestSent, requestWasMade };
