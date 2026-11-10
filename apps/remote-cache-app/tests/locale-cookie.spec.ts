import { describe, expect, it } from 'vitest';

import { useRemoteCacheAppLocale } from '../app/composables/use-remote-cache-app-locale';
import { remoteCacheAppStores } from './nuxt-globals';

/**
 * Hợp đồng cookie locale của ứng dụng quản trị.
 *
 * Cookie là dữ liệu người dùng sửa được, nên nó là **cả** ranh giới đọc **và**
 * ranh giới ghi: một mã ngoài registry không được đi vào cookie, cùng cách nó
 * không được trở thành lựa chọn tường minh. Nếu chỉ chặn ở chiều đọc, cookie có
 * thể giữ một mã rác mà lần tải sau phải bỏ qua — trạng thái trong phiên và
 * trạng thái đã lưu lệch nhau, và một lần "sửa" cookie bằng tay trở thành lựa
 * chọn sống qua reload ở client khác.
 */
describe('remote-cache-app locale cookie', () => {
  const COOKIE = 'remote-cache-app-locale';

  it('persists the chosen locale', () => {
    const locale = useRemoteCacheAppLocale();

    locale.chooseLocale('vi');

    expect(remoteCacheAppStores.cookies.get(COOKIE)?.value).toBe('vi');
    expect(locale.preferred.value).toBe('vi');
  });

  it('never writes a value outside the registry', () => {
    const locale = useRemoteCacheAppLocale();

    // Ép qua ranh giới kiểu — đúng kịch bản mà một caller `as never` có thể tạo.
    locale.chooseLocale('klingon' as never);

    expect(remoteCacheAppStores.cookies.get(COOKIE)?.value).toBeUndefined();
    expect(locale.preferred.value).toBe('en');
  });

  it('maps the registry code to a BCP-47 tag for <html lang>', () => {
    const locale = useRemoteCacheAppLocale();

    locale.chooseLocale('zh-CN');

    expect(locale.language.value).toBe('zh-Hans');
  });
});
