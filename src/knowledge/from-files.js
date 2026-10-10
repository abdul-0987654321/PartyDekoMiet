'use strict';
/** Loads the knowledge pack from the knowledge/ folder. */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'knowledge');

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
  };
}

module.exports = { load, ROOT };
