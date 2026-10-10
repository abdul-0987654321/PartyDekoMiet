'use strict';
/**
 * Knowledge pack loader.
 *
 * Everything business-specific lives behind this interface, so the second bot
 * (the massage studio) is a new knowledge/ folder and a new .env, not new code.
 *
 *   KNOWLEDGE_SOURCE=files  -> knowledge/*.json + *.md   (this bot)
 *   KNOWLEDGE_SOURCE=sheet  -> the owner edits FAQ and prices in the Google Sheet
 *
 * The sheet source is deliberately loaded through the same shape, so nothing
 * downstream needs to know where the knowledge came from.
 */

const log = require('../log');
const fromFiles = require('./from-files');

let cached = null;

/** @param {{source?:string, sheetLoader?:function}} opts */
async function load(opts = {}) {
  const source = opts.source || process.env.KNOWLEDGE_SOURCE || 'files';

  if (source === 'sheet') {
    if (!opts.sheetLoader) throw new Error('KNOWLEDGE_SOURCE=sheet requires a sheet loader');
    const pack = await opts.sheetLoader();
    // Files stay the fallback: if the owner empties a cell, we do not lose the rules.
    const base = fromFiles.load();
    cached = { ...base, ...pack, source: 'sheet' };
  } else {
    cached = fromFiles.load();
  }

  log.info(
    `Knowledge loaded from ${cached.source}: ${cached.faq.length} FAQ entries, ` +
      `business "${cached.business.name}"`
  );
  return cached;
}

function get() {
  if (!cached) throw new Error('Knowledge not loaded yet - call load() during startup');
  return cached;
}

module.exports = { load, get };
