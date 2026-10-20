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
const { matchesOtherBusiness } = require('../whatsapp/router');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/**
 * Both bots live in one dashboard: the nav has a Party/Studio switch, and
 * every page that depends on which business is selected sends `?biz=studio`
 * on its API calls (the frontend's `api()` helper appends it automatically -
 * see public/app.js). Everything below picks the matching state/runtime/
 * WhatsApp client for that one query param; nothing else in the app knows
 * two businesses exist.
 */
function createServer({ config, state, whatsapp = null, settings = null, runtime = {}, catalog = null, studio = null }) {
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

  const isStudio = (req) => String(req.query?.biz || req.body?.biz || '') === 'studio';

  /** The state/runtime/whatsapp/business for whichever side `?biz=` asked for. */
  function pick(req) {
    if (isStudio(req) && studio) {
      return { biz: 'studio', state: studio.state, runtime: studio.runtime, whatsapp: studio.whatsapp };
    }
    return { biz: 'party', state, runtime, whatsapp };
  }

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
  app.get('/chats', page('chats.html'));
  app.get('/test', page('test.html'));
  app.get('/professionals', page('professionals.html'));
  app.get('/services', page('services.html'));
  app.get('/locations', page('locations.html'));

  app.get('/api/status', (req, res) => {
    const { biz, state: st, runtime: rt, whatsapp: wa } = pick(req);
    const s = settings ? settings.all() : {};
    const isStudio = biz === 'studio';
    res.json({
      ok: true,
      biz,
      ready: st.ready,
      startedAt: st.startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      storage: db.status(), // one shared Google Sheet for both businesses
      storageError: state.storageError, // the Sheet connection itself, from Party's boot
      storageWarning: state.storageWarning,
      calendarError: st.calendarError,
      bootError: st.bootError,
      knowledge: st.knowledge,
      catalog: isStudio ? null : (catalog ? catalog.status() : null), // Studio has no Shopify catalog
      ai: rt.router ? rt.router.aiHealth() : null,
      skipped: rt.router ? rt.router.skipped() : null,
      whatsapp: wa ? wa.getStatus() : { status: 'not-wired' },
      pausedChats: rt.router ? rt.router.listPaused() : [],
      lang: s.dashboardLanguage || 'de',
      config: {
        model: config.openai?.model,
        hasOpenAiKey: Boolean(config.openai?.apiKey),
        hasServiceAccount: Boolean(config.calendar?.serviceAccountJsonB64),
        hasSheet: Boolean(config.storage?.webhookUrl && config.storage?.secret),
        calendarConfigured: Boolean(isStudio ? s.studioCalendarId : s.calendarId),
        serviceAccountEmail: rt.calendar?.serviceAccountEmail || null,
        botEnabled: isStudio ? s.studioBotEnabled : s.botEnabled,
        botLanguage: s.botLanguage,
        // The owner's number is personal data: only ever show the last four digits.
        ownerNumber: (isStudio ? s.studioOwnerWhatsapp : s.ownerWhatsapp)
          ? `…${String(isStudio ? s.studioOwnerWhatsapp : s.ownerWhatsapp).slice(-4)}`
          : null,
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
    const { whatsapp: wa } = pick(req);
    if (!wa) return res.json({ ok: true, status: 'not-wired' });
    res.json({ ok: true, ...wa.getStatus() });
  });

  app.post('/api/whatsapp/connect', safe(async (req, res) => {
    const { whatsapp: wa } = pick(req);
    if (!wa) return res.status(503).json({ ok: false, error: 'WhatsApp not wired' });
    res.json(await wa.start());
  }));

  app.post('/api/whatsapp/relink', safe(async (req, res) => {
    const { whatsapp: wa } = pick(req);
    if (!wa) return res.status(503).json({ ok: false, error: 'WhatsApp not wired' });
    res.json(await wa.logoutAndRelink());
  }));

  app.post('/api/whatsapp/pause', safe(async (req, res) => {
    const { runtime: rt } = pick(req);
    if (!rt.router) return res.status(503).json({ ok: false, error: 'router not ready' });
    const jid = String(req.body?.jid || '');
    if (!jid) return res.status(400).json({ ok: false, error: 'jid required' });
    rt.router.pause(jid, Number(req.body?.hours) || settings.get('takeoverPauseHours'), 'dashboard');
    res.json({ ok: true, paused: rt.router.listPaused() });
  }));

  app.post('/api/whatsapp/resume', safe(async (req, res) => {
    const { runtime: rt } = pick(req);
    if (!rt.router) return res.status(503).json({ ok: false, error: 'router not ready' });
    rt.router.resume(String(req.body?.jid || ''));
    res.json({ ok: true, paused: rt.router.listPaused() });
  }));

  app.post('/api/whatsapp/pair', safe(async (req, res) => {
    const { whatsapp: wa } = pick(req);
    if (!wa) return res.status(503).json({ ok: false, error: 'WhatsApp not wired' });
    res.json(await wa.startPairing(String(req.body?.number || '')));
  }));

  app.post('/api/whatsapp/pair/cancel', safe(async (req, res) => {
    const { whatsapp: wa } = pick(req);
    if (!wa) return res.status(503).json({ ok: false, error: 'WhatsApp not wired' });
    res.json(wa.cancelPairing());
  }));

  // ---- Chats ----
  // The owner reads conversations here and can step in. Sending from the
  // dashboard also pauses the bot in that chat, so the two never talk at once.
  app.get('/api/chats', (req, res) => {
    const { biz, runtime: rt } = pick(req);
    const byJid = new Map();
    for (const m of db.all('chat')) {
      if ((m.business || 'party') !== biz) continue;
      const prev = byJid.get(m.jid);
      if (!prev || String(m.at) > String(prev.at)) byJid.set(m.jid, m);
      const entry = byJid.get(m.jid);
      entry.count = (entry.count || 0) + 1;
    }
    const paused = new Set((rt.router ? rt.router.listPaused() : []).map((p) => p.jid));
    const chats = [...byJid.entries()]
      .map(([jid, last]) => {
        const customer = db.get('customers', jid);
        return {
          jid,
          phone: require('../contacts').phoneOf(jid),
          name: customer?.name || customer?.pushName || null,
          lastAt: last.at,
          lastText: String(last.text || '').slice(0, 120),
          lastDirection: last.direction,
          messages: last.count || 0,
          paused: paused.has(jid),
        };
      })
      .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
    res.json({ ok: true, chats });
  });

  app.get('/api/chats/:jid', (req, res) => {
    const { biz, runtime: rt } = pick(req);
    const jid = String(req.params.jid);
    const messages = db
      .all('chat')
      .filter((m) => m.jid === jid && (m.business || 'party') === biz)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .slice(-300);
    const customer = db.get('customers', jid) || null;
    const paused = (rt.router ? rt.router.listPaused() : []).find((p) => p.jid === jid) || null;
    res.json({ ok: true, jid, phone: require('../contacts').phoneOf(jid), customer, paused, messages });
  });

  app.post('/api/chats/:jid/send', safe(async (req, res) => {
    const { biz, runtime: rt, whatsapp: wa } = pick(req);
    if (!wa) return res.status(503).json({ ok: false, error: 'WhatsApp not wired' });
    const jid = String(req.params.jid);
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'text required' });
    if (!wa.isConnected()) {
      // Not a server fault: the phone is simply not linked right now.
      return res.status(503).json({ ok: false, error: 'WhatsApp ist nicht verbunden.' });
    }

    await wa.sendText(jid, text);
    db.put('chat', {
      id: `${Date.now()}-dash`,
      business: biz,
      at: new Date().toISOString(),
      jid,
      direction: 'out',
      text,
    });
    // The owner is handling this chat now, so the bot steps aside.
    if (rt.router) {
      rt.router.pause(jid, settings ? settings.get('takeoverPauseHours') : 12, 'sent from dashboard');
    }
    await db.flush();
    res.json({ ok: true });
  }));

  // ---- Test chat ----
  // Talks to the real agent with the real catalog and calendar, but never
  // touches WhatsApp and never writes to the customer tables. Safe to use on a
  // live deployment, and the surface to use for a demo recording.
  const testSessions = new Map(); // id -> [{role, content}]

  app.post('/api/test/chat', safe(async (req, res) => {
    const { biz, runtime: rt } = pick(req);
    if (!rt.agent) {
      return res.status(503).json({
        ok: false,
        error: 'Kein Agent aktiv - OPENAI_API_KEY fehlt.',
      });
    }
    const id = `${biz}:${String(req.body?.session || 'default')}`;
    if (req.body?.reset) {
      testSessions.delete(id);
      return res.json({ ok: true, reset: true });
    }

    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ ok: false, error: 'message required' });

    const history = testSessions.get(id) || [];

    // The out-of-scope check lives in the router, so mirror it here or the test
    // chat would behave differently from the real one. Studio has its own
    // WhatsApp number, so the "other business" handoff is a Party-only concept.
    const otherBusiness = biz === 'party'
      && matchesOtherBusiness(message, settings ? settings.get('otherBusinessKeywords') : '');
    if (otherBusiness) {
      const lang = /\b(the|and|is|how|can|hello|hi|you|do|your)\b/i.test(message) ? 'en' : 'de';
      const text = settings.get(lang === 'en' ? 'otherBusinessReplyEn' : 'otherBusinessReplyDe');
      history.push({ role: 'user', content: message }, { role: 'assistant', content: text });
      testSessions.set(id, history.slice(-24));
      return res.json({ ok: true, text, handoff: true, otherBusiness: true, toolCalls: [], violations: [] });
    }

    const out = await rt.agent.reply({
      history: [...history],
      message,
      services: { ...rt.services, messenger: null }, // no real sending from the test chat
      chatId: `test:${id}`,
    });

    history.push({ role: 'user', content: message }, { role: 'assistant', content: out.text });
    testSessions.set(id, history.slice(-24));

    res.json({
      ok: true,
      text: out.text,
      lang: out.lang,
      handoff: out.handoff,
      blocked: out.blocked,
      violations: out.violations || [],
      toolCalls: (out.toolCalls || []).map((c) => ({
        name: c.name,
        args: c.args,
        ok: c.result?.ok !== false,
        result: c.result,
      })),
    });
  }));

  // ---- Bookings (Party) / Appointments (Studio) ----
  app.get('/api/bookings', (req, res) => {
    const { biz, runtime: rt } = pick(req);
    if (biz === 'studio') {
      const rows = rt.appointments ? rt.appointments.list({ status: req.query.status || null }) : [];
      return res.json({ ok: true, appointments: rows });
    }
    const rows = rt.bookings ? rt.bookings.list({ status: req.query.status || null }) : [];
    res.json({ ok: true, bookings: rows });
  });

  app.post('/api/bookings/:id/status', safe(async (req, res) => {
    const { biz, runtime: rt } = pick(req);
    const svc = biz === 'studio' ? rt.appointments : rt.bookings;
    if (!svc) return res.status(503).json({ ok: false, error: `${biz === 'studio' ? 'appointments' : 'bookings'} not ready` });
    const result = await svc.setStatus(String(req.params.id), String(req.body?.status || ''));
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }));

  // ---- Studio directory: professionals / services / locations ----
  // All dashboard-editable, nothing hardcoded (HANDOFF.md §8). Every write goes
  // through src/studio/directory.js's own validation, so the API layer here is
  // thin on purpose.
  if (studio?.directory) {
    const dir = studio.directory;

    app.get('/api/studio/professionals', (req, res) => {
      res.json({ ok: true, professionals: dir.listProfessionals() });
    });
    app.post('/api/studio/professionals', safe(async (req, res) => {
      const result = await dir.createProfessional(req.body || {});
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    }));
    app.patch('/api/studio/professionals/:id', safe(async (req, res) => {
      const result = await dir.updateProfessional(String(req.params.id), req.body || {});
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    }));
    app.delete('/api/studio/professionals/:id', safe(async (req, res) => {
      const result = await dir.removeProfessional(String(req.params.id));
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    }));

    app.get('/api/studio/services', (req, res) => {
      res.json({ ok: true, services: dir.listServices() });
    });
    app.post('/api/studio/services', safe(async (req, res) => {
      const result = await dir.createService(req.body || {});
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    }));
    app.patch('/api/studio/services/:id', safe(async (req, res) => {
      const result = await dir.updateService(String(req.params.id), req.body || {});
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    }));
    app.delete('/api/studio/services/:id', safe(async (req, res) => {
      const result = await dir.removeService(String(req.params.id));
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    }));

    app.get('/api/studio/locations', (req, res) => {
      res.json({ ok: true, locations: dir.listLocations() });
    });
    app.post('/api/studio/locations', safe(async (req, res) => {
      const result = await dir.createLocation(req.body || {});
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    }));
    app.patch('/api/studio/locations/:id', safe(async (req, res) => {
      const result = await dir.updateLocation(String(req.params.id), req.body || {});
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    }));
    app.delete('/api/studio/locations/:id', safe(async (req, res) => {
      const result = await dir.removeLocation(String(req.params.id));
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    }));

    // A professional's photo: uploaded as base64 JSON (consistent with how
    // reference photos already travel through this app - see backend-sheets.js
    // putFile/getFile), stored the same private way, then just its file id is
    // kept on the professional record.
    app.post('/api/studio/professionals/:id/photo', safe(async (req, res) => {
      const professional = dir.getProfessional(String(req.params.id));
      if (!professional) return res.status(404).json({ ok: false, error: 'professional not found' });
      const { name, mimeType, base64 } = req.body || {};
      if (!base64) return res.status(400).json({ ok: false, error: 'base64 required' });
      const id = await db.putFile(name || 'foto.jpg', mimeType || 'image/jpeg', Buffer.from(base64, 'base64'));
      const result = await dir.updateProfessional(professional.id, { photoFileId: id });
      res.json({ ok: true, photoFileId: id, professional: result.professional });
    }));

    app.get('/api/studio/photo/:fileId', safe(async (req, res) => {
      const file = await db.getFile(String(req.params.fileId));
      res.set('Content-Type', file.mimeType || 'image/jpeg');
      res.set('Cache-Control', 'private, max-age=3600');
      res.send(file.buffer);
    }));
  }

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
