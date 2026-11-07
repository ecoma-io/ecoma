/**
 * Chấp nhận i18n trên `/preferences` — selector lưu preference **bền vững**.
 *
 * ⚠️ Khác selector header (chỉ đổi trong phiên), selector ở `/preferences` lưu qua
 * server. Hai luật ở đây: locale lạ từ server được đưa ra đường lỗi thay vì bị ép
 * im lặng thành locale khác, và mọi lựa chọn được đề xuất đều từ registry.
 * (Tách từ `tests/acceptance-i18n.spec.ts` — giữ nguyên từng test case.)
 */
import { describe, expect, it } from 'vitest';

import PreferencesPage from './preferences.vue';
import { ACCOUNT_LOCALES, type AccountLocale } from '../i18n/locale-registry';
import { mountAccount } from '../../tests/harness';

describe('i18n acceptance', () => {
  it('surfaces an unsupported stored locale on /preferences instead of coercing it', async () => {
    const { wrapper } = await mountAccount(PreferencesPage, {
      adapterOptions: { invalidStoredLocale: 'klingon' },
    });
    const error = wrapper.find('[data-testid="preferences-invalid-locale"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain('klingon');
  });

  it('shows no locale error when the stored locale is supported', async () => {
    const { wrapper } = await mountAccount(PreferencesPage);
    expect(wrapper.find('[data-testid="preferences-invalid-locale"]').exists()).toBe(false);
  });

  it('never offers or accepts a locale outside the registry', async () => {
    const { wrapper } = await mountAccount(PreferencesPage);
    const offered = wrapper
      .findAll('[data-testid="preferences-language"] option')
      .map((option) => (option.element as HTMLOptionElement).value);

    // Chỉ ba locale trong registry, và mỗi mục đều từ registry chứ không viết tay.
    expect(offered).toEqual(ACCOUNT_LOCALES.map((definition) => definition.code));
    // Lấy từ registry một locale **không** có trong danh sách — registry frozen nên
    // chỉ có thể bằng cách ép kiểu, và đó chính là việc cần chặn: giá trị lạ không được
    // đi ra khỏi UI dưới dạng preference đã lưu.
    expect(offered).not.toContain('klingon' as AccountLocale);
    expect(offered).not.toContain('en-US' as AccountLocale);
  });
});
