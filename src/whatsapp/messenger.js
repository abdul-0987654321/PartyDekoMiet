'use strict';
/**
 * Sends a product to a customer: picture, name, price, shop link.
 *
 * If the image cannot be sent (bad URL, shop down, WhatsApp refuses the media),
 * the text still goes out. A customer getting the link without the picture is a
 * small problem; a customer getting nothing is a lost booking.
 */

const log = require('../log');
const settings = require('../settings');
const db = require('../store/db');
const { cleanTitle } = require('../catalog/shopify');

/** Downloads a picture ourselves, for when WhatsApp cannot fetch the URL itself. */
async function fetchImage(url, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0];
  if (!type.startsWith('image/')) throw new Error(`not an image (${type})`);
  return { buffer: Buffer.from(await res.arrayBuffer()), type };
}

/**
 * The dashboard shows the chat from these rows. Product cards used to go to
 * WhatsApp only, so the owner saw the bot's text ("schau dir den Link an")
 * without the pictures it referred to.
 */
function recordProduct(chatId, text, image) {
  try {
    db.put('chat', {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      business: 'party',
      at: new Date().toISOString(),
      jid: chatId,
      direction: 'out',
      text,
      image: image || '',
    });
  } catch (err) {
    log.warn(`Could not record the product card for ${chatId}: ${err.message}`);
  }
}

function createMessenger({ client, fetchImpl }) {
  function caption(product, note) {
    const deposit = settings.get('depositChf');
    return [
      `*${cleanTitle(product.title)}*`,
      product.priceLabel ? `${product.priceLabel} + CHF ${deposit}.- Kaution` : null,
      note || null,
      product.url,
    ]
      .filter(Boolean)
      .join('\n');
  }

  async function sendProduct(chatId, product, note) {
    const text = caption(product, note);
    const image = product.image ? String(product.image).replace(/^\/\//, 'https://') : null;
    if (image) {
      try {
        await client.sendImage(chatId, image, text);
        recordProduct(chatId, text, image);
        return { ok: true, withImage: true };
      } catch (err) {
        log.warn(`Image URL for "${product.title}" failed (${err.message}) - downloading it ourselves`);
      }
      // Second try: fetch the picture here and send the bytes.
      try {
        const { buffer, type } = await fetchImage(image, fetchImpl);
        await client.forwardImage(chatId, buffer, text, type);
        recordProduct(chatId, text, image);
        return { ok: true, withImage: true };
      } catch (err) {
        log.warn(`Image for "${product.title}" could not be sent (${err.message}) - sending text only`);
      }
    }
    await client.sendText(chatId, text);
    recordProduct(chatId, text, null);
    return { ok: true, withImage: false };
  }

  return { sendProduct, caption };
}

module.exports = { createMessenger, fetchImage };
