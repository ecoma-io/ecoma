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
