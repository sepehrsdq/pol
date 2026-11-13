import { Sha256 } from '../lib/sha256';
import { trace } from '../lib/trace';

const CHUNK_SIZE = 64 * 1024;
const READ_SIZE = 1024 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;
/**
 * Relay traffic (cross-network transfers) is capped by the TURN plan.
 * Direct transfers on the same network have no size limit.
 */
export const RELAY_SIZE_LIMIT = 200 * 1024 * 1024;

/** Give the first ICE attempt this long before restarting once. */
const RESTART_AFTER_MS = 11_000;
/** Hard stop: no data channel by then means the network refused. */
const CONNECT_TIMEOUT_MS = 30_000;
/** The second attempt gets a shorter window than the first. */
const RESTART_TIMEOUT_MS = 16_000;

export type TransferRole = 'sender' | 'receiver';

export interface FileMeta {
  name: string;
  size: number;
  mime: string;
  hash: string | null;
}

export type SignalPayload =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit };

export interface VerifyResult {
  checked: boolean;
  ok: boolean;
  expected: string | null;
  received: string | null;
  blob: Blob | null;
}

export type TransferError = 'connection-failed' | 'channel-closed' | 'send-failed' | 'file-too-large';

/** What the browser managed to gather, so a failure can be explained. */
export interface TransferDiagnostics {
  candidates: string[];
  iceErrors: string[];
}

export interface TransferEvents {
  onState: (state: 'connecting' | 'open' | 'closed') => void;
  onMeta: (meta: FileMeta) => void;
  onProgress: (done: number, total: number) => void;
  onVerified: (result: VerifyResult) => void;
  onAck: (ok: boolean) => void;
  onError: (error: TransferError, detail?: TransferDiagnostics) => void;
}

function waitDrain(channel: RTCDataChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      channel.removeEventListener('bufferedamountlow', handleLow);
      channel.removeEventListener('close', handleClose);
    };
    const handleLow = (): void => {
      cleanup();
      resolve();
    };
    const handleClose = (): void => {
      cleanup();
      reject(new Error('channel closed while draining'));
    };
    channel.addEventListener('bufferedamountlow', handleLow);
    channel.addEventListener('close', handleClose);
  });
}

function waitOpen(channel: RTCDataChannel): Promise<RTCDataChannel> {
  if (channel.readyState === 'open') return Promise.resolve(channel);
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      channel.removeEventListener('open', handleOpen);
      channel.removeEventListener('close', handleClose);
    };
    const handleOpen = (): void => {
      cleanup();
      resolve(channel);
    };
    const handleClose = (): void => {
      cleanup();
      reject(new Error('channel closed before opening'));
    };
    channel.addEventListener('open', handleOpen);
    channel.addEventListener('close', handleClose);
  });
}

/**
 * Owns one RTCPeerConnection and one data channel.
 * The sender offers; the receiver answers. File bytes flow only here.
 */
export class Transfer {
  private readonly pc: RTCPeerConnection;
  private readonly events: TransferEvents;
  private readonly role: TransferRole;
  private channel: RTCDataChannel | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private finished = false;

  private opened = false;
  private restarted = false;
  private giveUpTimer = 0;
  private restartTimer = 0;
  private readonly candidateTypes = new Set<string>();
  private readonly iceErrors: string[] = [];

  private expectedHash: string | null = null;
  private expectedSize = 0;
  private mime = 'application/octet-stream';
  private receiveHash: Sha256 | null = null;
  private received: Uint8Array<ArrayBuffer>[] = [];
  private receivedBytes = 0;

