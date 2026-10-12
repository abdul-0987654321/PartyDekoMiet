'use strict';
/**
 * Which language the bot answers in.
 *
 * Three bugs this replaces:
 *  - the botLanguage setting existed but was never read, so choosing German or
 *    English in the dashboard did nothing at all
 *  - the system prompt never stated a language, so the model re-decided every
 *    turn and the German-by-default persona won on short messages
 *  - detection counted matches with `text.match(re)` and no /g flag, which
 *    returns at most one match, so every score was 0 or 1
 *
 * Detection is now sticky. "Hi", "ok" or "danke" carry no signal, and a
 * conversation must not flip language because of them: an unclear message keeps
 * whatever the customer last used clearly.
 */

const STRONG_DE = /[äöüß]/i;

const DE_WORDS =
  /\b(ich|du|wir|und|oder|nicht|kein|keine|das|der|die|ist|sind|war|für|wie|was|wann|wo|wer|kann|könnt|möchte|hätte|habt|haben|bitte|danke|hallo|hoi|grüezi|guten|deko|dekoration|geburtstag|miete|mieten|kaution|abholen|abholung|lieferung|liefern|tage|preis|frei|buchung|buchen|motto|farbe|kind)\b/gi;

const EN_WORDS =
  /\b(i|you|we|the|a|an|and|or|not|no|is|are|was|do|does|did|can|could|would|how|what|when|where|who|please|thanks|thank|hello|hey|decoration|birthday|rent|rental|deposit|pickup|pick|deliver|delivery|days|price|free|book|booking|theme|colour|color|kid|child)\b/gi;

const count = (text, re) => (String(text).match(re) || []).length;

/**
 * @returns {'de'|'en'|null} null when the message carries no real signal
 */
function scoreText(text) {
  const s = String(text || '').trim();
  if (s.length < 2) return null;
  if (STRONG_DE.test(s)) return 'de'; // an umlaut is decisive

  const de = count(s, DE_WORDS);
  const en = count(s, EN_WORDS);

  if (de === 0 && en === 0) return null; // "ok", "👍", a bare date
  if (de === en) return null;            // "Hi" alone, ambiguous greetings
  return en > de ? 'en' : 'de';
}

/**
 * @param {object} opts
 * @param {string} opts.message        the new customer message
 * @param {Array}  [opts.history]      prior turns, oldest first
 * @param {string} [opts.setting]      'auto' | 'de' | 'en' from the dashboard
 * @returns {{lang:'de'|'en', source:'setting'|'message'|'history'|'default'}}
 */
function resolveLanguage({ message, history = [], setting = 'auto' }) {
  if (setting === 'de' || setting === 'en') return { lang: setting, source: 'setting' };

  const now = scoreText(message);
  if (now) return { lang: now, source: 'message' };

  // Unclear message: stay in whatever the customer last used clearly.
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'user') continue;
    const past = scoreText(m.content);
    if (past) return { lang: past, source: 'history' };
  }

  return { lang: 'de', source: 'default' }; // Swiss shop, German is the safe default
}

const NAMES = { de: 'Deutsch (German)', en: 'English' };

/** The instruction appended to the system prompt. */
function languageInstruction(lang, source) {
  if (lang === 'en') {
    return [
      '# Language',
      'Answer this conversation in ENGLISH. The customer writes English.',
      source === 'setting'
        ? 'English is fixed in the settings: answer in English even if the customer writes German.'
        : 'If the customer switches to German, switch with them.',
    ].join('\n');
  }
  return [
    '# Sprache',
    'Antworte in DIESER Unterhaltung auf DEUTSCH, mit "du".',
    source === 'setting'
      ? 'Deutsch ist in den Einstellungen fest gewaehlt: antworte auch dann auf Deutsch, wenn der Kunde Englisch schreibt.'
      : 'Wenn der Kunde auf Englisch wechselt, wechsle mit.',
    'Schweizer Schreibweise: niemals "ss"-Ersatz durch das deutsche scharfe S.',
  ].join('\n');
}

module.exports = { resolveLanguage, scoreText, languageInstruction, NAMES };
