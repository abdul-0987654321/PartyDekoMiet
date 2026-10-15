'use strict';
/**
 * Scores products against what the customer asked for.
 *
 * Customers write German, often Swiss German, often misspelled, and the shop's
 * product titles are the owner's own wording. So matching is done on a folded,
 * accent-free form and a synonym table maps everyday words to the words a shop
 * actually uses ("Meerjungfrau" -> "mermaid", "pink" -> "rosa").
 */

const FOLD = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss', 'é': 'e', 'è': 'e', 'à': 'a' };

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[äöüßéèà]/g, (c) => FOLD[c] || c)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Everyday word -> words that may appear in a product title or tag. */
const SYNONYMS = {
  einhorn: ['einhorn', 'unicorn'],
  prinzessin: ['prinzessin', 'princess', 'krone', 'schloss'],
  meerjungfrau: ['meerjungfrau', 'mermaid', 'arielle'],
  dino: ['dino', 'dinosaurier', 'dinosaur', 'trex'],
  auto: ['auto', 'cars', 'rennwagen', 'fahrzeug'],
  bagger: ['bagger', 'baustelle', 'construction'],
  flamingo: ['flamingo'],
  dschungel: ['dschungel', 'jungle', 'safari', 'tiere'],
  weltraum: ['weltraum', 'space', 'rakete', 'astronaut'],
  regenbogen: ['regenbogen', 'rainbow'],
  schmetterling: ['schmetterling', 'butterfly'],
  blumen: ['blumen', 'flower', 'floral'],
  ballon: ['ballon', 'ballons', 'balloon', 'luftballon'],
  maedchen: ['maedchen', 'girl', 'girls'],
  junge: ['junge', 'boy', 'boys'],
  taufe: ['taufe', 'baptism', 'christening'],
  hochzeit: ['hochzeit', 'wedding'],
  babyshower: ['babyshower', 'baby shower', 'baby'],
  geburtstag: ['geburtstag', 'birthday', 'bday'],
  // colours
  rosa: ['rosa', 'pink', 'rose'],
  blau: ['blau', 'blue'],
  gold: ['gold', 'golden', 'goldig'],
  silber: ['silber', 'silver'],
  weiss: ['weiss', 'white'],
  schwarz: ['schwarz', 'black'],
  gruen: ['gruen', 'green'],
  rot: ['rot', 'red'],
  lila: ['lila', 'violett', 'purple'],
  tuerkis: ['tuerkis', 'turquoise', 'mint'],
  pastell: ['pastell', 'pastel'],
};

const COLOURS = ['rosa', 'blau', 'gold', 'silber', 'weiss', 'schwarz', 'gruen', 'rot', 'lila', 'tuerkis', 'pastell'];

/** Words that carry no meaning for matching. */
const STOP = new Set(
  norm(
    'ich suche brauche moechte haette gerne habt ihr haben sie fuer ein eine einen das der die ' +
      'und oder mit von zu am im an auf ist sind wie was wo wann bitte danke hallo hoi guten tag ' +
      'deko dekoration set sets party i we need want have you a an the for with and or is are my'
  ).split(' ')
);

function expand(tokens) {
  const out = new Set(tokens);
  for (const t of tokens) {
    for (const [key, words] of Object.entries(SYNONYMS)) {
      if (t === key || words.includes(t)) {
        out.add(key);
        for (const w of words) out.add(w);
      }
    }
  }
  return out;
}

function tokenise(text) {
  return norm(text).split(' ').filter((t) => t.length > 2 && !STOP.has(t));
}

/**
 * @param {object[]} products normalised products
 * @param {object} query { query, theme, color, limit }
 * @returns {object[]} best matches first
 */
function search(products, { query = '', theme = '', color = '', limit = 5 } = {}) {
  const wanted = expand(tokenise([query, theme, color].filter(Boolean).join(' ')));

  // Nothing usable in the query: return available products rather than nothing.
  if (!wanted.size) {
    return products.filter((p) => p.available).slice(0, limit);
  }

  // Colours only refine a theme. "Einhorn, blau" must return unicorn sets first,
  // not a blue tablecloth: a colour word used to weigh as much as the theme.
  const colourWords = new Set(COLOURS.flatMap((c) => [c, ...SYNONYMS[c]]));
  const themeWanted = [...wanted].filter((w) => w && !colourWords.has(w));
  const colourWanted = [...wanted].filter((w) => w && colourWords.has(w));

  const scoreFor = (p, words) => {
    const title = norm(p.title);
    const tags = norm(p.tags.join(' '));
    const type = norm(p.productType);
    const body = norm(p.description);
    let score = 0;
    for (const w of words) {
      // A word in the title is the strongest signal, then tags, then type, then text.
      if (title.includes(w)) score += 10;
      if (tags.includes(w)) score += 6;
      if (type.includes(w)) score += 3;
      if (body.includes(w)) score += 1;
    }
    return score;
  };

  let scored = products.map((p) => ({
    product: p,
    theme: scoreFor(p, themeWanted),
    colour: scoreFor(p, colourWanted),
  }));

  // If anything matches the theme, only theme matches are offered.
  const anyTheme = scored.some((s) => s.theme > 0);
  scored = scored
    .filter((s) => (anyTheme ? s.theme > 0 : s.colour > 0))
    .map((s) => ({ ...s, score: s.theme * 3 + s.colour - (s.product.available ? 0 : 5) }));

  return scored
    .sort((a, b) => b.score - a.score || a.product.title.localeCompare(b.product.title))
    .slice(0, limit)
    .map((s) => s.product);
}

module.exports = { search, tokenise, expand, norm, SYNONYMS, COLOURS };
