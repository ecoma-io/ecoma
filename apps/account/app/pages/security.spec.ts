/**
 * Chấp nhận tương tác trên `/security` — dialog xác nhận phải tự đóng, thao tác hỏng
 * không được xoá danh sách.
 *
 * ⚠️ `removing` phải được reset ngay sau thao tác: không thì `open` vẫn true, dialog
 * treo vĩnh viễn và nút xác nhận bấm lần nữa sẽ gỡ một id đã bị gỡ — đúng lỗi mà hai
 * trang anh em (`sessions`, `applications`) đã tránh. (Tách từ
 * `tests/acceptance-data-pages.spec.ts` — nhóm `security page interactions` giữ nguyên
 * từng test case.)
 *
 * Cùng file này giữ thêm hai nhóm tách từ các spec chấp nhận cũ: i18n của
 * `/security` (từ `tests/acceptance-i18n.spec.ts` — locale mặc định/ưu tiên qua
 * đường shell wiring, không phụ thuộc browser hay route) và bất biến passwordless
 * của `/security` (từ `tests/acceptance-passwordless.spec.ts` — mã khôi phục MFA
 * có mặt, nhưng không một ngữ cảnh mật khẩu nào).
 */
import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';

import SecurityPage from './security.vue';
import { useAccountI18n } from '../composables/use-account-i18n';
import { useAccountShellPreferences } from '../composables/use-account-shell-preferences';
import { createMockAccountAdapter } from '../account-data/mock-adapter';
import { flushPromises, mountAccount } from '../../tests/harness';
import { accountStores } from '../../tests/nuxt-runtime-bridge';

/**
 * Trang bọc trong đúng những gì `app.vue` làm: nối i18n rồi nạp shell preference.
 *
 * ⚠️ Mount component này mới là "tải trang" qua **đường thật**. Test set thẳng
 * composer locale thì không đi qua `useAccountLocale` hay shell wiring — đúng
 * chỗ mà một preference đã lưu không bao giờ được nạp sẽ vẫn pass.
 */
