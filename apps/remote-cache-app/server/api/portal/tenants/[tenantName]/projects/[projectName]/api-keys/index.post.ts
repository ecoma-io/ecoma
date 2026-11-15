/**
 * `POST /api/portal/tenants/:tenantName/projects/:projectName/api-keys` — tạo
 * thêm key (R19). Response `201 { api_key: { token, ... } }` — **show-once**.
 * Portal chỉ mint developer credential (read scope, `trusted_ci = false`) —
 * không có request nào chọn được `write` hay trusted (R20).
 */
import { createApiKeyHandler } from '../../../../../_proxy.ts';

export default createApiKeyHandler;
