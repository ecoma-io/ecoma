import { afterEach, describe, expect, it, vi } from 'vitest';

import IndexPage from './index.vue';
import { mountLlmConsolePage } from '../../tests/harness';
import { i18n } from '../../tests/nuxt-globals';

afterEach(() => {
  vi.unstubAllGlobals();
  // `i18n` là singleton cấp module: trả locale về mặc định để test sau không
  // phụ thuộc thứ tự chạy (`tests/setup.ts` cũng làm việc này ở `beforeEach`).
  i18n.global.locale.value = 'en';
});

/**
 * Hợp đồng render của trang overview — trang duy nhất của scaffold.
 *
 * Ba bất biến:
 *
 * 1. **Đúng một `<h1>`**, và nó là tiêu đề đã dịch. Shell không render heading
 *    nào, nên hai `h1` là một lỗi a11y thật (đường điều hướng bằng phím H bị
 *    phá), không phải chi tiết trình bày.
 * 2. **Thông báo scaffold hiện đúng theo locale** — kiểm cả `en` và `vi` trên
 *    catalog thật, không phải chuỗi giả, để một bản dịch bị rơi về tiếng Anh là
 *    đỏ ngay.
 * 3. **Không có bảng, không có metric** — trang chưa có dữ liệu nào, nên một
 *    `<table>` hay một con số ở đây chỉ có thể là dữ liệu bịa. Test này là chốt
 *    chặn cho quyết định sản phẩm đó.
 *
 * Locale được đặt trực tiếp trên composer của harness (`i18n.global.locale`) —
 * đúng composer mà `plugins: [i18n]` gắn vào cây mount. `useLlmConsoleI18n()`
 * không chạy ở đây vì nó thuộc `app.vue`; trang chỉ đọc `useI18n()`.
 */
describe('overview page', () => {
  it('renders exactly one localized h1', async () => {
    const wrapper = await mountLlmConsolePage(IndexPage);

    const headings = wrapper.findAll('h1');
    expect(headings).toHaveLength(1);
    expect(headings[0]?.text()).toBe('Overview');
    wrapper.unmount();
  });

  it('renders the scaffold notice in English', async () => {
    const wrapper = await mountLlmConsolePage(IndexPage);

    const notice = wrapper.find('[data-testid="llm-console-scaffold-notice"]');
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toContain('Scaffold ready');
    // Nói rõ phần **chưa** có — không được hứa hẹn tính năng đã tồn tại.
    expect(notice.text()).toContain('not implemented yet');
    wrapper.unmount();
  });

  it('renders the scaffold notice in Vietnamese when the composer is set to vi', async () => {
    i18n.global.locale.value = 'vi';

    const wrapper = await mountLlmConsolePage(IndexPage);

    expect(wrapper.findAll('h1')[0]?.text()).toBe('Tổng quan');
    const notice = wrapper.find('[data-testid="llm-console-scaffold-notice"]');
    expect(notice.text()).toContain('Khung giao diện đã sẵn sàng');
    // Không còn câu tiếng Anh nào rơi vào giao diện tiếng Việt.
    expect(notice.text()).not.toContain('not implemented yet');
    wrapper.unmount();
  });

  it('renders no table and no numeric metric', async () => {
    const wrapper = await mountLlmConsolePage(IndexPage);

    expect(wrapper.find('table').exists()).toBe(false);
    // Một metric bịa sẽ là một con số trên trang; trang scaffold không có con
    // số nào để hiển thị.
    expect(wrapper.text()).not.toMatch(/\d/u);
    wrapper.unmount();
  });
});
