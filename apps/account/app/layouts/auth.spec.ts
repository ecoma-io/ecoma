/**
 * Banner preview ở layout auth — một nửa của bằng chứng bất invariant "UI phản
 * ánh thực tế" (nửa còn lại ở `default.spec.ts` cho layout tài khoản). Ba trang
 * auth là nơi người dùng **chưa đăng nhập** nhìn thấy màn hình uỷ quyền: banner
 * sai một trạng thái là người dùng tin `/consent` đang chạy dữ liệu thật.
 */
import { describe, expect, it } from 'vitest';

import AuthLayout from './auth.vue';
import { mountAccount } from '../../tests/harness';
import { createTestAccountAdapter } from '../../tests/test-adapter';

describe('preview banner', () => {
  it('renders the preview banner when the adapter flags preview data', async () => {
    const { wrapper } = await mountAccount(AuthLayout, {
      slots: { default: '<p data-testid="slot" />' },
    });
    expect(wrapper.find('[data-testid="account-preview-banner"]').exists()).toBe(true);
  });

  it('renders no preview banner on a real adapter', async () => {
    const { wrapper } = await mountAccount(AuthLayout, {
      adapter: { ...createTestAccountAdapter(), isPreview: false },
      slots: { default: '<p data-testid="slot" />' },
    });
    expect(wrapper.find('[data-testid="account-preview-banner"]').exists()).toBe(false);
  });
});
