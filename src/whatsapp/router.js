'use strict';
/**
 * Decides what happens with every incoming WhatsApp message.
 *
 *   owner's own number  -> commands (/pause, /resume, /status, /on, /off)
 *   owner typing in a customer chat from the phone -> pause the bot there
 *   customer            -> agent reply, unless that chat is paused
 *
 * Group chats, status updates and broadcasts never get here: client.js drops
 * anything that is not a private chat.
 */

const log = require('../log');
const db = require('../store/db');
const settings = require('../settings');

const STATE_KEY = 'chatstate'; // { [jid]: { pausedUntil, reason, count:[ts,...] } }

function loadState() {
  try {
    const row = db.get('state', STATE_KEY);
    return row?.value ? JSON.parse(row.value) : {};
  } catch {
    return {};
  }
}
function saveState(state) {
  db.put('state', { key: STATE_KEY, value: JSON.stringify(state) });
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

function createRouter({ client, agent, services, notify, knowledge }) {
  let state = {};

  const isOwner = (jid) => {
    const owner = digits(settings.get('ownerWhatsapp'));
    return Boolean(owner) && digits(jid).startsWith(owner);
  };

  function pause(jid, hours, reason) {
    state[jid] = { ...(state[jid] || {}), pausedUntil: Date.now() + hours * 3600 * 1000, reason };
    saveState(state);
    log.info(`Bot paused for ${jid} for ${hours}h (${reason})`);
  }

  function resume(jid) {
    if (state[jid]) {
      delete state[jid].pausedUntil;
      delete state[jid].reason;
      saveState(state);
    }
    log.info(`Bot resumed for ${jid}`);
  }

  function isPaused(jid) {
    const until = state[jid]?.pausedUntil;
    return Boolean(until && until > Date.now());
  }

  /** Per-chat hourly cap, so a loop or a troll cannot burn the OpenAI budget. */
  function underRateLimit(jid) {
    const max = Number(settings.get('maxMsgsPerChatPerHour')) || 30;
    const cutoff = Date.now() - 3600 * 1000;
    const entry = (state[jid] = state[jid] || {});
    entry.count = (entry.count || []).filter((t) => t > cutoff);
    if (entry.count.length >= max) return false;
    entry.count.push(Date.now());
    saveState(state);
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
          `Kalender: ${settings.get('calendarId') ? 'eingerichtet' : 'fehlt'}`,
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
        ].join('\n');
      default:
        return null; // not a command: the owner is just writing
    }
  }

  // ---- Main entry -----------------------------------------------------------

  async function handle(msg) {
    const jid = msg.key.remoteJid;
    const text = textOf(msg);

    // 1. The owner answered a customer by hand from the phone -> step aside.
    if (msg.key.fromMe) {
      if (!isOwner(jid)) {
        pause(jid, settings.get('takeoverPauseHours'), 'owner replied manually');
      }
      return;
    }

    // 2. A message from the owner's own number: commands.
    if (isOwner(jid)) {
      const reply = text.startsWith('/') ? await handleOwnerCommand(jid, text) : null;
      if (reply) await client.sendText(jid, reply);
      return;
    }

    // 3. Everything else is a customer.
    if (!settings.get('botEnabled')) {
      log.info(`Bot is off, ignoring message from ${jid}`);
      return;
    }
    if (isPaused(jid)) {
      log.info(`Chat ${jid} is paused, not replying`);
      return;
    }
    if (!underRateLimit(jid)) {
      log.warn(`Rate limit reached for ${jid}, not replying`);
      return;
    }
    if (!agent) {
      log.error('No agent configured (OPENAI_API_KEY missing) - cannot reply');
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
          ...(customer || { jid, createdAt: new Date().toISOString() }),
          jid,
          phone: jid.split('@')[0],
          referencePhotoFileId: fileId,
          updatedAt: new Date().toISOString(),
        });
        await notify.owner(
          `Referenzbild von ${jid.split('@')[0]}${text ? `\nText: ${text}` : ''}`,
          { kind: 'reference_photo', jid },
          buffer
        );
        photoNote = '\n\n[Der Kunde hat ein Referenzbild geschickt. Es wurde gespeichert und ans Team weitergegeben.]';
      } catch (err) {
        log.error(`Could not handle the reference photo from ${jid}: ${err.message}`);
      }
    }

    if (!text && !photoNote) return;

    const history = recentHistory(jid);
    const out = await agent.reply({
      history,
      message: (text || '[Bild ohne Text]') + photoNote,
      services,
      chatId: jid,
      customerName: db.get('customers', jid)?.name,
    });

    await client.sendText(jid, out.text);
    remember(jid, 'in', text || '[Bild]');
    remember(jid, 'out', out.text);

    if (out.handoff) {
      pause(jid, settings.get('takeoverPauseHours'), 'handoff to human');
      await notify.owner(
        `Uebergabe noetig im Chat mit ${jid.split('@')[0]}\nLetzte Nachricht: ${text}`,
        { kind: 'handoff', jid }
      );
    }
    if (out.blocked) {
      await notify.owner(
        `Eine Antwort wurde von den Regeln blockiert (${out.violations.map((v) => v.code).join(', ')}).\n` +
          `Chat: ${jid.split('@')[0]}`,
        { kind: 'guard_blocked', jid }
      );
    }
  }

  // ---- Conversation history -------------------------------------------------

  const MAX_TURNS = 20;

  function remember(jid, direction, text) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.put('chat', { id, at: new Date().toISOString(), jid, direction, text: String(text).slice(0, 4000) });
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
    init() {
      state = loadState();
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

module.exports = { createRouter, textOf, hasImage, jidOf, digits };
