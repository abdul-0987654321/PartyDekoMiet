'use strict';
/**
 * Which WhatsApp Web protocol version to hand Baileys.
 *
 * Since early 2026 WhatsApp has rejected fresh device registrations with
 * "code 405: Connection Failure" before a QR code is ever issued. It is not
 * specific to one bot, fork or host (WhiskeySockets/Baileys#2370, #2679).
 *
 * The cause reported by the people who got past it: `fetchLatestBaileysVersion()`
 * does NOT ask WhatsApp anything. It reads a version hardcoded in the Baileys
 * repo, last changed in March 2026, so it hands back a build WhatsApp no longer
 * accepts. `fetchLatestWaWebVersion()` reads the build web.whatsapp.com is
 * actually serving right now, and pairing is reported to succeed with it.
 *
 * Hence the order below: the live source first, the hardcoded list only as a
 * fallback, and a pinned constant last. Pinning alone is a trap - any constant
 * goes stale the same way, which is how the previous pin (2.3000.1033893291)
 * ended up OLDER than the version the bug reports call broken.
 *
 * Both fetchers are injected rather than required here, so this stays testable
 * without the Baileys package installed.
 */

/**
 * Last resort only. Newest version reported accepted by WhatsApp's servers in
 * Baileys#2679 (2026-07-28). It will go stale too - it exists so a failed
 * network lookup still produces something more recent than the library default,
 * not as the primary answer.
 */
const PINNED_FALLBACK = Object.freeze([2, 3000, 1044015310]);

/** A usable version is exactly three numbers, e.g. [2, 3000, 1044015310]. */
function isValidVersion(value) {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => Number.isInteger(n) && n >= 0)
  );
}

/**
 * WHATSAPP_VERSION lets the pin be corrected on a live deploy without a code
 * change, for when WhatsApp moves the target again.
 * @returns {number[]|null}
 */
function parseVersionEnv(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isValidVersion(parsed) ? parsed : null;
  } catch {
    // Also accept a plain "2.3000.1044015310", which is how the version is
    // written in logs and bug reports - easier to paste correctly.
    const parts = String(raw).trim().split('.').map(Number);
    return isValidVersion(parts) ? parts : null;
  }
}

/**
 * @param {object} deps
 * @param {Function} [deps.fetchWaWeb]    Baileys' fetchLatestWaWebVersion
 * @param {Function} [deps.fetchBaileys]  Baileys' fetchLatestBaileysVersion
 * @param {object}   [deps.env]           defaults to process.env
 * @param {object}   [deps.log]           {info, warn} - optional
 * @returns {Promise<{version:number[], source:string}>}
 */
async function resolveWaVersion({ fetchWaWeb, fetchBaileys, env = process.env, log } = {}) {
  const note = (msg) => log?.info?.(msg);

  const override = parseVersionEnv(env.WHATSAPP_VERSION);
  if (override) {
    note(`WhatsApp protocol ${override.join('.')} (WHATSAPP_VERSION override)`);
    return { version: override, source: 'env' };
  }

  // 1. What web.whatsapp.com is serving right now.
  if (typeof fetchWaWeb === 'function') {
    try {
      const res = await fetchWaWeb();
      if (isValidVersion(res?.version)) {
        note(`WhatsApp protocol ${res.version.join('.')} (live from web.whatsapp.com)`);
        return { version: res.version, source: 'wa-web' };
      }
    } catch (err) {
      log?.warn?.(`Live WhatsApp version lookup failed (${err.message}) - falling back`);
    }
  }

  // 2. The Baileys list. It resolves even when its own fetch fails, flagging the
  //    stale bundled value with isLatest:false - which is the version that gets
  //    rejected, so that case is treated as a failure rather than an answer.
  if (typeof fetchBaileys === 'function') {
    try {
      const res = await fetchBaileys();
      if (isValidVersion(res?.version) && res.isLatest !== false) {
        note(`WhatsApp protocol ${res.version.join('.')} (Baileys version list)`);
        return { version: res.version, source: 'baileys' };
      }
    } catch (err) {
      log?.warn?.(`Baileys version lookup failed (${err.message}) - using the pinned fallback`);
    }
  }

  note(`WhatsApp protocol ${PINNED_FALLBACK.join('.')} (pinned fallback - both lookups failed)`);
  return { version: [...PINNED_FALLBACK], source: 'pinned' };
}

module.exports = { resolveWaVersion, parseVersionEnv, isValidVersion, PINNED_FALLBACK };
