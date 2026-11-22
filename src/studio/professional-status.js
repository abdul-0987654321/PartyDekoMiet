'use strict';
/**
 * What a professional says between clients, and what it means.
 *
 * She is standing in a room with a client either just gone or still there, and
 * the only practical thing she can do is hold the phone and speak. So the
 * vocabulary is built around what somebody actually says out loud - "besetzt",
 * "ich bin frei", "der Kunde bleibt noch eine halbe Stunde" - and not around a
 * command syntax nobody will remember.
 *
 * The input is a machine transcription, so it arrives with punctuation, filler
 * words, and the occasional mishearing. Matching is therefore on words found
 * anywhere in the sentence rather than on an exact phrase. That is the opposite
 * of the J/N parser next door, and deliberately so: there, a wrong guess
 * cancels somebody's appointment, so only a bare yes or no counts. Here the
 * worst case is a status that she can correct by speaking again, and the real
 * risk is the other way round - a command not understood means she stops
 * bothering, and then nobody knows anything, which is what caused the double
 * booking this was built for.
 *
 * Still, "frei" and "besetzt" in the same sentence, or no match at all, mean no
 * guess: she is asked, rather than a coin being tossed.
 */

/** Said while a client is there, or about to be. */
const BUSY = [
  'besetzt', 'beschäftigt', 'beschaeftigt', 'busy', 'occupied', 'belegt',
  'nicht frei', 'not free', 'im termin', 'in session', 'arbeite', 'working',
  'kunde ist da', 'kunde da', 'client is here', 'client here', 'angefangen', 'started',
];

/** Said when the room is empty again. */
const FREE = [
  'frei', 'free', 'fertig', 'finished', 'done', 'available', 'verfügbar', 'verfuegbar',
  'bereit', 'ready', 'kunde ist weg', 'kunde weg', 'client is gone', 'client gone',
  'fertig jetzt', 'wieder da',
];

/**
 * Said when the client is staying on.
 *
 * Split into two strengths because of one sentence: "ich bin noch besetzt".
 * "Noch" on its own is one of the commonest words in spoken German and means
 * nothing by itself, so taking it as an extension would have added half an hour
 * to an appointment every time she said she was still busy. A weak word counts
 * only together with a length and without a plain busy or free word beside it.
 */
const LONGER = [
  'länger', 'laenger', 'longer', 'bleibt', 'bleiben',
  'verlängern', 'verlaengern', 'extend', 'more time', 'mehr zeit',
  'stays', 'staying', 'overrun', 'dauert noch',
];
const LONGER_WEAK = ['noch eine', 'noch ein', 'noch', 'weiter', 'more'];

const WORD_NUMBERS = new Map([
  ['eine', 1], ['ein', 1], ['einen', 1], ['one', 1], ['a', 1],
  ['zwei', 2], ['two', 2], ['drei', 3], ['three', 3], ['vier', 4], ['four', 4],
  ['fünf', 5], ['fuenf', 5], ['five', 5], ['zehn', 10], ['ten', 10],
  ['fünfzehn', 15], ['fuenfzehn', 15], ['fifteen', 15],
  ['zwanzig', 20], ['twenty', 20], ['dreissig', 30], ['dreißig', 30], ['thirty', 30],
  ['vierzig', 40], ['forty', 40], ['fünfzig', 50], ['fuenfzig', 50], ['fifty', 50],
  ['sechzig', 60], ['sixty', 60], ['neunzig', 90], ['ninety', 90],
]);

const normalise = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[.,!?;:"'`´]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const has = (text, list) => list.some((w) => text.includes(w));

/**
 * How much longer, in minutes.
 *
 * Handles the forms people actually say: "30 Minuten", "eine halbe Stunde",
 * "noch eine Stunde", "anderthalb Stunden", "45 min", "half an hour".
 * Returns null when no length was said - the caller then uses a default rather
 * than inventing one here.
 */
function minutesIn(text) {
  const t = normalise(text);

  // "eine halbe Stunde", "half an hour" - said far more often than "30 Minuten".
  if (/(halbe stunde|half an hour|half hour)/.test(t)) return 30;
  // "anderthalb Stunden", "eineinhalb Stunden", "one and a half hours"
  if (/(anderthalb|eineinhalb|one and a half|1 5 stunden)/.test(t)) return 90;
  if (/(dreiviertelstunde|drei viertel stunde)/.test(t)) return 45;

  // "45 Minuten", "45 min", "45m"
  const mins = t.match(/(\d{1,3})\s*(minuten|minute|mins|min\b|m\b)/);
  if (mins) return Number(mins[1]);

  // "2 Stunden", "1 hour"
  const hours = t.match(/(\d{1,2})\s*(stunden|stunde|hours|hour|std|h\b)/);
  if (hours) return Number(hours[1]) * 60;

  // "eine Stunde", "zwei Stunden" - the number as a word
  const wordHour = t.match(/(\w+)\s+(stunden|stunde|hours|hour)/);
  if (wordHour && WORD_NUMBERS.has(wordHour[1])) return WORD_NUMBERS.get(wordHour[1]) * 60;

  const wordMin = t.match(/(\w+)\s+(minuten|minute|minutes)/);
  if (wordMin && WORD_NUMBERS.has(wordMin[1])) return WORD_NUMBERS.get(wordMin[1]);

  // A bare number, only when the sentence is about staying longer: "noch 30".
  const bare = t.match(/\b(\d{1,3})\b/);
  if (bare) {
    const n = Number(bare[1]);
    if (n > 0 && n <= 240) return n;
  }
  return null;
}

/**
 * @param {string} text what she said, already transcribed
 * @returns {{command: 'busy'|'free'|'longer'|null, minutes: number|null, ambiguous: boolean}}
 */
function parseStatus(text) {
  const t = normalise(text);
  if (!t) return { command: null, minutes: null, ambiguous: false };

  const busy = has(t, BUSY);
  const free = has(t, FREE);
  const minutes = minutesIn(t);
  // A weak word is an extension only when it brings a length with it and no
  // plain "besetzt" or "frei" is in the sentence to explain it better.
  const longer = has(t, LONGER) || (has(t, LONGER_WEAK) && minutes !== null && !busy && !free);

  // "Der Kunde bleibt noch eine halbe Stunde" contains neither besetzt nor
  // frei, but it is unmistakably about staying longer - and it is the one that
  // matters most, so it is checked before the other two.
  if (longer && !free) {
    return { command: 'longer', minutes, ambiguous: false };
  }

  // Both words in one sentence: no guessing. "Ich war besetzt, jetzt bin ich
  // frei" and "bin ich frei oder besetzt?" look identical from here.
  if (busy && free) return { command: null, minutes, ambiguous: true };
  if (busy) return { command: 'busy', minutes, ambiguous: false };
  if (free) return { command: 'free', minutes, ambiguous: false };
  return { command: null, minutes, ambiguous: false };
}

module.exports = { parseStatus, minutesIn, BUSY, FREE, LONGER, LONGER_WEAK };
