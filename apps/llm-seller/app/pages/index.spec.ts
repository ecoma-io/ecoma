/**
 * Colocated spec của trang overview — hợp đồng render trên catalog thật.
 *
 * Trang scaffold có ba bất biến đáng ghim:
 *
 * - **Đúng một `<h1>`**, localized theo locale đang chọn. Shell không render
 *   heading nào, nên mọi `h1` thứ hai là lỗi a11y của chính trang.
 * - **Không có metric bịa**: chưa có dữ liệu nghiệp vụ nào được định nghĩa, nên
 *   trang không được render bảng số liệu hay con số nào. Một bảng "offers" với
 *   vài dòng giả sẽ là claim mà app không có quyền đưa ra.
 * - **Thông báo scaffold** hiện đúng nội dung đã dịch ở cả `en` và `vi` — nó là
 *   câu duy nhất nói cho người dùng biết phần nào chưa được hiện thực.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import IndexPage from './index.vue';
import { mountLlmSellerPage } from '../../tests/harness';
import { i18n } from '../../tests/nuxt-globals';

afterEach(() => {
  vi.unstubAllGlobals();
  // `i18n` là singleton cấp module: trả locale về mặc định để test sau không
  // phụ thuộc thứ tự chạy (`tests/setup.ts` cũng làm việc này ở `beforeEach`).
  i18n.global.locale.value = 'en';
});

describe('seller overview page', () => {
  it('renders exactly one h1 with the localized title', async () => {
    const wrapper = await mountLlmSellerPage(IndexPage);

    const headings = wrapper.findAll('h1');
    expect(headings).toHaveLength(1);
    expect(headings[0]?.text()).toBe('Overview');
    wrapper.unmount();
  });

  it('renders the scaffold notice in en', async () => {
    const wrapper = await mountLlmSellerPage(IndexPage);

    const notice = wrapper.find('[data-testid="llm-seller-scaffold-notice"]');
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toContain('Scaffold ready');
    expect(notice.text()).toContain(
      'Onboarding, verification, offers, pricing, earnings and payouts are not implemented yet.',
    );
    wrapper.unmount();
  });

  it('renders the scaffold notice translated in vi', async () => {
    i18n.global.locale.value = 'vi';
    const wrapper = await mountLlmSellerPage(IndexPage);

    expect(wrapper.find('h1').text()).toBe('Tổng quan');
    const notice = wrapper.find('[data-testid="llm-seller-scaffold-notice"]');
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toContain('Khung giao diện đã sẵn sàng');
    expect(notice.text()).toContain('chưa được hiện thực');
    wrapper.unmount();
  });

  it('renders no table and no numeric metric', async () => {
    const wrapper = await mountLlmSellerPage(IndexPage);

    expect(wrapper.find('table').exists()).toBe(false);
    expect(wrapper.find('[data-testid*="metric"]').exists()).toBe(false);
    // Một con số bất kỳ trên trang đều là số liệu bịa ở giai đoạn này — copy
    // hiện tại không chứa chữ số, nên phép kiểm này trực tiếp ghim bất biến.
    expect(wrapper.text()).not.toMatch(/[0-9]/u);
    wrapper.unmount();
  });
});
