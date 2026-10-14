'use strict';
/**
 * Voice notes, both directions.
 *
 *  1. A CUSTOMER sends a voice note -> it is transcribed and answered like text.
 *  2. The OWNER dictates a reply ("tell him the set is free on Saturday, answer
 *     in Italian") -> it is transcribed, turned into the exact message for the
 *     customer in the requested language, shown to the owner as a preview, and
 *     sent on "ok".
 *
 * Both use the client's own OpenAI key. Transcription costs about USD 0.006 per
 * minute of audio.
 */

const log = require('../log');

const LANGS = {
  de: 'Deutsch', en: 'English', it: 'Italiano', es: 'Español', fr: 'Français', pt: 'Português',
  no: 'Norsk', sv: 'Svenska', da: 'Dansk', nl: 'Nederlands',
};

/** Swiss orthography: never the German sharp s. */
const swiss = (s) => String(s || '').replace(/ß/g, 'ss');

const COMPOSE_PROMPT = `You help a shop owner answer a customer on WhatsApp while he is busy (often driving).
He dictates what he wants to say, in any language, often loosely ("tell him it's free on Saturday, in Italian").
Write the exact message that will be sent to the customer, as if the owner typed it himself.

Rules:
- Language: the one the owner names ("auf Italienisch", "in Spanish", "en español", ...).
  If he names none, use the customer's language from the context. If that is unknown, use German.
- Only what the owner said. Do not add facts, prices, dates or promises he did not say.
- Short, friendly, natural WhatsApp style. Informal "du" in German, the equivalent elsewhere.
- Swiss German spelling: never use "ß", always "ss".
- Never mention that this was dictated, transcribed or translated.
- Leave out the instruction itself ("tell him", "answer in Italian") - only the message.

Answer with JSON only: {"language":"<ISO 639-1 code>","message":"<the message>"}`;

/**
 * @param {object} deps
 * @param {object} deps.openai   OpenAI client (audio.transcriptions + chat.completions)
 * @param {string} [deps.model]  chat model for composing owner replies
 * @param {string} [deps.transcribeModel]
 * @param {Function} [deps.toFile]  injectable for tests; defaults to openai's toFile
 */
function createVoice({ openai, model = 'gpt-4o-mini', transcribeModel = 'whisper-1', toFile } = {}) {
  if (!openai) throw new Error('createVoice needs an OpenAI client');

  function fileFrom(buffer, mimetype) {
    const make = toFile || require('openai').toFile;
    const type = String(mimetype || 'audio/ogg').split(';')[0];
    const ext = type.includes('mpeg') ? 'mp3' : type.includes('mp4') || type.includes('m4a') ? 'm4a' : 'ogg';
    return make(buffer, `voice.${ext}`, { type });
  }

  /** Audio buffer -> text. Throws on failure, so the caller can react honestly. */
  async function transcribe(buffer, mimetype) {
    if (!buffer || !buffer.length) throw new Error('empty audio');
    const file = await fileFrom(buffer, mimetype);
    const res = await openai.audio.transcriptions.create({ file, model: transcribeModel });
    const text = String(res?.text || '').trim();
    if (!text) throw new Error('transcription was empty');
    return text;
  }

  /**
   * The owner's dictated instruction -> the message for the customer.
   * @param {string} instruction  what the owner said
   * @param {object} [ctx]
   * @param {string} [ctx.lastCustomerText]  the customer's last message, for language and context
   * @returns {Promise<{language:string, languageName:string, message:string}>}
   */
  async function composeOwnerReply(instruction, ctx = {}) {
    const context = ctx.lastCustomerText
      ? `Customer's last message (for context and language): "${String(ctx.lastCustomerText).slice(0, 600)}"`
      : 'Customer language: unknown.';
    const res = await openai.chat.completions.create({
      model,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: COMPOSE_PROMPT },
        { role: 'user', content: `${context}\n\nOwner's instruction:\n${instruction}` },
      ],
    });
    const raw = res?.choices?.[0]?.message?.content || '';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { language: '', message: raw };
    }
    const message = swiss(String(parsed.message || '').trim());
    if (!message) throw new Error('the composed message was empty');
    const language = String(parsed.language || '').toLowerCase().slice(0, 2);
    log.info(`Owner reply composed (${language || '?'}, ${message.length} chars)`);
    return { language, languageName: LANGS[language] || language || '?', message };
  }

  return { transcribe, composeOwnerReply };
}

module.exports = { createVoice, LANGS, swiss, COMPOSE_PROMPT };
