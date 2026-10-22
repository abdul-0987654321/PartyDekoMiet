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
 *
 * This is a factory (createWhatsAppClient(business)) because the Studio gets its own
 * WhatsApp number, which means its own Baileys socket, QR code and connection state -
 * two businesses cannot share one `runtime`. The module's default export is still a
 * ready-made Party instance (business='party'), so every existing
 * `require('./whatsapp/client')` call site is completely unaffected; Studio is wired
 * up by calling `createWhatsAppClient('studio')` for a second, independent instance.
 */

const baileys = require('@itsliaaa/baileys');

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} = baileys;

const QRCode = require('qrcode');
const pino = require('pino');
const log = require('../log');
const settings = require('../settings');
const { useSheetAuthState, clearSession, hasSession } = require('./auth-state');
const { resolveWaVersion } = require('./wa-version');
const { browserTriple, deviceLabel } = require('./device');

// Reads the build web.whatsapp.com is actually serving, instead of the Baileys
// repo's hardcoded list - see wa-version.js for why that matters. Resolved
// defensively so an older fork without the export still loads; resolveWaVersion()
// simply skips a missing fetcher.
const fetchLatestWaWebVersion =
  baileys.fetchLatestWaWebVersion || baileys.default?.fetchLatestWaWebVersion || null;

const baileysLogger = pino({ level: 'silent' });

