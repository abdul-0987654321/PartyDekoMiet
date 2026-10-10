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
const { createAgent } = require('./agent/agent');
const catalog = require('./catalog');
const { createCalendarService } = require('./calendar');
const { createBookings } = require('./bookings');
const { createNotifier } = require('./notify/owner');
const { createMessenger } = require('./whatsapp/messenger');
const { createRouter } = require('./whatsapp/router');
const whatsapp = require('./whatsapp/client');
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

const runtime = { agent: null, calendar: null, bookings: null, router: null, notify: null, services: {} };

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
      state.storageError = `Google Sheet not reachable: ${err.message}`;
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

  const guards = createGuards({
    faqAnswers: knowledge.faq.flatMap((e) => [e.a_de, e.a_en]),
    depositChf: settings.get('depositChf'),
    lateFeeChf: settings.get('lateFeeChf'),
  });

  if (config.openai.apiKey) {
    const OpenAI = require('openai');
    runtime.agent = createAgent({
      openai: new OpenAI({ apiKey: config.openai.apiKey }),
      knowledge,
      guards,
      config: config.openai,
    });
    log.info(`Agent ready (${config.openai.model})`);
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
  });
  runtime.router.init();
  whatsapp.onMessage((msg) => runtime.router.handle(msg));

  state.ready = true;
  log.info('Boot complete.');

  // 6. Connect WhatsApp last: everything it needs is now in place.
  await whatsapp.start();
}

const app = createServer({ config, state, whatsapp, settings, runtime, catalog });
const server = app.listen(config.web.port, () => {
  log.info(`HTTP listening on port ${config.web.port} (env ${config.env}, tz ${config.tz})`);
  if (!config.web.dashboardPassword) log.warn('DASHBOARD_PASSWORD is not set - the dashboard cannot be opened.');
  boot().catch((err) => {
    state.bootError = err.message;
    log.error(`Boot failed: ${err.stack || err.message}`);
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

module.exports = { app, state, runtime };