  constructor(
    role: TransferRole,
    iceServers: RTCIceServer[],
    private readonly sendSignal: (payload: SignalPayload) => void,
    events: TransferEvents,
  ) {
    this.events = events;
    this.role = role;
    this.pc = new RTCPeerConnection({ iceServers });

    this.pc.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return;
      const type = event.candidate.type;
      if (typeof type === 'string') this.candidateTypes.add(type);
      sendSignal({ kind: 'ice', candidate: event.candidate.toJSON() });
    });

    // STUN/TURN failures land here (401 from a TURN server, 701 for a timeout).
    this.pc.addEventListener('icecandidateerror', (event) => {
      const detail = event as RTCPeerConnectionIceErrorEvent;
      const url = typeof detail.url === 'string' ? detail.url : '';
      this.iceErrors.push(`${detail.errorCode}${url ? ` ${url}` : ''}`);
      trace('ice error', detail.errorCode, url);
    });

    this.pc.addEventListener('connectionstatechange', () => {
      const state = this.pc.connectionState;
      trace('pc', state);
      if (state === 'failed' && !this.opened) this.failOrRestart();
    });

    if (role === 'sender') {
      this.attach(this.pc.createDataChannel('pol', { ordered: true }));
    } else {
      this.pc.addEventListener('datachannel', (event) => {
        this.attach(event.channel);
      });
    }
  }

  private diagnostics(): TransferDiagnostics {
    return { candidates: [...this.candidateTypes], iceErrors: [...this.iceErrors] };
  }

  /** True when the selected pair includes a TURN relay (cross-network path). */
  private usedRelay(): boolean {
    return this.candidateTypes.has('relay');
  }

  /** Only start counting once an offer or answer is actually on the wire. */
  private startGiveUpTimer(ms: number): void {
    window.clearTimeout(this.giveUpTimer);
    this.giveUpTimer = window.setTimeout(() => {
      if (this.opened) return;
      this.events.onError('connection-failed', this.diagnostics());
    }, ms);
  }

  /** The sender owns renegotiation, so only it can restart ICE. */
  private failOrRestart(): void {
    if (this.role === 'sender' && !this.restarted) {
      void this.restartIce();
      return;
    }
    this.events.onError('connection-failed', this.diagnostics());
  }

  private scheduleRestart(): void {
    if (this.role !== 'sender' || this.restarted) return;
    this.restartTimer = window.setTimeout(() => void this.restartIce(), RESTART_AFTER_MS);
  }

  private async restartIce(): Promise<void> {
    if (this.opened) return;
    if (this.restarted) {
      this.events.onError('connection-failed', this.diagnostics());
      return;
    }
    this.restarted = true;
    window.clearTimeout(this.restartTimer);
    trace('ice restart');

    try {
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      this.sendSignal({ kind: 'offer', sdp: offer.sdp ?? '' });
      this.startGiveUpTimer(RESTART_TIMEOUT_MS);
    } catch {
      this.events.onError('connection-failed', this.diagnostics());
    }
  }

  private attach(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    this.events.onState('connecting');
    trace('channel attached', channel.label);

    channel.addEventListener('open', () => {
      channel.bufferedAmountLowThreshold = LOW_WATER;
      this.opened = true;
      window.clearTimeout(this.giveUpTimer);
      window.clearTimeout(this.restartTimer);
      trace('dc open');
      this.events.onState('open');
    });

    channel.addEventListener('close', () => {
      trace('dc close');
      this.events.onState('closed');
      if (!this.finished) this.events.onError('channel-closed');
    });

    channel.addEventListener('message', (event) => {
      if (typeof event.data === 'string') this.handleControl(event.data);
      else this.handleBytes(event.data as ArrayBuffer);
    });
  }

  async startOffer(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    trace('offer ready', offer.sdp?.length ?? 0);
    this.sendSignal({ kind: 'offer', sdp: offer.sdp ?? '' });
    this.startGiveUpTimer(CONNECT_TIMEOUT_MS);
    this.scheduleRestart();
  }

  async handleSignal(payload: SignalPayload): Promise<void> {
    trace('signal-in', payload.kind);
    if (payload.kind === 'ice') {
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(payload.candidate);
      else this.pendingIce.push(payload.candidate);
      return;
    }

    await this.pc.setRemoteDescription({ type: payload.kind, sdp: payload.sdp });

    for (const candidate of this.pendingIce) {
      await this.pc.addIceCandidate(candidate);
    }
    this.pendingIce = [];

    if (payload.kind === 'offer') {
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.sendSignal({ kind: 'answer', sdp: answer.sdp ?? '' });
      this.startGiveUpTimer(CONNECT_TIMEOUT_MS);
    }
  }

  /**
   * Stream the file and hash it in the same pass, so the sender never has to
   * read a large file twice. The digest travels with the final "end" message.
   * When the connection went through a relay, files above RELAY_SIZE_LIMIT
   * are refused before the first byte moves.
   */
  async sendFile(file: File): Promise<void> {
    const channel = this.channel;
    if (!channel) {
      this.events.onError('send-failed');
      return;
    }

    await waitOpen(channel);

    if (this.usedRelay() && file.size > RELAY_SIZE_LIMIT) {
      trace('relay limit', file.size);
      this.events.onError('file-too-large');
      return;
    }

    const meta: FileMeta = {
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      hash: null,
    };
    channel.send(JSON.stringify({ kind: 'meta', ...meta }));

    const hash = new Sha256();
    let offset = 0;
    try {
      while (offset < file.size) {
        // Read a megabyte at a time: a blob read per 64 KB chunk costs more
        // than the hashing itself. Chunks still go out at 64 KB.
        const buffer = await file.slice(offset, offset + READ_SIZE).arrayBuffer();
        const bytes = new Uint8Array(buffer);
        hash.update(bytes);
        const chunkStart = offset;
        offset += bytes.byteLength;

        for (let inner = 0; inner < bytes.byteLength; inner += CHUNK_SIZE) {
          if (channel.bufferedAmount > HIGH_WATER) await waitDrain(channel);
          const end = Math.min(inner + CHUNK_SIZE, bytes.byteLength);
          channel.send(bytes.subarray(inner, end));
          this.events.onProgress(chunkStart + end, file.size);
        }
      }
      channel.send(JSON.stringify({ kind: 'end', hash: hash.digestHex() }));
    } catch {
      this.events.onError('send-failed');
    }
  }

  private handleControl(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (message.kind === 'meta') {
      this.expectedSize = Number(message.size) || 0;
      this.expectedHash = typeof message.hash === 'string' ? message.hash : null;
      this.mime = typeof message.mime === 'string' ? message.mime : 'application/octet-stream';
      this.receiveHash = new Sha256();
      this.received = [];
      this.receivedBytes = 0;
      this.events.onMeta({
        name: String(message.name ?? 'file'),
        size: this.expectedSize,
        mime: this.mime,
        hash: this.expectedHash,
      });
      return;
    }

    if (message.kind === 'end') {
      this.finished = true;
      const received = this.receiveHash ? this.receiveHash.digestHex() : null;
      // New senders declare the digest here; old ones put it in "meta".
      const declared = typeof message.hash === 'string' ? message.hash : this.expectedHash;
      const checked = received !== null && declared !== null;
      const sizeOk = this.receivedBytes === this.expectedSize;
      const ok = checked && received === declared && sizeOk;
      const blob = new Blob(this.received, { type: this.mime });
      this.channel?.send(JSON.stringify({ kind: 'done', ok, hash: received }));
      this.events.onVerified({ checked, ok, expected: declared, received, blob });
      return;
    }

    if (message.kind === 'done') {
      this.finished = true;
      this.events.onAck(Boolean(message.ok));
    }
  }

  private handleBytes(data: ArrayBuffer): void {
    const bytes = new Uint8Array(data);
    this.received.push(bytes);
    this.receivedBytes += bytes.byteLength;
    this.receiveHash?.update(bytes);
    this.events.onProgress(this.receivedBytes, this.expectedSize);
  }

  close(): void {
    this.finished = true;
    window.clearTimeout(this.giveUpTimer);
    window.clearTimeout(this.restartTimer);
    this.channel?.close();
    this.pc.close();
  }
}
