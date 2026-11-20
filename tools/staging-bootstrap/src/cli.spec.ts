import { describe, expect, it } from 'vitest';
import { assertCanonicalEnvironment, main, parseArgs } from './cli.ts';

describe('parseArgs', () => {
  it('accepts staging as the only valid environment', () => {
    expect(parseArgs(['staging'])).toEqual({ environment: 'staging' });
  });

  it('rejects unknown environments and empty args fail closed', () => {
    expect(() => parseArgs(['prod'])).toThrow(/Usage:/u);
    expect(() => parseArgs([])).toThrow(/Usage:/u);
  });
});

describe('assertCanonicalEnvironment', () => {
  it('accepts absent or exactly canonical overrides', () => {
    expect(() => assertCanonicalEnvironment({})).not.toThrow();
    expect(() =>
      assertCanonicalEnvironment({
        BOOTSTRAP_TENANT: 'ecoma',
        BOOTSTRAP_SUPERADMIN_EMAIL: 'superadmin@ecoma.io',
        BOOTSTRAP_SELLER_TENANT: 'dronie',
      }),
    ).not.toThrow();
  });

  it('refuses non-canonical input per ADR-0021 Q1', () => {
    expect(() => assertCanonicalEnvironment({ BOOTSTRAP_TENANT: 'acme' })).toThrow(
      /Refusing non-canonical/u,
    );
    expect(() => assertCanonicalEnvironment({ BOOTSTRAP_SELLER_TENANT: 'ecoma' })).toThrow(
      /Refusing non-canonical/u,
    );
    expect(() => assertCanonicalEnvironment({ BOOTSTRAP_SUPERADMIN_EMAIL: 'admin@x.io' })).toThrow(
      /Refusing non-canonical/u,
    );
  });
});

describe('main', () => {
  it('exits 2 listing blockers while staging prerequisites are unmet — fail closed before any step', () => {
    const writes: string[] = [];
    const stderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const exit = main(['staging'], {});
      expect(exit).toBe(2);
    } finally {
      process.stderr.write = stderr;
    }
    expect(writes.join('')).toMatch(/TODO\(349\/blocking\)/u);
    expect(writes.join('')).toMatch(/TODO\(351\/blocking\)/u);
  });

  it('exits 2 on non-canonical environment overrides before consulting blockers', () => {
    const exit = main(['staging'], { BOOTSTRAP_TENANT: 'acme' });
    expect(exit).toBe(2);
  });
});
