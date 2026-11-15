/**
 * `POST /api/portal/tenants/:tenantName/projects` — tạo project + key đầu tiên
 * (R18/R19). Response `201 { project, api_key: { token, ... } }` — **show-once**:
 * token chỉ ở response này; BFF không giữ lại, không log (SR-007).
 */
import { createProjectHandler } from '../../../_proxy.ts';

export default createProjectHandler;
