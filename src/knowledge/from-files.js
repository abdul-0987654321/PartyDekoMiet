'use strict';
/** Loads the knowledge pack from the knowledge/ folder. */

const fs = require('fs');
const path = require('path');

// KNOWLEDGE_DIR lets a second bot process (e.g. the Studio) point at its own
// folder - "knowledge-studio" instead of "knowledge" - without copying this
// loader. Defaults to the original PartyDekoMiet folder.
const ROOT = path.join(__dirname, '..', '..', process.env.KNOWLEDGE_DIR || 'knowledge');

function readText(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8').trim();
}
function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));
}

function load() {
  const business = readJson('business.json');
  const faq = readJson('faq.json');
  return {
    source: 'files',
    business,
    faq: faq.entries,
    rules: readText('rules.md'),
    persona: readText('persona.md'),
    // Optional: the owner's official damage / loss price list.
    damagePrices: fs.existsSync(path.join(ROOT, 'damage-prices.md')) ? readText('damage-prices.md') : '',
  };
}

module.exports = { load, ROOT };
