'use strict';
/**
 * Decides what happens with every incoming WhatsApp message.
 *
 *   owner's own number  -> commands (/pause, /resume, /status, /on, /off)
 *                          and dictated replies: a voice note (or a typed reply
 *                          quoting a bot alert) becomes a message to that customer,
 *                          in the language the owner names, sent after "ok"
 *   owner typing in a customer chat from the phone -> pause the bot there
 *   customer            -> agent reply, unless that chat is paused; customer
 *                          voice notes are transcribed and answered like text
 *
 * Group chats, status updates and broadcasts never get here: client.js drops
 * anything that is not a private chat.
 */

const log = require('../log');
const db = require('../store/db');
const settings = require('../settings');
const { m } = require('../notify/messages');
const contacts = require('../contacts');

/**
 * Both bots share the `state` table/sheet, so each needs its own pause-state key
 * or Studio's paused chats would overwrite Party's (they also share no chat jids,
 * but the key itself would still collide). Party keeps the original, unprefixed
 * key for backward compatibility with state already on the sheet.
 */
function stateKey(business) {
  return business === 'studio' ? 'chatstate:studio' : 'chatstate';
}

function loadState(business) {
  try {
    const row = db.get('state', stateKey(business));
    return row?.value ? JSON.parse(row.value) : {};
  } catch {
    return {};
  }
}
function saveState(state, business) {
  db.put('state', { key: stateKey(business), value: JSON.stringify(state) });
}

const digits = (s) => String(s || '').replace(/[^0-9]/g, '');
const jidOf = (number) => `${digits(number)}@s.whatsapp.net`;

/** Pulls the readable text out of whatever message shape WhatsApp sent. */
function textOf(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  ).trim();
}

function hasImage(msg) {
  return Boolean(msg.message?.imageMessage);
}

function hasAudio(msg) {
  return Boolean(msg.message?.audioMessage);
}

/** Text of the message the owner replied to (quoted), if any. */
function quotedTextOf(msg) {
  const m = msg.message || {};
  const ctx =
    m.extendedTextMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo;
  const q = ctx?.quotedMessage;
  if (!q) return '';
  return String(q.conversation || q.extendedTextMessage?.text || q.imageMessage?.caption || '').trim();
}

/** First phone-number-like run of digits (8-15) in a text: "Chat: 41791234567". */
function numberIn(text) {
  const match = String(text || '').match(/\+?\d[\d ]{6,18}\d/);
  if (!match) return null;
  const n = match[0].replace(/[^0-9]/g, '');
  return n.length >= 8 && n.length <= 15 ? { number: n, raw: match[0] } : null;
}

/** The user part of a jid: "41791234567:12@s.whatsapp.net" -> "41791234567". */
const userOf = (jid) => String(jid || '').split('@')[0].split(':')[0];

const CONFIRM = /^(ok|okay|ja|jep|yes|yep|senden|send|si|s\u00ec|oui|go)\b[\s.!]*$/i;
const CANCEL = /^(nein|no|nee|cancel|abbrechen|stop|verwerfen|discard)\b[\s.!]*$/i;
const PENDING_TTL_MS = 30 * 60 * 1000;

const VOICE_UNREADABLE =
  'Sorry, deine Sprachnachricht kann ich gerade nicht abhoeren - schreib mir bitte kurz. ' +
  '/ Sorry, I cannot listen to your voice message right now - please type it.';

/**
 * Folds umlauts and strips punctuation so keyword matching survives the way
 * customers actually type.
 */
