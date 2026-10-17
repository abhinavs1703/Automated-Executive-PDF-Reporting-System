import crypto from 'node:crypto';
import { config } from './config.js';

export function sessionCookieName() {
  return config.nodeEnv === 'production' ? '__Host-execubrief_session' : 'execubrief_session';
}

function secureCookieSuffix() {
  return config.nodeEnv === 'production' ? '; Secure' : '';
}

export function readCookie(req, name) {
  const header = req.get('cookie') || '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

export function appendCookie(res, name, value, { maxAgeSeconds = 600, httpOnly = true } = {}) {
  const flags = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (httpOnly) flags.push('HttpOnly');
  if (config.nodeEnv === 'production') flags.push('Secure');
  res.append('Set-Cookie', flags.join('; '));
}

export function clearCookie(res, name, { httpOnly = true } = {}) {
  const flags = [`${name}=`, 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (httpOnly) flags.push('HttpOnly');
  if (config.nodeEnv === 'production') flags.push('Secure');
  res.append('Set-Cookie', flags.join('; '));
}

export function setSessionCookie(res, session) {
  appendCookie(res, sessionCookieName(), session.rawToken, { maxAgeSeconds: session.maxAgeSeconds });
}

export function clearSessionCookie(res) {
  clearCookie(res, sessionCookieName());
}

export function resolveSession(storeProvider) {
  return (req, res, next) => {
    try {
      const token = readCookie(req, sessionCookieName());
      req.authSessionToken = token;
      if (!token) return next();
      const session = storeProvider().resolveSession(token);
      if (!session) {
        clearSessionCookie(res);
        return next();
      }
      req.authUser = session.user;
      req.authCsrfToken = session.csrfToken;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function requireAuthenticated(req, res, next) {
  if (!req.authUser) return res.status(401).json({ error: 'Sign in to use your private reporting workspace.' });
  return next();
}

export function isSameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.origin === `${req.protocol}://${req.get('host')}`;
  } catch {
    return false;
  }
}

function safeTokenEqual(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function requireSameOrigin(req, res, next) {
  if (!isSameOrigin(req)) return res.status(403).json({ error: 'Request origin could not be verified. Reload the page and try again.' });
  return next();
}

export function requireCsrf(req, res, next) {
  if (!req.authUser || !req.authCsrfToken || !isSameOrigin(req) || !safeTokenEqual(req.get('x-csrf-token'), req.authCsrfToken)) {
    return res.status(403).json({ error: 'Security check failed. Reload the page and try again.' });
  }
  return next();
}

export function createAuthRateLimiter({ limit = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const requests = new Map();
  return {
    allow(key, now = Date.now()) {
      const recent = (requests.get(key) || []).filter((time) => now - time < windowMs);
      if (recent.length >= limit) {
        requests.set(key, recent);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000)) };
      }
      recent.push(now);
      requests.set(key, recent);
      if (requests.size > 2000) {
        for (const [entry, times] of requests) if (times.every((time) => now - time >= windowMs)) requests.delete(entry);
      }
      return { allowed: true };
    },
  };
}

export function getSafeUploadFilename(value) {
  const input = typeof value === 'string' ? value.replace(/\\/g, '/') : 'upload.csv';
  const basename = input.split('/').pop() || 'upload.csv';
  const safe = basename.replace(/[\u0000-\u001f<>:"|?*]/g, '_').slice(0, 120);
  if (!safe || !safe.toLowerCase().endsWith('.csv')) throw new Error('Upload filename must end in .csv.');
  return safe;
}

export function safeLocalRedirect(value, fallback = '/custom-reports') {
  return typeof value === 'string' && /^\/(?!\/)[A-Za-z0-9/_?=&.-]{0,150}$/.test(value) ? value : fallback;
}

export function deriveRequestOrigin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

export function secureGoogleCookieSuffix() {
  return secureCookieSuffix();
}
