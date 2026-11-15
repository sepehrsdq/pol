// Room behaviour: a tab may take its own seat back, a different device cannot,
// and the peer is never kicked by someone else's reconnect.
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

const PORT = 8900 + Math.floor(Math.random() * 80);
const URL = `ws://127.0.0.1:${PORT}/signal`;
let server;

/**
 * Connect and start queuing messages immediately. The server can answer a join
 * before the test awaits its reply, and a message that arrives with no listener
 * is dropped, so nothing may be left to `once('message')` later.
 */
function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(URL);
    socket.polQueue = [];
    socket.polWaiters = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      const waiter = socket.polWaiters.shift();
      if (waiter) waiter.resolve(message);
      else socket.polQueue.push(message);
    });
    socket.on('close', () => {
      for (const waiter of socket.polWaiters.splice(0)) waiter.reject(new Error('closed'));
    });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function next(socket, timeoutMs = 2000) {
  if (socket.polQueue.length > 0) return Promise.resolve(socket.polQueue.shift());
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    socket.polWaiters.push(waiter);
    setTimeout(() => {
      const index = socket.polWaiters.indexOf(waiter);
      if (index < 0) return;
      socket.polWaiters.splice(index, 1);
      reject(new Error('no message'));
    }, timeoutMs);
  });
}

/** Every message that arrives during the next window. */
async function collect(socket, ms = 400) {
  const seen = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      seen.push((await next(socket, end - Date.now())).t);
    } catch {
      break;
    }
  }
  return seen;
}

function join(socket, role, client, room = 'آب باد ماه گل') {
  socket.send(JSON.stringify({ t: 'join', room, role, client }));
}

beforeAll(async () => {
  server = spawn(process.execPath, ['server/signal.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('signaling server never started');
});

afterAll(() => {
  server?.kill();
});

describe('rooms', () => {
  it('pairs a sender and a receiver, then gives the seat back to the same tab', async () => {
    const sender = await connect();
    join(sender, 'sender', 'tab-a');
    const receiver = await connect();
    join(receiver, 'receiver', 'tab-b');

    expect((await next(receiver)).t).toBe('ready');

    // Same tab reconnecting: it takes its own seat, the sender is left alone.
    const senderWatcher = collect(sender, 500);
    const receiverAgain = await connect();
    join(receiverAgain, 'receiver', 'tab-b');

    expect((await next(receiver)).t).toBe('replaced');
    expect((await next(receiverAgain)).t).toBe('ready');
    const senderSaw = await senderWatcher;
    expect(senderSaw).not.toContain('peer-left');
    expect(senderSaw).not.toContain('replaced');

    sender.close();
    receiverAgain.close();
  });

  it('refuses a different device on a taken seat', async () => {
    const sender = await connect();
    join(sender, 'sender', 'tab-a');
    const receiver = await connect();
    join(receiver, 'receiver', 'tab-b');
    expect((await next(receiver)).t).toBe('ready');

    const intruder = await connect();
    join(intruder, 'receiver', 'tab-z');
    expect((await next(intruder)).t).toBe('full');

    sender.close();
    receiver.close();
    intruder.close();
  });

  it('relays payloads only between the two seated peers', async () => {
    const sender = await connect();
    join(sender, 'sender', 'tab-a');
    const receiver = await connect();
    join(receiver, 'receiver', 'tab-b');
    expect((await next(receiver)).t).toBe('ready');

    sender.send(JSON.stringify({ t: 's', data: { kind: 'offer', sdp: 'x' } }));
    const relayed = await next(receiver);
    expect(relayed.t).toBe('s');
    expect(relayed.data.kind).toBe('offer');

    sender.close();
    receiver.close();
  });
});

describe('static assets', () => {
  // A page still holding the previous deploy asks for a bundle that is gone.
  // Serving index.html there would parse as JavaScript and fail silently.
  it('answers 404 for a missing hashed asset instead of the page', async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/assets/index-GONE123.js`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).not.toContain('<!doctype html');
  });

  it('answers 404 for a missing file with any extension', async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/icons/missing-192.png`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('<!doctype html');
  });

  it('keeps the hash route working: an unknown path without extension is the page', async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/some/route`);
    // Without a build the server says so; with one it must be the HTML shell.
    expect([200, 404]).toContain(response.status);
    const body = await response.text();
    if (response.status === 200) expect(body).toContain('<!doctype html');
    else expect(body).toContain('npm run build');
  });
});
