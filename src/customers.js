'use strict';
/**
 * Customer records, one per business.
 *
 * PartyDekoMiet and the Studio run on two WhatsApp numbers out of one process
 * and share one Google Sheet. The same person can be a decoration customer and
 * a studio client, and the two must never see each other's record: the Studio
 * has no business knowing whose birthday party it was, and the rental shop has
 * no business knowing who booked a massage.
 *
 * Everything goes through here so no caller has to remember to pass the
 * business along - forgetting that once is what merged the two.
 */

const db = require('./store/db');

const BUSINESSES = new Set(['party', 'studio']);

const normalise = (business) => (BUSINESSES.has(business) ? business : 'party');

/** The stored key. Matches TABLES.customers.derive in store/db.js. */
function key(business, jid) {
  return `${normalise(business)}:${jid}`;
}

/** @returns {object|null} */
function get(business, jid) {
  return db.get('customers', key(business, jid));
}

/**
 * Creates or updates this business's record for this person.
 * @returns {object} the stored record
 */
function save(business, jid, patch = {}) {
  const biz = normalise(business);
  const existing = get(biz, jid);
  const record = {
    ...(existing || { createdAt: new Date().toISOString() }),
    ...patch,
    id: key(biz, jid),
    jid,
    business: biz,
    updatedAt: new Date().toISOString(),
  };
  db.put('customers', record);
  return record;
}

/** Every customer of one business. */
function list(business) {
  const biz = normalise(business);
  return db.all('customers').filter((c) => (c.business || 'party') === biz);
}

module.exports = { key, get, save, list, BUSINESSES };
