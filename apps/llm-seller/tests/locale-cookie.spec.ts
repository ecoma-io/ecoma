import { describe, expect, it } from 'vitest';

import { useLlmSellerLocale } from '../app/composables/use-llm-seller-locale';
import { llmSellerStores } from './nuxt-globals';

/**
 * Hợp đồng cookie locale của seller.
 *
 * Cookie là dữ liệu người dùng sửa được, nên nó là **cả** ranh giới đọc **và**
 * ranh giới ghi: một mã ngoài registry không được đi vào cookie, cùng cách nó
 * không được trở thành lựa chọn tường minh. Nếu chỉ chặn ở chiều đọc, cookie có
 * thể giữ một mã rác mà lần tải sau phải bỏ qua — trạng thái trong phiên và
 * trạng thái đã lưu lệch nhau, và một lần "sửa" cookie bằng tay trở thành lựa
 * chọn sống qua reload ở client khác.
 */
describe('llm-seller locale cookie', () => {
  const COOKIE = 'llm-seller-locale';

  it('persists the chosen locale', () => {
    const locale = useLlmSellerLocale();

    locale.chooseLocale('vi');

    expect(llmSellerStores.cookies.get(COOKIE)?.value).toBe('vi');
    expect(locale.preferred.value).toBe('vi');
  });

  it('never writes a value outside the registry', () => {
    const locale = useLlmSellerLocale();

    // Ép qua ranh giới kiểu — đúng kịch bản mà một caller `as never` có thể tạo.
    locale.chooseLocale('klingon' as never);

    expect(llmSellerStores.cookies.get(COOKIE)?.value).toBeUndefined();
    expect(locale.preferred.value).toBe('en');
  });

  it('maps the registry code to a BCP-47 tag for <html lang>', () => {
    const locale = useLlmSellerLocale();

    locale.chooseLocale('zh-CN');

    expect(locale.language.value).toBe('zh-Hans');
  });
});
