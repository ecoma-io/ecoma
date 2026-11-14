/**
 * `GET /api/portal/tenants/:tenantName/projects` — list project (R19).
 *
 * Thân chung `../portal/_proxy.ts`: fail-closed cấu hình (503), principal từ
 * middleware authn, pass-through status/body của control plane (đã bóc khoá
 * secret). Query `limit`/`cursor` được forward nguyên vẹn trong path đã ký —
 * control plane validate theo contract list.
 */
import { listProjectsHandler } from '../../../_proxy.ts';

export default listProjectsHandler;
