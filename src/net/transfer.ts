import { hashBlob, Sha256 } from '../lib/sha256';
import {
  createStore,
  markSuspending,
  parkForResume,
  takeResume,
  type ReceiveStore,
  type StoreMeta,
} from '../lib/receive-store';
import { buildZip, zipSize, type ZipEntry } from '../lib/zip';
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
/** Bytes held back while header patches are still possible. */
const PATCH_WINDOW = 256 * 1024;

/** One file of a folder transfer: path inside the archive plus a reader. */
export interface FolderEntry {
  /** Forward-slash path inside the ZIP, no leading slash. */
  path: string;
  size: number;
  modified?: Date;
  read: () => AsyncGenerator<Uint8Array>;
}

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
  /** Origin lastModified, for matching a resumable partial file. */
  modified?: number | null;
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

export type TransferError =
  | 'connection-failed'
  | 'channel-closed'
  | 'send-failed'
  | 'file-too-large'
  | 'storage-failed';

/** What the browser managed to gather, so a failure can be explained. */
export interface TransferDiagnostics {
  candidates: string[];
  iceErrors: string[];
}

export interface TransferEvents {
  onState: (state: 'connecting' | 'open' | 'closed') => void;
  onMeta: (meta: FileMeta) => void;
  onProgress: (done: number, total: number) => void;
  /** A partial copy was found and the transfer continues from this offset. */
  onResume?: (offset: number, total: number) => void;
  onVerified: (result: VerifyResult) => void;
  onAck: (ok: boolean, size?: number) => void;
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
  private channelLost = false;

  private opened = false;
  private restarted = false;
  private offered = false;
  private giveUpTimer = 0;
  private restartTimer = 0;
  private readonly candidateTypes = new Set<string>();
  private readonly iceErrors: string[] = [];

  private expectedHash: string | null = null;
  private expectedSize = 0;
  private mime = 'application/octet-stream';
  private receiveHash: Sha256 | null = null;
  private store: ReceiveStore | null = null;
  private storeMeta: StoreMeta | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private writeError: unknown = null;
  private early: Uint8Array[] = [];
  private resumed = false;
  private parked = false;
  private receivedBytes = 0;

  /** Sender side: offset a resuming receiver asked for, resolved once. */
  private readyOffset: number | null = null;
  private readyResolver: (() => void) | null = null;

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

  /** Cached answer of usesRelay(); null until the stats say one way or another. */
  private relaySelected: boolean | null = null;

  /**
   * True only when the *selected* pair actually goes through a TURN relay.
   * Gathering is not selection: with a TURN server configured the browser
   * always collects relay candidates, so counting gathered ones would cap
   * every transfer — even direct ones on the same network.
   */
  private async usesRelay(): Promise<boolean> {
    if (this.relaySelected !== null) return this.relaySelected;
    // The selected pair can lag the open event by a beat; retry a few times.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const found = await this.selectedPairIsRelay();
      if (found !== null) {
        this.relaySelected = found;
        return found;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    }
    trace('selected pair unknown; assuming direct');
    this.relaySelected = false;
    return false;
  }

