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

/**
 * Write the picture into the chat history, so the dashboard shows what the
 * customer was actually sent. Without this the owner reads "I've sent you a
 * photo of Sofia" with no photo anywhere - the same gap product cards had
 * before messenger.js started recording them.
 *
 * The dashboard serves the file from its own endpoint rather than a public
 * URL, which is also where the professionals page reads it from.
 */
function record(chatId, text, photoFileId) {
  try {
    db.put('chat', {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      business: 'studio',
      at: new Date().toISOString(),
      jid: chatId,
      direction: 'out',
      text,
      image: `/api/studio/photo/${encodeURIComponent(photoFileId)}`,
    });
  } catch (err) {
    log.warn(`[studio] Could not record the sent photo for ${chatId}: ${err.message}`);
  }
}

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
    record(chatId, caption, professional.photoFileId);
    log.info(`[studio] Photo sent for ${professional.name} to ${chatId}`);
    return { ok: true };
  }

  return { sendProfessional };
}

module.exports = { createPhotos };
