/**
 * Helper đọc biến context mà middleware auth bảo đảm có mặt.
 *
 * ⚠️ `c.get('tenantId')!` (non-null assertion) bị oxlint cấm
 * (`typescript/no-non-null-assertion`). Invariant thật: mọi route group chạy
 * SAU middleware `requireMachineToken`, mà middleware đó `c.set('tenantId', …)`
 * trước khi gọi `next()` — thiếu nghĩa là route bị mount sai thứ tự, lỗi cấu
 * hình lúc viết code chứ không phải trạng thái request. Nên ném thay vì trả
 * `undefined` lặng lẽ: lỗi lộ ngay ở request đầu, không trôi xuống SQL với
 * `tenant_id = undefined`.
 */
import type { Context } from 'hono';
import type { AppEnv } from '../types';

export function currentTenantId(c: Context<AppEnv>): string {
  const tenantId = c.get('tenantId');
  if (tenantId === undefined) {
    throw new Error('tenantId is not set: route is mounted without requireMachineToken middleware');
  }
  return tenantId;
}
