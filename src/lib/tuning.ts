// Sender-side tuning for the data channel.
//
// These numbers never travel on the wire: the receiver does not know or care
// how the sender slices its bytes, so changing them cannot break an older
// peer. They are also settable at runtime from a `?debug=1` page, which lets
// scripts/bench.mjs measure several configurations against one build.

export interface TransferTuning {
  /** Bytes per data-channel message. */
  chunkSize: number;
  /** Queueing stops once this many bytes are buffered. */
  highWater: number;
  /** Sending resumes when the buffer drops below this. */
  lowWater: number;
}

/** Measured defaults: see docs/benchmark.md. */
export const DEFAULT_TUNING: TransferTuning = {
  chunkSize: 64 * 1024,
  highWater: 4 * 1024 * 1024,
  lowWater: 1024 * 1024,
};

/** Below this the per-message overhead dominates. */
const MIN_CHUNK_SIZE = 4 * 1024;
/** SCTP rejects messages above 256 KB, so never ask for more than that. */
const MAX_CHUNK_SIZE = 256 * 1024;
const MIN_HIGH_WATER = 256 * 1024;
/**
 * Chrome closes a data channel once its send queue is full (the hard limit is
 * 16 MB of buffered bytes), so the queue we ask for has to stay well under it.
 * Measured: a 16 MB high watermark kills the transfer; 8 MB is comfortable.
 */
const MAX_HIGH_WATER = 8 * 1024 * 1024;

function clamp(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function pick(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Merge a partial config onto a base one, clamping anything impossible.
 * Tuning must never break a transfer, so bad input is corrected, not thrown.
 */
export function resolveTuning(
  base: TransferTuning,
  patch: Partial<TransferTuning> = {},
): TransferTuning {
  const chunkSize = clamp(pick(patch.chunkSize, base.chunkSize), MIN_CHUNK_SIZE, MAX_CHUNK_SIZE);
  // Room for at least four messages, otherwise the queue waits itself to death.
  const highWater = clamp(
    pick(patch.highWater, base.highWater),
    Math.max(MIN_HIGH_WATER, chunkSize * 4),
    MAX_HIGH_WATER,
  );
  const lowWater = clamp(
    pick(patch.lowWater, base.lowWater),
    chunkSize,
    highWater - chunkSize,
  );
  return { chunkSize, highWater, lowWater };
}

/** True when the buffer is fuller than the tuning allows. */
export function isAboveHighWater(tuning: TransferTuning, bufferedAmount: number): boolean {
  return bufferedAmount > tuning.highWater;
}
