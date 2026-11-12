import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildIceServers, DEFAULT_STUN, hasIncompleteTurn, parseList, turnCredential } from './ice.mjs';

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
