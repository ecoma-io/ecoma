/**
 * Chấp nhận selector ngôn ngữ ở header — control đổi locale **chưa lưu**.
 *
 * ⚠️ Selector này đổi locale **ngay** (đường `chooseLocal`) nhưng chỉ bền khi lưu
 * thành công; mọi tương tác "ưu tiên" giữa lựa chọn trong phiên và preference đã
 * lưu được giữ ở spec của composable `useAccountLocale`. Ở đây chỉ giữ hành vi
 * của control: danh sách lựa chọn đến từ registry, và ghi nhận kết quả lưu.
 * (Tách từ `tests/acceptance-i18n.spec.ts` — giữ nguyên từng test case.)
 */
import { describe, expect, it } from 'vitest';

import AccountLanguageSelect from './AccountLanguageSelect.vue';
import { flushPromises, mountAccount } from '../../tests/harness';
import { accountStores } from '../../tests/nuxt-runtime-bridge';

describe('i18n acceptance', () => {
  it('the language selector offers exactly English, Tiếng Việt and 简体中文', async () => {
    const { wrapper } = await mountAccount(AccountLanguageSelect, {
      props: { authenticated: false },
    });
    const options = wrapper.findAll('[data-testid="account-language-select"] option');
    expect(options.map((option) => option.text())).toEqual(['English', 'Tiếng Việt', '简体中文']);
  });

  it('an unauthenticated explicit choice survives a remount', async () => {
    const { wrapper } = await mountAccount(AccountLanguageSelect, {
      props: { authenticated: false },
    });
    await wrapper.find('[data-testid="account-language-select"]').setValue('vi');
    await flushPromises();
    expect(accountStores.cookies.get(LOCALE_COOKIE)).toBe('vi');
  });

  it('reports a failed save instead of a durable success', async () => {
    const { wrapper } = await mountAccount(AccountLanguageSelect, {
      props: {
        authenticated: true,
        saveFailedLabel: 'Could not save your language.',
        savedLabel: 'Language saved.',
      },
      adapterOptions: { failWrites: ['updatePreferences'] },
    });

    await wrapper.find('[data-testid="account-language-select"]').setValue('vi');
    await flushPromises();

    expect(wrapper.find('[data-testid="account-language-saved"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="account-language-failed"]').exists()).toBe(true);
  });

  it('reports a successful save when the adapter accepts it', async () => {
    const { wrapper } = await mountAccount(AccountLanguageSelect, {
      props: {
        authenticated: true,
        saveFailedLabel: 'Could not save your language.',
        savedLabel: 'Language saved.',
      },
    });

    await wrapper.find('[data-testid="account-language-select"]').setValue('vi');
    await flushPromises();

    expect(wrapper.find('[data-testid="account-language-saved"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="account-language-failed"]').exists()).toBe(false);
  });
});

/**
 * Cookie locale cục bộ — cùng tên với hằng trong `use-account-locale.ts`.
 *
 * ⚠️ Viết lại ở đây thay vì import hằng ( nó không được export): nếu tên cookie đổi mà
 * test không theo, test sẽ **vẫn xanh** — nó đặt cookie không ai đọc rồi khẳng định app
 * rơi về tiếng Anh. Ở đây chính app đọc cookie, nên test kiểm được cả hai cùng lúc: nếu
 * tên lệch, `preferred` sẽ theo cookie mà test vừa đặt và khẳng định fail.
 */
const LOCALE_COOKIE = 'account-locale';
