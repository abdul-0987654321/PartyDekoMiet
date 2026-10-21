'use strict';
/**
 * Entry point. Wires the parts together and keeps the process alive.
 *
 * Boot order matters on Render: HTTP comes up first and answers /health
 * immediately, so the health check passes and the deploy goes live while the
 * slower parts (Google Sheet, catalog, WhatsApp) are still starting. Each of
 * those can fail without taking the service down - the dashboard shows what is
 * broken instead.
 */

const { config } = require('./config');
const log = require('./log');
const db = require('./store/db');
const { createSheetsBackend } = require('./store/backend-sheets');
const { createMemoryBackend } = require('./store/backend-memory');
const settings = require('./settings');
const knowledgeLoader = require('./knowledge');
const { createGuards } = require('./agent/guards');
const { createStudioGuards } = require('./agent/guards-studio');
const { createAgent } = require('./agent/agent');
const studioTools = require('./agent/tools/studio');
const catalog = require('./catalog');
const { createCalendarService } = require('./calendar');
const { createStudioCalendarService } = require('./calendar/studio-service');
const { createBookings } = require('./bookings');
const { createAppointments } = require('./appointments');
const directory = require('./studio/directory');
const faqStore = require('./faq-store');
const { createNotifier } = require('./notify/owner');
const { createMessenger } = require('./whatsapp/messenger');
const { createRouter } = require('./whatsapp/router');
const { createVoice } = require('./voice');
const whatsapp = require('./whatsapp/client');
const { createWhatsAppClient } = require('./whatsapp/client');
const { createServer } = require('./http/server');

const state = {
  startedAt: new Date().toISOString(),
  ready: false,
  storageError: null,
  storageWarning: null,
  knowledge: null,
  calendarError: null,
  bootError: null,
};

const runtime = { agent: null, voice: null, calendar: null, bookings: null, router: null, notify: null, services: {} };

/**
 * The Studio's own WhatsApp number needs its own Baileys socket (whatsapp/client.js
 * is a factory for exactly this reason), state and runtime - everything below
 * mirrors `state`/`runtime` above but must never block or break Party's boot, since
 * the client has not finished configuring it yet (hours, prices, roster, and even
 * the calendar ID are filled in later from the dashboard).
 */
const studioWhatsapp = createWhatsAppClient('studio');
const studioState = {
  startedAt: new Date().toISOString(),
  ready: false,
  knowledge: null,
  calendarError: null,
  bootError: null,
};
const studioRuntime = { agent: null, calendar: null, appointments: null, router: null, notify: null, services: {} };

