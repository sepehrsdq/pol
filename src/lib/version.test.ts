import { describe, expect, it } from 'vitest';
import manifest from '../../package.json?raw';
import { APP_VERSION } from './version';

describe('APP_VERSION', () => {
  it('matches the version in package.json', () => {
    const pkg = JSON.parse(manifest) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('is a plain major.minor.patch string', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
