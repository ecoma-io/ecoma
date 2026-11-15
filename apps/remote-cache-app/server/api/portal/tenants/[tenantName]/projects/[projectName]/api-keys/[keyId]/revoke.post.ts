/**
 * `POST /api/portal/tenants/:tenantName/projects/:projectName/api-keys/:keyId/revoke`
 * — revoke key, hiệu lực ngay lập tức (R19). Response không mang secret.
 */
import { revokeApiKeyHandler } from '../../../../../../_proxy.ts';

export default revokeApiKeyHandler;
