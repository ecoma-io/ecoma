/**
 * Hằng client OAuth thứ hai auth-deploy seed cho lane local: client public
 * `pact-broker-app` mà BFF của `pact-broker-app` dùng chạy luồng OIDC
 * authorization-code + PKCE (ADR-0031 §4, #206) — sibling của
 * `LOCAL_BACKOFFICE_CLIENT_ID` trong `@ecoma-io/deployment`.
 *
 * ⚠️ Vì sao KHÔNG nằm ở `libs/deployment` cạnh hằng backoffice: slice #206
 * không sửa `libs/deployment` (scope lock), và hằng này chỉ có MỘT bên seed
 * (auth-deploy) — bên tiêu thụ (`pact-broker-app-deploy`) đọc giá trị qua
 * cross-stack `pulumi config get` lúc up (stack config do `local.ts` của
 * auth-deploy persist), nên không có hai import nào cần đồng bộ chuỗi. Khi
 * client contract hợp nhất về lib (việc còn lại của #194), hằng này là ứng
 * viên di chuyển đầu tiên.
 *
 * Module THUẦN: không import Pulumi, không side effect — `index.ts` (chương
 * trình Pulumi) và `local.ts` (entry lifecycle) cùng import được mà không dựng
 * resource hay chạy `main()`.
 */

/**
 * `client_id` của client public `pact-broker-app` tại `auth` trên lane local.
 *
 * ⚠️ Hằng số, KHÔNG sinh ngẫu nhiên: `client_id` là định danh công khai trong
 * giao thức OAuth, không phải secret, và phải ổn định qua các lần `pulumi up`
 * để row `oauth_clients` cũ không thành mồ côi redirect URI. Public client,
 * PKCE S256 bắt buộc (`token_endpoint_auth_method: 'none'` do
 * `toProviderClientMetadata` ghim) — không secret nào đi qua hằng này.
 */
export const LOCAL_PACT_BROKER_CLIENT_ID = 'ecoma-pact-broker-local';

/** `client_name` hiển thị của client trong row `oauth_clients` — cùng văn phạm `Backoffice (local)`. */
export const LOCAL_PACT_BROKER_CLIENT_NAME = 'Pact Broker App (local)';

/**
 * Key stack config của auth-deploy chứa {@link LOCAL_PACT_BROKER_CLIENT_ID} —
 * `pact-broker-app-deploy` đọc cross-stack lúc up. Không phải secret (định danh
 * công khai OAuth) nên nằm ở config thường, không phải `--secret`.
 */
export const PACT_BROKER_APP_CLIENT_ID_CONFIG_KEY = 'namespace:pactBrokerAppClientId';
