'use strict';
/**
 * Reads and validates the environment. Fails fast and loudly: a bot that starts
 * with a missing key only to break on the first customer is worse than one that
 * refuses to start.
 *
 * Features are validated per area, so the local CLI chat can run with only an
 * OpenAI key, without a Google Sheet or a calendar.
 */

require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

const config = {
  env: process.env.NODE_ENV || 'development',
  tz: process.env.TZ || 'Europe/Zurich',

  storage: {
    webhookUrl: process.env.SHEET_WEBHOOK_URL || '',
    secret: process.env.SHEET_SECRET || '',
    flushMs: num(process.env.STORAGE_FLUSH_MS, 1500),
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    timeoutMs: num(process.env.OPENAI_TIMEOUT_MS, 30000),
    maxRetries: num(process.env.OPENAI_MAX_RETRIES, 2),
    maxSteps: num(process.env.AGENT_MAX_STEPS, 6),
  },

  whatsapp: {
    ownerNumber: String(process.env.OWNER_WHATSAPP || '').replace(/[^0-9]/g, ''),
    takeoverPauseHours: num(process.env.TAKEOVER_PAUSE_HOURS, 12),
    typingMinMs: num(process.env.TYPING_MIN_MS, 2000),
    typingMaxMs: num(process.env.TYPING_MAX_MS, 5000),
    maxMsgsPerChatPerHour: num(process.env.MAX_MSGS_PER_CHAT_PER_HOUR, 30),
  },

  calendar: {
    id: process.env.GOOGLE_CALENDAR_ID || '',
    serviceAccountJsonB64: process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 || '',
    oauth: {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
      refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '',
    },
  },

  shop: {
    url: (process.env.SHOP_URL || 'https://partydekomiet.ch').replace(/\/+$/, ''),
    refreshHours: num(process.env.CATALOG_REFRESH_HOURS, 6),
    depositProductUrl: process.env.DEPOSIT_PRODUCT_URL || '',
  },

  business: {
    rentalDays: num(process.env.RENTAL_DAYS, 3),
    depositChf: num(process.env.DEPOSIT_CHF, 50),
    lateFeeChf: num(process.env.LATE_FEE_CHF, 50),
    pickupAddress: process.env.PICKUP_ADDRESS || '',
    pickupHours: process.env.PICKUP_HOURS || '',
    bufferDays: num(process.env.BUFFER_DAYS, 0),
    handoffPhone: process.env.HANDOFF_PHONE || '',
  },

  web: {
    port: num(process.env.PORT, 3000),
    dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  },

  knowledge: {
    source: process.env.KNOWLEDGE_SOURCE || 'files',
  },

  debug: bool(process.env.DEBUG, false),
};

/**
 * @param {string[]} features  any of: openai, storage, whatsapp, calendar, web
 * @throws if something required for those features is missing
 */
function require_(features) {
  const missing = [];
  const need = (cond, name) => {
    if (!cond) missing.push(name);
  };

  for (const f of features) {
    if (f === 'openai') need(config.openai.apiKey, 'OPENAI_API_KEY');
    if (f === 'storage') {
      need(config.storage.webhookUrl, 'SHEET_WEBHOOK_URL');
      need(config.storage.secret, 'SHEET_SECRET');
      need(config.storage.secret !== 'change-me-long-random-string', 'SHEET_SECRET (still the example value)');
    }
    if (f === 'whatsapp') need(config.whatsapp.ownerNumber.length >= 8, 'OWNER_WHATSAPP');
    if (f === 'calendar') {
      need(config.calendar.id, 'GOOGLE_CALENDAR_ID');
      need(
        config.calendar.serviceAccountJsonB64 || config.calendar.oauth.refreshToken,
        'GOOGLE_SERVICE_ACCOUNT_JSON_B64 (or the OAuth fallback)'
      );
    }
    if (f === 'web') {
      need(config.web.dashboardPassword, 'DASHBOARD_PASSWORD');
      need(config.web.dashboardPassword !== 'change-me', 'DASHBOARD_PASSWORD (still the example value)');
    }
  }

  if (missing.length) {
    throw new Error(
      `Missing configuration: ${missing.join(', ')}.\n` +
        `Copy .env.example to .env and fill those in (on Render: Environment > Environment Variables).`
    );
  }
}

module.exports = { config, require: require_ };
