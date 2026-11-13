/**
 * Hợp đồng của điểm chọn adapter — bằng chứng hành vi cho những gì
 * `adapter-slot.ts` lập luận bằng lời:
 *
 * - **Một `nuxtApp` — một adapter**: cùng app gọi hai lần nhận cùng instance
 *   (ghi của trang này, trang khác phải thấy).
 * - **Hai `nuxtApp` — hai adapter**: trên SSR mỗi request một app, nên hai
 *   request không bao giờ dùng chung adapter. Test này là hàng rào chống hồi
 *   quy đúng thứ `AGENTS.md` cấm: nếu một refactor biến composable thành
 *   singleton module-level, cả hai khẳng định trên đều đỏ.
 * - **Slot trống — fallback là adapter thật**: `isPreview: false` chứng minh
 *   nhánh fallback không bao giờ là đường preview.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { AccountNuxtApp } from '../account-data/adapter-slot';
import { useAccountAdapter } from './use-account-adapter';

describe('adapter selection contract', () => {
  const globals = globalThis as Record<string, unknown>;
  const originalUseNuxtApp = globals.useNuxtApp;

  afterEach(() => {
    globals.useNuxtApp = originalUseNuxtApp;
  });

  it('serves one adapter per nuxtApp and falls back to the real adapter on an empty slot', () => {
    const nuxtApp = {} as AccountNuxtApp;
    globals.useNuxtApp = (): unknown => nuxtApp;

    const first = useAccountAdapter();
    const second = useAccountAdapter();

    expect(second).toBe(first);
    expect(first.isPreview).toBe(false);
  });

  it('never shares an adapter across two nuxtApps', () => {
    const appA = {} as AccountNuxtApp;
    const appB = {} as AccountNuxtApp;
    let current: AccountNuxtApp = appA;
    globals.useNuxtApp = (): unknown => current;

    const adapterA = useAccountAdapter();
    current = appB;
    const adapterB = useAccountAdapter();

    expect(adapterB).not.toBe(adapterA);
    expect(appA.$accountAdapter).toBe(adapterA);
    expect(appB.$accountAdapter).toBe(adapterB);
  });
});
