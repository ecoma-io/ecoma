/**
 * Bất biến passwordless và trạng thái của `/login/continue` — điểm kết-cuộc của
 * luồng đăng nhập không qua mật khẩu.
 *
 * ⚠️ Trang này nhận `handle` từ query và **không được** để lộ nó: handle trong DOM
 * là handle trong SSR HTML, trong view-source và trong mọi script quét DOM (FR-006k3).
 * Ngoài ra thứ tự trạng thái phải trung thực — request đang treo thì hiện loading,
 * không hiện lỗi sớm; không handle thì không có gì để retry.
 * (Tách từ `tests/acceptance-passwordless.spec.ts` — giữ nguyên từng test case.)
 */
import { describe, expect, it } from 'vitest';

import ContinuePage from './continue.vue';
import type { AccountAdapter } from '../../account-data/types';
import { createMockAccountAdapter } from '../../account-data/mock-adapter';
import { mountAccount } from '../../../tests/harness';

/**
 * Adapter chờ bàn giao **do test điều khiển**: `completeHandoff` chỉ resolve khi
 * test gọi `resolve()` — để khẳng định trạng thái *trong lúc* request chưa xong
 * (trước đây nhánh `v-else` nuốt `loading` và hiện lỗi sớm).
 */
function createDeferredHandoff(): {
  adapter: AccountAdapter;
  resolve: (outcome: 'already-processed') => void;
  flush: (wrapper: { vm: { $nextTick(): Promise<void> } }) => Promise<void>;
} {
  let release: (() => void) | undefined;
  let flushHook: (() => Promise<void>) | undefined;
  const adapter = createMockAccountAdapter();
  return {
    adapter: {
      ...adapter,
      completeHandoff: async () => {
        await new Promise<void>((resolvePromise) => {
          release = resolvePromise;
        });
        if (flushHook !== undefined) {
          await flushHook();
        }
        // Outcome không cấp URL (`already_processed`) — hợp đồng vắng URL.
        return { ok: true, value: { continueUrl: undefined } } as const;
      },
    },
    resolve: () => {
      release?.();
    },
    flush: async (wrapper) => {
      flushHook = () => wrapper.vm.$nextTick();
      await new Promise((resolveTimer) => {
        setTimeout(resolveTimer, 0);
      });
      await wrapper.vm.$nextTick();
    },
  };
}

describe('passwordless invariant', () => {
  it('/login/continue builds no protocol continuation URL', async () => {
    const { wrapper, setRoute } = await mountAccount(ContinuePage);
    setRoute({
      path: '/login/continue',
      query: { handle: 'opaque-handle-value' },
    });

    // Không có form, không có `action`/`href` chứa tham số protocol.
    expect(wrapper.find('form').exists()).toBe(false);
    for (const anchor of wrapper.findAll('a')) {
      const href = anchor.attributes('href') ?? '';
      expect(href).not.toMatch(/[?&](code|state|client_id|redirect_uri|scope)=/u);
    }
  });

  it('/login/continue never renders the continuation handle into the DOM', async () => {
    // Handle trong DOM là handle trong HTML SSR, trong view-source, trong cây
    // accessibility và trong mọi script quét DOM — một đường rò handle ra ngoài
    // luồng sinh ra nó (FR-006k3). Trước đây một `<p class="sr-only">` dán nó
    // thẳng vào trang; test này giữ cho nó không quay lại.
    const HANDLE = 'opaque-handle-value';
    const { wrapper } = await mountAccount(ContinuePage, {
      route: { path: '/login/continue', query: { handle: HANDLE } },
    });

    expect(wrapper.html()).not.toContain(HANDLE);
    expect(wrapper.find('[data-testid="login-continue-handle"]').exists()).toBe(false);
  });

  it('/login/continue shows a loading state first, not a premature error', async () => {
    // Trước đây nhánh `v-else` nuốt cả `loading`: lỗi "thất bại" hiện trước khi
    // request kịp chạy xong rồi mới nhảy sang thành công. Tách nhánh loading
    // (khung bốn trạng thái) giữ cho thứ tự trạng thái trung thực.
    const HANDOFF_DELAY = createDeferredHandoff();
    const { wrapper } = await mountAccount(ContinuePage, {
      route: {
        path: '/login/continue',
        query: { handle: 'opaque-handle-value' },
      },
      adapter: HANDOFF_DELAY.adapter,
    });

    // Request vẫn đang treo — trang hiện loading, không hiện trạng lỗi.
    expect(wrapper.find('[data-testid="account-loading"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="login-continue-retry"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Login could not be completed');

    HANDOFF_DELAY.resolve('already-processed');
    await HANDOFF_DELAY.flush(wrapper);

    // Sau khi resolve (không URL — `already_processed`): hết loading, trang
    // chuyển sang nhánh kết-cuộc thông thường của nó.
    expect(wrapper.find('[data-testid="account-loading"]').exists()).toBe(false);
  });

  it('/login/continue without a handle shows the error state with no retry button', async () => {
    // Không handle thì không có gì để retry — bấm lại chỉ lặp đúng đường
    // `undefined → lỗi`. Nút retry phải tắt hẳn, không chỉ disable.
    const { wrapper } = await mountAccount(ContinuePage, {
      route: { path: '/login/continue', query: {} },
    });

    expect(wrapper.find('[data-testid="login-continue-retry"]').exists()).toBe(false);
  });
});
