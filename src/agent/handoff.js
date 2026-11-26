'use strict';
/**
 * When handing a conversation to a person is the right move, and when it is
 * the model giving up.
 *
 * Both tool registries used to describe handoff_to_human as being for
 * "anything you are unsure about", and both listed `unclear` as a reason the
 * model could give. A customer wrote "I need massga" - a misspelling of the
 * thing the bot had just offered him - and got "Let me check that with the
 * team". The model did exactly what it was told.
 *
 * The rules files say not to do this. A tool description beats a rules file,
 * because it sits in front of the model on every single call, so the fix has
 * to be here.
 *
 * Refusing is deliberately a blocklist rather than a list of allowed reasons.
 * A real handoff with a word nobody anticipated must still get through - the
 * cost of wrongly refusing a complaint is far higher than the cost of letting
 * an oddly-worded one past. Only the words that mean "I do not know" are
 * turned away.
 */

/** Reasons that mean the model is stuck, not that a person is needed. */
const VAGUE = [
  'unclear', 'unsure', 'not sure', 'uncertain', 'unknown', 'unverstaendlich', 'unverständlich',
  'misunderstanding', 'misverstaendnis', 'missverständnis', 'confused', 'confusing',
  'verwirrt', 'nicht verstanden', 'dont understand', "don't understand", 'do not understand',
  'nicht sicher', 'keine ahnung', 'no idea', 'general', 'generell', 'allgemein',
  'question', 'frage', 'other', 'sonstiges', 'anderes', 'n/a', 'none',
];

/**
 * @param {string} reason as the model gave it
 * @returns {boolean} true when this is the model giving up rather than a case
 *   that genuinely needs a person
 */
function isVague(reason) {
  const text = String(reason || '').trim().toLowerCase();
  if (!text) return true;
  return VAGUE.some((v) => text === v || text.includes(v));
}

/**
 * What the model is told instead of being allowed to hand off.
 *
 * In German because every other tool result on both sides is, and the model
 * answers the customer in the customer's language regardless.
 */
const ASK_INSTEAD =
  'Das ist kein Fall fuer einen Menschen. Du hast die Nachricht nur nicht verstanden - '
  + 'das ist ein Grund nachzufragen, nicht jemanden zu holen. '
  + 'Frag den Kunden kurz und freundlich, was er genau meint, oder nenne die naechstliegende '
  + 'Moeglichkeit und frag, ob er die meint. Ist es ein Tippfehler fuer etwas aus deiner Liste, '
  + 'nimm das an und mach weiter. Uebergib nur bei Reklamationen, Stornierungen, Aenderungen an '
  + 'einem bestehenden Termin oder einer bestehenden Buchung, Schaeden, Preisstreit oder wenn '
  + 'jemand etwas verlangt, was nicht angeboten wird.';

/** The one sentence both tool descriptions end with. */
const DESCRIPTION_TAIL =
  'Do NOT use it because a message was vague, misspelled, or you did not understand it - '
  + 'ask the customer what they mean, or name the closest thing you offer and ask if that is it. '
  + 'Tell the customer briefly that a colleague will get back to them, without promising a time.';

module.exports = { isVague, ASK_INSTEAD, DESCRIPTION_TAIL, VAGUE };
