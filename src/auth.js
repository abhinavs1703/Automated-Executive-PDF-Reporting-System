import crypto from 'node:crypto';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export const isLoopbackHost = (host) => LOOPBACK_HOSTS.has(String(host).toLowerCase());

/**
 * Fail closed: refuse to start in a configuration that would expose the
 * report-generation and download endpoints without protection.
 *  - NODE_ENV=production always requires API_AUTH_TOKEN.
 *  - Binding to anything other than loopback requires API_AUTH_TOKEN.
 */
export function assertSafeBinding({ host, apiAuthToken, nodeEnv }) {
  if (apiAuthToken && apiAuthToken.length < 16) {
    throw new Error('API_AUTH_TOKEN is too short; use at least 16 characters (for example: openssl rand -hex 32).');
  }
  if (apiAuthToken) return;
  if (nodeEnv === 'production') {
    throw new Error('API_AUTH_TOKEN is required when NODE_ENV=production.');
  }
  if (!isLoopbackHost(host)) {
    throw new Error(`Refusing to listen on ${host} without API_AUTH_TOKEN. Set API_AUTH_TOKEN, or bind HOST=127.0.0.1.`);
  }
}

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

/** Bearer-token middleware using a constant-time comparison. A falsy token disables auth. */
export function bearerAuth(token) {
  if (!token) return (_req, _res, next) => next();
  const expected = digest(token);
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match && crypto.timingSafeEqual(digest(match[1].trim()), expected)) return next();
    res.set('WWW-Authenticate', 'Bearer realm="reports"');
    return res.status(401).json({ error: 'Authentication required.' });
  };
}