/** @param {'party'|'studio'} [business] defaults to 'party' - existing callers are unaffected. */
function createWhatsAppClient(business = 'party') {
  const logTag = business === 'studio' ? '[studio] ' : '';
  const deviceTriple = browserTriple({ business });

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
    // Pairing-code login: the owner types the bot's own phone number and gets an
    // 8-character code to enter on the phone, instead of scanning a QR image.
    pairingRequest: null, // phone number waiting for a code
    pairingCode: null,
    pairingError: null,
  };

  let messageHandler = async () => {};
  function onMessage(fn) {
    messageHandler = fn;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CONNECT_WATCHDOG_MS = 60000;
  // A rejected handshake (e.g. code 405) used to retry forever, capped at one try
  // per 60s. Over a day that is 1000+ fresh-login attempts hammering WhatsApp's
  // servers from the same IP/number, which looks like abuse and likely makes a
  // transient block worse instead of letting it clear. After this many CONSECUTIVE
  // failed attempts (reset by any real progress: a QR shown, a connect, or the
  // owner clicking "Connect"/"Re-link" by hand), automatic retries stop and the
  // dashboard asks for a manual retry instead.
  const MAX_AUTO_RECONNECTS = 10;

  /**
   * Which protocol version to announce. The whole 405 story and the ordering
   * live in wa-version.js; this just adds the per-business log prefix.
   */
  async function resolveVersion() {
    const { version } = await resolveWaVersion({
      fetchWaWeb: fetchLatestWaWebVersion,
      fetchBaileys: fetchLatestBaileysVersion,
      log: {
        info: (msg) => log.info(`${logTag}${msg}`),
        warn: (msg) => log.warn(`${logTag}${msg}`),
      },
    });
    return version;
  }

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
      qrDataUrl: runtime.status === 'qr' || runtime.status === 'pairing' ? runtime.qrDataUrl : null,
      pairingCode: runtime.pairingCode,
      pairingNumber: runtime.pairingRequest,
      pairingError: runtime.pairingError,
      me: runtime.me,
      connectedAt: runtime.connectedAt,
      lastDisconnect: runtime.lastDisconnect,
      hasStoredSession: hasSession(business),
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
      log.warn(`${logTag}Typing indicator failed for ${jid}: ${err.message}`);
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
      log.warn(`${logTag}Typing indicator failed for ${jid}: ${err.message}`);
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

  /**
   * Marks a message as read after a short pause rather than instantly.
   *
   * The whole exchange then reads as a person: the tick appears after about a
   * second, "typing..." runs for a few seconds, and the reply lands around four
   * seconds in. An instant read receipt followed by an instant answer is one of
   * the patterns that makes an account look automated.
   */
  async function markRead(msg) {
    try {
      const delay = Number(settings.get('readDelayMs'));
      if (delay > 0) await sleep(delay);
      await runtime.sock?.readMessages([msg.key]);
    } catch (err) {
      log.warn(`${logTag}Could not mark message as read: ${err.message}`);
    }
  }

  async function downloadImage(msg) {
    return downloadMediaMessage(msg, 'buffer', {}, { logger: baileysLogger, reuploadRequest: runtime.sock.updateMediaMessage });
  }

  /** Any media (image, voice note) as a Buffer. */
  const downloadMedia = downloadImage;

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
    if (runtime.reconnectAttempts > MAX_AUTO_RECONNECTS) {
      runtime.status = 'blocked';
      runtime.lastDisconnect = {
        at: new Date().toISOString(),
        code: runtime.lastDisconnect?.code ?? null,
        message: `${reason} — ${runtime.reconnectAttempts - 1} attempts in a row rejected. Automatic retries stopped so the number doesn't get flagged further. Wait a few hours, then click "Connect" to try again.`,
      };
      log.error(
        `${logTag}WhatsApp rejected ${runtime.reconnectAttempts - 1} connection attempts in a row (${reason}). ` +
          'Stopping automatic retries - click "Connect" on the dashboard to try again after a few hours.'
      );
      return;
    }
    runtime.status = 'reconnecting';
    const delay = Math.min(60000, 2000 * runtime.reconnectAttempts);
    log.warn(`${logTag}WhatsApp disconnected (${reason}). Reconnecting in ${delay / 1000}s (attempt ${runtime.reconnectAttempts})`);
    setTimeout(() => {
      if (!runtime.stopping) void start(true);
    }, delay).unref?.();
  }

  /**
   * @param {boolean} auto true only when called internally by the reconnect
   * scheduler's own setTimeout. Any other caller (dashboard "Connect"/"Re-link",
   * boot, a pairing retry, or the post-QR-scan restart WhatsApp itself asks for)
   * means real progress or a deliberate manual attempt, so the failure counter
   * resets - that's what lets the owner break out of a "blocked" state by hand.
   */
  async function start(auto = false) {
    if (runtime.starting) return { ok: false, message: 'Verbindung wird bereits aufgebaut…' };
    if (isConnected()) return { ok: true, message: 'Bereits verbunden.' };
    if (!auto) runtime.reconnectAttempts = 0;
    runtime.starting = true;
    runtime.stopping = false;
    runtime.status = 'starting';
    try {
      detachSocket();
      const { state, saveCreds } = useSheetAuthState(business);
      const version = await resolveVersion();
      log.info(
        `${logTag}Starting WhatsApp connection (${hasSession(business) ? 'stored session' : 'new session, QR needed'}, ` +
          `protocol ${version ? version.join('.') : 'library default'}, as "${deviceLabel(deviceTriple)}")`
      );
      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
        logger: baileysLogger,
        // See device.js: the first slot must be a real OS name or pairing by
        // phone number is rejected, however harmless a custom one looks.
        browser: deviceTriple,
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
          // Real progress: the handshake got far enough for WhatsApp to hand us a
          // QR, so the consecutive-failure counter no longer applies.
          runtime.reconnectAttempts = 0;
          // The QR is always rendered, so the owner can choose either way to log in.
          try {
            runtime.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
          } catch (err) {
            log.error(`${logTag}QR render failed: ${err.message}`);
          }

          // A pairing code was asked for: the socket is now open and unregistered,
          // which is the only moment WhatsApp accepts the request.
          if (runtime.pairingRequest && !runtime.pairingCode) {
            const number = runtime.pairingRequest;
            try {
              const code = await sock.requestPairingCode(number);
              runtime.pairingCode = String(code).toUpperCase();
              runtime.pairingError = null;
              runtime.status = 'pairing';
              log.info(`${logTag}Pairing code for ${number}: ${runtime.pairingCode}`);
            } catch (err) {
              runtime.pairingError = err.message;
              runtime.pairingRequest = null;
              runtime.status = 'qr';
              log.error(`${logTag}Pairing code request failed for ${number}: ${err.message}`);
            }
          } else if (runtime.status !== 'pairing') {
            runtime.status = 'qr';
            log.info(`${logTag}New QR code available on the dashboard.`);
          }
        }
        if (connection === 'open') {
          runtime.status = 'connected';
          runtime.qrDataUrl = null;
          runtime.pairingRequest = null;
          runtime.pairingCode = null;
          runtime.pairingError = null;
          runtime.reconnectAttempts = 0;
          runtime.connectedAt = new Date().toISOString();
          runtime.me = {
            id: sock.user?.id || null,
            lid: sock.user?.lid || null, // the self-chat can arrive under the LID
            name: sock.user?.name || sock.user?.verifiedName || null,
          };
          log.info(`${logTag}WhatsApp connected as ${runtime.me.name || ''} ${runtime.me.id || ''}`);
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
          // A pairing code only lives as long as the socket that issued it. If
          // that socket dies before the owner finishes typing, the code on the
          // dashboard is already dead - and leaving it there is what made this
          // look like "the code is always wrong". Ask for a fresh one instead.
          if (runtime.pairingRequest && runtime.pairingCode) {
            log.warn(
              `${logTag}Pairing attempt ended before it completed (code ${code ?? '?'}: ${message}). ` +
                `The code ${runtime.pairingCode} is no longer valid - requesting a new one.`
            );
            runtime.pairingCode = null;
            runtime.pairingError = null;
            if (code === DisconnectReason.loggedOut) await clearSession(business);
            runtime.reconnectAttempts = 0;
            setTimeout(() => void start(), 1000).unref?.();
            return;
          }

          if (code === DisconnectReason.loggedOut) {
            log.warn(`${logTag}WhatsApp session logged out (device removed). Clearing stored session — scan a new QR on the dashboard.`);
            await clearSession(business);
            runtime.reconnectAttempts = 0;
            setTimeout(() => void start(), 1000).unref?.();
            return;
          }
          if (code === DisconnectReason.connectionReplaced) {
            // Another instance (e.g. the new Render deploy) took over this session — don't fight it.
            runtime.status = 'replaced';
            log.warn(`${logTag}WhatsApp connection replaced by another instance; not reconnecting.`);
            return;
          }
          if (code === DisconnectReason.restartRequired) {
            log.info(`${logTag}WhatsApp requested a restart (normal after QR scan). Reconnecting now.`);
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
              log.error(`${logTag}Handling message from ${jid} failed: ${err.stack || err.message}`);
            }
          })();
        }
      });

      return { ok: true, message: 'Verbindung wird aufgebaut.' };
    } catch (err) {
      log.error(`${logTag}WhatsApp start failed: ${err.message}`);
      scheduleReconnect(err.message);
      return { ok: false, message: err.message };
    } finally {
      runtime.starting = false;
    }
  }

  /**
   * Logs in with a pairing code instead of a QR image.
   *
   * WhatsApp only hands out a code while the socket is open and not yet
   * registered, so the connection is restarted and the code is requested from the
   * connection handler at exactly that moment. The owner then enters it on the
   * phone under Linked devices > Link with phone number instead.
   *
   * @param {string} phoneNumber the BOT's own number, international, digits only
   */
  async function startPairing(phoneNumber) {
    const number = String(phoneNumber || '').replace(/[^0-9]/g, '');
    if (number.length < 8 || number.length > 15) {
      return { ok: false, message: 'Bitte die Nummer international und nur mit Ziffern angeben, z.B. 41791234567.' };
    }
    if (isConnected()) {
      return { ok: false, message: 'WhatsApp ist bereits verbunden. Zuerst "Neu verknuepfen" waehlen.' };
    }

    runtime.pairingRequest = number;
    runtime.pairingCode = null;
    runtime.pairingError = null;

    // A fresh socket is needed: a code can only be requested on an unregistered
    // one. Stored credentials make the new socket resume the OLD device instead,
    // which WhatsApp then drops as logged out - so the owner sees a code that
    // can never work. Asking for a code is always a deliberate re-link, so
    // dropping the stored session here is what they asked for.
    runtime.stopping = true;
    detachSocket();
    await clearSession(business);
    runtime.stopping = false;
    runtime.reconnectAttempts = 0;

    const res = await start();
    return { ok: res.ok !== false, message: 'Code wird angefordert, bitte einen Moment...', number };
  }

  /** Goes back to QR login and drops a pending pairing request. */
  function cancelPairing() {
    runtime.pairingRequest = null;
    runtime.pairingCode = null;
    runtime.pairingError = null;
    if (runtime.status === 'pairing') runtime.status = 'qr';
    return { ok: true };
  }

  async function stop() {
    runtime.stopping = true;
    detachSocket();
    runtime.status = 'stopped';
    runtime.qrDataUrl = null;
    runtime.connectedAt = null;
    runtime.pairingRequest = null;
    runtime.pairingCode = null;
  }

  /** Logs out (unlinks the device) and starts again with a fresh QR code. */
  async function logoutAndRelink() {
    try {
      await runtime.sock?.logout();
    } catch (err) {
      log.warn(`${logTag}Logout failed: ${err.message}`);
    }
    await stop();
    await clearSession(business);
    runtime.stopping = false;
    return start();
  }

  return {
    business,
    start, stop, logoutAndRelink, getStatus, isConnected, onMessage,
    sendText, sendImage, forwardImage, downloadImage, downloadMedia, isPrivateChat, isOwnMessage,
    startPairing, cancelPairing,
  };
}

// Default export: a ready-made Party instance, so every existing
// `require('./whatsapp/client')` call site behaves exactly as before.
const partyClient = createWhatsAppClient('party');

module.exports = { ...partyClient, createWhatsAppClient };
