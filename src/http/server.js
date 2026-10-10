'use strict';
/**
 * HTTP surface.
 *
 *   GET  /health                  open, always 200 while the process runs.
 *                                 Render's health check and UptimeRobot hit this;
 *                                 on the free plan that ping also keeps the
 *                                 instance from spinning down.
 *   GET  /login                   password form
 *   GET  /  /settings  /whatsapp  /bookings     dashboard pages (login required)
 *   GET  /api/status              service state
 *   GET  /api/settings            schema + current values
 *   POST /api/settings            save changes
 *   POST /api/settings/reset      drop one override
 *   GET  /api/whatsapp            connection state + QR code
 *   POST /api/whatsapp/connect    start / retry the connection
 *   POST /api/whatsapp/relink     log out and show a fresh QR
 *   GET  /api/bookings            booking requests
 *   POST /api/catalog/refresh     re-read the shop now
 */

const path = require('path');
const express = require('express');
const log = require('../log');
const auth = require('./auth');
const db = require('../store/db');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

function createServer({ config, state, whatsapp = null, settings = null, runtime = {}, catalog = null }) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(PUBLIC_DIR, { index: false }));

  const safe = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      log.error(`API error on ${req.method} ${req.path}: ${err.stack || err.message}`);
      if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
    });
  };

  // ---- Health: open, and carries nothing secret. ----
  app.get('/health', (req, res) => {
    res.status(200).json({
      ok: true,
      service: 'partydekomiet-bot',
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: state.startedAt,
      ready: state.ready,
      whatsapp: whatsapp ? whatsapp.getStatus().status : 'not-wired',
      storage: db.status(),
    });
  });

  // ---- Login ----
  app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
  app.post('/login', (req, res) => {
    if (auth.login(req, res)) return res.redirect('/');
    return res.redirect('/login?fehler=1');
  });
  app.post('/logout', (req, res) => {
    auth.logout(res);
    res.redirect('/login');
  });

  // ---- Everything below needs the dashboard password ----
  app.use(auth.requireLogin);

  const page = (file) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, file));
  app.get('/', page('status.html'));
  app.get('/settings', page('settings.html'));
  app.get('/whatsapp', page('whatsapp.html'));
  app.get('/bookings', page('bookings.html'));

  app.get('/api/status', (req, res) => {
    const s = settings ? settings.all() : {};
    res.json({
      ok: true,
      ready: state.ready,
      startedAt: state.startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      storage: db.status(),
      storageError: state.storageError,
      storageWarning: state.storageWarning,
      calendarError: state.calendarError,
      bootError: state.bootError,
      knowledge: state.knowledge,
      catalog: catalog ? catalog.status() : null,
      whatsapp: whatsapp ? whatsapp.getStatus() : { status: 'not-wired' },
      pausedChats: runtime.router ? runtime.router.listPaused() : [],
      lang: s.dashboardLanguage || 'de',
      config: {
        model: config.openai?.model,
        hasOpenAiKey: Boolean(config.openai?.apiKey),
        hasServiceAccount: Boolean(config.calendar?.serviceAccountJsonB64),
        hasSheet: Boolean(config.storage?.webhookUrl && config.storage?.secret),
        calendarConfigured: Boolean(s.calendarId),
        serviceAccountEmail: runtime.calendar?.serviceAccountEmail || null,
        botEnabled: s.botEnabled,
        botLanguage: s.botLanguage,
        // The owner's number is personal data: only ever show the last four digits.
        ownerNumber: s.ownerWhatsapp ? `…${String(s.ownerWhatsapp).slice(-4)}` : null,
      },
    });
  });

  // ---- Settings ----
  app.get('/api/settings', (req, res) => {
    if (!settings) return res.status(503).json({ ok: false, error: 'settings not ready' });
    res.json({ ok: true, settings: settings.describe() });
  });

  app.post('/api/settings', safe(async (req, res) => {
    if (!settings) return res.status(503).json({ ok: false, error: 'settings not ready' });
    const result = await settings.update(req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true, changed: result.changed, settings: settings.describe() });
  }));

  app.post('/api/settings/reset', safe(async (req, res) => {
    if (!settings) return res.status(503).json({ ok: false, error: 'settings not ready' });
    const result = await settings.reset(String(req.body?.key || ''));
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true, settings: settings.describe() });
  }));

  // ---- WhatsApp ----
  app.get('/api/whatsapp', (req, res) => {
    if (!whatsapp) return res.json({ ok: true, status: 'not-wired' });
    res.json({ ok: true, ...whatsapp.getStatus() });
  });

  app.post('/api/whatsapp/connect', safe(async (req, res) => {
    if (!whatsapp) return res.status(503).json({ ok: false, error: 'WhatsApp not wired' });
    res.json(await whatsapp.start());
  }));

  app.post('/api/whatsapp/relink', safe(async (req, res) => {
    if (!whatsapp) return res.status(503).json({ ok: false, error: 'WhatsApp not wired' });
    res.json(await whatsapp.logoutAndRelink());
  }));

  app.post('/api/whatsapp/pause', safe(async (req, res) => {
    if (!runtime.router) return res.status(503).json({ ok: false, error: 'router not ready' });
    const jid = String(req.body?.jid || '');
    if (!jid) return res.status(400).json({ ok: false, error: 'jid required' });
    runtime.router.pause(jid, Number(req.body?.hours) || settings.get('takeoverPauseHours'), 'dashboard');
    res.json({ ok: true, paused: runtime.router.listPaused() });
  }));

  app.post('/api/whatsapp/resume', safe(async (req, res) => {
    if (!runtime.router) return res.status(503).json({ ok: false, error: 'router not ready' });
    runtime.router.resume(String(req.body?.jid || ''));
    res.json({ ok: true, paused: runtime.router.listPaused() });
  }));

  // ---- Bookings ----
  app.get('/api/bookings', (req, res) => {
    const rows = runtime.bookings ? runtime.bookings.list({ status: req.query.status || null }) : [];
    res.json({ ok: true, bookings: rows });
  });

  // ---- Catalog ----
  app.post('/api/catalog/refresh', safe(async (req, res) => {
    if (!catalog) return res.status(503).json({ ok: false, error: 'catalog not ready' });
    res.json(await catalog.refresh({ force: true }));
  }));

  app.get('/api/catalog', (req, res) => {
    if (!catalog) return res.status(503).json({ ok: false, error: 'catalog not ready' });
    const q = String(req.query.q || '');
    const all = catalog.all();
    const list = q
      ? all.filter((p) => `${p.title} ${p.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()))
      : all;
    res.json({ ok: true, ...catalog.status(), products: list.slice(0, 200) });
  });

  app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error(`HTTP error on ${req.method} ${req.path}: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: 'Internal error' });
  });

  return app;
}

module.exports = { createServer };
