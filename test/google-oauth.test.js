import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { clearGoogleSigningKeyCache, verifyGoogleIdToken } from '../src/google-oauth.js';

function encoded(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

function signedToken(privateKey, payload, kid = 'test-key') {
  const header = encoded({ alg: 'RS256', kid, typ: 'JWT' });
  const body = encoded(payload);
  const signingInput = `${header}.${body}`;
  return `${signingInput}.${crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')}`;
}

function response(body) {
  return { ok: true, headers: { get: () => 'public, max-age=3600' }, json: async () => body };
}

test('Google ID token verification checks signature, issuer, audience, expiry, nonce and verified email', async () => {
  clearGoogleSigningKeyCache();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' };
  const now = Math.floor(Date.now() / 1000);
  const token = signedToken(privateKey, {
    iss: 'https://accounts.google.com', aud: 'test-client', exp: now + 3600, iat: now,
    nonce: 'expected-nonce', sub: 'subject-123', email: 'verified@example.com', email_verified: true,
    name: 'Verified Person', picture: 'https://example.com/picture.png',
  });
  const fetchImpl = async () => response({ keys: [jwk] });
  const identity = await verifyGoogleIdToken(token, { audience: 'test-client', nonce: 'expected-nonce', fetchImpl });
  assert.equal(identity.sub, 'subject-123');
  assert.equal(identity.email, 'verified@example.com');
  assert.equal(identity.emailVerified, true);
  await assert.rejects(verifyGoogleIdToken(token, { audience: 'other-client', nonce: 'expected-nonce', fetchImpl }), /audience/i);
  await assert.rejects(verifyGoogleIdToken(token, { audience: 'test-client', nonce: 'wrong-nonce', fetchImpl }), /nonce/i);
});

test('Google ID token verification rejects expired or unverified identities', async () => {
  clearGoogleSigningKeyCache();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key-expired', use: 'sig', alg: 'RS256' };
  const now = Math.floor(Date.now() / 1000);
  const fetchImpl = async () => response({ keys: [jwk] });
  const expired = signedToken(privateKey, { iss: 'accounts.google.com', aud: 'test-client', exp: now - 1, iat: now - 60, nonce: 'n', sub: 's', email: 'a@example.com', email_verified: true }, 'test-key-expired');
  await assert.rejects(verifyGoogleIdToken(expired, { audience: 'test-client', nonce: 'n', fetchImpl }), /expired/i);
});
