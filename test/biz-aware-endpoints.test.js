'use strict';
/**
 * The dashboard has to tell the server which number it is asking about.
 *
 * It does that by appending `?biz=` - but only for the paths named in one list
 * in public/app.js. Everything else is sent without it and is answered for
 * PartyDekoMiet, because PartyDekoMiet is the default on every endpoint.
 *
 * A path missing from that list does not break. It lies, quietly, in whichever
 * direction is least helpful. It happened twice:
 *
 *   - /api/calendar missing, so the Studio's calendar showed PartyDekoMiet's
 *     rentals.
 *   - /api/alerts/where missing, so the Studio's settings page named
 *     PartyDekoMiet's alert number, which the owner read - reasonably - as the
 *     Studio sending its alerts to the wrong place.
 *
 * So this reads the server source for the routes that actually look at `biz`
 * and insists the list covers all of them. The next one is caught here rather
 * than in a conversation three weeks later.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(root, 'src/http/server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

/** The prefix list the dashboard actually uses. */
function prefixes() {
  const block = appSrc.match(/const BIZ_AWARE_PREFIXES = \[([\s\S]*?)\];/);
  assert.ok(block, 'BIZ_AWARE_PREFIXES must still be a plain array literal to be checkable');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Routes whose handler calls pick(req) - the helper that reads `biz` and hands
 * back that business's runtime.
 */
function bizAwareRoutes() {
  const found = new Set();
  // Routes are nested at different indents (some sit inside `if (lines)`), so
  // a handler runs from its own app.<verb>( to the next one at any indent.
  const starts = [...serverSrc.matchAll(/app\.(?:get|post|patch|delete)\(\s*'([^']+)'/g)];
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i].index;
    const to = i + 1 < starts.length ? starts[i + 1].index : serverSrc.length;
    if (/\bpick\(req\)/.test(serverSrc.slice(from, to))) found.add(starts[i][1]);
  }
  return [...found];
}

describe('every endpoint that reads biz is on the dashboard list', () => {
  test('the list is not empty and the scan found routes', () => {
    assert.ok(prefixes().length >= 5);
    assert.ok(bizAwareRoutes().length >= 5, 'the scan must actually be finding handlers');
  });

  test('each one is covered by a prefix', () => {
    const list = prefixes();
    const missing = bizAwareRoutes().filter((r) => !list.some((p) => r.startsWith(p)));
    assert.deepStrictEqual(
      missing,
      [],
      `these answer differently per number but the dashboard never says which: ${missing.join(', ')}`
    );
  });

  test('/api/alerts/where in particular', () => {
    // Named on its own because this is the one the owner hit: the Studio's
    // settings page showing PartyDekoMiet's alert number.
    assert.ok(bizAwareRoutes().includes('/api/alerts/where'), 'the route still reads biz');
    assert.ok(prefixes().includes('/api/alerts/where'), 'and the dashboard still sends it');
  });
});
