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

/**
 * Has this exact picture already gone to this chat?
 *
 * Read from the chat history rather than from separate bookkeeping, because
 * the history is what the picture was written into and it survives a restart.
 * Only used to avoid sending the same photo twice in one conversation.
 */
function alreadySent(chatId, photoFileId) {
  const needle = `/api/studio/photo/${encodeURIComponent(photoFileId)}`;
  return db
    .all('chat')
    .some((m) => m.jid === chatId && (m.business || 'party') === 'studio' && m.image === needle);
}

function createPhotos({ client }) {
  /**
   * @param {string} chatId
   * @param {object} professional record from the directory
   * @param {string} [note] caption; her name is used when there is none
   * @param {object} [opts]
   * @param {boolean} [opts.once] skip if this photo already went to this chat
   * @returns {Promise<{ok:boolean, skipped?:string}>}
   */
  async function sendProfessional(chatId, professional, note, { once = false } = {}) {
    if (!professional?.photoFileId) throw new Error('no photo on file');
    if (once && alreadySent(chatId, professional.photoFileId)) {
      return { ok: true, skipped: 'already sent in this chat' };
    }
    const file = await db.getFile(professional.photoFileId);
    if (!file?.buffer?.length) throw new Error('the stored photo is empty');
    const caption = String(note || professional.name || '').trim();
    await client.forwardImage(chatId, file.buffer, caption, file.mimeType);
    record(chatId, caption, professional.photoFileId);
    log.info(`[studio] Photo sent for ${professional.name} to ${chatId}`);
    return { ok: true };
  }

  /**
   * Sends the photos of the people this answer is about, without the model
   * having to decide to.
   *
   * Telling the model to send it in the same reply is advice, and advice gets
   * skipped: asked for a professional's details, it returned the text and left
   * the picture until the customer asked a second time. Reading the first
   * answer, a customer concludes there is no photo. So the lookup itself sends
   * it - the same shape as PartyDekoMiet turning a listed product into a
   * picture card rather than hoping the model remembers to.
   *
   * Never throws: a failed picture must not cost the customer their answer.
   *
   * @returns {Promise<string[]>} names whose photo was sent just now
   */
  async function sendForAnswer(chatId, professionals = []) {
    const sent = [];
    if (!chatId) return sent;
    for (const p of professionals) {
      if (!p?.photoFileId) continue;
      try {
        const res = await sendProfessional(chatId, p, p.name, { once: true });
        if (res.ok && !res.skipped) sent.push(p.name);
      } catch (err) {
        log.warn(`[studio] Could not send ${p.name}'s photo with the answer: ${err.message}`);
      }
    }
    return sent;
  }

  return { sendProfessional, sendForAnswer };
}

module.exports = { createPhotos };
