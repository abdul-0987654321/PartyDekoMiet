'use strict';
/**
 * Google Calendar access.
 *
 * A service account is used rather than OAuth: an OAuth app left in "Testing"
 * mode expires its refresh token after seven days, which would silently kill
 * availability checks every week. A service account key does not expire.
 *
 * The one thing a service account cannot do on a personal Gmail calendar is
 * email invitations to guests (that needs domain-wide delegation, Workspace
 * only). We never invite guests, so it does not matter.
 *
 * Calls go to the Calendar REST API directly with fetch, so the heavy googleapis
 * package is not needed on a 512 MB instance.
 */

const { JWT } = require('google-auth-library');
const log = require('../log');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const API = 'https://www.googleapis.com/calendar/v3';
const TIMEOUT_MS = 20000;

/**
 * Accepts the service account key in whichever form is easiest to paste:
 * the raw JSON straight out of the downloaded file, or base64 of it.
 *
 * Pasting the raw JSON is one step fewer and avoids the usual mistake of a
 * base64 string broken across lines. Both are supported so neither way fails.
 */
function readServiceAccount(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  let json = null;
  if (value.startsWith('{')) {
    try {
      json = JSON.parse(value);
    } catch (err) {
      throw new Error(`The service account JSON could not be parsed: ${err.message}`);
    }
  } else {
    let decoded;
    try {
      decoded = Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      throw new Error('The service account key is neither JSON nor valid base64.');
    }
    try {
      json = JSON.parse(decoded);
    } catch {
      throw new Error(
        'The service account key decoded from base64 but is not JSON. ' +
          'Tip: you can paste the contents of the downloaded .json file directly instead.'
      );
    }
  }

  if (!json.client_email || !json.private_key) {
    throw new Error('The service account JSON has no client_email / private_key - is this the right file?');
  }
  // Env vars often arrive with the newlines in the key escaped as \n.
  if (typeof json.private_key === 'string') {
    json.private_key = json.private_key.replace(/\\n/g, '\n');
  }
  return json;
}

function createCalendarClient({ serviceAccountJsonB64, getCalendarId, settingName = 'GOOGLE_CALENDAR_ID' }) {
  const key = readServiceAccount(serviceAccountJsonB64);
  if (!key) return null;

  const auth = new JWT({ email: key.client_email, key: key.private_key, scopes: SCOPES });
  log.info(`Calendar client ready as ${key.client_email}`);

  async function call(path, { method = 'GET', query, body } = {}) {
    const token = await auth.getAccessToken();
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token.token || token}`,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        detail = JSON.parse(text).error?.message || detail;
      } catch {
        /* keep the raw text */
      }
      // Name the setting this client actually reads, and quote the id it tried.
      // The two businesses have separate calendars, so a message hardcoded to
      // GOOGLE_CALENDAR_ID sends whoever is debugging the Studio to the wrong
      // setting - and a 404 is just as often a typo in the id as a missing share.
      if (res.status === 404) {
        throw new Error(
          `Calendar "${getCalendarId()}" not found. Check ${settingName}, and that this calendar ` +
            `is shared with ${key.client_email} with "Make changes to events".`
        );
      }
      if (res.status === 403) {
        throw new Error(
          `Calendar "${getCalendarId()}" access denied. Share it with ${key.client_email} and give it ` +
            `"Make changes to events". (${detail})`
        );
      }
      throw new Error(`Calendar API ${res.status}: ${detail}`);
    }
    return text ? JSON.parse(text) : {};
  }

  const calId = () => encodeURIComponent(getCalendarId());

  return {
    serviceAccountEmail: key.client_email,

    /** Confirms the credentials and the sharing actually work. */
    async check() {
      const cal = await call(`/calendars/${calId()}`);
      return { ok: true, calendar: cal.summary, timeZone: cal.timeZone };
    },

    /** Events overlapping [timeMin, timeMax). Expands recurring events. */
    async listEvents({ timeMin, timeMax, maxResults = 250 }) {
      const out = [];
      let pageToken;
      do {
        const page = await call(`/calendars/${calId()}/events`, {
          query: {
            timeMin,
            timeMax,
            singleEvents: 'true',
            orderBy: 'startTime',
            maxResults,
            showDeleted: 'false',
            pageToken,
          },
        });
        out.push(...(page.items || []));
        pageToken = page.nextPageToken;
      } while (pageToken && out.length < 2000);
      return out;
    },

    async createEvent(event) {
      return call(`/calendars/${calId()}/events`, { method: 'POST', body: event });
    },

    async patchEvent(eventId, patch) {
      return call(`/calendars/${calId()}/events/${encodeURIComponent(eventId)}`, {
        method: 'PATCH',
        body: patch,
      });
    },

    async deleteEvent(eventId) {
      return call(`/calendars/${calId()}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
    },
  };
}

module.exports = { createCalendarClient, readServiceAccount };
