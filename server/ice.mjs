// ICE server configuration for Pol.
//
// STUN is always included. TURN is optional and comes from the environment:
//   TURN_URLS       comma-separated turn:/turns: URLs
//   TURN_SECRET     shared secret for time-limited credentials (coturn REST API)
//   TURN_TTL        credential lifetime in seconds (default 3600)
// or static credentials:
//   TURN_USERNAME / TURN_PASSWORD
//
// The secret never reaches the browser: clients get a short-lived username
// and an HMAC credential instead.

import { createHmac } from 'node:crypto';

export const DEFAULT_STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];
const DEFAULT_TTL = 3600;

export function parseList(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function turnCredential(secret, ttl = DEFAULT_TTL, now = Date.now()) {
  const lifetime = Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_TTL;
  const username = `${Math.floor(now / 1000) + lifetime}:pol`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, ttl: lifetime };
}

/**
 * Build the ICE list for a client. Returns only public data.
 * @param {Record<string, string | undefined>} env
 * @param {number} now
 */
export function buildIceServers(env = process.env, now = Date.now()) {
  const stun = parseList(env.STUN_URLS);
  const servers = [{ urls: stun.length > 0 ? stun : DEFAULT_STUN }];

  const turnUrls = parseList(env.TURN_URLS);
  let ttl = 0;

  if (turnUrls.length > 0 && typeof env.TURN_SECRET === 'string' && env.TURN_SECRET.length > 0) {
    const requested = Number(env.TURN_TTL ?? DEFAULT_TTL);
    const generated = turnCredential(env.TURN_SECRET, requested, now);
    servers.push({
      urls: turnUrls,
      username: generated.username,
      credential: generated.credential,
    });
    ttl = generated.ttl;
  } else if (
    turnUrls.length > 0 &&
    typeof env.TURN_USERNAME === 'string' &&
    env.TURN_USERNAME.length > 0 &&
    typeof env.TURN_PASSWORD === 'string' &&
    env.TURN_PASSWORD.length > 0
  ) {
    servers.push({
      urls: turnUrls,
      username: env.TURN_USERNAME,
      credential: env.TURN_PASSWORD,
    });
  }

  return { iceServers: servers, ttl };
}

/** True when TURN_URLS is set without any way to authenticate. */
export function hasIncompleteTurn(env = process.env) {
  const turnUrls = parseList(env.TURN_URLS);
  if (turnUrls.length === 0) return false;
  const hasSecret = typeof env.TURN_SECRET === 'string' && env.TURN_SECRET.length > 0;
  const hasStatic =
    typeof env.TURN_USERNAME === 'string' &&
    env.TURN_USERNAME.length > 0 &&
    typeof env.TURN_PASSWORD === 'string' &&
    env.TURN_PASSWORD.length > 0;
  return !hasSecret && !hasStatic;
}