async function connectStorage() {
  let backend;
  if (config.storage.webhookUrl && config.storage.secret) {
    backend = createSheetsBackend({ url: config.storage.webhookUrl, secret: config.storage.secret });
  } else {
    state.storageWarning =
      'SHEET_WEBHOOK_URL / SHEET_SECRET are not set - data is kept in memory only and is lost on restart.';
    log.warn(state.storageWarning);
    backend = createMemoryBackend();
  }

  for (let attempt = 1; ; attempt++) {
    try {
      await db.init(backend);
      state.storageError = null;
      return;
    } catch (err) {
      state.storageError = `Google Sheet storage failed: ${err.message}`;
      log.error(`${state.storageError} (attempt ${attempt}, retrying in 15s)`);
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
}

async function boot() {
  // 1. Storage first: settings, the WhatsApp session and the catalog cache live there.
  await connectStorage();
  settings.load();

  // 2. Knowledge and the agent.
  const knowledge = await knowledgeLoader.load({ source: config.knowledge.source });
  state.knowledge = { source: knowledge.source, faqEntries: knowledge.faq.length };

  // The pack from knowledge/ plus whatever the owner has written in the
  // dashboard, re-read on every reply. buildSystemPrompt destructures `faq`,
  // so the getter runs per reply and an answer saved in the dashboard is live
  // without a restart. Dashboard entries come last, so they win on a conflict.
  const liveKnowledge = {
    ...knowledge,
    get faq() {
      return [...knowledge.faq, ...faqStore.forPrompt('party')];
    },
  };

  const guards = createGuards({
    faqAnswers: () => liveKnowledge.faq.flatMap((e) => [e.a_de, e.a_en]),
    depositChf: settings.get('depositChf'),
    lateFeeChf: settings.get('lateFeeChf'),
    damagePrices: knowledge.damagePrices || '',
  });

  if (config.openai.apiKey) {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: config.openai.apiKey });
    runtime.agent = createAgent({
      openai,
      knowledge: liveKnowledge,
      guards,
      config: config.openai,
    });
    // Voice notes: customers' are transcribed, the owner's become dictated replies.
    runtime.voice = createVoice({
      openai,
      model: config.openai.model,
      transcribeModel: config.openai.transcribeModel,
    });
    log.info(`Agent ready (${config.openai.model}), voice notes via ${config.openai.transcribeModel}`);
  } else {
    log.warn('OPENAI_API_KEY is not set - the bot cannot answer customers.');
  }

  // 3. Catalog: serves the cached copy at once, refreshes in the background.
  try {
    await catalog.init();
  } catch (err) {
    log.error(`Catalog could not be initialised: ${err.message}`);
  }

  // 4. Calendar (optional: without it the bot hands availability questions over).
  if (config.calendar.serviceAccountJsonB64) {
    try {
      runtime.calendar = createCalendarService({
        serviceAccountJsonB64: config.calendar.serviceAccountJsonB64,
        timeZone: config.tz,
        getStock: () => settings.get('defaultStock'),
      });
      if (settings.get('calendarId')) {
        const info = await runtime.calendar.check();
        log.info(`Calendar connected: "${info.calendar}" (${info.timeZone})`);
        state.calendarError = null;
      } else {
        state.calendarError = 'GOOGLE_CALENDAR_ID is not set yet.';
        log.warn(state.calendarError);
      }
    } catch (err) {
      state.calendarError = err.message;
      log.error(`Calendar not usable: ${err.message}`);
    }
  } else {
    state.calendarError = 'GOOGLE_SERVICE_ACCOUNT_JSON_B64 is not set - availability checks are disabled.';
    log.warn(state.calendarError);
  }

  // 5. WhatsApp side.
  runtime.notify = createNotifier({ client: whatsapp });
  const messenger = createMessenger({ client: whatsapp });
  runtime.bookings = createBookings({ catalog, calendar: runtime.calendar, notify: runtime.notify });

  runtime.services = {
    catalog,
    calendar: runtime.calendar,
    bookings: runtime.bookings,
    messenger,
    notify: runtime.notify,
  };

  runtime.router = createRouter({
    client: whatsapp,
    agent: runtime.agent,
    services: runtime.services,
    notify: runtime.notify,
    voice: runtime.voice,
  });
  runtime.router.init();
  whatsapp.onMessage((msg) => runtime.router.handle(msg));

  state.ready = true;
  log.info('Boot complete.');

  // 6. Connect WhatsApp last: everything it needs is now in place.
  await whatsapp.start();
}

/**
 * Boots the Studio side: its own knowledge pack, agent/tools, timed-slot
 * calendar, appointments, notifier, router and WhatsApp number. Deliberately
 * additive and best-effort - unlike Party's boot(), a missing or not-yet-filled
 * setting (no calendar ID, no owner number) must never throw here, because the
 * client fills those in later from the dashboard, not before the first deploy.
 * Storage, settings and the OpenAI key are shared with Party and are already in
 * place by the time this runs (boot() calls this after its own step 2).
 */
