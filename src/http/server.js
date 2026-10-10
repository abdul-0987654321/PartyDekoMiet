'use strict';
/**
 * HTTP surface:
 *   GET  /health        no login, always 200 while the process runs.
 *                       This is what Render's health check and UptimeRobot hit;
 *                       on the free plan that ping is also what keeps the
 *                       instance from spinning down.
 *   GET  /login         password form
 *   GET  /              status page (login required)
 *   GET  /api/status    machine-readable status (login required)
 *
 * The QR code endpoints are registered by the WhatsApp module once it exists;
 * until then the status page says so instead of pretending to be connected.
 */

const path = require('path');
const express = require('express');
const log = require('../log');
const auth = require('./auth');
const db = require('../store/db');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.state   mutable boot state: { ready, storageError, storageWarning, startedAt }
 * @param {object} [deps.whatsapp]  optional, wired in a later phase
 */
function createServer({ config, state, whatsapp = null }) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(PUBLIC_DIR, { index: false }));

  // ---- Health: no login, no secrets. Render + UptimeRobot poll this. ----
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

  app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'status.html')));

  app.get('/api/status', (req, res) => {
    res.json({
      ok: true,
      ready: state.ready,
      startedAt: state.startedAt,
      storage: db.status(),
      storageError: state.storageError,
      storageWarning: state.storageWarning,
      knowledge: state.knowledge,
      whatsapp: whatsapp ? whatsapp.getStatus() : { status: 'not-wired' },
      config: {
        model: config.openai.model,
        hasOpenAiKey: Boolean(config.openai.apiKey),
        hasCalendar: Boolean(config.calendar.id && config.calendar.serviceAccountJsonB64),
        ownerNumber: config.whatsapp.ownerNumber ? `…${config.whatsapp.ownerNumber.slice(-4)}` : null,
        rentalDays: config.business.rentalDays,
        depositChf: config.business.depositChf,
      },
    });
  });

  // The WhatsApp module adds /qr and /api/whatsapp/* here when it is wired in.
  if (whatsapp?.registerRoutes) whatsapp.registerRoutes(app);

  app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error(`HTTP error on ${req.method} ${req.path}: ${err.stack || err.message}`);
    res.status(500).json({ ok: false, error: 'Internal error' });
  });

  return app;
}

module.exports = { createServer };
