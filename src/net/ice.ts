/**
 * ICE configuration for Pol.
 *
 * The signaling server exposes GET /ice, which returns the STUN/TURN list it
 * wants clients to use. Deployments can add TURN credentials there without
 * rebuilding the client. VITE_ICE is kept as a build-time override for local
 * experiments.
 */

export interface IceConfig {
  servers: RTCIceServer[];
  hasTurn: boolean;
}

export const DEFAULT_STUN: RTCIceServer[] = [
  {
    urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'],
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Keep only entries that look like usable RTCIceServer objects. */
export function normalizeIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value)) return [];

  const servers: RTCIceServer[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { urls, username, credential } = entry;

    const validUrls =
      typeof urls === 'string'
        ? urls.trim().length > 0
        : Array.isArray(urls) && urls.some((item) => typeof item === 'string' && item.trim().length > 0);

    if (!validUrls) continue;

    const server: RTCIceServer = { urls: urls as string | string[] };
    if (typeof username === 'string' && username.length > 0) server.username = username;
    if (typeof credential === 'string' && credential.length > 0) server.credential = credential;
    servers.push(server);
  }
  return servers;
}

export function hasTurnServer(servers: RTCIceServer[]): boolean {
  return servers.some((server) => {
    const list = Array.isArray(server.urls) ? server.urls : [server.urls];
    return list.some((url) => typeof url === 'string' && /^turns?:/i.test(url.trim()));
  });
}

/** Parse the optional VITE_ICE JSON array, returning null when it is unusable. */
export function configuredIceServers(raw: unknown): RTCIceServer[] | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const servers = normalizeIceServers(JSON.parse(raw));
    return servers.length > 0 ? servers : null;
  } catch {
    return null;
  }
}

/** Turn the WebSocket signaling URL into the HTTP(S) /ice URL. */
export function iceEndpoint(signalUrl: string): string {
  const base = typeof window === 'undefined' ? 'http://localhost/' : window.location.href;
  const url = new URL(signalUrl, base);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/ice';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * Ask the signaling server for ICE servers. Falls back to public STUN when
 * the endpoint is missing, slow, or returns nothing usable. A missing TURN
 * server never blocks the transfer: direct and STUN paths still work.
 */
export async function loadIceServers(signalUrl: string, timeoutMs = 2500): Promise<IceConfig> {
  const configured = configuredIceServers(import.meta.env.VITE_ICE);
  if (configured) return { servers: configured, hasTurn: hasTurnServer(configured) };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(iceEndpoint(signalUrl), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`ice ${response.status}`);
    const body: unknown = await response.json();
    const servers = normalizeIceServers(isRecord(body) ? body.iceServers : null);
    if (servers.length > 0) return { servers, hasTurn: hasTurnServer(servers) };
  } catch {
    // Fall through to STUN: the transfer can still succeed on most networks.
  } finally {
    clearTimeout(timer);
  }

  return { servers: DEFAULT_STUN, hasTurn: false };
}