async function bootStudio() {
  try {
    const knowledge = await knowledgeLoader.load({ source: config.knowledge.source, dir: 'knowledge-studio' });
    studioState.knowledge = { source: knowledge.source, faqEntries: knowledge.faq.length };

    if (config.openai.apiKey) {
      // A function, not a list: the owner adds and edits services in the
      // dashboard while the bot runs, and a list read once at boot makes every
      // later service an "invented price".
      const activePrices = () =>
        directory
          .listServices({ activeOnly: true })
          .map((s) => Number(s.priceChf))
          .filter((n) => Number.isFinite(n) && n > 0);
      const liveKnowledge = {
        ...knowledge,
        get faq() {
          return [...knowledge.faq, ...faqStore.forPrompt('studio')];
        },
      };
      const guards = createStudioGuards({
        faqAnswers: () => liveKnowledge.faq.flatMap((e) => [e.a_de, e.a_en]),
        allowedPrices: activePrices,
        priceMode: () => settings.get('studioPriceGuard'),
      });

      const OpenAI = require('openai');
      const openai = new OpenAI({ apiKey: config.openai.apiKey });
      studioRuntime.agent = createAgent({
        openai,
        knowledge: liveKnowledge,
        guards,
        tools: studioTools,
        config: config.openai,
      });
      log.info(
        `[studio] Agent ready (${activePrices().length} active service price(s) right now, ` +
          're-read from the dashboard on every reply)'
      );
    } else {
      log.warn('[studio] OPENAI_API_KEY is not set - the Studio bot cannot answer customers.');
    }

    // Calendar: reuses the same Google service account as Party (shared infra),
    // pointed at the Studio's own calendar ID once the client provides it.
    if (config.calendar.serviceAccountJsonB64) {
      try {
        studioRuntime.calendar = createStudioCalendarService({
          serviceAccountJsonB64: config.calendar.serviceAccountJsonB64,
          timeZone: config.tz,
        });
        if (settings.get('studioCalendarId')) {
          const info = await studioRuntime.calendar.check();
          log.info(`[studio] Calendar connected: "${info.calendar}" (${info.timeZone})`);
          studioState.calendarError = null;
        } else {
          studioState.calendarError = 'studioCalendarId is not set yet (dashboard: Studio settings).';
          log.warn(`[studio] ${studioState.calendarError}`);
        }
      } catch (err) {
        studioState.calendarError = err.message;
        log.error(`[studio] Calendar not usable: ${err.message}`);
      }
    } else {
      studioState.calendarError = 'GOOGLE_SERVICE_ACCOUNT_JSON_B64 is not set - availability checks are disabled.';
      log.warn(`[studio] ${studioState.calendarError}`);
    }

    studioRuntime.notify = createNotifier({ client: studioWhatsapp, business: 'studio' });
    studioRuntime.appointments = createAppointments({ calendar: studioRuntime.calendar, notify: studioRuntime.notify });

    studioRuntime.services = {
      directory,
      calendar: studioRuntime.calendar,
      appointments: studioRuntime.appointments,
      notify: studioRuntime.notify,
    };

    studioRuntime.router = createRouter({
      client: studioWhatsapp,
      agent: studioRuntime.agent,
      services: studioRuntime.services,
      notify: studioRuntime.notify,
      voice: runtime.voice, // shares Party's OpenAI-backed transcriber/composer; no separate key needed
      business: 'studio',
    });
    studioRuntime.router.init();
    studioWhatsapp.onMessage((msg) => studioRuntime.router.handle(msg));

    studioState.ready = true;
    log.info('[studio] Boot complete.');

    // Connect the Studio's own WhatsApp number last, same as Party.
    await studioWhatsapp.start();
  } catch (err) {
    // Never let a Studio boot problem take Party down with it.
    studioState.bootError = err.message;
    log.error(`[studio] Boot failed: ${err.stack || err.message}`);
  }
}

const app = createServer({
  config, state, whatsapp, settings, runtime, catalog,
  studio: { state: studioState, runtime: studioRuntime, whatsapp: studioWhatsapp, directory },
});
const server = app.listen(config.web.port, () => {
  log.info(`HTTP listening on port ${config.web.port} (env ${config.env}, tz ${config.tz})`);
  if (!config.web.dashboardPassword) log.warn('DASHBOARD_PASSWORD is not set - the dashboard cannot be opened.');
  boot()
    .catch((err) => {
      state.bootError = err.message;
      log.error(`Boot failed: ${err.stack || err.message}`);
    })
    .finally(() => {
      // Studio boots after Party is fully up, and never on Party's own promise
      // chain, so nothing it does can delay or fail Party's boot.
      void bootStudio();
    });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received - saving data and shutting down.`);
  server.close();
  try {
    await whatsapp.stop();
  } catch (err) {
    log.warn(`WhatsApp stop failed: ${err.message}`);
  }
  try {
    await studioWhatsapp.stop();
  } catch (err) {
    log.warn(`[studio] WhatsApp stop failed: ${err.message}`);
  }
  try {
    await db.flush();
    log.info('All data saved.');
  } catch (err) {
    log.error(`Final save failed: ${err.message}`);
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error(`Unhandled rejection: ${err?.stack || err}`));
process.on('uncaughtException', (err) => log.error(`Uncaught exception: ${err?.stack || err}`));

module.exports = { app, state, runtime, studioState, studioRuntime, studioWhatsapp };
