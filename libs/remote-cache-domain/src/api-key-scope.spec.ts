import { describe, expect, it } from 'vitest';

import {
  hasRemoteCacheWriteScope,
  isRemoteCacheApiKeyScopeList,
  REMOTE_CACHE_API_KEY_SCOPES,
  REMOTE_CACHE_API_KEY_SCOPE_PATTERN,
} from './api-key-scope';

describe('remote-cache api key scopes', () => {
  it('exposes exactly read and write — no staff-access permission vocabulary', () => {
    expect([...REMOTE_CACHE_API_KEY_SCOPES].toSorted()).toEqual(['read', 'write'].toSorted());
  });

  it('accepts single-scope and space-separated multi-scope lists', () => {
    expect(isRemoteCacheApiKeyScopeList('read')).toBe(true);
    expect(isRemoteCacheApiKeyScopeList('write')).toBe(true);
    expect(isRemoteCacheApiKeyScopeList('read write')).toBe(true);
    expect(isRemoteCacheApiKeyScopeList('write read')).toBe(true);
  });

  it('rejects empty, duplicated, unknown-token, and malformed scope lists', () => {
    expect(isRemoteCacheApiKeyScopeList('')).toBe(false);
    expect(isRemoteCacheApiKeyScopeList('read read')).toBe(false);
    expect(isRemoteCacheApiKeyScopeList('read  write')).toBe(false);
    expect(isRemoteCacheApiKeyScopeList('admin')).toBe(false);
    expect(isRemoteCacheApiKeyScopeList('read,write')).toBe(false);
    expect(isRemoteCacheApiKeyScopeList(' read')).toBe(false);
    expect(isRemoteCacheApiKeyScopeList('read ')).toBe(false);
    expect(isRemoteCacheApiKeyScopeList(null)).toBe(false);
    expect(isRemoteCacheApiKeyScopeList(123)).toBe(false);
  });

  it('keeps the DB CHECK format pattern aligned with the validator', () => {
    // DB CHECK chi gap FORMAT (token hop le, mot khoang); quy tac khong lap do
    // validator thuc thi — hai lop chia viec chu khong nhan ban tap chap nhan.
    const pattern = new RegExp(REMOTE_CACHE_API_KEY_SCOPE_PATTERN, 'u');
    expect(pattern.test('read')).toBe(true);
    expect(pattern.test('read write')).toBe(true);
    expect(pattern.test('')).toBe(false);
    expect(pattern.test('admin')).toBe(false);
    expect(pattern.test('read,write')).toBe(false);
  });

  it('detects the write scope for write-side authorization', () => {
    expect(hasRemoteCacheWriteScope(['read', 'write'])).toBe(true);
    expect(hasRemoteCacheWriteScope(['read'])).toBe(false);
    expect(hasRemoteCacheWriteScope([])).toBe(false);
  });
});
