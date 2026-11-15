import { beforeEach, describe, expect, it } from 'vitest';
import {
  createStore,
  hasOpfs,
  metaMatches,
  parkForResume,
  takeResume,
  type StoreMeta,
} from './receive-store';

const meta: StoreMeta = { name: 'report.pdf', size: 12, mime: 'application/pdf', modified: 1_700_000_000_000 };

beforeEach(() => {
  // Drop whatever a previous test parked for an in-page resume.
  parkForResume(meta, { offset: 0, write: async () => {}, finish: async () => new Blob(), suspend: async () => {}, discard: async () => {} });
  void takeResume({ ...meta, name: 'other' });
});

describe('metaMatches', () => {
  it('accepts the same name, size and timestamp', () => {
    expect(metaMatches(meta, { ...meta })).toBe(true);
  });

  it('rejects a different size, name or timestamp', () => {
    expect(metaMatches(meta, { ...meta, size: 13 })).toBe(false);
    expect(metaMatches(meta, { ...meta, name: 'other.pdf' })).toBe(false);
    expect(metaMatches(meta, { ...meta, modified: 1 })).toBe(false);
  });

  it('treats a missing timestamp as null on both sides', () => {
    const a = { ...meta, modified: null };
    const b = { ...meta, modified: undefined as unknown as number | null };
    expect(metaMatches(a, b)).toBe(true);
  });
});

describe('stores without OPFS', () => {
  it('falls back to memory in this environment', () => {
    expect(hasOpfs()).toBe(false);
  });

  it('stores bytes and hands back the right blob', async () => {
    const store = await createStore(meta);
    expect(store.offset).toBe(0);

    await store.write(new TextEncoder().encode('hello '));
    await store.write(new TextEncoder().encode('pol'));
    expect(store.offset).toBe(9);

    const blob = await store.finish();
    expect(blob.size).toBe(9);
    expect(await blob.text()).toBe('hello pol');
  });

  it('resumes from the parked store in the same page', async () => {
    const store = await createStore(meta);
    await store.write(new TextEncoder().encode('12345'));
    parkForResume(meta, store);

    const resumed = await takeResume({ ...meta });
    expect(resumed).toBe(store);
    expect(resumed?.offset).toBe(5);

    // The remaining bytes append, so the file is whole again.
    await resumed?.write(new TextEncoder().encode('6789'));
    const blob = await resumed?.finish();
    expect(await blob?.text()).toBe('123456789');
  });

  it('refuses a parked store for a different file', async () => {
    const store = await createStore(meta);
    parkForResume(meta, store);
    expect(await takeResume({ ...meta, size: 99 })).toBeNull();
  });

  it('drops bytes that arrive after a suspend', async () => {
    const store = await createStore(meta);
    await store.write(new TextEncoder().encode('12345'));
    parkForResume(meta, store);
    await store.suspend();
    // A dead connection can deliver one last chunk; the next attempt re-sends
    // everything after the stored offset, so keeping it would duplicate bytes.
    await store.write(new TextEncoder().encode('XXXXX'));

    const resumed = await takeResume({ ...meta });
    expect(resumed?.offset).toBe(5);
    await resumed?.write(new TextEncoder().encode('6789'));
    expect(await (await resumed?.finish())?.text()).toBe('123456789');
  });

  it('discard empties a memory store', async () => {
    const store = await createStore(meta);
    await store.write(new TextEncoder().encode('abc'));
    await store.discard();
    expect(store.offset).toBe(0);
    expect((await store.finish()).size).toBe(0);
  });
});
