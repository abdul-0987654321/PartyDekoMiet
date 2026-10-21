'use strict';
/**
 * Talks to the Apps Script web app in apps-script/Code.gs.
 * Every call is a POST with { secret, action, ... }; Apps Script answers with JSON.
 */

const log = require('../log');

const TIMEOUT_MS = 60000;
const MAX_HOPS = 5;

/** The redirect Apps Script uses to hand back a POST's output. */
const isEchoUrl = (u) => /script\.googleusercontent\.com/.test(u);
/** A web-app entry point. Google redirects here to canonicalise a URL. */
const isExecUrl = (u) => /\/exec(\?|#|$)/.test(u);

/**
 * The deployment id in an /exec URL is a capability - anyone holding it can
 * reach the web app - so the trace keeps the shape of the URL and drops the id.
 */
function redact(u) {
  return String(u)
    .replace(/\/s\/[^/]+\//, '/s/***/')
    .replace(/user_content_key=[^&]*/, 'user_content_key=***');
}

function createSheetsBackend({ url, secret }) {
  if (!url) throw new Error('SHEET_WEBHOOK_URL is not set');
  if (!secret) throw new Error('SHEET_SECRET is not set');

  // Updated in place when Google redirects us to the canonical /exec URL, so the
  // detour is paid once per process instead of on every single call.
  let activeUrl = url;
  let tracedOnce = false;

  /**
   * POSTs the body and returns the response text, following redirects BY HAND.
   *
   * `redirect: 'follow'` cannot be used here. Per the fetch spec a 302 turns a
   * POST into a GET with no body - and when Google redirects one /exec URL to
   * another (it does this to canonicalise the URL), that GET runs doGet()
   * instead of doPost(). The script then answers 200 ok:true with no data and
   * nothing anywhere says a redirect happened. That was a live outage.
   *
   * So: a redirect to the googleusercontent echo URL is fetched with GET - the
   * POST already ran, that URL only carries its output. A redirect to another
   * /exec URL is re-POSTed, body and all.
   */
  async function post(body, targetUrl = activeUrl, hops = 0, trace = []) {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // The trace is the only evidence available when the answer is wrong but the
    // status is 200: a POST that is answered by doGet() looks identical to a
    // working call from the outside. Two debugging rounds were lost to guessing
    // at this instead of recording it.
    trace.push(`POST ${redact(targetUrl)} -> ${res.status}`);

    if (res.status < 300 || res.status >= 400) {
      return { status: res.status, text: await res.text(), trace };
    }

    const location = res.headers.get('location');
    if (!location) throw new Error(`Apps Script redirected (HTTP ${res.status}) without a Location header`);
    if (hops >= MAX_HOPS) throw new Error(`Apps Script redirected more than ${MAX_HOPS} times`);
    const next = new URL(location, targetUrl).toString();

    if (isExecUrl(next) && !isEchoUrl(next)) {
      if (next !== activeUrl) {
        log.warn(
          `SHEET_WEBHOOK_URL redirects to a different web-app URL. Re-POSTing to it and using it ` +
            `from now on. Set SHEET_WEBHOOK_URL to this to skip the redirect: ${next}`
        );
        activeUrl = next;
      }
      return post(body, next, hops + 1, trace);
    }

    // The echo URL: GET is correct here, the script has already run.
    const echo = await fetch(next, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    trace.push(`GET ${redact(next)} -> ${echo.status}`);
    return { status: echo.status, text: await echo.text(), trace };
  }

  async function call(action, payload = {}, attempts = 3) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await post(JSON.stringify({ secret, action, ...payload }));
        const path = (res.trace || []).join(' | ');
        if (!tracedOnce) {
          tracedOnce = true;
          log.info(`Sheets HTTP path: ${path}`);
        }
        const text = res.text;
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`Apps Script returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
        }
        if (!json.ok) throw new Error(`Apps Script error: ${json.error}`);
        // Not enumerable: this must never end up written into the Sheet.
        Object.defineProperty(json, '__http', { value: path, enumerable: false });
        return json;
      } catch (err) {
        lastErr = err;
        // Neither a wrong secret nor a redirect loop fixes itself on a retry.
        if (/unauthorized|redirected more than/.test(err.message)) break;
        if (i < attempts) {
          log.warn(`Sheets ${action} failed (try ${i}/${attempts}): ${err.message}`);
          await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
        }
      }
    }
    throw lastErr;
  }

  return {
    name: 'google-sheets',
    async load(tables) {
      const res = await call('load', { tables });
      // A 'load' that answers ok:true but carries no data used to surface three
      // frames later as "Cannot convert undefined or null to object", which says
      // nothing about the actual problem. The usual cause is an Apps Script
      // deployment older than this code - Code.gs is NOT updated by deploying
      // this repo, it has to be pasted into the Apps Script editor by hand.
      if (!res.data || typeof res.data !== 'object' || Array.isArray(res.data)) {
        // Echo the whole reply: which of the two causes below it is can only be
        // told apart by what came back, and the log is the only place anyone
        // gets to see it.
        const reply = JSON.stringify(res).slice(0, 200);
        // doGet() answers { ok:true, service:'partydekomiet-bot-storage' }. Getting
        // that back from a POST means the request never reached doPost() at all,
        // which is a URL / deployment-access problem, not an outdated Code.gs.
        const cause = typeof res.service === 'string'
          ? 'That is the doGet() reply, so the POST never reached doPost(). Check that SHEET_WEBHOOK_URL ' +
            'is the /exec URL of the CURRENT deployment (not /dev, and not an older deployment), and that ' +
            'the deployment is set to "Execute as: Me" and "Who has access: Anyone".'
          : 'The deployed Code.gs is probably older than this app: open the Sheet - Extensions - ' +
            'Apps Script, paste the current apps-script/Code.gs, and Deploy - Manage deployments - Edit - Deploy.';
        const path = res.__http ? ` HTTP path: ${res.__http}.` : '';
        throw new Error(
          `Apps Script answered without a "data" object. Its reply was: ${reply}.${path} ${cause}`
        );
      }
      const missing = tables.filter((t) => !Array.isArray(res.data[t]));
      if (missing.length) {
        throw new Error(
          `Apps Script returned no rows for: ${missing.join(', ')}. ` +
            'That usually means the deployed Code.gs predates these tables - re-paste apps-script/Code.gs ' +
            'into the Apps Script editor and redeploy it.'
        );
      }
      return res.data;
    },
    async write(ops) {
      await call('write', { ops });
    },
    async putFile(name, mimeType, buffer) {
      return (await call('putFile', { name, mimeType, base64: buffer.toString('base64') })).id;
    },
    async getFile(id) {
      const r = await call('getFile', { id });
      return { mimeType: r.mimeType, buffer: Buffer.from(r.base64, 'base64') };
    },
  };
}

module.exports = { createSheetsBackend };
