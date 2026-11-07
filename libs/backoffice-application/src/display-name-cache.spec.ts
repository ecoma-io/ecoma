/**
 * Unit test của `display-name-cache.ts` — TTL tuyệt đối, chính
 * sách không gia hạn null, và ghi đè entry tươi (06 §9: không dùng `Date.now`
 * thật; thời gian do test truyền).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  cachedDisplayName,
  DISPLAY_NAME_CACHE_TTL_SECONDS,
  resetDisplayNameCacheForTests,
  storeDisplayNames,
} from './display-name-cache';

const T0 = 1_000_000_000_000;

describe('displayName cache', () => {
  beforeEach(() => {
    resetDisplayNameCacheForTests();
  });

  it('returns undefined for a sub that was never stored', () => {
    expect(cachedDisplayName('sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', T0)).toBeUndefined();
  });

  it('returns the stored displayName within the TTL', () => {
    const sub = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    storeDisplayNames([{ sub, displayName: 'Nguyễn Văn A' }], T0);
    expect(cachedDisplayName(sub, T0 + DISPLAY_NAME_CACHE_TTL_SECONDS * 1_000 - 1)).toBe(
      'Nguyễn Văn A',
    );
  });

  it('returns undefined at exactly the expiry boundary', () => {
    const sub = 'sub_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    storeDisplayNames([{ sub, displayName: 'Trần B' }], T0);
    expect(cachedDisplayName(sub, T0 + DISPLAY_NAME_CACHE_TTL_SECONDS * 1_000)).toBeUndefined();
  });

  it('caches null but only for one TTL — it is never refreshed into a longer life', () => {
    const sub = 'sub_cccccccccccccccccccccccccccccccc';
    storeDisplayNames([{ sub, displayName: null }], T0);

    // Đọc nhiều lần trong TTL không nối dài tuổi null...
    for (let ms = 1_000; ms < DISPLAY_NAME_CACHE_TTL_SECONDS * 1_000; ms += 10_000) {
      expect(cachedDisplayName(sub, T0 + ms)).toBeNull();
    }
    // ...và hết TTL là hết — không đọc lại được từ cache.
    expect(cachedDisplayName(sub, T0 + DISPLAY_NAME_CACHE_TTL_SECONDS * 1_000)).toBeUndefined();
  });

  it('overwrites a fresh entry with newer batch data', () => {
    const sub = 'sub_dddddddddddddddddddddddddddddddd';
    storeDisplayNames([{ sub, displayName: 'Tên cũ' }], T0);
    storeDisplayNames([{ sub, displayName: 'Tên mới' }], T0 + 1_000);

    expect(cachedDisplayName(sub, T0 + 2_000)).toBe('Tên mới');
  });

  it('deletes the entry on the first read past the TTL instead of keeping it', () => {
    const sub = 'sub_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    storeDisplayNames([{ sub, displayName: 'X' }], T0);
    cachedDisplayName(sub, T0 + DISPLAY_NAME_CACHE_TTL_SECONDS * 1_000 + 1);
    // Đọc lần hai sau khi entry đã bị xoá — vẫn undefined, không phục hồi.
    expect(cachedDisplayName(sub, T0 + DISPLAY_NAME_CACHE_TTL_SECONDS * 1_000 + 2)).toBeUndefined();
  });
});
