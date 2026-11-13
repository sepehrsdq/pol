// ICE server configuration for Pol.
//
// STUN is always included. TURN comes from one of two sources, in order:
//
// 1. Metered (https://metered.ca) — managed TURN with the free 20 GB/month
//    tier. Configured with two env vars and nothing else:
//      METERED_APP    app name from the dashboard (the part before .metered.live)
//      METERED_KEY    API key of the TURN credential
//    The server asks Metered for short-lived iceServers, caches them for
//    CACHE_TTL_MS and hands them to clients via GET /ice.
//
// 2. Self-hosted TURN from the environment:
//      TURN_URLS       comma-separated turn:/turns: URLs
//      TURN_SECRET     shared secret for time-limited credentials (coturn REST API)
//      TURN_TTL        credential lifetime in seconds (default 3600)
//    or static credentials:
//      TURN_USERNAME / TURN_PASSWORD
//
// Keys and secrets never reach the browser: clients get short-lived
// credentials, or nothing at all.

import { createHmac } from 'node:crypto';

export const DEFAULT_STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];
const DEFAULT_TTL = 3600;
const CACHE_TTL_MS = 10 * 60 * 1000;

/** @type {{ servers: unknown[], fetchedAt: number } | null} */
let meteredCache = null;

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

/**
 * True when both METERED_APP and METERED_KEY are present.
 * @param {Record<string, string | undefined>} env
 */
export function hasMetered(env = process.env) {
  return (
    typeof env.METERED_APP === 'string' &&
    env.METERED_APP.trim().length > 0 &&
    typeof env.METERED_KEY === 'string' &&
    env.METERED_KEY.trim().length > 0
  );
}

/** Build the Metered credentials endpoint URL. Exported for tests. */
export function meteredUrl(app, key) {
  const host = `${String(app).trim()}.metered.live`;
  const url = new URL(`https://${host}/api/v1/turn/credentials`);
  url.searchParams.set('apiKey', key);
  return url;
}

/**
 * Keep only entries that look like usable ICE server objects and rewrite
 * stun: URLs the API may return — Metered already includes its own STUN.
 * @param {unknown} value
 */
export function normalizeMeteredServers(value) {
  if (!Array.isArray(value)) return [];
  const servers = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = /** @type {Record<string, unknown>} */ (entry);
    const urls =
      typeof record.urls === 'string'
        ? [record.urls]
        : Array.isArray(record.urls)
          ? record.urls.filter((u) => typeof u === 'string')
          : [];
    const usable = urls.filter((u) => /^(stun|turn|turns):/i.test(u.trim()));
    if (usable.length === 0) continue;
    const server = { urls: usable };
    if (typeof record.username === 'string' && record.username.length > 0) {
      server.username = record.username;
    }
    if (typeof record.credential === 'string' && record.credential.length > 0) {
      server.credential = record.credential;
    }
    servers.push(server);
  }
  return servers;
}

/**
 * Fetch short-lived iceServers from Metered, with a small in-memory cache so
 * parallel /ice requests do not hammer the API. Throws on failure; callers
 * fall back to self-hosted or static config.
 * @param {Record<string, string | undefined>} env
 * @param {{ fetch?: typeof fetch, now?: number }} [deps]
 * @returns {Promise<{ iceServers: unknown[], ttl: number, cached: boolean }>}
 */
export async function fetchMeteredServers(env = process.env, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now();

  if (meteredCache && now - meteredCache.fetchedAt < CACHE_TTL_MS) {
    return { iceServers: meteredCache.servers, ttl: 0, cached: true };
  }

  const response = await doFetch(meteredUrl(env.METERED_APP, env.METERED_KEY));
  if (!response.ok) {
    throw new Error(`metered ${response.status}`);
  }
  const body = await response.json();
  const servers = normalizeMeteredServers(body);
  if (servers.length === 0) {
    throw new Error('metered returned no usable ice servers');
  }

  meteredCache = { servers, fetchedAt: now };
  return { iceServers: servers, ttl: 0, cached: false };
}

/** Test hook: forget the cached Metered response. */
export function resetMeteredCache() {
  meteredCache = null;
}
