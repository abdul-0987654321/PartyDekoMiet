'use strict';
/**
 * WhatsApp connection (Baileys). Reuses the connection lifecycle of the original demo
 * (QR as image, reconnect with backoff), with the session stored in Google Sheets.
 *
 * Ban-risk rules enforced here:
 *  - only private chats are handled (groups, status, broadcasts, newsletters ignored)
 *  - the bot never starts a conversation; send() is only called in reply to a customer
 *    or after an admin decision on that customer's own payment
 *  - plain text only, with a random 2–5 s "typing…" delay before every message
 */

const {
  default: makeWASocket,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} = require('@itsliaaa/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const log = require('../log');
const settings = require('../settings');
const { useSheetAuthState, clearSession, hasSession } = require('./auth-state');

const baileysLogger = pino({ level: 'silent' });

const runtime = {
  sock: null,
  status: 'stopped', // stopped | starting | qr | connected | reconnecting | replaced
  qrDataUrl: null,
  me: null,
  connectedAt: null,
  lastDisconnect: null,
  reconnectAttempts: 0,
  stopping: false,
  starting: false,
};

let messageHandler = async () => {};
function onMessage(fn) {
  messageHandler = fn;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONNECT_WATCHDOG_MS = 60000;
const typingDelay = () => {
  const min = Number(settings.get('typingMinMs')) || 0;
  const max = Math.max(min, Number(settings.get('typingMaxMs')) || min);
  return min + Math.floor(Math.random() * (max - min + 1));
};

function isConnected() {
  return runtime.status === 'connected' && Boolean(runtime.sock);
}

function getStatus() {
  return {
    status: runtime.status,
    connected: isConnected(),
    qrDataUrl: runtime.status === 'qr' ? runtime.qrDataUrl : null,
    me: runtime.me,
    connectedAt: runtime.connectedAt,
    lastDisconnect: runtime.lastDisconnect,
    hasStoredSession: hasSession(),
  };
}

/** Sends a plain text message after showing "typing…" for 2–5 seconds. */
async function sendText(jid, text) {
  const sock = runtime.sock;
  if (!sock || !isConnected()) throw new Error('WhatsApp ist nicht verbunden');
  try {
    await sock.presenceSubscribe(jid).catch(() => {});
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(typingDelay());
    await sock.sendPresenceUpdate('paused', jid);
  } catch (err) {
    log.warn(`Typing indicator failed for ${jid}: ${err.message}`);
  }
  const sent = await sock.sendMessage(jid, { text });
  rememberOwnMessage(sent?.key?.id);
  return sent;
}

/** Sends an image with a caption (product pictures). */
async function sendImage(jid, imageUrl, caption) {
  const sock = runtime.sock;
  if (!sock || !isConnected()) throw new Error('WhatsApp ist nicht verbunden');
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(typingDelay());
    await sock.sendPresenceUpdate('paused', jid);
  } catch (err) {
    log.warn(`Typing indicator failed for ${jid}: ${err.message}`);
  }
  const sent = await sock.sendMessage(jid, { image: { url: imageUrl }, caption: caption || undefined });
  rememberOwnMessage(sent?.key?.id);
  return sent;
}

/** Forwards an image buffer (e.g. a customer's reference photo) to someone. */
async function forwardImage(jid, buffer, caption, mimetype = 'image/jpeg') {
  const sock = runtime.sock;
  if (!sock || !isConnected()) throw new Error('WhatsApp ist nicht verbunden');
  const sent = await sock.sendMessage(jid, { image: buffer, caption: caption || undefined, mimetype });
  rememberOwnMessage(sent?.key?.id);
  return sent;
}

/**
 * Ids of messages this process sent. When WhatsApp echoes them back as fromMe we
 * must not mistake them for the owner typing by hand - that would make the bot
 * pause itself after every reply.
 */
const ownMessageIds = new Set();
function rememberOwnMessage(id) {
  if (!id) return;
  ownMessageIds.add(id);
  if (ownMessageIds.size > 500) {
    for (const old of ownMessageIds) {
      ownMessageIds.delete(old);
      if (ownMessageIds.size <= 400) break;
    }
  }
}
function isOwnMessage(id) {
  return Boolean(id) && ownMessageIds.has(id);
}

async function markRead(msg) {
  try {
    await runtime.sock?.readMessages([msg.key]);
  } catch (err) {
    log.warn(`Could not mark message as read: ${err.message}`);
  }
}

async function downloadImage(msg) {
  return downloadMediaMessage(msg, 'buffer', {}, { logger: baileysLogger, reuploadRequest: runtime.sock.updateMediaMessage });
}

function isPrivateChat(jid) {
  return typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));
}

function detachSocket() {
  const sock = runtime.sock;
  runtime.sock = null;
  if (!sock) return;
  try { sock.ev.removeAllListeners(); } catch {}
  try { sock.end(undefined); } catch {}
}

