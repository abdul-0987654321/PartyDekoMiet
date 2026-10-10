'use strict';
/**
 * Entry point.
 *
 * Boot order matters on Render: the HTTP server starts first and answers /health
 * immediately, so the health check passes and the deploy is marked live even while
 * the Google Sheet is still being loaded. Storage then connects in the background
 * and keeps retrying - a sheet that is briefly unreachable must not take the
 * service down.
 */

const { config, require: requireConfig } = require('./config');
const log = require('./log');
const db = require('./store/db');
const { createSheetsBackend } = require('./store/backend-sheets');
const { createMemoryBackend } = require('./store/backend-memory');
const knowledgeLoader = require('./knowledge');
const { createGuards } = require('./agent/guards');
const { createAgent } = require('./agent/agent');
const { createServer } = require('./http/server');

const state = {
  startedAt: new Date().toISOString(),
  ready: false,
  storageError: null,
  storageWarning: null,
  knowledge: null,
};

let agent = null;
const whatsapp = null; // wired in the WhatsApp phase

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

  // Keep retrying: never start WhatsApp without the stored session, or the owner
  // would be asked for a new QR code every time the sheet hiccups.
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
  const knowledge = await knowledgeLoader.load({ source: config.knowledge.source });
  state.knowledge = { source: knowledge.source, faqEntries: knowledge.faq.length };

  const guards = createGuards({
    faqAnswers: knowledge.faq.flatMap((e) => [e.a_de, e.a_en]),
    depositChf: config.business.depositChf,
    lateFeeChf: config.business.lateFeeChf,
  });

  if (config.openai.apiKey) {
    const OpenAI = require('openai');
    agent = createAgent({
      openai: new OpenAI({ apiKey: config.openai.apiKey }),
      knowledge,
      guards,
      config: config.openai,
    });
    log.info(`Agent ready (${config.openai.model})`);
  } else {
    log.warn('OPENAI_API_KEY is not set - the agent is not started.');
  }

  await connectStorage();

  state.ready = true;
  log.info('Boot complete.');
}

const app = createServer({ config, state, whatsapp });
const server = app.listen(config.web.port, () => {
  log.info(`HTTP listening on port ${config.web.port} (env ${config.env}, tz ${config.tz})`);
  if (!config.web.dashboardPassword) {
    log.warn('DASHBOARD_PASSWORD is not set - the dashboard cannot be opened.');
  }
  boot().catch((err) => {
    log.error(`Boot failed: ${err.stack || err.message}`);
    state.storageError = err.message;
  });
});

/** Render sends SIGTERM on every deploy and restart: save what is queued, then exit. */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received - saving data and shutting down.`);
  server.close();
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

module.exports = { app, state, getAgent: () => agent };
