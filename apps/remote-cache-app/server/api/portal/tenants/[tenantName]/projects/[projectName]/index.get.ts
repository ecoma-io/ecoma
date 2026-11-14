/**
 * `GET /api/portal/tenants/:tenantName/projects/:projectName` — chi tiết project
 * (R19). Response không bao giờ mang credential (contract của control plane;
 * BFF bóc thêm một lớp ở `_proxy.ts`).
 */
import { projectDetailHandler } from '../../../../_proxy.ts';

export default projectDetailHandler;
