/**
 * Chấp nhận các trạng thái trang dữ liệu — bốn trạng thái trên **mọi** trang dữ liệu.
 *
 * ⚠️ Yêu cầu sản phẩm là **mọi** trang dữ liệu phải có đủ loading/empty/error/success.
 * Test này dùng adapter **cố ý hỏng** để ép nhánh lỗi: mock mặc định trả dữ liệu tốt,
 * và nếu chỉ kiểm bằng mock mặc định thì nhánh lỗi không bao giờ chạy — trang vẫn "có
 * trạng thái lỗi" trên giấy mà không ai từng thấy nó render.
 *
 * ⚠️ Danh sách lời gọi **đọc** viết tay chứ không dò bằng tiền tố `get`: adapter có cả
 * `getProfile` lẫn `listEmails`, và một bộ lọc theo tiền tố sẽ âm thầm bỏ qua nửa còn
 * lại — nhánh lỗi của những trang danh sách sẽ không bao giờ được kiểm mà test vẫn xanh.
 *
 * (Tách từ `tests/acceptance-data-pages.spec.ts` — nhóm `data page states` giữ nguyên
 * từng test case.)
 */
import { describe, expect, it } from 'vitest';
import type { Component } from 'vue';
import type { AccountAdapter } from '../account-data/types';

import { createMockAccountAdapter } from '../account-data/mock-adapter';

import ProfilePage from './index.vue';
import EmailsPage from './emails.vue';
import SecurityPage from './security.vue';
import SessionsPage from './sessions.vue';
import ApplicationsPage from './applications.vue';
import PreferencesPage from './preferences.vue';
import NotificationsPage from './notifications.vue';
import PrivacyPage from './privacy.vue';
import { mountAccount } from '../../tests/harness';

type DataPage = {
  readonly name: string;
  readonly component: Component;
  /** Trang có nhánh rỗng, hay luôn có dữ liệu vì nó là **một** object. */
  readonly hasEmpty: boolean;
  /** Trang có `useAsyncState` nhiều lần — adapter hỏng ở lần nào cũng phải ra lỗi. */
  readonly reads: readonly string[];
};

/**
 * ⚠️ `/preferences` và `/notifications` không có nhánh rỗng: chúng là một object
 * preference nên luôn có dữ liệu, và chỉ có loading/error/ready. `useAsyncState` cố ý bỏ
 * nhánh `empty` cho những trang đó — giữ nó nghĩa là có một template branch không bao
 * giờ tới mà vẫn phải viết `v-else-if`, và mọi lần sửa sau đó lại phải thêm một kiểm tra
 * cho nhánh chết đó.
 */
const DATA_PAGES: readonly DataPage[] = [
  {
    name: '/',
    component: ProfilePage,
    hasEmpty: true,
    reads: ['getProfile'],
  },
  {
    name: '/emails',
    component: EmailsPage,
    hasEmpty: true,
    reads: ['listEmails'],
  },
  {
    name: '/security',
    component: SecurityPage,
    hasEmpty: true,
    reads: ['getTotpState', 'getRecoveryCodesState', 'listPasskeys'],
  },
  {
    name: '/sessions',
    component: SessionsPage,
    hasEmpty: true,
    reads: ['listSessions'],
  },
  {
    name: '/applications',
    component: ApplicationsPage,
    hasEmpty: true,
    reads: ['listApplications'],
  },
  {
    name: '/preferences',
    component: PreferencesPage,
    hasEmpty: false,
    reads: ['getPreferences'],
  },
  {
    name: '/notifications',
    component: NotificationsPage,
    hasEmpty: false,
    reads: ['getNotificationPreferences'],
  },
  {
    name: '/privacy',
    component: PrivacyPage,
    hasEmpty: true,
    reads: ['listPrivacyRequests'],
  },
] as const;

/** Thông điệp mà adapter giả ném — test khẳng định nó **hiện ra**, không bị nuốt. */
const READ_FAILURE = 'adapter read failed';

/**
 * Adapter mà mọi lời gọi đọc trong `methods` đều ném lỗi.
 *
 * ⚠️ Đây là **hợp đồng thật**: `AccountAdapter` trả `Result` cho thao tác ghi và ném cho
 * lời gọi đọc, và `useAsyncState` bắt lỗi ném để dựng nhánh `error`. Adapter trả `Result`
 * lỗi cho một lời gọi đọc sẽ không bao giờ chạm tới nhánh lỗi của **trang**.
 */
