import { expect, test } from '@playwright/test';

import { UNAUTHENTICATED_STATUS } from './support/fixtures';
import { resolveStackOrigin, stackGet } from './support/local-origin';

/**
 * Denial chưa đăng nhập — lớp đầu tiên của access control.
 *
 * Mọi `/api/**` của backoffice được middleware `authn` chặn trước route
 * (`apps/backoffice/server/middleware/authn.ts`, PR #358): cookie
 * `__Host-backoffice-session` vắng ⇒ **401**, KHÔNG PHẢI 403 — caller chưa
 * xác thực thì chưa tới tầng phân quyền. 403 ở đây là bug (route nào lộ ra
 * trước authn là lộ đó forever); 503 là stack predates #358 (đã bị gate
 * global-setup chặn, nhưng một test tường minh vẫn giữ chữ ký này hiển thị).
 *
 * Năm route phủ trọn surface `/api` của BFF: bốn read route có enforcement
 * (staff/roles/permissions/onboarding-status) + `me` (route đọc session, không
 * enforcement permission). Global-setup đã probe `/api/staff`; nhóm test này
 * lặp lại TẤT CẢ các route để mỗi route tự bảo vệ mình trong report.
 *
 * Client là `stackGet` (Node `https` + `ca` scoped) — cùng pattern với
 * skeleton `home-public-e2e`; `request` fixture của Playwright KHÔNG được dùng
 * vì nó không nhận `ca` scoped (đường duy nhất của nó với cert self-signed là
 * `ignoreHTTPSErrors`, bị cấm ở config).
 */

test.describe('unauthenticated denial', () => {
  const guardedRoutes = [
    '/api/staff',
    '/api/roles',
    '/api/permissions',
    '/api/me',
    '/api/onboarding-status',
  ] as const;

  for (const route of guardedRoutes) {
    test(`denies unauthenticated GET ${route} with 401`, async () => {
      const response = await stackGet(`${resolveStackOrigin()}${route}`);
      expect(response.status).toBe(UNAUTHENTICATED_STATUS);
    });
  }
});
