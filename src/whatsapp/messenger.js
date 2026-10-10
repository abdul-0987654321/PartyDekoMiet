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

function createMessenger({ client }) {
  function caption(product, note) {
    const deposit = settings.get('depositChf');
    return [
      `*${product.title}*`,
      product.priceLabel ? `${product.priceLabel} + CHF ${deposit}.- Kaution` : null,
      note || null,
      product.url,
    ]
      .filter(Boolean)
      .join('\n');
  }

  async function sendProduct(chatId, product, note) {
    const text = caption(product, note);
    if (product.image) {
      try {
        await client.sendImage(chatId, product.image, text);
        return { ok: true, withImage: true };
      } catch (err) {
        log.warn(`Image for "${product.title}" could not be sent (${err.message}) - sending text only`);
      }
    }
    await client.sendText(chatId, text);
    return { ok: true, withImage: false };
  }

  return { sendProduct, caption };
}

module.exports = { createMessenger };
