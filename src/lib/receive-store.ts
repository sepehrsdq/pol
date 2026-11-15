// Receiver-side storage for incoming files.
//
// Files are written to OPFS (origin private file system) when the browser
// supports it, so multi-gigabyte transfers do not have to live in the tab's
// memory. When OPFS is unavailable the old in-memory path is used.
//
// Resume: a partially received file is kept (bytes in OPFS, metadata in
// localStorage) when the connection drops. The next session that announces
// the same file (name + size + modified) continues at the stored offset.
// Integrity is never assumed: the final SHA-256 still has to match.

import { trace } from './trace';

export interface StoreMeta {
  name: string;
  size: number;
  mime: string;
  modified: number | null;
}

export interface ReceiveStore {
  /** Bytes already stored before this session started. */
  readonly offset: number;
  write(bytes: Uint8Array): Promise<void>;
  /** Close the file and hand back its blob for the download link. */
  finish(): Promise<Blob>;
  /** Close the file but keep the bytes for a later resume. */
  suspend(): Promise<void>;
  /** Delete the partial data entirely. */
  discard(): Promise<void>;
  /** The store is handed to a new attempt: accept writes again. */
  reopen?(): void;
}

const RESUME_KEY = 'pol-resume-v1';
/** Bundle small writes before touching the file stream. */
const FLUSH_BYTES = 512 * 1024;

interface ResumeRecord {
  fileId: string;
  meta: StoreMeta;
  bytes: number;
}

function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  return base.replace(/[^\w.\-\u0600-\u06FF]+/g, '_').slice(0, 80) || 'file';
}

function opfsAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage === 'object' &&
    typeof (navigator.storage as StorageManager & { getDirectory?: unknown }).getDirectory === 'function'
  );
}

export function metaMatches(a: StoreMeta, b: StoreMeta): boolean {
  return a.name === b.name && a.size === b.size && (a.modified ?? null) === (b.modified ?? null);
}

function readRecord(): ResumeRecord | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ResumeRecord;
    if (!parsed || typeof parsed.fileId !== 'string' || !parsed.meta) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeRecord(record: ResumeRecord | null): void {
  try {
    if (record) localStorage.setItem(RESUME_KEY, JSON.stringify(record));
    else localStorage.removeItem(RESUME_KEY);
  } catch {
    /* storage disabled: resume simply will not survive a reload */
  }
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  const storage = navigator.storage as StorageManager & {
    getDirectory(): Promise<FileSystemDirectoryHandle>;
  };
  return storage.getDirectory();
}

class OpfsStore implements ReceiveStore {
  private writable: FileSystemWritableFileStream | null = null;
  /** Byte count actually flushed to the file stream. */
  private flushed: number;
  /** Small batches: a write call per 64 KB chunk would dominate for 1 GB. */
  private batch: Uint8Array[] = [];
  private batchBytes = 0;
  /**
   * True between suspend() and the next attempt taking the file over. Chunks
   * that arrive from a dead connection in that window are dropped: the new
   * sender re-sends everything after the stored offset.
   */
  private suspended = false;

  constructor(
    private readonly meta: StoreMeta,
    private readonly fileId: string,
    offset: number,
  ) {
    this.flushed = offset;
  }

  /** Bytes actually in the file — the only safe resume point. */
  get offset(): number {
    return this.flushed;
  }

  private async ensureWritable(): Promise<FileSystemWritableFileStream> {
    if (this.writable) return this.writable;
    const root = await opfsRoot();
    const handle = await root.getFileHandle(this.fileId, { create: true });
    const writable = await handle.createWritable({ keepExistingData: this.flushed > 0 });
    if (this.flushed > 0) await writable.seek(this.flushed);
    this.writable = writable;
    return writable;
  }

  private async flush(): Promise<void> {
    if (this.batchBytes === 0) return;
    const merged = new Uint8Array(this.batchBytes);
    let cursor = 0;
    for (const part of this.batch) {
      merged.set(part, cursor);
      cursor += part.length;
    }
    this.batch = [];
    this.batchBytes = 0;
    const writable = await this.ensureWritable();
    await writable.write(merged);
    this.flushed += merged.length;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.suspended) return;
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    this.batch.push(copy);
    this.batchBytes += copy.length;
    if (this.batchBytes >= FLUSH_BYTES) await this.flush();
  }

  async finish(): Promise<Blob> {
    await this.flush();
    if (this.writable) {
      await this.writable.close();
      this.writable = null;
    }
    const root = await opfsRoot();
    const handle = await root.getFileHandle(this.fileId);
    const file = await handle.getFile();
    // Keep the entry: Chrome's File reads from the OPFS backing file, so
    // removing it here can leave a blob that looks sized but reads empty.
    // Stale entries are swept on the next page load instead.
    writeRecord(null);
    return new Blob([file], { type: this.meta.mime });
  }

  async suspend(): Promise<void> {
    await trackSuspend(async () => {
      this.suspended = true;
      await this.flush().catch(() => undefined);
      if (this.writable) {
        await this.writable.close().catch(() => undefined);
        this.writable = null;
      }
      trace('opfs suspend', this.flushed, 'batch', this.batchBytes);
      writeRecord({ fileId: this.fileId, meta: this.meta, bytes: this.flushed });
    });
  }

  /** Called when a fresh attempt takes this store over. */
  reopen(): void {
    this.suspended = false;
  }

  async discard(): Promise<void> {
    await this.writable?.abort().catch(() => undefined);
    this.writable = null;
    this.suspended = false;
    this.batch = [];
    this.batchBytes = 0;
    const root = await opfsRoot();
    await root.removeEntry(this.fileId).catch(() => undefined);
    const record = readRecord();
    if (!record || record.fileId === this.fileId) writeRecord(null);
  }
}

