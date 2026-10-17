import crypto from 'node:crypto';
import { URLSearchParams } from 'node:url';

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
let jwksCache = { keys: [], expiresAt: 0 };

function decodeJsonSegment(segment, label) {
  try { return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')); }
  catch { throw new Error(`Google returned an invalid ${label}.`); }
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function fetchGoogleKeys({ forceRefresh = false, fetchImpl = fetch, now = Date.now } = {}) {
  if (!forceRefresh && jwksCache.expiresAt > now() && jwksCache.keys.length) return jwksCache.keys;
  const response = await fetchImpl(GOOGLE_CERTS_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Google signing keys are temporarily unavailable.');
  const body = await response.json();
  if (!Array.isArray(body.keys)) throw new Error('Google returned an invalid signing-key set.');
  const cacheHeader = response.headers.get('cache-control') || '';
  const maxAgeMatch = /max-age=(\d+)/i.exec(cacheHeader);
  const maxAge = Math.min(24 * 60 * 60, Math.max(60, Number(maxAgeMatch?.[1] || 3600)));
  jwksCache = { keys: body.keys, expiresAt: now() + maxAge * 1000 };
  return jwksCache.keys;
}

/** Verify a Google OpenID Connect ID token using Google's published rotating JWKS. */
export async function verifyGoogleIdToken(token, { audience, nonce, fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (typeof token !== 'string' || token.length > 16384) throw new Error('Google returned an invalid identity token.');
  const segments = token.split('.');
  if (segments.length !== 3) throw new Error('Google returned an invalid identity token.');
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const header = decodeJsonSegment(encodedHeader, 'identity token header');
  const claims = decodeJsonSegment(encodedPayload, 'identity token payload');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Google used an unsupported identity-token signature.');

  let keys = await fetchGoogleKeys({ fetchImpl, now });
  let jwk = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === 'RSA' && (!candidate.use || candidate.use === 'sig'));
  if (!jwk) {
    keys = await fetchGoogleKeys({ forceRefresh: true, fetchImpl, now });
    jwk = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === 'RSA' && (!candidate.use || candidate.use === 'sig'));
  }
  if (!jwk) throw new Error('Google identity-token signing key was not recognized.');

  let validSignature = false;
  try {
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    validSignature = crypto.verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`), publicKey, Buffer.from(encodedSignature, 'base64url'));
  } catch { validSignature = false; }
  if (!validSignature) throw new Error('Google identity-token signature is invalid.');

  const currentSeconds = Math.floor(now() / 1000);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) throw new Error('Google identity-token issuer is invalid.');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience || !audiences.includes(audience)) throw new Error('Google identity-token audience is invalid.');
  if (audiences.length > 1 && claims.azp !== audience) throw new Error('Google identity-token authorized party is invalid.');
  if (!Number.isFinite(claims.exp) || claims.exp <= currentSeconds) throw new Error('Google identity token has expired.');
  if (!Number.isFinite(claims.iat) || claims.iat > currentSeconds + 120) throw new Error('Google identity-token issue time is invalid.');
  if (!safeEqual(claims.nonce, nonce)) throw new Error('Google nonce validation failed.');
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.email !== 'string') throw new Error('Google identity token is missing account information.');
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  if (!emailVerified) throw new Error('Google has not verified this email address.');

  return {
    sub: claims.sub,
    email: claims.email,
    emailVerified,
    name: typeof claims.name === 'string' ? claims.name : '',
    picture: typeof claims.picture === 'string' ? claims.picture : null,
  };
}

export async function exchangeGoogleCode({ code, clientId, clientSecret, redirectUri, fetchImpl = fetch }) {
  if (![code, clientId, clientSecret, redirectUri].every((value) => typeof value === 'string' && value.length)) {
    throw new Error('Google sign-in is not configured.');
  }
  const body = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Google could not complete sign-in. Please try again.');
  const tokens = await response.json();
  if (typeof tokens.id_token !== 'string') throw new Error('Google did not return an identity token.');
  return tokens.id_token;
}

export function clearGoogleSigningKeyCache() {
  jwksCache = { keys: [], expiresAt: 0 };
}
