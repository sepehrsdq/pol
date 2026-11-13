import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildIceServers,
  DEFAULT_STUN,
  fetchMeteredServers,
  hasIncompleteTurn,
  hasMetered,
  meteredUrl,
  normalizeMeteredServers,
  parseList,
  resetMeteredCache,
  turnCredential,
} from './ice.mjs';

afterEach(() => {
  resetMeteredCache();
  vi.restoreAllMocks();
});

describe('parseList', () => {
  it('splits on commas and whitespace', () => {
    expect(parseList('turn:a:3478, turn:b:443')).toEqual(['turn:a:3478', 'turn:b:443']);
    expect(parseList('  ')).toEqual([]);
    expect(parseList(undefined)).toEqual([]);
  });
});

describe('turnCredential', () => {
  it('builds a coturn REST credential', () => {
    const now = 1_700_000_000_000;
    const result = turnCredential('secret', 3600, now);
    const expectedUser = `${Math.floor(now / 1000) + 3600}:pol`;
    const expectedCredential = createHmac('sha1', 'secret').update(expectedUser).digest('base64');

    expect(result.username).toBe(expectedUser);
    expect(result.credential).toBe(expectedCredential);
    expect(result.ttl).toBe(3600);
  });

  it('falls back to the default ttl for invalid values', () => {
    const result = turnCredential('secret', -5, 1_700_000_000_000);
    expect(result.ttl).toBe(3600);
  });
});

describe('buildIceServers', () => {
  it('returns public STUN by default', () => {
    const result = buildIceServers({}, 1_700_000_000_000);
    expect(result).toEqual({ iceServers: [{ urls: DEFAULT_STUN }], ttl: 0 });
  });

  it('adds time-limited TURN credentials', () => {
    const now = 1_700_000_000_000;
    const result = buildIceServers(
      { TURN_URLS: 'turn:turn.example.com:3478,turns:turn.example.com:443', TURN_SECRET: 's3cret' },
      now,
    );

    expect(result.iceServers).toHaveLength(2);
    expect(result.iceServers[1].urls).toEqual([
      'turn:turn.example.com:3478',
      'turns:turn.example.com:443',
    ]);
    expect(result.iceServers[1].username).toBe(`${Math.floor(now / 1000) + 3600}:pol`);
    expect(result.ttl).toBe(3600);
    expect(JSON.stringify(result)).not.toContain('s3cret');
  });

  it('supports static TURN credentials', () => {
    const result = buildIceServers({
      TURN_URLS: 'turn:turn.example.com:3478',
      TURN_USERNAME: 'user',
      TURN_PASSWORD: 'pass',
    });

    expect(result.iceServers[1]).toEqual({
      urls: ['turn:turn.example.com:3478'],
      username: 'user',
      credential: 'pass',
    });
    expect(result.ttl).toBe(0);
  });

  it('honours STUN_URLS and reports incomplete TURN', () => {
    const result = buildIceServers({ STUN_URLS: 'stun:custom.example.com:3478', TURN_URLS: 'turn:x:3478' });
    expect(result.iceServers[0].urls).toEqual(['stun:custom.example.com:3478']);
    expect(result.iceServers).toHaveLength(1);
    expect(hasIncompleteTurn({ TURN_URLS: 'turn:x:3478' })).toBe(true);
    expect(hasIncompleteTurn({ TURN_URLS: 'turn:x:3478', TURN_SECRET: 's' })).toBe(false);
  });
});

describe('metered', () => {
  const env = { METERED_APP: 'astrids', METERED_KEY: 'k3y' };

  it('detects complete metered config', () => {
    expect(hasMetered(env)).toBe(true);
    expect(hasMetered({ METERED_APP: 'astrids' })).toBe(false);
    expect(hasMetered({ METERED_KEY: 'k3y' })).toBe(false);
    expect(hasMetered({ METERED_APP: '  ', METERED_KEY: 'k3y' })).toBe(false);
  });

  it('builds the credentials endpoint url without leaking the key into paths', () => {
    const url = meteredUrl('astrids', 'k3y');
    expect(url.origin).toBe('https://astrids.metered.live');
    expect(url.pathname).toBe('/api/v1/turn/credentials');
    expect(url.searchParams.get('apiKey')).toBe('k3y');
  });

  it('trims spaces around the app name', () => {
    expect(meteredUrl(' astrids ', 'k3y').host).toBe('astrids.metered.live');
  });

  it('normalizes the metered response shape', () => {
    const servers = normalizeMeteredServers([
      {
        urls: 'turn:standard.relay.metered.ca:443?transport=tcp',
        username: 'abc',
        credential: 'def',
      },
      { urls: ['stun:stun.relay.metered.ca:80'], username: 'x', credential: 'y' },
      { urls: 'ftp:not-a-thing' },
      null,
      'garbage',
    ]);

    expect(servers).toEqual([
      {
        urls: ['turn:standard.relay.metered.ca:443?transport=tcp'],
        username: 'abc',
        credential: 'def',
      },
      { urls: ['stun:stun.relay.metered.ca:80'], username: 'x', credential: 'y' },
    ]);
  });

  it('fetches from metered and keeps the key out of the result', async () => {
    const fake = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          { urls: 'turn:standard.relay.metered.ca:80', username: 'u-1', credential: 'p-1' },
        ]),
        { status: 200 },
      ),
    );

    const result = await fetchMeteredServers(env, { fetch: /** @type {any} */ (fake) });

    expect(fake).toHaveBeenCalledOnce();
    expect(fake.mock.calls[0][0]).toMatchObject({ host: 'astrids.metered.live' });
    expect(result.cached).toBe(false);
    expect(result.iceServers).toEqual([
      { urls: ['turn:standard.relay.metered.ca:80'], username: 'u-1', credential: 'p-1' },
    ]);
    expect(JSON.stringify(result)).not.toContain('k3y');
  });

  it('throws on http errors', async () => {
    const fake = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(fetchMeteredServers(env, { fetch: /** @type {any} */ (fake) })).rejects.toThrow('metered 401');
  });

  it('throws when the response has no usable servers', async () => {
    const fake = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    await expect(fetchMeteredServers(env, { fetch: /** @type {any} */ (fake) })).rejects.toThrow(
      'no usable ice servers',
    );
  });

  it('caches responses within the ttl', async () => {
    const fake = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ urls: 'turn:a:3478', username: 'u', credential: 'p' }]), {
        status: 200,
      }),
    );
    const deps = { fetch: /** @type {any} */ (fake), now: 1_000_000 };

    await fetchMeteredServers(env, deps);
    const second = await fetchMeteredServers(env, deps);

    expect(fake).toHaveBeenCalledOnce();
    expect(second.cached).toBe(true);
    expect(second.iceServers).toEqual([{ urls: ['turn:a:3478'], username: 'u', credential: 'p' }]);
  });

  it('refetches after the cache ttl expires', async () => {
    const fake = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          resolve(
            new Response(JSON.stringify([{ urls: 'turn:a:3478', username: 'u', credential: 'p' }]), {
              status: 200,
            }),
          ),
        ),
    );

    await fetchMeteredServers(env, { fetch: /** @type {any} */ (fake), now: 1_000_000 });
    await fetchMeteredServers(env, { fetch: /** @type {any} */ (fake), now: 1_000_000 + 10 * 60 * 1000 + 1 });

    expect(fake).toHaveBeenCalledTimes(2);
  });
});
