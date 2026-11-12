import { Sha256 } from '../lib/sha256';
import { trace } from '../lib/trace';

const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;

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

export type TransferError = 'connection-failed' | 'channel-closed' | 'send-failed';

export interface TransferEvents {
  onState: (state: 'connecting' | 'open' | 'closed') => void;
  onMeta: (meta: FileMeta) => void;
  onProgress: (done: number, total: number) => void;
  onVerified: (result: VerifyResult) => void;
  onAck: (ok: boolean) => void;
  onError: (error: TransferError) => void;
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
  private channel: RTCDataChannel | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private finished = false;

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
    this.pc = new RTCPeerConnection({ iceServers });

    this.pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        sendSignal({ kind: 'ice', candidate: event.candidate.toJSON() });
      }
    });

    this.pc.addEventListener('connectionstatechange', () => {
      const state = this.pc.connectionState;
      trace('pc', state);
      if (state === 'failed') this.events.onError('connection-failed');
    });

    if (role === 'sender') {
      this.attach(this.pc.createDataChannel('pol', { ordered: true }));
    } else {
      this.pc.addEventListener('datachannel', (event) => {
        this.attach(event.channel);
      });
    }
  }

  private attach(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    this.events.onState('connecting');
    trace('channel attached', channel.label);

    channel.addEventListener('open', () => {
      channel.bufferedAmountLowThreshold = LOW_WATER;
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
    }
  }

  async sendFile(file: File, hash: string | null): Promise<void> {
    const channel = this.channel;
    if (!channel) {
      this.events.onError('send-failed');
      return;
    }

    await waitOpen(channel);

    const meta: FileMeta = {
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      hash,
    };
    channel.send(JSON.stringify({ kind: 'meta', ...meta }));

    let offset = 0;
    try {
      while (offset < file.size) {
        if (channel.bufferedAmount > HIGH_WATER) await waitDrain(channel);
        const buffer = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
        channel.send(buffer);
        offset += buffer.byteLength;
        this.events.onProgress(offset, file.size);
      }
      channel.send(JSON.stringify({ kind: 'end' }));
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
      const checked = received !== null && this.expectedHash !== null;
      const sizeOk = this.receivedBytes === this.expectedSize;
      const ok = checked && received === this.expectedHash && sizeOk;
      const blob = new Blob(this.received, { type: this.mime });
      this.channel?.send(JSON.stringify({ kind: 'done', ok, hash: received }));
      this.events.onVerified({ checked, ok, expected: this.expectedHash, received, blob });
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
    this.channel?.close();
    this.pc.close();
  }
}
