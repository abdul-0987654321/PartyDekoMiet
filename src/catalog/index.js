'use strict';
/**
 * Catalog with a cache that survives restarts.
 *
 * The product list is kept in the Google Sheet's `state` table, so a restart on
 * Render does not leave the bot without a catalog while the shop is being
 * re-fetched - and if the shop is temporarily unreachable, the last good copy is
 * still served instead of telling customers we have nothing.
 */

const log = require('../log');
const db = require('../store/db');
const settings = require('../settings');
const { fetchProducts, cleanTitle } = require('./shopify');
const { search: searchProducts } = require('./search');

const STATE_KEY = 'catalog';

let products = [];
let fetchedAt = null;
let lastError = null;
let timer = null;
let refreshing = null;

function loadFromCache() {
  try {
    const row = db.get('state', STATE_KEY);
    if (!row?.value) return false;
    const cached = JSON.parse(row.value);
    if (!Array.isArray(cached.products) || !cached.products.length) return false;
    products = cached.products;
    fetchedAt = cached.fetchedAt || null;
    log.info(`Catalog restored from cache: ${products.length} products (fetched ${fetchedAt})`);
    return true;
  } catch (err) {
    log.warn(`Could not read the catalog cache: ${err.message}`);
    return false;
  }
}

function saveToCache() {
  db.put('state', { key: STATE_KEY, value: JSON.stringify({ products, fetchedAt }) });
}

/** Fetches the shop. Keeps the previous list if the shop cannot be reached. */
async function refresh({ force = false } = {}) {
  if (refreshing) return refreshing;

  refreshing = (async () => {
    try {
      const fresh = await fetchProducts(settings.get('shopUrl'));
      if (!fresh.length) throw new Error('shop returned an empty product list');
      products = fresh;
      fetchedAt = new Date().toISOString();
      lastError = null;
      saveToCache();
      return { ok: true, count: products.length };
    } catch (err) {
      lastError = err.message;
      log.error(`Catalog refresh failed: ${err.message}`);
      if (products.length && !force) {
        log.warn(`Keeping the previous catalog (${products.length} products).`);
      }
      return { ok: false, error: err.message, count: products.length };
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

function scheduleRefresh() {
  if (timer) clearInterval(timer);
  const hours = Math.max(1, Number(settings.get('catalogRefreshHours')) || 6);
  timer = setInterval(() => void refresh(), hours * 3600 * 1000);
  timer.unref?.();
  log.info(`Catalog refresh scheduled every ${hours}h`);
}

/** Called at boot: serve the cache immediately, refresh in the background. */
async function init() {
  const hadCache = loadFromCache();
  scheduleRefresh();
  const p = refresh();
  if (!hadCache) await p; // nothing to serve yet, so wait for the first fetch
  return { count: products.length, fetchedAt, lastError };
}

function status() {
  return { count: products.length, fetchedAt, lastError, shopUrl: settings.get('shopUrl') };
}

function all() {
  return products;
}

function byId(idOrHandle) {
  const needle = String(idOrHandle).trim().toLowerCase();
  return (
    products.find((p) => p.id.toLowerCase() === needle) ||
    products.find((p) => p.handle.toLowerCase() === needle) ||
    products.find((p) => p.title.toLowerCase() === needle) ||
    null
  );
}

/** Tool-facing search: returns only the fields the model needs. */
async function search(args) {
  const hits = searchProducts(products, args);
  return hits.map((p) => ({
    id: p.handle || p.id,
    title: cleanTitle(p.title),
    price: p.priceLabel,
    available_in_shop: p.available,
    url: p.url,
  }));
}

module.exports = { init, refresh, search, byId, all, status, _loadFromCache: loadFromCache };
