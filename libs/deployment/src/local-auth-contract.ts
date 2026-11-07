/**
 * Contract client OAuth giữa `auth-deploy` (bên seed) và `backoffice-deploy`
 * (bên cấu hình) ở lane local — hai deploy unit import CÙNG hằng số, không copy
 * chuỗi.
 *
 * Vấn đề: `auth` so `client_id` của authorize request với row đã seed trong
 * `auth.oauth_clients`, còn `backoffice` đặt `client_id` vào authorize URL và
 * token exchange. Hai bên chỉ cần khớp **giá trị**, không cần shared code —
 * nhưng nếu mỗi stack tự khai một string literal thì một phía sửa (hay gõ lệch)
 * là authorize `invalid_client` ở runtime, không có tín hiệu nào ở compile time.
 * Hằng số dùng chung ở đây biến lệch giá trị thành một diff nhìn thấy được ở cả
 * hai stack trong cùng một PR.
 *
 * Local-only: client `backoffice` của staging/production thuộc việc còn lại của
 * issue #194 (audience riêng + seed per-environment), không đi qua hằng này.
 */

/**
 * `client_id` của client public `backoffice` tại `auth` trên lane local.
 *
 * ⚠️ Hằng số, KHÔNG sinh ngẫu nhiên: `client_id` là định danh công khai trong
 * giao thức OAuth, không phải secret, và phải ổn định qua các lần `pulumi up`
 * để row cũ của `oauth_clients` không bị bỏ lại mồ côi redirect URI. Public
 * client, PKCE S256 bắt buộc — không secret nào đi qua hằng này.
 */
export const LOCAL_BACKOFFICE_CLIENT_ID = 'ecoma-backoffice-local';
