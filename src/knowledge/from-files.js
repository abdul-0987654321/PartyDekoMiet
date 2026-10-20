'use strict';
/** Loads the knowledge pack from the knowledge/ folder. */

const fs = require('fs');
const path = require('path');

// `dir` (or KNOWLEDGE_DIR) lets a second business in the SAME process (the
// Studio) load its own folder - "knowledge-studio" instead of "knowledge" -
// without copying this loader. Computed per call, not at module load, because
// Party and Studio both run in this one process and need different folders at
// the same time; a module-level constant could only ever hold one of them.
// Defaults to the original PartyDekoMiet folder, so every existing call with
// no argument is unaffected.
function rootDir(dir) {
  return path.join(__dirname, '..', '..', dir || process.env.KNOWLEDGE_DIR || 'knowledge');
}

function readText(root, name) {
  return fs.readFileSync(path.join(root, name), 'utf8').trim();
}
function readJson(root, name) {
  return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
}

/** @param {{dir?: string}} [opts] folder name under the project root, e.g. 'knowledge-studio' */
function load({ dir } = {}) {
  const root = rootDir(dir);
  const business = readJson(root, 'business.json');
  const faq = readJson(root, 'faq.json');
  return {
    source: 'files',
    business,
    faq: faq.entries,
    rules: readText(root, 'rules.md'),
    persona: readText(root, 'persona.md'),
    // Optional: the owner's official damage / loss price list.
    damagePrices: fs.existsSync(path.join(root, 'damage-prices.md')) ? readText(root, 'damage-prices.md') : '',
  };
}

module.exports = { load };
