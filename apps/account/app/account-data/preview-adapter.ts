import { createMockAccountAdapter } from './mock-adapter';
import { createServerAccountAdapter } from './real-adapter';
import type { AccountAdapter } from './types';

/**
 * Adapter preview — dữ liệu mock ghép lên **auth thật**, dùng chung duy nhất ở
 * mode `mock` dưới `nuxt dev` (`docs/architecture/05-code-architecture.md` §5).
 *
 * Cấu trúc ghép là điều kiện của invariant "auth luôn thật ở mọi mode":
 *
 * - Base là adapter thật: port auth (`AuthenticationPort`) và port security
 *   (`AccountSecurityPort`) **chỉ có ở đây** — mock không thể cung cấp chúng
 *   vì kiểu `PreviewAccountAdapter` của mock không định nghĩa. Một spread ngược
 *   chiều (`{ ...mock, ...real }` cho data) vẫn không thể cho mock quyền auth.
 * - Overlay là fixtures dữ liệu: 16 phương thức của `AccountDataPort` từ mock
 *   đè lên phương thức thật — ghi chỉ đổi state trong bộ nhớ, `isPreview` nói
 *   với UI rằng mọi số liệu trên màn hình là preview data (banner).
 *
 * ⚠️ File này **chỉ được import bởi `preview-adapter-plugin.ts`**, và plugin đó
 * chỉ được đăng ký dưới `nuxt dev` (module inline trong `nuxt.config.ts`).
 * Không có nhánh runtime nào ở artifact production chạm tới đây — mock không
 * được ship dưới dạng lazy chunk (`frontend-data-mocking` §H), nó không được
 * ship dưới mọi hình thức.
 */
export function createPreviewAccountAdapter(): AccountAdapter {
  const data = createMockAccountAdapter();
  const real = createServerAccountAdapter();

  return {
    // Base thật trước: mọi phương thức mà mock không có (auth, security) giữ
    // nguyên của adapter thật. Overlay mock sau: 16 phương thức dữ liệu bị đè
    // bằng fixtures. `isPreview` đặt tường minh cuối cùng — literal, không dẫn
    // xuất, để một khi mock vắng mặt trong object thì kiểu của object này tự
    // sai thay vì lặng lẽ quên banner.
    ...real,
    ...data,
    isPreview: true,
  };
}
