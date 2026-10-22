'use strict';
/**
 * Sending a professional's photo to a customer on WhatsApp.
 *
 * The photo is already in the owner's own private Drive folder - the dashboard
 * uploads it through db.putFile and keeps only the file id on the record, the
 * same way PartyDekoMiet stores customer reference pictures. This reads those
 * bytes back and forwards them, so the picture never needs a public URL.
 *
 * Kept apart from messenger.js on purpose: that one builds product cards out of
 * a Shopify catalog entry, which the Studio has nothing to do with.
 */

const db = require('../store/db');
const log = require('../log');

function createPhotos({ client }) {
  /**
   * @param {string} chatId
   * @param {object} professional record from the directory
   * @param {string} [note] caption; her name is used when there is none
   */
  async function sendProfessional(chatId, professional, note) {
    if (!professional?.photoFileId) throw new Error('no photo on file');
    const file = await db.getFile(professional.photoFileId);
    if (!file?.buffer?.length) throw new Error('the stored photo is empty');
    const caption = String(note || professional.name || '').trim();
    await client.forwardImage(chatId, file.buffer, caption, file.mimeType);
    log.info(`[studio] Photo sent for ${professional.name} to ${chatId}`);
    return { ok: true };
  }

  return { sendProfessional };
}

module.exports = { createPhotos };
