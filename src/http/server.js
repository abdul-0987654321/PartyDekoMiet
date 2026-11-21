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
const directory = require('../studio/directory');
const faqStore = require('../faq-store');
const { clearSession } = require('../whatsapp/auth-state');
const { createLocalCalendarClient, overlapsWindow } = require('../calendar/local-client');

/** All-day ranges end on the morning after, the way a calendar writes them. */
function addOneDay(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/**
 * Both bots live in one dashboard: the nav has a Party/Studio switch, and
 * every page that depends on which business is selected sends `?biz=studio`
 * on its API calls (the frontend's `api()` helper appends it automatically -
 * see public/app.js). Everything below picks the matching state/runtime/
 * WhatsApp client for that one query param; nothing else in the app knows
 * two businesses exist.
 */
function createServer({
  config, state, whatsapp = null, settings = null, runtime = {}, catalog = null, studio = null,
  // The professionals' own numbers: { registry, running, boot }. Optional, so
  // every existing caller and test that builds a server without them still works.
  lines = null,
}) {
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

  const bizParam = (req) => String(req.query?.biz || req.body?.biz || '');
  const isStudio = (req) => bizParam(req) === 'studio';

  /**
   * The state/runtime/whatsapp/business for whichever number `?biz=` asked for.
   *
   * An unknown or missing value falls back to PartyDekoMiet, which is what it
   * has always done - important, because a professional's number that has been
   * deleted must land somewhere harmless rather than throwing on every page.
   */
  function pick(req) {
    const asked = bizParam(req);
    if (asked === 'studio' && studio) {
      return { biz: 'studio', state: studio.state, runtime: studio.runtime, whatsapp: studio.whatsapp };
    }
    const entry = lines?.running?.get(asked);
    if (entry) {
      return { biz: asked, state: entry.state, runtime: entry.runtime, whatsapp: entry.whatsapp, line: entry.line };
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
  app.get('/calendar', page('calendar.html'));
  app.get('/chats', page('chats.html'));
  app.get('/test', page('test.html'));
  app.get('/professionals', page('professionals.html'));
  app.get('/services', page('services.html'));
  app.get('/locations', page('locations.html'));
  app.get('/numbers', page('numbers.html'));
  app.get('/faq', page('faq.html'));

  app.get('/api/status', (req, res) => {
    const { biz, state: st, runtime: rt, whatsapp: wa } = pick(req);
    const s = settings ? settings.all() : {};
    // Everything that is not PartyDekoMiet is the Studio side: the Studio's own
    // number and each professional's number share its calendar, its settings
    // and its directory, and none of them has a Shopify catalog.
    const isStudio = biz !== 'party';
    const line = lines?.running?.get(biz)?.line || null;
    res.json({
      ok: true,
      biz,
      line: line ? { id: line.id, name: line.name, professionalId: line.professionalId || '' } : null,
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
      // What the Studio has been filled in with. The dashboard turns this into
      // a setup checklist: a new owner otherwise has no way of knowing what is
      // still missing, and the bot answers "I'll check with the team" to
      // everything until it is all there, with nothing saying why.
      directory: isStudio
        ? {
            locations: directory.listLocations({ activeOnly: true }).length,
            professionals: directory.listProfessionals({ activeOnly: true }).length,
            services: directory.listServices({ activeOnly: true }).length,
            servicesWithDetails: directory
              .listServices({ activeOnly: true })
              .filter((x) => String(x.notes || '').trim()).length,
            photos: directory.listProfessionals({ activeOnly: true }).filter((p) => p.photoFileId).length,
            faq: faqStore.list({ business: 'studio', activeOnly: true }).length,
          }
        : null,
      alertError: st.alertError || null,
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
    // One entry per chat, built in its own object. The count used to be written
    // onto the chat row itself and reset every time a newer message replaced
    // the one being held, so it was both wrong and a stray field on a stored
    // record.
    const byJid = new Map();
    for (const m of db.all('chat')) {
      if ((m.business || 'party') !== biz) continue;
      let entry = byJid.get(m.jid);
      if (!entry) {
        entry = { last: m, count: 0 };
        byJid.set(m.jid, entry);
      }
      entry.count += 1;
      if (String(m.at) > String(entry.last.at)) entry.last = m;
    }
    const paused = new Set((rt.router ? rt.router.listPaused() : []).map((p) => p.jid));
    const chats = [...byJid.entries()]
      .map(([jid, { last, count }]) => {
        const customer = require('../customers').get(biz, jid);
        return {
          jid,
          phone: require('../contacts').phoneOf(biz, jid),
          name: customer?.name || customer?.pushName || null,
          lastAt: last.at,
          lastText: String(last.text || '').slice(0, 120),
          lastDirection: last.direction,
          messages: count,
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
    const customer = require('../customers').get(biz, jid) || null;
    const paused = (rt.router ? rt.router.listPaused() : []).find((p) => p.jid === jid) || null;
    res.json({ ok: true, jid, phone: require('../contacts').phoneOf(biz, jid), customer, paused, messages });
  });

  /**
   * Clears a conversation's history from the dashboard.
   *
   * Only this business's rows: the two bots share one chat table, and the same
   * person can have written to both numbers. The customer record is kept - the
   * owner is clearing a transcript, not forgetting who someone is - and nothing
   * is deleted on anyone's phone, which is said plainly in the confirmation.
   */
  app.delete('/api/chats/:jid', safe(async (req, res) => {
    const { biz } = pick(req);
    const jid = String(req.params.jid);
    const doomed = db.all('chat').filter((m) => m.jid === jid && (m.business || 'party') === biz);
    for (const m of doomed) db.remove('chat', m.id);
    await db.flush();
    log.info(`Chat history cleared for ${jid} (${biz}): ${doomed.length} message(s)`);
    res.json({ ok: true, deleted: doomed.length });
  }));

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

  // ---- Calendar ----
  // One month at a time, flattened into what a day cell needs. The entries are
  // the same rows the bot checks availability against, so what the owner sees
  // here is exactly what the bot believes - there is no second version of the
  // truth to drift.
  app.get('/api/calendar', (req, res) => {
    const { biz } = pick(req);
    const from = String(req.query.from || '').slice(0, 10);
    const to = String(req.query.to || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ ok: false, error: 'from and to must be YYYY-MM-DD' });
    }

    const entries = db
      .all('calendarEvents')
      .filter((e) => e.business === biz)
      .filter((e) => overlapsWindow(e, `${from}T00:00:00Z`, `${to}T23:59:59Z`))
      .map((e) => {
        let priv = {};
        try { priv = JSON.parse(e.privateJson || '{}'); } catch { priv = {}; }
        const title = String(e.summary || '');
        const status = /\[CONFIRMED\]/i.test(title) ? 'CONFIRMED'
          : /\[PENDING\]/i.test(title) ? 'PENDING'
          : priv.bookingStatus || null;
        return {
          id: e.id,
          allDay: e.allDay === true,
          startDate: e.allDay ? e.startDate : String(e.startDateTime || '').slice(0, 10),
          endDate: e.allDay ? e.endDate : String(e.endDateTime || e.startDateTime || '').slice(0, 10),
          startTime: e.allDay ? '' : String(e.startDateTime || '').slice(11, 16),
          endTime: e.allDay ? '' : String(e.endDateTime || '').slice(11, 16),
          // The bracketed status is for the calendar's own bookkeeping; the
          // page shows it as a colour instead.
          title: title.replace(/^\[(PENDING|CONFIRMED|CANCELLED|BLOCKED)\]\s*/i, '').trim(),
          status,
          source: e.source || 'bot',
          professionalId: priv.professionalId || '',
          appointmentId: priv.appointmentId || '',
          bookingId: priv.bookingId || '',
        };
      })
      .sort((a, b) => `${a.startDate}${a.startTime}`.localeCompare(`${b.startDate}${b.startTime}`));

    res.json({ ok: true, entries, today: new Date().toISOString().slice(0, 10) });
  });

  /**
   * Time the owner blocks by hand: a holiday, a closure, an hour kept free.
   * Written as an ordinary entry, so the bot stops offering it without any
   * further code - blocking is just something being in the way.
   */
  app.post('/api/calendar/block', safe(async (req, res) => {
    const { biz } = pick(req);
    const body = req.body || {};
    const date = String(body.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD' });
    }
    const note = String(body.note || '').trim();
    const start = String(body.startTime || '').trim();
    const end = String(body.endTime || '').trim();
    const timed = /^\d{2}:\d{2}$/.test(start) && /^\d{2}:\d{2}$/.test(end);
    if ((start || end) && !timed) {
      return res.status(400).json({ ok: false, error: 'startTime and endTime must both be HH:MM' });
    }
    if (timed && end <= start) {
      return res.status(400).json({ ok: false, error: 'endTime must be after startTime' });
    }

    // "Blocked" is one of the keywords the availability check already treats as
    // closing a day, so an all-day block needs no new rule anywhere.
    const summary = `[BLOCKED] ${note || 'Blockiert'}`;
    const client = createLocalCalendarClient({ business: biz, timeZone: config.tz || 'Europe/Zurich' });
    const event = timed
      ? {
          summary,
          start: { dateTime: `${date}T${start}:00`, timeZone: config.tz || 'Europe/Zurich' },
          end: { dateTime: `${date}T${end}:00`, timeZone: config.tz || 'Europe/Zurich' },
          source: 'owner',
          extendedProperties: { private: { blocked: 'true' } },
        }
      : {
          summary,
          start: { date },
          end: { date: addOneDay(date) }, // all-day ends are exclusive
          source: 'owner',
          extendedProperties: { private: { blocked: 'true' } },
        };
    const created = await client.createEvent(event);
    res.json({ ok: true, id: created.id });
  }));

  app.delete('/api/calendar/block/:id', safe(async (req, res) => {
    const { biz } = pick(req);
    const row = db.get('calendarEvents', String(req.params.id));
    if (!row || row.business !== biz) return res.status(404).json({ ok: false, error: 'not found' });
    // Only what the owner put there by hand. An appointment is cancelled on its
    // own card, where the customer is told - not quietly deleted off a grid.
    if ((row.source || 'bot') !== 'owner') {
      return res.status(400).json({ ok: false, error: 'Only blocked time can be removed here.' });
    }
    await createLocalCalendarClient({ business: biz }).deleteEvent(row.id);
    res.json({ ok: true });
  }));

  // ---- Bookings (Party) / Appointments (Studio) ----
  app.get('/api/bookings', (req, res) => {
    const { biz, runtime: rt } = pick(req);
    // Appointments, not bookings, for the Studio and for every professional's
    // own number - they all book time, not rental sets.
    if (biz !== 'party') {
      let rows = rt.appointments ? rt.appointments.list({ status: req.query.status || null }) : [];
      // On a professional's own number, her appointments only. The Studio's
      // number still sees everyone's.
      const her = lines?.running?.get(biz)?.line?.professionalId;
      if (her) rows = rows.filter((a) => a.professionalId === her);
      return res.json({ ok: true, appointments: rows });
    }
    const rows = rt.bookings ? rt.bookings.list({ status: req.query.status || null }) : [];
    res.json({ ok: true, bookings: rows });
  });

  app.post('/api/bookings/:id/status', safe(async (req, res) => {
    const { biz, runtime: rt } = pick(req);
    const svc = biz === 'party' ? rt.bookings : rt.appointments;
    if (!svc) return res.status(503).json({ ok: false, error: `${biz === 'party' ? 'bookings' : 'appointments'} not ready` });
    const result = await svc.setStatus(String(req.params.id), String(req.body?.status || ''));
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }));

  // ---- FAQ: both businesses, selected by ?business= ----
  // Not under /api/studio/: PartyDekoMiet has an FAQ too (its file-based one),
  // and the owner adds to the same table from the same page with the dashboard
  // business switch deciding which set is shown.
  const faqBusiness = (req) => (String(req.query.business || req.body?.business) === 'studio' ? 'studio' : 'party');

  app.get('/api/faq', (req, res) => {
    res.json({ ok: true, entries: faqStore.list({ business: faqBusiness(req) }) });
  });
  app.post('/api/faq', safe(async (req, res) => {
    const result = await faqStore.create({ ...(req.body || {}), business: faqBusiness(req) });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }));
  app.patch('/api/faq/:id', safe(async (req, res) => {
    const result = await faqStore.update(String(req.params.id), req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }));
  app.delete('/api/faq/:id', safe(async (req, res) => {
    const result = await faqStore.remove(String(req.params.id));
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }));

  // ---- Studio directory: professionals / services / locations ----
  // All dashboard-editable, nothing hardcoded (HANDOFF.md §8). Every write goes
  // through src/studio/directory.js's own validation, so the API layer here is
  // thin on purpose.
  // ---- The professionals' own WhatsApp numbers ----
  // Adding one is adding a number, not a row: it gets its own session, its own
  // chats and its own customers, and it has to be started and stopped here
  // rather than on the next deploy - the client adds these himself.
  if (lines?.registry) {
    const registry = lines.registry;
    const running = lines.running;

    const withStatus = (line) => {
      const entry = running?.get(line.id);
      return {
        ...line,
        connected: entry?.whatsapp ? entry.whatsapp.getStatus().status === 'connected' : false,
        status: entry?.whatsapp ? entry.whatsapp.getStatus().status : 'stopped',
        bootError: entry?.state?.bootError || null,
        alertError: entry?.state?.alertError || null,
      };
    };

    app.get('/api/lines', (req, res) => {
      res.json({ ok: true, lines: registry.all().map(withStatus), max: registry.MAX_PRO_LINES });
    });

    app.post('/api/lines', safe(async (req, res) => {
      const result = await registry.create(req.body || {});
      if (!result.ok) return res.status(400).json(result);
      // Start it straight away, so the QR page has something to show.
      if (lines.boot) await lines.boot(result.line);
      log.info(`New WhatsApp number added: ${result.line.name} (${result.line.id})`);
      res.json({ ok: true, line: withStatus(result.line) });
    }));

    app.patch('/api/lines/:id', safe(async (req, res) => {
      const id = String(req.params.id);
      const before = registry.get(id);
      const result = await registry.update(id, req.body || {});
      if (!result.ok) return res.status(400).json(result);

      // Switching a number off means hanging it up, not just hiding it.
      const entry = running?.get(id);
      const wasActive = before?.active !== false;
      if (entry && wasActive && result.line.active === false) {
        try { await entry.whatsapp.stop(); } catch (err) { log.warn(`[${id}] stop failed: ${err.message}`); }
      } else if (!wasActive && result.line.active && lines.boot) {
        await lines.boot(result.line);
      } else if (
        entry &&
        result.line.active !== false &&
        lines.boot &&
        String(before?.professionalId || '') !== String(result.line.professionalId || '')
      ) {
        // Which professional a number belongs to is baked into the filter its
        // agent reads the directory through, and that filter is built when the
        // line boots. Without this the number kept answering as the woman it
        // used to belong to until the next deploy - the dashboard said one
        // thing and the bot said another. Rebuilt in place: the socket stays
        // up, so nobody has to scan a QR again.
        await lines.boot(result.line);
        log.info(`[${id}] Professional changed - agent and filter rebuilt for the running number.`);
      }
      res.json({ ok: true, line: withStatus(result.line) });
    }));

    app.delete('/api/lines/:id', safe(async (req, res) => {
      const id = String(req.params.id);
      if (!registry.get(id)) return res.status(404).json({ ok: false, error: 'not found' });
      if (registry.isBuiltIn(id)) return res.status(400).json({ ok: false, error: 'this number is built in' });

      // Order matters: unlink the device and hang up, then drop the row. Doing
      // it the other way round leaves a socket running for a number that no
      // longer exists, session rows nothing will ever clean up, and a dead
      // entry under "Linked devices" on her phone.
      const entry = running?.get(id);
      if (entry) {
        try {
          await entry.whatsapp.logoutAndStop();
        } catch (err) {
          log.warn(`[${id}] logout failed, clearing anyway: ${err.message}`);
          await clearSession(id);
        }
        running.delete(id);
      } else {
        await clearSession(id);
      }
      const result = await registry.remove(id);
      if (!result.ok) return res.status(400).json(result);
      log.info(`WhatsApp number removed: ${id} (session cleared)`);
      res.json({ ok: true });
    }));
  }

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
