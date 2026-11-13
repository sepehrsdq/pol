// Signaling server for Pol, with the built client served from the same origin.
//
// It pairs two browsers by room code, relays SDP/ICE, and serves dist/ when
// it exists. File bytes never pass through here, and nothing is persisted.
//
// Protocol (JSON over WebSocket):
//   c -> s  { t: "join", room, role: "sender" | "receiver" }
//   s -> c  { t: "ready" }        both roles present
//   s -> c  { t: "full" }         room already has that role
//   s -> c  { t: "peer-left" }
//   s -> c  { t: "error", message }
//   both    { t: "s", data }      opaque relay for SDP/ICE
//
// HTTP: GET /healthz for platform checks, GET /ice for STUN/TURN, the rest from dist/.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import {
  buildIceServers,
  fetchMeteredServers,
  hasIncompleteTurn,
  hasMetered,
} from './ice.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const HEARTBEAT_MS = 30_000;
const MAX_IDLE_MS = 2 * 60 * 60 * 1000;
const DIST_DIR = resolve(process.cwd(), 'dist');

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.map', 'application/json; charset=utf-8'],
]);

/** @type {Map<string, { sender: any, receiver: any, createdAt: number }>} */
const rooms = new Map();

/** Normalize a room code: Persian/Arabic variants collapse to one form. */
function normalizeRoom(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .normalize('NFKC')
    .replace(/\u064A/g, '\u06CC') // Arabic yeh -> Persian yeh
    .replace(/\u0643/g, '\u06A9') // Arabic kaf -> Persian kaf
    .replace(/[\u200c\u200f\u200e]/g, '')
    .trim()
    .toLowerCase();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length !== 4) return '';
  if (words.some((w) => w.length > 24)) return '';
  return words.join(' ');
}

function send(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}

function partnerOf(room, ws) {
  if (!room) return null;
  if (room.sender === ws) return room.receiver;
  if (room.receiver === ws) return room.sender;
  return null;
}

function leave(ws) {
  const key = ws.polRoom;
  if (!key) return;
  const room = rooms.get(key);
  ws.polRoom = undefined;
  ws.polRole = undefined;
  if (!room) return;

  const other = partnerOf(room, ws);
  if (room.sender === ws) room.sender = null;
  if (room.receiver === ws) room.receiver = null;

  if (other) send(other, { t: 'peer-left' });
  if (!room.sender && !room.receiver) rooms.delete(key);
}

function sendFile(request, response, filePath) {
  const info = statSync(filePath);
  const ext = extname(filePath).toLowerCase();
  const immutable = filePath.startsWith(resolve(DIST_DIR, 'assets') + sep);
  response.writeHead(200, {
    'content-type': MIME.get(ext) ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

function serveClient(request, response) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('bad request');
    return;
  }

  const candidate = resolve(DIST_DIR, `.${pathname}`);
  const inside = candidate === DIST_DIR || candidate.startsWith(DIST_DIR + sep);
  if (!inside) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('forbidden');
    return;
  }

  const fallback = resolve(DIST_DIR, 'index.html');
  const filePath =
    existsSync(candidate) && statSync(candidate).isFile() ? candidate : fallback;

  if (!existsSync(filePath)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('client build not found; run npm run build');
    return;
  }

  sendFile(request, response, filePath);
}

/**
 * ICE list for /ice, in priority order:
 *   1. Metered (METERED_APP + METERED_KEY) — managed TURN, cached in memory.
 *   2. Self-hosted TURN from TURN_URLS + TURN_SECRET / TURN_USERNAME.
 *   3. Public STUN only.
 * A Metered outage never takes the endpoint down: it degrades to the next
 * source and the transfer can still go direct or via STUN.
 * @returns {Promise<{ iceServers: unknown[], ttl: number }>}
 */
async function resolveIceServers() {
  if (hasMetered()) {
    try {
      const { iceServers } = await fetchMeteredServers();
      return { iceServers, ttl: 0 };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`metered turn unavailable (${reason}); falling back to env config`);
    }
  }
  return buildIceServers();
}

const server = createServer(async (request, response) => {
  let pathname = '/';
  try {
    pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  } catch {
    // Keep the root fallback for malformed URLs.
  }

  if (pathname === '/healthz') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }
  if (pathname === '/ice') {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-max-age': '86400',
      });
      response.end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    response.end(JSON.stringify(await resolveIceServers()));
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('method not allowed');
    return;
  }
  serveClient(request, response);
});

const wss = new WebSocketServer({
  server,
  path: '/signal',
  maxPayload: 64 * 1024,
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send(ws, { t: 'error', message: 'bad-json' });
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'join') {
      if (ws.polRoom) return; // one room per socket
      const key = normalizeRoom(msg.room);
      const role = msg.role === 'sender' || msg.role === 'receiver' ? msg.role : '';
      if (!key || !role) {
        send(ws, { t: 'error', message: 'bad-join' });
        return;
      }
      const room = rooms.get(key) ?? { sender: null, receiver: null, createdAt: Date.now() };
      if (room[role]) {
        send(ws, { t: 'full' });
        return;
      }
      room[role] = ws;
      rooms.set(key, room);
      ws.polRoom = key;
      ws.polRole = role;

      if (room.sender && room.receiver) {
        send(room.sender, { t: 'ready' });
        send(room.receiver, { t: 'ready' });
      }
      return;
    }

    if (msg.t === 's') {
      const room = ws.polRoom ? rooms.get(ws.polRoom) : null;
      const other = room ? partnerOf(room, ws) : null;
      if (other) send(other, { t: 's', data: msg.data });
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, room] of rooms) {
    if (now - room.createdAt > MAX_IDLE_MS) {
      for (const ws of [room.sender, room.receiver]) {
        if (ws) {
          send(ws, { t: 'error', message: 'room-expired' });
          ws.close();
        }
      }
      rooms.delete(key);
    }
  }
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(sweeper));

const bootIce = await resolveIceServers();
const turnConfigured = bootIce.iceServers.some((entry) => {
  const urls = entry && typeof entry === 'object' ? entry.urls : entry;
  return (Array.isArray(urls) ? urls : [urls]).some((url) => /^turns?:/i.test(String(url)));
});
if (hasIncompleteTurn()) {
  console.warn('TURN_URLS is set but TURN_SECRET or TURN_USERNAME/TURN_PASSWORD is missing; serving STUN only.');
}

server.listen(PORT, () => {
  console.log(
    `pol listening on :${PORT} (client from ${DIST_DIR}, ws /signal, health /healthz, ice /ice turn:${turnConfigured ? 'on' : 'off'})`,
  );
});
