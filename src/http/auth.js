'use strict';
/**
 * Dashboard login: one password from env DASHBOARD_PASSWORD, stored in a signed,
 * HttpOnly cookie valid for 7 days. No session storage needed (works across restarts).
 */

const crypto = require('crypto');

const COOKIE = 'dash_session';
const MAX_AGE_S = 7 * 24 * 3600;

function password() {
  return process.env.DASHBOARD_PASSWORD || '';
}

function sign(value) {
  return crypto.createHmac('sha256', 'dashboard:' + password()).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isLoggedIn(req) {
  if (!password()) return false;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return false;
  const [expires, sig] = token.split('.');
  if (!expires || !sig || Number(expires) < Date.now() / 1000) return false;
  return safeEqual(sig, sign(expires));
}

function login(req, res) {
  if (!password() || !safeEqual(req.body?.password || '', password())) return false;
  const expires = String(Math.floor(Date.now() / 1000) + MAX_AGE_S);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${expires}.${sign(expires)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`
  );
  return true;
}

function logout(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Express middleware: API calls get 401, page requests are redirected to /login. */
function requireLogin(req, res, next) {
  if (isLoggedIn(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
  return res.redirect('/login');
}

module.exports = { isLoggedIn, login, logout, requireLogin };