const flatten = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\u00e4/g, 'ae').replace(/\u00f6/g, 'oe').replace(/\u00fc/g, 'ue').replace(/\u00df/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The same WhatsApp number may be used for a second business. The bot only
 * knows the rental rules, so a question about the other business must never be
 * answered here - it would be answered confidently and wrongly, and no rule
 * guard would catch it, because nothing is being violated.
 *
 * This check runs BEFORE the model, so there is no chance of it improvising.
 *
 * @returns {boolean} true when the message belongs to the other business
 */
function matchesOtherBusiness(text, keywordsRaw) {
  const keywords = String(keywordsRaw || '')
    .split(',')
    .map((k) => flatten(k))
    .filter((k) => k.length > 2);
  if (!keywords.length) return false;
  const haystack = ` ${flatten(text)} `;
  return keywords.some((k) => haystack.includes(` ${k} `) || haystack.includes(k));
}

/**
 * @param {'party'|'studio'} [business] defaults to 'party' - existing callers are
 *   unaffected. Only the pieces that would otherwise collide between two bots on
 *   the same shared sheet (pause-state key, chat/customer business tag, and the
 *   owner-number / calendar settings) are parameterized; everything else
 *   (botEnabled, takeoverPauseHours, maxMsgsPerChatPerHour, ownerVoicePreview,
 *   otherBusinessKeywords/Reply) stays shared/global on purpose.
 */
function createRouter({ client, agent, services, notify, knowledge, voice = null, business = 'party' }) {
  let state = {};
  const pendingReplies = new Map(); // ownerJid -> { target, message, heard, langName, at }

  /** Maps a shared settings key to its Studio-specific name when needed. */
  const BUSINESS_SETTINGS = { ownerWhatsapp: 'studioOwnerWhatsapp', calendarId: 'studioCalendarId' };
  const setting = (key) => settings.get(business === 'studio' && BUSINESS_SETTINGS[key] ? BUSINESS_SETTINGS[key] : key);

  const isOwner = (jid) => {
    const owner = digits(setting('ownerWhatsapp'));
    return Boolean(owner) && digits(jid).startsWith(owner);
  };

  /** The bot's own chat ("Message yourself") - where the owner talks to it on the same number. */
  function isSelfChat(jid) {
    const me = client.getStatus?.().me || {};
    const user = userOf(jid);
    return Boolean(user) && (user === userOf(me.id) || user === userOf(me.lid));
  }

  function pause(jid, hours, reason) {
    state[jid] = { ...(state[jid] || {}), pausedUntil: Date.now() + hours * 3600 * 1000, reason };
    saveState(state, business);
    log.info(`Bot paused for ${jid} for ${hours}h (${reason})`);
  }

  function resume(jid) {
    if (state[jid]) {
      delete state[jid].pausedUntil;
      delete state[jid].reason;
      saveState(state, business);
    }
    log.info(`Bot resumed for ${jid}`);
  }

  function isPaused(jid) {
    const until = state[jid]?.pausedUntil;
    return Boolean(until && until > Date.now());
  }

  /**
   * Per-chat hourly cap. 0 switches it off, which is the default: the owner
   * asked for it and accepts that a loop or a troll can then run up usage.
   */
  function underRateLimit(jid) {
    const max = Number(settings.get('maxMsgsPerChatPerHour'));
    if (!max || max <= 0) return true;
    const cutoff = Date.now() - 3600 * 1000;
    const entry = (state[jid] = state[jid] || {});
    entry.count = (entry.count || []).filter((t) => t > cutoff);
    if (entry.count.length >= max) return false;
    entry.count.push(Date.now());
    saveState(state, business);
    return true;
  }

  // ---- Owner commands -------------------------------------------------------

  async function handleOwnerCommand(jid, text) {
    const [cmd, ...rest] = text.trim().split(/\s+/);
    const arg = rest.join(' ').trim();
    const target = arg ? jidOf(arg) : null;

    switch (cmd.toLowerCase()) {
      case '/pause': {
        if (!target) return 'Nutzung: /pause <nummer>  z.B. /pause 41791234567';
        pause(target, settings.get('takeoverPauseHours'), 'owner command');
        return `Bot pausiert fuer ${arg} (${settings.get('takeoverPauseHours')}h).`;
      }
      case '/resume': {
        if (!target) return 'Nutzung: /resume <nummer>';
        resume(target);
        return `Bot wieder aktiv fuer ${arg}.`;
      }
      case '/off': {
        await settings.update({ botEnabled: false });
        return 'Bot ist global AUS. Mit /on wieder einschalten.';
      }
      case '/on': {
        await settings.update({ botEnabled: true });
        return 'Bot ist global AN.';
      }
      case '/status': {
        const paused = Object.entries(state).filter(([, v]) => v.pausedUntil > Date.now());
        const cat = services.catalog?.status?.();
        return [
          `Bot: ${settings.get('botEnabled') ? 'AN' : 'AUS'}`,
          `WhatsApp: ${client.getStatus().status}`,
          `Katalog: ${cat ? `${cat.count} Produkte` : 'nicht geladen'}`,
          `Kalender: ${setting('calendarId') ? 'eingerichtet' : 'fehlt'}`,
          `Pausierte Chats: ${paused.length}`,
          ...paused.map(([j, v]) => `  ${j.split('@')[0]} bis ${new Date(v.pausedUntil).toLocaleString('de-CH')}`),
        ].join('\n');
      }
      case '/help':
        return [
          'Befehle:',
          '/status            Uebersicht',
          '/pause <nummer>    Bot in einem Chat stoppen',
          '/resume <nummer>   Bot dort wieder starten',
          '/off  /on          Bot global aus / an',
          '',
          'Sprachbefehl: auf eine Benachrichtigung antworten (zitieren) und eine',
          'Sprachnachricht schicken, z.B. "Sag ihm, das Set ist am Samstag frei,',
          'auf Italienisch". Du bekommst eine Vorschau, mit "ok" wird gesendet.',
        ].join('\n');
      default:
        return null; // not a command: the owner is just writing
    }
  }

  // ---- Main entry -----------------------------------------------------------

  // ---- Owner input: commands and dictated replies ---------------------------

  async function handleOwnerInput(msg, jid, text) {
    if (text.startsWith('/')) {
      const reply = await handleOwnerCommand(jid, text);
      if (reply) await client.sendText(jid, reply);
      return;
    }

    // Answer to a preview?
    const pending = pendingReplies.get(jid);
    if (pending && Date.now() - pending.at > PENDING_TTL_MS) pendingReplies.delete(jid);
    if (pendingReplies.has(jid) && text && !hasAudio(msg)) {
      if (CONFIRM.test(text)) return sendPending(jid);
      if (CANCEL.test(text)) {
        pendingReplies.delete(jid);
        return client.sendText(jid, m().voiceCancelled);
      }
    }

    // A dictated reply is a voice note, or typed text quoting one of the bot's alerts.
    const quoted = quotedTextOf(msg);
    if (!hasAudio(msg) && !(text && quoted)) return; // the owner is just writing

    if (!voice) return client.sendText(jid, m().voiceNoAi);

    let instruction = text;
    try {
      if (hasAudio(msg)) {
        const buffer = await client.downloadMedia(msg);
        instruction = await voice.transcribe(buffer, msg.message.audioMessage?.mimetype);
      }
    } catch (err) {
      log.error(`Owner voice note could not be transcribed: ${err.message}`);
      return client.sendText(jid, m().voiceFailed(err.message));
    }

    // Who is it for: the customer in the quoted alert, or a number the owner said.
    let target = null;
    const fromQuote = numberIn(quoted);
    if (fromQuote) target = jidOf(fromQuote.number);
    if (!target) {
      const said = numberIn(instruction);
      if (said) {
        target = jidOf(said.number);
        instruction = instruction.replace(said.raw, ' ').trim();
      }
    }
    if (!target || isOwner(target) || isSelfChat(target)) return client.sendText(jid, m().voiceNoTarget);

    let composed;
    try {
      const lastIn = db.all('chat')
        .filter((c) => c.jid === target && c.direction === 'in')
        .sort((a, b) => String(a.at).localeCompare(String(b.at)))
        .pop();
      composed = await voice.composeOwnerReply(instruction, { lastCustomerText: lastIn?.text });
    } catch (err) {
      log.error(`Owner reply could not be composed: ${err.message}`);
      return client.sendText(jid, m().voiceFailed(err.message));
    }

    pendingReplies.set(jid, {
      target, message: composed.message, heard: instruction, langName: composed.languageName, at: Date.now(),
    });
    if (!settings.get('ownerVoicePreview')) return sendPending(jid);
    return client.sendText(jid, m().voicePreview(target, composed.languageName, instruction, composed.message));
  }

  async function sendPending(ownerJid) {
    const p = pendingReplies.get(ownerJid);
    pendingReplies.delete(ownerJid);
    if (!p) return;
    try {
      await client.sendText(p.target, p.message);
    } catch (err) {
      return client.sendText(ownerJid, m().voiceFailed(err.message));
    }
    remember(p.target, 'out', p.message);
    // A human is now talking in this chat: the bot must not answer over him.
    pause(p.target, settings.get('takeoverPauseHours'), 'owner voice reply');
    log.info(`Owner reply sent to ${p.target} (${p.langName})`);
    await client.sendText(ownerJid, m().voiceSent(p.target));
  }

  // ---- Main entry -----------------------------------------------------------

  async function handle(msg) {
    const jid = msg.key.remoteJid;
    let text = textOf(msg);
    contacts.remember(msg); // real phone number + WhatsApp name, for alerts and the dashboard

    // 0. The owner talking to the bot in its own chat (same number as the bot).
    if (msg.key.fromMe && isSelfChat(jid)) return handleOwnerInput(msg, jid, text);

    // 1. The owner answered a customer by hand from the phone -> step aside.
    if (msg.key.fromMe) {
      if (!isOwner(jid)) {
        pause(jid, settings.get('takeoverPauseHours'), 'owner replied manually');
      }
      return;
    }

    // 2. A message from the owner's own number: commands and dictated replies.
    if (isOwner(jid)) return handleOwnerInput(msg, jid, text);

    // 3. Everything else is a customer.
    //
    // Each of these ends the turn without answering. They used to do so with
    // nothing but a log line, which from the outside is indistinguishable from
    // the bot being broken. Every one of them now records the message, is
    // visible on the dashboard, and tells the owner a customer is waiting.
    if (!settings.get('botEnabled')) return skip(jid, text, 'bot_off');
    if (isPaused(jid)) return skip(jid, text, 'paused');
    if (!underRateLimit(jid)) return skip(jid, text, 'rate_limit');
    if (!agent) return skip(jid, text, 'no_agent');

    // A voice note: transcribe it and carry on as if the customer had typed it.
    let voiceMark = '';
    if (hasAudio(msg)) {
      try {
        if (!voice) throw new Error('voice is not set up');
        const buffer = await client.downloadMedia(msg);
        text = await voice.transcribe(buffer, msg.message.audioMessage?.mimetype);
        voiceMark = '\u{1F3A4} '; // tells the model (and the dashboard) it was spoken
        log.info(`Voice note from ${jid} transcribed (${text.length} chars)`);
      } catch (err) {
        log.error(`Voice note from ${jid} could not be transcribed: ${err.message}`);
        await client.sendText(jid, VOICE_UNREADABLE);
        remember(jid, 'in', '[Sprachnachricht]');
        remember(jid, 'out', VOICE_UNREADABLE);
        await notify.owner(m().customerVoiceFailed(jid), { kind: 'voice_failed', jid });
        return;
      }
    }

    // Belongs to the other business on this number: answer honestly, hand over,
    // and never let the model near it.
    if (matchesOtherBusiness(text, settings.get('otherBusinessKeywords'))) {
      const lang = /\b(the|and|is|how|can|hello|hi|you|do|your)\b/i.test(text) ? 'en' : 'de';
      const reply = settings.get(lang === 'en' ? 'otherBusinessReplyEn' : 'otherBusinessReplyDe');
      await client.sendText(jid, reply);
      remember(jid, 'in', text);
      remember(jid, 'out', reply);
      pause(jid, settings.get('takeoverPauseHours'), 'other business');
      await notify.owner(m().otherBusiness(jid, text), { kind: 'other_business', jid });
      log.info(`Message from ${jid} matched the other business - handed over`);
      return;
    }

    // A reference photo: accept it, store it, pass it to the owner.
    let photoNote = '';
    if (hasImage(msg)) {
      try {
        const buffer = await client.downloadImage(msg);
        const fileId = await db.putFile(`referenz-${Date.now()}.jpg`, 'image/jpeg', buffer);
        const customer = db.get('customers', jid);
        db.put('customers', {
          ...(customer || { jid, business, createdAt: new Date().toISOString() }),
          jid,
          phone: jid.split('@')[0],
          referencePhotoFileId: fileId,
          updatedAt: new Date().toISOString(),
        });
        await notify.owner(m().referencePhoto(jid, text), { kind: 'reference_photo', jid }, buffer);
        photoNote = '\n\n[Der Kunde hat ein Referenzbild geschickt. Es wurde gespeichert und ans Team weitergegeben.]';
      } catch (err) {
        log.error(`Could not handle the reference photo from ${jid}: ${err.message}`);
      }
    }

    if (!text && !photoNote) return;

    const history = recentHistory(jid);
    let out;
    try {
      out = await agent.reply({
        history,
        message: voiceMark + (text || '[Bild ohne Text]') + photoNote,
        services,
        chatId: jid,
        customerName: db.get('customers', jid)?.name,
      });
    } catch (err) {
      // The AI failed (bad key, quota, outage). The customer must not be left in
      // silence: say something honest, hand the chat to a human, and tell the
      // owner once rather than on every message.
      await handleAiFailure(jid, text, err);
      return;
    }

    await client.sendText(jid, out.text);
    remember(jid, 'in', voiceMark + (text || '[Bild]'));
    remember(jid, 'out', out.text);

    if (out.handoff) {
      pause(jid, settings.get('takeoverPauseHours'), 'handoff to human');
      // The handoff_to_human tool already alerted the owner with its own reason.
      // Sending a second, vaguer alert for the same event just doubles the noise.
      const toolAlreadyTold = (out.toolCalls || []).some((c) => c.name === 'handoff_to_human');
      if (out.stepLimit) {
        // Not a normal handover: the model could not finish. Say what it was doing.
        const failed = (out.toolCalls || [])
          .filter((c) => c.result?.ok === false)
          .map((c) => `${c.name}: ${c.result.error}`)
          .join('\n');
        await notify.owner(m().stepLimit(jid, text, failed), { kind: 'step_limit', jid });
      } else if (!toolAlreadyTold) {
        await notify.owner(m().handoff(jid, text), { kind: 'handoff', jid });
      }
    }
    if (out.blocked) {
      await notify.owner(
        m().guardBlocked(out.violations.map((v) => v.code).join(', '), jid),
        { kind: 'guard_blocked', jid }
      );
    }
  }

  // ---- A message the bot deliberately did not answer -------------------------

  const skipped = { last: null, counts: {}, notifiedAt: {} };
  const SKIP_NOTIFY_EVERY_MS = 10 * 60 * 1000;

  /**
   * A customer wrote and the bot stayed quiet on purpose. The message is still
   * recorded, so whoever picks the chat up sees it, and the owner is nudged,
   * because in every one of these cases a real person is waiting for a human.
   */
  async function skip(jid, text, reason) {
    const explanation = m().skipReasons[reason] || reason;
    skipped.last = { jid, reason, at: new Date().toISOString(), text: String(text || '').slice(0, 120) };
    skipped.counts[reason] = (skipped.counts[reason] || 0) + 1;
    log.info(`Not answering ${jid}: ${reason} - ${explanation}`);

    if (text) remember(jid, 'in', text); // never lose what the customer said

    // "paused" is the normal case after a handover and the owner already knows,
    // so it is nudged rarely; the others mean something is actually wrong.
    const key = `${reason}:${jid}`;
    const now = Date.now();
    if (now - (skipped.notifiedAt[key] || 0) < SKIP_NOTIFY_EVERY_MS) return;
    skipped.notifiedAt[key] = now;

    await notify.owner(m().customerWaiting(explanation, jid, text), { kind: 'skipped', reason, jid });
  }

  // ---- When the AI itself fails ---------------------------------------------

  const aiHealth = { lastError: null, lastErrorAt: null, lastNotifiedAt: 0, count: 0 };
  const NOTIFY_EVERY_MS = 15 * 60 * 1000;

  const AI_DOWN = {
    de: 'Sorry, bei mir klemmt es gerade technisch. Ich habe jemandem aus dem Team Bescheid gegeben, du hoerst gleich von uns.',
    en: 'Sorry, I am having a technical problem right now. I have told a colleague, you will hear from us shortly.',
  };

  async function handleAiFailure(jid, text, err) {
    const status = err?.status || err?.response?.status || null;
    const message = String(err?.message || err);

    aiHealth.lastError = status ? `${status}: ${message}` : message;
    aiHealth.lastErrorAt = new Date().toISOString();
    aiHealth.count += 1;
    log.error(`AI call failed for ${jid}: ${aiHealth.lastError}`);

    const lang = /\b(the|and|is|how|can|hello|hi|you|do|your|price|book)\b/i.test(String(text || ''))
      ? 'en'
      : 'de';

    try {
      await client.sendText(jid, AI_DOWN[lang]);
      remember(jid, 'in', text || '[Bild]');
      remember(jid, 'out', AI_DOWN[lang]);
    } catch (sendErr) {
      log.error(`Could not even send the fallback to ${jid}: ${sendErr.message}`);
    }

    // A human has to take this conversation over.
    pause(jid, settings.get('takeoverPauseHours'), 'ai failure');

    // An invalid key fails on every single message. Telling the owner each time
    // would bury the chat it is meant to rescue.
    const now = Date.now();
    if (now - aiHealth.lastNotifiedAt > NOTIFY_EVERY_MS) {
      aiHealth.lastNotifiedAt = now;
      const t = m();
      const hint = t.aiHints[status] || t.aiHints.other;
      await notify.owner(t.aiDown(hint, aiHealth.lastError, aiHealth.count, jid), { kind: 'ai_failure', jid });
    }
  }

  // ---- Conversation history -------------------------------------------------

  const MAX_TURNS = 20;

  function remember(jid, direction, text) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.put('chat', { id, business, at: new Date().toISOString(), jid, direction, text: String(text).slice(0, 4000) });
  }

  function recentHistory(jid) {
    return db
      .all('chat')
      .filter((m) => m.jid === jid)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .slice(-MAX_TURNS)
      .map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.text }));
  }

  return {
    handle,
    aiHealth: () => ({ ...aiHealth }),
    skipped: () => ({ ...skipped, notifiedAt: undefined }),
    init() {
      state = loadState(business);
      log.info(`Router ready (${Object.keys(state).length} known chats)`);
    },
    isPaused,
    pause,
    resume,
    listPaused: () =>
      Object.entries(state)
        .filter(([, v]) => v.pausedUntil > Date.now())
        .map(([jid, v]) => ({ jid, until: new Date(v.pausedUntil).toISOString(), reason: v.reason })),
    _textOf: textOf,
  };
}

module.exports = {
  createRouter, textOf, hasImage, hasAudio, quotedTextOf, numberIn, jidOf, digits, matchesOtherBusiness, flatten,
};
