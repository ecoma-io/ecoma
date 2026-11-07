/**
 * Chấp nhận `useAccountLocale` — thứ tự ưu tiên giữa lựa chọn trong phiên và
 * preference đã lưu, qua **đường thật** `chooseAndPersist`.
 *
 * ⚠️ Selector header dùng `chooseLocal` (chỉ đổi trong phiên), còn trang
 * `/preferences` lưu qua `chooseAndPersist`: nếu hàm persist không cập nhật
 * `explicit` thì lựa chọn vừa lưu sẽ thua `stored` và app hiển thị locale cũ
 * trong khi server đã lưu locale mới. Test này giữ đúng hợp đồng đó.
 * (Tách từ `tests/acceptance-i18n.spec.ts` — giữ nguyên từng test case.)
 */
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';

import { useAccountLocale } from './use-account-locale';
import type { AccountLocale } from '../i18n/locale-registry';
import { createMockAccountAdapter } from '../account-data/mock-adapter';
import { accountStores } from '../../tests/nuxt-runtime-bridge';

describe('i18n acceptance', () => {
  it('a successful save wins over an explicit choice left from earlier in the session', async () => {
    // Kịch bản thật: đổi ở selector header nhưng lưu hỏng → `explicit` giữ lựa
    // chọn mới, `stored` giữ giá trị cũ; sau đó lưu thành công (đường của
    // `/preferences`, gọi `chooseAndPersist` mà **không** qua `chooseLocal`) thì
    // `explicit` phải theo locale vừa lưu — nếu không nó vẫn thắng `stored` và
    // app hiển thị locale cũ trong khi server đã lưu locale mới cho tới lần tải
    // trang sau. Key `useState` viết lại ở đây với cùng lý do với `LOCALE_COOKIE`.
    accountStores.store.set('account-locale-explicit', ref<AccountLocale>('vi'));
    accountStores.store.set('account-locale-stored', ref<AccountLocale>('en'));
    const { preferred, chooseAndPersist } = useAccountLocale();
    const outcome = await chooseAndPersist('en', createMockAccountAdapter());
    expect(outcome).toBe('saved');
    expect(preferred.value).toBe('en');
  });
});
