/**
 * `GET /api/portal/tenants/:tenantName/projects/:projectName/api-keys` — list
 * metadata key (R19). Response **không bao giờ** mang `token`/`token_hash` —
 * BFF bóc khoá forbidden ở `_proxy.ts` trước khi trả browser (SR hard invariant).
 */
import { listApiKeysHandler } from '../../../../../_proxy.ts';

export default listApiKeysHandler;
