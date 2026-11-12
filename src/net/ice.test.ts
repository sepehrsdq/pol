import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configuredIceServers,
  DEFAULT_STUN,
  hasTurnServer,
  iceEndpoint,
  loadIceServers,
  normalizeIceServers,
} from './ice';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('normalizeIceServers', () => {
  it('drops entries without usable urls', () => {
    expect(normalizeIceServers(null)).toEqual([]);
    expect(normalizeIceServers([{ urls: '' }, { urls: [] }, { username: 'x' }, 4])).toEqual([]);
  });

  it('keeps urls and credentials only when they are strings', () => {
    const servers = normalizeIceServers([
      { urls: 'stun:stun.example.com:3478' },
      { urls: ['turn:turn.example.com:3478'], username: 'user', credential: 'pass' },
      { urls: 'turn:other.example.com', username: 7, credential: null },
    ]);

    expect(servers).toEqual([
      { urls: 'stun:stun.example.com:3478' },
      { urls: ['turn:turn.example.com:3478'], username: 'user', credential: 'pass' },
      { urls: 'turn:other.example.com' },
    ]);
  });
});

describe('hasTurnServer', () => {
  it('detects turn and turns urls', () => {
    expect(hasTurnServer([{ urls: 'stun:stun.example.com:3478' }])).toBe(false);
    expect(hasTurnServer([{ urls: 'turn:turn.example.com:3478' }])).toBe(true);
    expect(hasTurnServer([{ urls: ['stun:x', 'turns:turn.example.com:443'] }])).toBe(true);
  });
});

describe('configuredIceServers', () => {
  it('parses a JSON array and rejects broken values', () => {
    expect(configuredIceServers('[{"urls":"stun:a"}]')).toEqual([{ urls: 'stun:a' }]);
    expect(configuredIceServers('not json')).toBeNull();
    expect(configuredIceServers('')).toBeNull();
    expect(configuredIceServers('{"urls":"stun:a"}')).toBeNull();
  });
});

describe('iceEndpoint', () => {
  it('maps ws and wss to http and https on /ice', () => {
    expect(iceEndpoint('wss://qqsp.ir/signal')).toBe('https://qqsp.ir/ice');
    expect(iceEndpoint('ws://127.0.0.1:8787/signal?x=1')).toBe('http://127.0.0.1:8787/ice');
  });
});

describe('loadIceServers', () => {
  it('uses the server list when it is valid', async () => {
    vi.stubEnv('VITE_ICE', '');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          iceServers: [
            { urls: 'stun:stun.example.com:3478' },
            { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' },
          ],
        }),
      })),
    );

    const config = await loadIceServers('wss://qqsp.ir/signal');
    expect(config.hasTurn).toBe(true);
    expect(config.servers).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it('falls back to STUN when the endpoint fails', async () => {
    vi.stubEnv('VITE_ICE', '');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));

    const config = await loadIceServers('wss://qqsp.ir/signal', 50);
    expect(config).toEqual({ servers: DEFAULT_STUN, hasTurn: false });
    vi.unstubAllGlobals();
  });

  it('prefers the build-time VITE_ICE override', async () => {
    vi.stubEnv('VITE_ICE', '[{"urls":"turn:custom.example.com:3478","username":"u","credential":"c"}]');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const config = await loadIceServers('wss://qqsp.ir/signal');
    expect(config.hasTurn).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