class MemoryStore implements ReceiveStore {
  private chunks: Uint8Array[] = [];
  private received = 0;
  private suspended = false;

  constructor(private readonly mime: string) {}

  /** Bytes already held, so an in-page resume can continue mid-file. */
  get offset(): number {
    return this.received;
  }

  async write(bytes: Uint8Array): Promise<void> {
    // Bytes from a connection that already died would be duplicated by the
    // next attempt, which re-sends everything after the stored offset.
    if (this.suspended) return;
    this.chunks.push(bytes);
    this.received += bytes.length;
  }

  async finish(): Promise<Blob> {
    const blob = new Blob(this.chunks as BlobPart[], { type: this.mime });
    this.chunks = [];
    return blob;
  }

  async suspend(): Promise<void> {
    // Memory around means the page is alive; the in-memory chunks stay put.
    await trackSuspend(async () => {
      this.suspended = true;
    });
  }

  reopen(): void {
    this.suspended = false;
  }

  async discard(): Promise<void> {
    this.chunks = [];
    this.received = 0;
    this.suspended = false;
  }
}

/** Same-page resume: the store object itself survives a channel drop. */
let pending: { meta: StoreMeta; store: ReceiveStore } | null = null;

/** A suspend in flight: a resume must not touch the file until it lands. */
let suspending: Promise<void> | null = null;

/**
 * The transfer parks its store before the await inside, so the marker has to
 * cover the whole suspend: a resume that arrives first waits for it.
 */
export function markSuspending(work: Promise<void>): void {
  suspending = work.catch(() => undefined);
}

function trackSuspend(run: () => Promise<void>): Promise<void> {
  const task = run();
  suspending = task.catch(() => undefined);
  return task;
}

/** Persist a store for a later resume in this page. */
export function parkForResume(meta: StoreMeta, store: ReceiveStore): void {
  pending = { meta, store };
}

/**
 * Pick up where the previous session stopped, if the announced file matches.
 * Cross-reload resume needs OPFS plus the localStorage record.
 */
export async function takeResume(meta: StoreMeta): Promise<ReceiveStore | null> {
  // The previous attempt may still be closing its file; its offset is only
  // trustworthy once that has landed.
  if (suspending) await suspending;
  if (pending && metaMatches(pending.meta, meta)) {
    const store = pending.store;
    pending = null;
    store.reopen?.();
    return store;
  }
  pending = null;

  if (!opfsAvailable()) return null;
  const record = readRecord();
  if (!record || !metaMatches(record.meta, meta) || record.bytes <= 0) return null;

  try {
    const root = await opfsRoot();
    const handle = await root.getFileHandle(record.fileId);
    const size = (await handle.getFile()).size;
    trace('resume record', record.bytes, 'file', size);
    if (size <= 0 || size > meta.size) return null;
    return new OpfsStore(meta, record.fileId, size);
  } catch {
    return null;
  }
}

/** Build a store for a fresh file, preferring OPFS. */
export async function createStore(meta: StoreMeta): Promise<ReceiveStore> {
  if (!opfsAvailable()) return new MemoryStore(meta.mime);
  try {
    const fileId = `pol-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName(meta.name)}`;
    const root = await opfsRoot();
    await root.getFileHandle(fileId, { create: true });
    return new OpfsStore(meta, fileId, 0);
  } catch {
    return new MemoryStore(meta.mime);
  }
}

/** True when the browser can store big files off-heap. */
export function hasOpfs(): boolean {
  return opfsAvailable();
}

/**
 * Drop finished-but-unremoved temp files from previous visits, keeping the one
 * a pending resume still points at. Cheap: OPFS scandir is metadata only.
 */
export async function cleanupStaleFiles(): Promise<void> {
  if (!opfsAvailable()) return;
  try {
    const root = await opfsRoot();
    const record = readRecord();
    const names: string[] = [];
    const iterable = root as unknown as { keys(): AsyncIterable<string> };
    for await (const name of iterable.keys()) {
      if (name.startsWith('pol-') && name !== record?.fileId) names.push(name);
    }
    for (const name of names) await root.removeEntry(name).catch(() => undefined);
  } catch {
    /* sweeping is best-effort */
  }
}
