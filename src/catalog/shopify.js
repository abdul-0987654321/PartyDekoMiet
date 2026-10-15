'use strict';

/**
 * Shop titles are the owner's own text and some carry contact details, e.g.
 * "KinderGeburtstag Einhorn deko whats 0786353632 Zurich". Customers should see
 * the set's name, not a phone number glued to it.
 */
function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*\b(whats\s*app|whatsapp|whats|tel\.?|phone|telefon)?\s*\+?\d[\d\s\/.-]{7,}\d(\s+(z(u|ue|ü)rich))?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || String(title || '').trim();
}
/**
 * Reads the shop's public products.json. No Shopify admin access needed.
 *
 * Shopify paginates this endpoint; it keeps returning pages until one comes back
 * empty. Fields are parsed defensively because a shop owner can leave almost
 * anything blank, and a missing price must never crash a customer conversation.
 */

const log = require('../log');

const PAGE_SIZE = 250;
const MAX_PAGES = 20; // 5000 products is far beyond this shop; a guard against loops
const TIMEOUT_MS = 20000;

/** Strips Shopify's HTML body down to a short plain-text description. */
function plainText(html, maxLen = 400) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function normaliseProduct(raw, shopUrl) {
  const variants = Array.isArray(raw.variants) ? raw.variants : [];
  const prices = variants
    .map((v) => Number(v.price))
    .filter((n) => Number.isFinite(n) && n > 0);
  const images = (Array.isArray(raw.images) ? raw.images : [])
    .map((i) => i?.src)
    .filter(Boolean);

  return {
    id: String(raw.id ?? raw.handle ?? ''),
    handle: String(raw.handle || ''),
    title: String(raw.title || '').trim(),
    description: plainText(raw.body_html),
    productType: String(raw.product_type || '').trim(),
    tags: Array.isArray(raw.tags)
      ? raw.tags.map(String)
      : String(raw.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    price: prices.length ? Math.min(...prices) : null,
    priceLabel: prices.length ? `CHF ${Math.min(...prices).toFixed(2).replace(/\.00$/, '.-')}` : null,
    available: variants.some((v) => v.available !== false),
    image: images[0] || null,
    images,
    url: raw.handle ? `${shopUrl}/products/${raw.handle}` : shopUrl,
    updatedAt: raw.updated_at || null,
  };
}

/**
 * Fetches every product page.
 * @param {string} shopUrl e.g. https://partydekomiet.ch
 * @returns {Promise<object[]>}
 */
async function fetchProducts(shopUrl) {
  const base = String(shopUrl).replace(/\/+$/, '');
  const out = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${base}/products.json?limit=${PAGE_SIZE}&page=${page}`;
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'PartyDekoMiet-Bot/1.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${url} did not return JSON (got ${text.slice(0, 120)})`);
    }

    const products = Array.isArray(json.products) ? json.products : [];
    if (!products.length) break;

    for (const p of products) {
      const n = normaliseProduct(p, base);
      if (n.id && n.title) out.push(n);
    }
    if (products.length < PAGE_SIZE) break;
  }

  log.info(`Catalog fetched: ${out.length} products from ${base}`);
  return out;
}

module.exports = {
  cleanTitle, fetchProducts, normaliseProduct, plainText };