  /** null when this stats snapshot has no selected pair yet. */
  private async selectedPairIsRelay(): Promise<boolean | null> {
    try {
      const stats = await this.pc.getStats();
      let pairLocalId = '';
      stats.forEach((value) => {
        const report = value as unknown as Record<string, unknown>;
        if (
          report.type === 'candidate-pair' &&
          report.state === 'succeeded' &&
          (report.selected === true || report.nominated === true) &&
          typeof report.localCandidateId === 'string'
        ) {
          pairLocalId = report.localCandidateId;
        }
      });
      if (!pairLocalId) return null;
      let isRelay = false;
      stats.forEach((value) => {
        const report = value as unknown as Record<string, unknown>;
        if (report.type === 'local-candidate' && report.id === pairLocalId) {
          isRelay = report.candidateType === 'relay';
        }
      });
      return isRelay;
    } catch (error) {
      trace('getStats failed', error);
      return false;
    }
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
    this.channelLost = false;
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
      this.channelLost = true;
      this.events.onState('closed');
      if (!this.finished && !this.parked) {
        // A receiver holding a partial file keeps it for the next session.
        if (this.role === 'receiver' && this.store) void this.suspendReceive();
        this.events.onError('channel-closed');
      }
    });

    channel.addEventListener('message', (event) => {
      if (typeof event.data === 'string') this.handleControl(event.data);
      else this.handleBytes(event.data as ArrayBuffer);
    });
  }

  async startOffer(): Promise<void> {
    // A transfer that already offered must not offer again: after a drop its
    // peer connection is dead, and a second offer from it can collide with the
    // fresh connection that replaced it.
    if (this.offered) return;
    this.offered = true;
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
   * How long to wait for the receiver's ready/offset before starting at 0.
   * The receiver answers this on its own (it may spend a moment opening the
   * partial file), so the wait is deliberately long: starting at 0 while it
   * resumes at N would splice the file together wrongly.
   */
  private waitForReady(channel: RTCDataChannel, ms = 30_000): Promise<number> {
    if (this.readyOffset !== null) return Promise.resolve(this.readyOffset);
    return new Promise((resolve) => {
      const done = (value: number): void => {
        window.clearTimeout(timer);
        channel.removeEventListener('close', onClose);
        resolve(value);
      };
      const timer = window.setTimeout(() => {
        this.readyResolver = null;
        done(0);
      }, ms);
      const onClose = (): void => {
        this.readyResolver = null;
        done(0);
      };
      channel.addEventListener('close', onClose);
      this.readyResolver = () => done(this.readyOffset ?? 0);
    });
  }

  /**
   * Stream arbitrary byte chunks with hashing and backpressure, as
   * `meta` → bytes → `end`. Both sendFile and the folder ZIP ride this.
   * When the receiver already holds part of this file (resume), it answers
   * the meta with its offset and only the remaining bytes go on the wire —
   * the hash still covers the whole file.
   */
  private async streamBytes(
    channel: RTCDataChannel,
    name: string,
    mime: string,
    size: number,
    source: AsyncGenerator<Uint8Array>,
    modified: number | null = null,
  ): Promise<void> {
    const meta: FileMeta = { name, size, mime, hash: null, modified };
    this.readyOffset = null;
    this.readyResolver = null;
    // A previous transfer's "done" must not suppress this one's failure path.
    this.finished = false;
    this.parked = false;
    channel.send(JSON.stringify({ kind: 'meta', ...meta }));

    const offset = await this.waitForReady(channel);
    trace('stream start', offset, 'of', size);
    const hash = new Sha256();
    let sent = Math.min(offset, size);
    try {
      let position = 0;
      for await (const block of source) {
        hash.update(block);
        const blockStart = position;
        position += block.byteLength;
        // Skip whatever the receiver already has; keep hashing regardless.
        const from = Math.max(0, offset - blockStart);
        if (from >= block.byteLength) continue;

        for (let inner = from; inner < block.byteLength; inner += CHUNK_SIZE) {
          if (channel.bufferedAmount > HIGH_WATER) await waitDrain(channel);
          const end = Math.min(inner + CHUNK_SIZE, block.byteLength);
          const slice = new Uint8Array(block.buffer, block.byteOffset + inner, end - inner);
          const out = new Uint8Array(slice.byteLength);
          out.set(slice);
          channel.send(out);
          sent += out.byteLength;
          this.events.onProgress(sent, size);
        }
      }
      channel.send(JSON.stringify({ kind: 'end', hash: hash.digestHex() }));
    } catch {
      // A drop mid-stream is reported once by the channel's close handler.
      if (this.channelLost) return;
      this.events.onError('send-failed');
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

    if (file.size > RELAY_SIZE_LIMIT && (await this.usesRelay())) {
      trace('relay limit', file.size);
      this.events.onError('file-too-large');
      return;
    }

    const fileSource = async function* (): AsyncGenerator<Uint8Array> {
      let offset = 0;
      while (offset < file.size) {
        // Read a megabyte at a time: a blob read per 64 KB chunk costs more
        // than the hashing itself. Chunks still go out at 64 KB.
        const buffer = await file.slice(offset, offset + READ_SIZE).arrayBuffer();
        const bytes = new Uint8Array(buffer);
        offset += bytes.byteLength;
        yield bytes;
      }
    }

    await this.streamBytes(
      channel,
      file.name,
      file.type || 'application/octet-stream',
      file.size,
      fileSource(),
      file.lastModified || null,
    );
  }

  /** Send a text snippet as a synthetic .txt file — same pipeline, no chunking cost. */
  async sendText(text: string, label = 'متن.txt'): Promise<void> {
    const channel = this.channel;
    if (!channel) {
      this.events.onError('send-failed');
      return;
    }
    await waitOpen(channel);
    const bytes = new TextEncoder().encode(text);
    const name = label.endsWith('.txt') ? label : `${label}.txt`;
    async function* textSource(): AsyncGenerator<Uint8Array> {
      yield bytes;
    }
    await this.streamBytes(channel, name, 'text/plain; charset=utf-8', bytes.byteLength, textSource());
  }

  /**
   * Send a whole folder as a streaming ZIP: files flow through the CRC into
   * 64 KB chunks, nothing is held in memory whole. Only headers are patched
   * after streaming; the receiver gets one normal .zip file.
   */
  async sendFolder(entries: FolderEntry[], zipName = 'folder.zip'): Promise<void> {
    const channel = this.channel;
    if (!channel) {
      this.events.onError('send-failed');
      return;
    }
    await waitOpen(channel);

    const total = zipSize(entries.map((entry) => ({ name: entry.path, size: entry.size })));
    if (total > RELAY_SIZE_LIMIT && (await this.usesRelay())) {
      trace('relay limit', total);
      this.events.onError('file-too-large');
      return;
    }

    const zipEntries: ZipEntry[] = entries.map((entry) => ({
      name: entry.path,
      size: entry.size,
      modified: entry.modified,
      read: () => entry.read(),
    }));

    const zipSource = async function* (): AsyncGenerator<Uint8Array> {
      // Output buffer: patches rewrite a few header fields after streaming,
      // so a bounded sliding buffer is enough. Blocks are kept small; the
      // sender applies patches to bytes not yet sent.
      const pending: Uint8Array[] = [];
      let pendingBytes = 0;
      let base = 0; // absolute offset of pending[0]
      const patches: { offset: number; value: number }[] = [];

      const flush = async function* (target: number): AsyncGenerator<Uint8Array> {
        while (base < target) {
          const part = pending.shift();
          if (!part) break;
          const take = Math.min(part.length, target - base);
          yield part.subarray(0, take);
          if (take < part.length) {
            pending.unshift(part.subarray(take));
          }
          base += take;
          pendingBytes -= take;
        }
      };

      for await (const step of buildZip(zipEntries)) {
        if (step.kind === 'bytes') {
          pending.push(step.data);
          pendingBytes += step.data.length;
          // Keep the pipeline moving: emit everything except a small tail.
          const safeEmit = base + pendingBytes - PATCH_WINDOW;
          for await (const block of flush(Math.max(base, safeEmit))) yield block;
        } else {
          patches.push(step);
        }
      }
      // Apply remaining patches within the window, then drain everything.
      for (const patch of patches) {
        let acc = base;
        for (const part of pending) {
          if (patch.offset < acc + part.length) {
            const dv = new DataView(part.buffer, part.byteOffset, part.byteLength);
            dv.setUint32(patch.offset - acc, patch.value >>> 0, true);
            break;
          }
          acc += part.length;
        }
      }
      for await (const block of flush(base + pendingBytes)) yield block;
    }

    const modified = entries.reduce((max, entry) => Math.max(max, entry.modified?.getTime() ?? 0), 0) || null;
    await this.streamBytes(channel, zipName, 'application/zip', total, zipSource(), modified);
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
      const modified = typeof message.modified === 'number' ? message.modified : null;
      const name = String(message.name ?? 'file');
      this.beginReceive({ name, size: this.expectedSize, mime: this.mime, modified });
      this.events.onMeta({ name, size: this.expectedSize, mime: this.mime, hash: this.expectedHash });
      return;
    }

    if (message.kind === 'end') {
      this.finished = true;
      void this.finishReceive(message);
      return;
    }

    if (message.kind === 'ready') {
      // Receiver's resume offset arrives before any byte.
      this.readyOffset = Number(message.offset) || 0;
      this.readyResolver?.();
      this.readyResolver = null;
      trace('receiver ready at', this.readyOffset);
      return;
    }

    if (message.kind === 'done') {
      this.finished = true;
      this.events.onAck(Boolean(message.ok), typeof message.size === 'number' ? message.size : undefined);
    }
  }

  /** Prepare storage (resuming when the receiver holds a partial copy). */
  private beginReceive(meta: StoreMeta): void {
    this.storeMeta = meta;
    this.receivedBytes = 0;
    this.early = [];
    this.writeChain = Promise.resolve();
    this.writeError = null;
    this.receiveHash = null;
    this.store = null;
    this.finished = false;
    this.parked = false;

    void (async () => {
      let store = (await takeResume(meta)) ?? (await createStore(meta));
      // A partial file only helps if the sender honoured its offset. Bytes that
      // arrived before the store was ready mean it started from zero, so the
      // stale prefix has to go.
      if (store.offset > 0 && this.early.length > 0) {
        await store.discard();
        store = await createStore(meta);
      }
      this.resumed = store.offset > 0;
      if (!this.resumed) this.receiveHash = new Sha256();
      this.store = store;
      trace('store pick', store.offset, 'early', this.early.length, meta.name);
      let queued = 0;
      for (const chunk of this.early.splice(0)) {
        queued += chunk.byteLength;
        this.enqueueWrite(chunk);
      }
      this.receivedBytes = store.offset + queued;
      if (this.resumed) {
        this.events.onResume?.(this.receivedBytes, this.expectedSize);
        this.events.onProgress(this.receivedBytes, this.expectedSize);
      }
      this.channel?.send(JSON.stringify({ kind: 'ready', offset: store.offset }));
      trace('store ready', this.resumed ? `resume ${store.offset}` : 'fresh');
    })();
  }

  private enqueueWrite(bytes: Uint8Array): void {
    const store = this.store;
    if (!store) {
      this.early.push(bytes);
      return;
    }
    this.writeChain = this.writeChain.then(() => store.write(bytes)).catch((error: unknown) => {
      this.writeError = error;
      trace('store write failed', error);
    });
  }

  private async finishReceive(message: Record<string, unknown>): Promise<void> {
    const declared = typeof message.hash === 'string' ? message.hash : this.expectedHash;
    await this.writeChain;
    const store = this.store;
    if (this.writeError || !store) {
      this.events.onError('storage-failed');
      return;
    }

    let blob: Blob;
    try {
      blob = await store.finish();
    } catch (error) {
      trace('store finish failed', error);
      this.events.onError('storage-failed');
      return;
    }

    // A resumed transfer has no continuous hash state: hash the stored file.
    const received = this.resumed ? await hashBlob(blob) : (this.receiveHash?.digestHex() ?? null);
    const checked = received !== null && declared !== null;
    const sizeOk = blob.size === this.expectedSize;
    trace('finish receive', blob.size, 'of', this.expectedSize, this.resumed ? 'resumed' : 'fresh');
    const ok = checked && received === declared && sizeOk;
    this.channel?.send(JSON.stringify({ kind: 'done', ok, hash: received, size: blob.size }));
    this.events.onVerified({ checked, ok, expected: declared, received, blob });
  }

  /** Keep the partial file so the next session can continue it. */
  private async suspendReceive(): Promise<void> {
    if (!this.store || !this.storeMeta || this.finished) return;
    this.parked = true;
    const meta = this.storeMeta;
    const store = this.store;
    const work = (async () => {
      await this.writeChain;
      // Park first: the next attempt may pick this store up as soon as the
      // suspend it is waiting for has landed.
      parkForResume(meta, store);
      trace('suspend store', store.offset, 'of', this.receivedBytes);
      await store.suspend().catch(() => undefined);
    })();
    markSuspending(work);
    await work;
  }

  private handleBytes(data: ArrayBuffer): void {
    const bytes = new Uint8Array(data);
    this.receivedBytes += bytes.byteLength;
    this.enqueueWrite(bytes);
    this.receiveHash?.update(bytes);
    this.events.onProgress(this.receivedBytes, this.expectedSize);
  }

  /**
   * Drop the data channel as a network failure would, keeping the partial
   * receiver state so the next attempt resumes. Used by the resume e2e test.
   */
  interrupt(): void {
    this.channel?.close();
  }

  close(): void {
    // A teardown mid-file keeps what has been written so far: the next
    // attempt resumes from the real file size instead of the last flush.
    if (!this.finished && !this.parked && this.role === 'receiver' && this.store) {
      void this.suspendReceive();
    }
    this.finished = true;
    window.clearTimeout(this.giveUpTimer);
    window.clearTimeout(this.restartTimer);
    this.channel?.close();
    this.pc.close();
  }
}
