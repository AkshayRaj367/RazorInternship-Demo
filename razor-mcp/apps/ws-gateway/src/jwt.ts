/**
 * Minimal HS256 JWT verification with node:crypto — NO jsonwebtoken dependency.
 *
 * Verifies: signature (HMAC-SHA256 over header.payload), exp, and returns the
 * claims. Used by the socket 'join' handshake to pin browser sockets to the
 * authenticated user's room ("user:<uid>:<sessionId>").
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

interface JwtClaims {
  sub: string;
  email?: string;
  type?: string;
  iat?: number;
  exp?: number;
  [key: string]: unknown;
}

function b64urlToBuffer(s: string): Buffer {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4 !== 0) b += '=';
  return Buffer.from(b, 'base64');
}

/** Verify a token against the secret; return claims or null (never throws). */
export function verifyJwt(token: unknown, secret: string): JwtClaims | null {
  if (typeof token !== 'string' || token.length < 20 || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  try {
    const header = JSON.parse(b64urlToBuffer(headerB64).toString('utf8')) as { alg?: string };
    if (header?.alg !== 'HS256') return null;

    const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
    const actual = b64urlToBuffer(sigB64);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

    const claims = JSON.parse(b64urlToBuffer(payloadB64).toString('utf8')) as JwtClaims;
    if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) return null; // expired
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) return null;
    return claims;
  } catch {
    return null;
  }
}
