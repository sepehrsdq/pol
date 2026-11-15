import { trace } from '../lib/trace';

export type Role = 'sender' | 'receiver';

export type ServerMessage =
  | { t: 'ready' }
  | { t: 'full' }
  | { t: 'peer-left' }
  | { t: 'replaced' }
  | { t: 'error'; message?: string }
  | { t: 's'; data: unknown };

/**
 * Stable identity for this tab. A reconnect after a drop (or a reload) joins
 * with the same id, which lets the server hand the seat back instead of
 * refusing it — while a different device still gets "full".
 */
const CLIENT_KEY = 'pol-client';
const CLIENT_ID = (() => {
  try {
    const existing = sessionStorage.getItem(CLIENT_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
})();

export interface SignalHandlers {
  onMessage: (message: ServerMessage) => void;
  onClose: () => void;
}

export function defaultSignalUrl(): string {
  const configured = import.meta.env.VITE_SIGNAL_URL;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/signal`;
}

/**
 * Thin WebSocket client. It joins a room, then relays opaque SDP/ICE
 * payloads. No file bytes ever reach this socket.
 */
export class SignalClient {
  private readonly socket: WebSocket;
  private closedByUs = false;
  private readonly queue: unknown[] = [];

  constructor(url: string, room: string, role: Role, handlers: SignalHandlers) {
    this.socket = new WebSocket(url);

    this.socket.addEventListener('open', () => {
      trace('signal open', room, role);
      this.socket.send(JSON.stringify({ t: 'join', room, role, client: CLIENT_ID }));
      for (const payload of this.queue) this.socket.send(JSON.stringify(payload));
      this.queue.length = 0;
    });

    this.socket.addEventListener('error', () => {
      trace('signal error');
    });

    this.socket.addEventListener('message', (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      const message = parsed as ServerMessage;
      if (typeof message.t !== 'string') return;
      // The server is closing this socket because our newer connection took
      // the seat; do not report that as an unrelated connection loss.
      if (message.t === 'replaced') this.closedByUs = true;
      handlers.onMessage(message);
    });

    this.socket.addEventListener('close', () => {
      if (!this.closedByUs) handlers.onClose();
    });
  }

  send(payload: unknown): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
      return;
    }
    // Hold early SDP/ICE until the socket is up instead of dropping it.
    if (this.socket.readyState === WebSocket.CONNECTING) this.queue.push(payload);
  }

  relay(data: unknown): void {
    this.send({ t: 's', data });
  }

  close(): void {
    this.closedByUs = true;
    this.socket.close();
  }
}