function scheduleReconnect(reason) {
  runtime.reconnectAttempts += 1;
  runtime.status = 'reconnecting';
  const delay = Math.min(60000, 2000 * runtime.reconnectAttempts);
  log.warn(`WhatsApp disconnected (${reason}). Reconnecting in ${delay / 1000}s (attempt ${runtime.reconnectAttempts})`);
  setTimeout(() => {
    if (!runtime.stopping) void start();
  }, delay).unref?.();
}

async function start() {
  if (runtime.starting) return { ok: false, message: 'Verbindung wird bereits aufgebaut…' };
  if (isConnected()) return { ok: true, message: 'Bereits verbunden.' };
  runtime.starting = true;
  runtime.stopping = false;
  runtime.status = 'starting';
  try {
    detachSocket();
    const { state, saveCreds } = useSheetAuthState();
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      version = undefined; // fall back to the library's built-in version
    }
    log.info(`Starting WhatsApp connection (${hasSession() ? 'stored session' : 'new session, QR needed'})`);
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
      logger: baileysLogger,
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
    });
    runtime.sock = sock;

    // Baileys can hang silently when the WebSocket never opens (no error, no close event).
    // If we have neither a QR code nor a connection after a minute, tear down and retry.
    setTimeout(() => {
      if (runtime.sock === sock && runtime.status === 'starting') {
        runtime.lastDisconnect = { at: new Date().toISOString(), code: null, message: 'Verbindungsaufbau hängt (Timeout)' };
        detachSocket();
        scheduleReconnect('connect timeout');
      }
    }, CONNECT_WATCHDOG_MS).unref?.();

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (runtime.sock !== sock) return; // event from an old socket
      if (qr) {
        runtime.status = 'qr';
        try {
          runtime.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
          log.info('New QR code available on the dashboard (WhatsApp-Status).');
        } catch (err) {
          log.error(`QR render failed: ${err.message}`);
        }
      }
      if (connection === 'open') {
        runtime.status = 'connected';
        runtime.qrDataUrl = null;
        runtime.reconnectAttempts = 0;
        runtime.connectedAt = new Date().toISOString();
        runtime.me = { id: sock.user?.id || null, name: sock.user?.name || sock.user?.verifiedName || null };
        log.info(`WhatsApp connected as ${runtime.me.name || ''} ${runtime.me.id || ''}`);
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const message = lastDisconnect?.error?.message || 'unknown';
        runtime.lastDisconnect = { at: new Date().toISOString(), code: code ?? null, message };
        runtime.qrDataUrl = null;
        runtime.connectedAt = null;
        detachSocket();
        if (runtime.stopping) {
          runtime.status = 'stopped';
          return;
        }
        if (code === DisconnectReason.loggedOut) {
          log.warn('WhatsApp session logged out (device removed). Clearing stored session — scan a new QR on the dashboard.');
          await clearSession();
          runtime.reconnectAttempts = 0;
          setTimeout(() => void start(), 1000).unref?.();
          return;
        }
        if (code === DisconnectReason.connectionReplaced) {
          // Another instance (e.g. the new Render deploy) took over this session — don't fight it.
          runtime.status = 'replaced';
          log.warn('WhatsApp connection replaced by another instance; not reconnecting.');
          return;
        }
        if (code === DisconnectReason.restartRequired) {
          log.info('WhatsApp requested a restart (normal after QR scan). Reconnecting now.');
          setTimeout(() => void start(), 500).unref?.();
          return;
        }
        scheduleReconnect(`code ${code ?? '?'}: ${message}`);
      }
    });

    sock.ev.on('messages.upsert', ({ type, messages }) => {
      if (type !== 'notify') return;
      for (const msg of messages || []) {
        const jid = msg.key?.remoteJid;
        if (!msg.message || !isPrivateChat(jid)) continue;

        // An echo of something we sent ourselves: nothing to do.
        if (msg.key.fromMe && isOwnMessage(msg.key.id)) continue;

        void (async () => {
          if (!msg.key.fromMe) await markRead(msg);
          try {
            await messageHandler(msg);
          } catch (err) {
            log.error(`Handling message from ${jid} failed: ${err.stack || err.message}`);
          }
        })();
      }
    });

    return { ok: true, message: 'Verbindung wird aufgebaut.' };
  } catch (err) {
    log.error(`WhatsApp start failed: ${err.message}`);
    scheduleReconnect(err.message);
    return { ok: false, message: err.message };
  } finally {
    runtime.starting = false;
  }
}

async function stop() {
  runtime.stopping = true;
  detachSocket();
  runtime.status = 'stopped';
  runtime.qrDataUrl = null;
  runtime.connectedAt = null;
}

/** Logs out (unlinks the device) and starts again with a fresh QR code. */
async function logoutAndRelink() {
  try {
    await runtime.sock?.logout();
  } catch (err) {
    log.warn(`Logout failed: ${err.message}`);
  }
  await stop();
  await clearSession();
  runtime.stopping = false;
  return start();
}

module.exports = {
  start, stop, logoutAndRelink, getStatus, isConnected, onMessage,
  sendText, sendImage, forwardImage, downloadImage, isPrivateChat, isOwnMessage,
};