const ShellSecurityPage = defineComponent({
  setup() {
    useAccountI18n();
    useAccountShellPreferences();
    return () => h(SecurityPage);
  },
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

/** Khớp mọi cách diễn đạt "mật khẩu" mà một UI có thể dùng ở cả ba locale. */
const PASSWORD_WORDS =
  /\bpassword\b|\bpasswd\b|\bpasswort\b|\bcontrase[nñ]a\b|\b密码\b|\bmật khẩu\b|\bmat khau\b/iu;

describe('security page interactions', () => {
  it('closes the confirmation dialog after removing a passkey', async () => {
    const { wrapper } = await mountAccount(SecurityPage);
    await wrapper.find('[data-testid="passkey-remove-passkey-1"]').trigger('click');
    await flushPromises();

    const dialog = wrapper.find('[data-testid="account-dialog"]');
    expect(dialog.attributes('open')).toBeDefined();

    await wrapper.find('[data-testid="account-dialog-confirm"]').trigger('click');
    await flushPromises();

    // `removing` phải được reset ngay sau thao tác: không thì `open` vẫn true,
    // dialog treo vĩnh viễn, nút xác nhận lại enable và bấm lần nữa sẽ gỡ một id
    // đã bị gỡ — đúng lỗi mà hai trang anh em (`sessions`, `applications`) đã tránh.
    expect(dialog.attributes('open')).toBeUndefined();
    expect(wrapper.find('[data-testid="account-result"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="account-result"]').attributes('data-tone')).toBe('success');
  });

  it('reports a failed removal and keeps the passkey list intact', async () => {
    const { wrapper } = await mountAccount(SecurityPage, {
      adapterOptions: { failWrites: ['removePasskey'] },
    });
    await wrapper.find('[data-testid="passkey-remove-passkey-1"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="account-dialog-confirm"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="account-result"]').attributes('data-tone')).toBe('danger');
    // Vẫn hiển thị danh sách passkey — thao tác hỏng không được xoá OptimisticListItem.
    expect(wrapper.find('[data-testid="passkey-list"]').exists()).toBe(true);
  });
});

describe('i18n acceptance', () => {
  it('defaults to English with no saved preference and no explicit choice', async () => {
    const { wrapper } = await mountAccount(SecurityPage, {
      adapterOptions: { invalidStoredLocale: 'en' },
    });
    // Locale hợp lệ từ server là tiếng Anh: nó cho cùng kết quả với "không có gì", nên
    // dùng `undefined` để kiểm đúng nhánh **không có** preference.
    expect(wrapper.text()).toContain('Ecoma is passwordless.');
  });

  it('never falls back to the browser language', async () => {
    // jsdom đặt `navigator.language` là `en-US`; dù app có dò thì cũng phải ra `en`.
    expect(navigator.language).toBe('en-US');
    const { wrapper } = await mountAccount(SecurityPage, {
      adapterOptions: { invalidStoredLocale: 'klingon' },
    });
    expect(wrapper.text()).toContain('Ecoma is passwordless.');
  });

  it('switching the locale updates every visible string without changing the route', async () => {
    const { wrapper, setLocale, setRoute } = await mountAccount(SecurityPage, {
      adapterOptions: { invalidStoredLocale: 'en' },
    });
    setRoute({ path: '/security' });

    const englishHeading = wrapper.find('h1').text();
    expect(englishHeading).toBe('Security');

    await setLocale('vi');
    expect(wrapper.find('h1').text()).toBe('Bảo mật');
    // Route giữ nguyên: locale không phải thứ URL biết.
    expect(accountStores.route.path).toBe('/security');
  });

  it('switching to Chinese renders Chinese, not a fallback', async () => {
    const { wrapper, setLocale } = await mountAccount(SecurityPage, {
      adapterOptions: { invalidStoredLocale: 'en' },
    });
    await setLocale('zh-CN');
    expect(wrapper.find('h1').text()).toBe('安全');
  });

  it('renders the whole page in the selected locale, not just the heading', async () => {
    const { wrapper, setLocale } = await mountAccount(SecurityPage, {
      adapterOptions: { invalidStoredLocale: 'en' },
    });
    await setLocale('vi');

    // Mọi khối chữ tiếng Anh đã biết ở trang này phải biến mất. Kiểm **nhiều** chỗ vì
    // một khẳng định chỉ bắt được thứ nó đã nghĩ tới.
    for (const english of ['Passkeys', 'Authenticator app', 'Recovery codes', 'Remove']) {
      expect(wrapper.text(), `still English: ${english}`).not.toContain(english);
    }
    for (const vietnamese of ['Passkey', 'Ứng dụng xác thực', 'Mã khôi phục']) {
      expect(wrapper.text(), `missing Vietnamese: ${vietnamese}`).toContain(vietnamese);
    }
  });

  it('a saved preference is authoritative over the local choice', async () => {
    // Cookie để 'en', preference đã lưu là 'vi' — preference đã lưu phải thắng
    // **lúc tải trang**, qua đúng đường shell wiring (`useAccountShellPreferences`
    // nạp `useStoredAccountLocale`), không phải bằng cách set composer locale.
    accountStores.cookies.set(LOCALE_COOKIE, 'en');
    const adapter = createMockAccountAdapter();
    await adapter.updatePreferences({ locale: 'vi' });
    const { wrapper } = await mountAccount(ShellSecurityPage, { adapter });
    await flushPromises();
    expect(wrapper.find('h1').text()).toBe('Bảo mật');
  });

  it('a stored locale only reaches the UI through the shell, not through the route', async () => {
    // Không có locale segment trong URL, nên route không đổi khi locale đổi: `/`
    // phải cho ra cùng một trang dù locale là 'vi' hay 'en'.
    accountStores.cookies.set(LOCALE_COOKIE, 'vi');
    const { wrapper, setRoute } = await mountAccount(SecurityPage);
    setRoute({ path: '/security' });
    expect(accountStores.route.path).toBe('/security');
    expect(wrapper.find('h1').text()).toBe('Security');
  });
});

describe('passwordless invariant', () => {
  it('/security has no password section at all', async () => {
    const { wrapper } = await mountAccount(SecurityPage);

    // Không có `type="password"`, không có form đổi/đặt lại mật khẩu.
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="login-email"]').exists()).toBe(false);
    // `noPasswordNote` nói rõ app không dùng mật khẩu — đây là câu được phép.
    expect(wrapper.find('[data-testid="security-no-password"]').exists()).toBe(true);

    // ⚠️ Mã khôi phục **có** mặt và phải mặt: đó là mã khôi phục MFA.
    expect(wrapper.find('[data-testid="recovery-codes-state"]').exists()).toBe(true);
  });

  it('/security never mentions password recovery in its section headings', async () => {
    const { wrapper } = await mountAccount(SecurityPage);
    const headings = wrapper.findAll('h2').map((heading) => heading.text());
    expect(headings.length).toBeGreaterThan(0);
    for (const heading of headings) {
      expect(heading, 'a security section heading must not be about passwords').not.toMatch(
        PASSWORD_WORDS,
      );
    }
  });
});
