/**
 * Unit test cho phần pure của machine-token auth: scope hierarchy + hash.
 * 401 shape/scope enforcement trên HTTP được test ở integration (cần DB).
 */
import { describe, it, expect } from 'vitest';
import { scopeSatisfied, hashToken } from './token-auth';

describe('scopeSatisfied', () => {
  it('read is satisfied by any scope', () => {
    expect(scopeSatisfied(['read'], 'read')).toBe(true);
    expect(scopeSatisfied(['write'], 'read')).toBe(true);
    expect(scopeSatisfied(['admin'], 'read')).toBe(true);
  });

  it('write is satisfied by write or admin, not read', () => {
    expect(scopeSatisfied(['read'], 'write')).toBe(false);
    expect(scopeSatisfied(['write'], 'write')).toBe(true);
    expect(scopeSatisfied(['admin'], 'write')).toBe(true);
  });

  it('admin is satisfied only by admin', () => {
    expect(scopeSatisfied(['read'], 'admin')).toBe(false);
    expect(scopeSatisfied(['write'], 'admin')).toBe(false);
    expect(scopeSatisfied(['admin'], 'admin')).toBe(true);
  });

  it('empty scopes satisfy nothing', () => {
    expect(scopeSatisfied([], 'read')).toBe(false);
    expect(scopeSatisfied([], 'write')).toBe(false);
    expect(scopeSatisfied([], 'admin')).toBe(false);
  });
});

describe('hashToken', () => {
  it('produces 64-char lowercase hex (the DB lookup key shape)', async () => {
    const hash = await hashToken('some-token-value');
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('is deterministic for the same input', async () => {
    expect(await hashToken('abc')).toBe(await hashToken('abc'));
  });

  it('differs for different inputs', async () => {
    expect(await hashToken('abc')).not.toBe(await hashToken('abd'));
  });
});
