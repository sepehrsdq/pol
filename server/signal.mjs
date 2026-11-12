// Signaling server for Pol.
//
// It only pairs two browsers by room code and relays SDP/ICE messages.
// File bytes never pass through here, and nothing is persisted.
//
// Protocol (JSON over WebSocket):
//   c -> s  { t: "join", room, role: "sender" | "receiver" }
//   s -> c  { t: "ready" }        both roles present
//   s -> c  { t: "full" }         room already has that role
//   s -> c  { t: "peer-left" }
//   s -> c  { t: "error", message }
//   both    { t: "s", data }      opaque relay for SDP/ICE
//
// Also serves GET /healthz for platform health checks.

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8787);
const HEARTBEAT_MS = 30_000;
const MAX_IDLE_MS = 2 * 60 * 60 * 1000;

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

const server = createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }
  response.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('expected a websocket upgrade at /signal');
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

server.listen(PORT, () => {
  console.log(`pol signal listening on :${PORT} (ws path /signal, health /healthz)`);
});