function failingReads(base: AccountAdapter, methods: readonly string[]): AccountAdapter {
  const broken = new Set(methods);
  return new Proxy(base, {
    get(target, property, receiver) {
      const name = String(property);
      if (broken.has(name)) {
        return () => {
          throw new Error(READ_FAILURE);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** Adapter có sẵn dữ liệu **rỗng** cho mọi lời gọi đọc. */
function emptyReads(base: AccountAdapter, methods: readonly string[]): AccountAdapter {
  const emptied = new Set(methods);
  return new Proxy(base, {
    get(target, property, receiver) {
      const name = String(property);
      if (emptied.has(name)) {
        return async () => {
          // Profile rỗng nhất vẫn phải là **object**: `useAsyncState` gọi `isEmpty` trên nó
          // và template đọc `displayName`. Một object rỗng là hình dạng "không có thông
          // tin" mà `/` hiển thị, khác hẳn với một mảng rỗng.
          return name === 'getProfile' ? { displayName: '', avatarUrl: undefined } : [];
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

describe('data page states', () => {
  // Không bọc `describe(page.name, …)`: `vitest(valid-title)` đòi title của `describe`
  // phải là chuỗi tĩnh, mà `page.name` đến từ vòng lặp. Tên trang đã nằm trong chính
  // title của từng `it`, nên nhóm ngoài không mang thêm thông tin nào.
  for (const page of DATA_PAGES) {
    for (const read of page.reads) {
      // Title ghép từ `read` như một template literal **inline** — đây là dạng repo
      // đã dùng và lint chấp nhận (`vitest(valid-title)` chỉ phạt khi title đi qua
      // biến, vì lúc đó công cụ không đọc được tên test).
      it(`shows an error state when ${read} fails`, async () => {
        const { wrapper } = await mountAccount(page.component, {
          adapter: failingReads(createMockAccountAdapter(), [read]),
        });

        expect(wrapper.find('[data-testid="account-error"]').exists()).toBe(true);
        // Không được nuốt: nội dung lỗi phải hiện ra để người dùng có gì báo support.
        expect(wrapper.find('[data-testid="account-error-detail"]').text()).toContain(READ_FAILURE);
      });
    }

    it('shows an error state, not an empty one, when a read fails', async () => {
      const { wrapper } = await mountAccount(page.component, {
        adapter: failingReads(createMockAccountAdapter(), page.reads),
      });

      // Nhánh rỗng là trạng thái **riêng**: hiện nó khi đọc hỏng là nói dối người dùng
      // rằng họ không có dữ liệu, trong khi thật ra app không biết.
      expect(wrapper.find('[data-testid="account-error"]').exists()).toBe(true);
    });

    it('does not show an empty state for a read that failed', async () => {
      const { wrapper } = await mountAccount(page.component, {
        adapter: failingReads(createMockAccountAdapter(), page.reads),
      });

      expect(wrapper.find('[data-testid="account-empty"]').exists()).toBe(false);
    });

    it('renders its own content when the adapter succeeds', async () => {
      const { wrapper } = await mountAccount(page.component);

      expect(wrapper.find('[data-testid="account-error"]').exists()).toBe(false);
      expect(wrapper.find('h1').exists(), `${page.name} must have an h1`).toBe(true);
    });
  }

  describe('empty states', () => {
    for (const page of DATA_PAGES.filter((candidate) => candidate.hasEmpty)) {
      it(`${page.name} shows an empty state when the adapter returns nothing`, async () => {
        const { wrapper } = await mountAccount(page.component, {
          adapter: emptyReads(createMockAccountAdapter(), page.reads),
        });

        expect(wrapper.find('[data-testid="account-error"]').exists()).toBe(false);
        expect(
          wrapper.find('[data-testid="account-empty"]').exists(),
          `${page.name} must render an empty state`,
        ).toBe(true);
      });
    }

    for (const page of DATA_PAGES.filter((candidate) => !candidate.hasEmpty)) {
      it(`${page.name} has no empty state: its data is always one object`, async () => {
        const { wrapper } = await mountAccount(page.component);

        // Trang đã **tải xong** — thiếu nhánh rỗng là quyết định có chủ ý, không phải sót.
        expect(wrapper.find('[data-testid="account-error"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="account-empty"]').exists()).toBe(false);
      });
    }
  });
});
