/**
 * Bất biến passwordless ở tầng layout — nav của khung app không được trỏ tới bất
 * kỳ màn hình mật khẩu nào.
 *
 * ⚠️ `app/layout/account-nav.spec.ts` kiểm **danh sách** nav; test này kiểm markup
 * đã render: mọi `<a>` thật trong layout, kể cả những link không đi qua
 * `ACCOUNT_NAV_ITEMS`. Ecoma không có mật khẩu, nên một href "quên mật khẩu" xuất
 * hiện ở đây là một đường vào UI không tồn tại.
 * (Tách từ `tests/acceptance-passwordless.spec.ts` — giữ nguyên từng test case.)
 */
import { describe, expect, it } from 'vitest';

import AccountLayout from './default.vue';
import { mountAccount } from '../../tests/harness';
import { createTestAccountAdapter } from '../../tests/test-adapter';

describe('passwordless invariant', () => {
  it('the account layout links to no password route', async () => {
    const { wrapper } = await mountAccount(AccountLayout, {
      slots: { default: '<p data-testid="slot" />' },
    });
    const hrefs = wrapper.findAll('a').map((anchor) => anchor.attributes('href') ?? '');
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).not.toMatch(/password|forgot|reset/iu);
    }
  });
});

describe('preview banner', () => {
  it('renders the preview banner when the adapter flags preview data', async () => {
    // Adapter test mặc định `isPreview: true` — banner phải có mặt, vì mọi số
    // liệu trên màn hình khi đó là fixtures ephemeral.
    const { wrapper } = await mountAccount(AccountLayout, {
      slots: { default: '<p data-testid="slot" />' },
    });
    expect(wrapper.find('[data-testid="account-preview-banner"]').exists()).toBe(true);
  });

  it('renders no preview banner on a real adapter', async () => {
    // `isPreview: false` là hợp đồng của adapter thật: banner tuyệt đối không
    // được xuất hiện — nó nói cho người dùng biết dữ liệu nào là preview.
    const { wrapper } = await mountAccount(AccountLayout, {
      adapter: { ...createTestAccountAdapter(), isPreview: false },
      slots: { default: '<p data-testid="slot" />' },
    });
    expect(wrapper.find('[data-testid="account-preview-banner"]').exists()).toBe(false);
  });
});
