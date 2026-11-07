/**
 * Chấp nhận `useAccountFormat` — định dạng theo timezone đã lưu và theo locale
 * **đang hiển thị**.
 *
 * ⚠️ Hai lỗi mà test này giữ: timezone chỉ có dữ liệu khi shell nạp preference
 * (fallback là UTC, không phải giờ máy), và locale của `Intl` phải theo locale
 * hiển thị chứ không chỉ `preferences.locale` — chữ đổi theo selector header thì
 * ngày giờ và số cũng phải đổi theo ngay.
 * (Tách từ `tests/acceptance-i18n.spec.ts` — giữ nguyên từng test case.)
 */
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';

import { useAccountFormat } from './use-account-preferences';
import { useAccountShellPreferences } from './use-account-shell-preferences';
import type { AccountLocale } from '../i18n/locale-registry';
import { createMockAccountAdapter } from '../account-data/mock-adapter';
import { accountStores } from '../../tests/nuxt-runtime-bridge';
import { flushPromises } from '../../tests/harness';

describe('i18n acceptance', () => {
  it('formats dates in the saved timezone once the shell has loaded preferences', async () => {
    // Timezone đọc từ `useState('account-preferences')`; state đó chỉ có dữ liệu
    // khi shell nạp. Mock lưu `Asia/Ho_Chi_Minh` (+07), còn fallback là UTC: một
    // timestamp buổi sáng UTC sẽ sang ngày hôm sau ở +07, nên hai locale cho chuỗi
    // khác nhau — khẳng định phải so sánh đúng hai chuỗi Intl. Locale trong test
    // này là 'en' (chưa có lựa chọn nào) nên chuỗi expected dựng bằng 'en'.
    const adapter = createMockAccountAdapter();
    await adapter.updatePreferences({ timezone: 'Asia/Ho_Chi_Minh' });
    accountStores.nuxtApp.$accountAdapter = adapter;
    useAccountShellPreferences();
    await flushPromises();

    const { formatDateTime } = useAccountFormat();
    const iso = '2026-01-01T20:00:00.000Z';
    const expected = new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Ho_Chi_Minh',
    }).format(new Date(iso));
    const utc = new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(new Date(iso));
    expect(expected).not.toBe(utc);
    expect(formatDateTime(iso)).toBe(expected);
  });

  it('formats in the locale currently shown, not only the saved preference', async () => {
    // Đổi locale hiển thị (như selector header) mà không đụng preference đã lưu:
    // ngày giờ và số phải đổi theo ngay — đúng cam kết trong JSDoc của
    // `useAccountFormat`. Trước đây locale chỉ đọc từ `preferences.locale` nên
    // cam kết sai: chữ đổi theo selector còn `Intl` vẫn theo locale cũ.
    accountStores.store.set('account-locale-explicit', ref<AccountLocale>('vi'));
    const { formatDateTime, formatCount } = useAccountFormat();
    const iso = '2026-01-01T20:00:00.000Z';
    const expected = new Intl.DateTimeFormat('vi', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(new Date(iso));
    expect(formatDateTime(iso)).toBe(expected);
    expect(formatCount(1234)).toBe(new Intl.NumberFormat('vi').format(1234));
  });
});
