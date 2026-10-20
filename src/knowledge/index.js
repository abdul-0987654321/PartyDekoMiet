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

/**
 * @param {{source?:string, sheetLoader?:function, dir?:string}} opts `dir` is the
 *   knowledge folder to read ('knowledge-studio' for the Studio); passed straight
 *   through to from-files.js. Two businesses in this one process each call load()
 *   with their own `dir` and keep the returned pack themselves - `get()` below
 *   only remembers the one loaded most recently, so it is not used for that.
 */
async function load(opts = {}) {
  const source = opts.source || process.env.KNOWLEDGE_SOURCE || 'files';
  let pack;

  if (source === 'sheet') {
    if (!opts.sheetLoader) throw new Error('KNOWLEDGE_SOURCE=sheet requires a sheet loader');
    const sheetPack = await opts.sheetLoader();
    // Files stay the fallback: if the owner empties a cell, we do not lose the rules.
    const base = fromFiles.load({ dir: opts.dir });
    pack = { ...base, ...sheetPack, source: 'sheet' };
  } else {
    pack = fromFiles.load({ dir: opts.dir });
  }

  cached = pack;
  log.info(
    `Knowledge loaded from ${pack.source}: ${pack.faq.length} FAQ entries, ` +
      `business "${pack.business.name}"`
  );
  return pack;
}

/** @deprecated kept for backward compatibility; with two businesses in one process, use load()'s return value instead. */
function get() {
  if (!cached) throw new Error('Knowledge not loaded yet - call load() during startup');
  return cached;
}

module.exports = { load, get };
