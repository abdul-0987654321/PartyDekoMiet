'use strict';
/**
 * Which stored session row belongs to which WhatsApp number.
 *
 * Its own file, with no dependencies, for two reasons: auth-state.js cannot be
 * loaded without Baileys installed, and this is the one piece of logic that
 * keeps six logins apart in a single shared table. It is worth being able to
 * test on its own.
 *
 * PartyDekoMiet keeps the unprefixed keys it has used since the first deploy -
 * renaming them would log that number out - so "Party's rows" is defined as
 * "rows carrying nobody else's prefix", including the prefix of a line that has
 * since been deleted.
 */

/** `studio:creds`, `pro-sofia:creds` - shape only, so deleted lines still match. */
const PREFIXED = /^(studio|pro-[a-z0-9][a-z0-9-]*):/;

/** @param {string} [business] line id */
function keyPrefix(business) {
  return !business || business === 'party' ? '' : `${business}:`;
}

/**
 * @param {string} key the stored row key
 * @param {string} [business] line id
 */
function ownedBy(key, business) {
  const prefix = keyPrefix(business);
  return prefix ? String(key).startsWith(prefix) : !PREFIXED.test(String(key));
}

module.exports = { keyPrefix, ownedBy, PREFIXED };
