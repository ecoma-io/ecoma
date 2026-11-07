/**
 * Danh tính đã xác thực của caller — do receiver HMAC (`internal-auth.ts`) trả về sau khi
 * credential khớp, **không bao giờ** đọc từ header hay body do caller kiểm soát
 * (`docs/applications/transactional-mail/01-architecture.md` §7.4: một header kiểu
 * `X-ECOMA-PRINCIPAL` không phải bằng chứng danh tính).
 *
 * File do lead agent sở hữu — interface dùng chung giữa receiver (middleware auth) và
 * route layer; subagent không sửa file này.
 */

/** Principal đã xác thực cùng permission tập do registry receiver-side cấp. */
export interface AuthenticatedPrincipal {
  /** Tên principal do server kiểm soát, suy từ credential khớp — ví dụ `svc.account`. */
  readonly principal: string;
  /** Permission đã cấp cho principal này; route đối chiếu trước khi xử lý. */
  readonly permissions: readonly string[];
}

/** Permission đọc runtime material — chỉ `svc.transactional-mailer-job`. */
export const PERMISSION_DELIVERY_READ = 'delivery.read' as const;

/** Permission báo outcome — chỉ `svc.transactional-mailer-job`. */
export const PERMISSION_DELIVERY_OUTCOME = 'delivery.outcome' as const;

/** Permission tạo message qua `POST /v1/messages` — `svc.account`/`svc.auth`/`svc.payment`. */
export const PERMISSION_MESSAGE_CREATE = 'message.create' as const;

/** Lý do từ chối xác thực — nguyên nhân đã chuẩn hoá để log MỘT lần mỗi request. */
export type AuthRejectionReason =
  | 'missing_header'
  | 'bad_timestamp'
  | 'weak_nonce'
  | 'invalid_field'
  | 'replayed_nonce'
  | 'bad_signature'
  | 'nonce_store_unavailable';
