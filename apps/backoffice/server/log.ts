/**
 * Structured logging của `backoffice` — allowlist field, nuốt mọi lỗi
 * (observability không là serving-path dependency, NFR-004).
 *
 * Cùng pattern `apps/account/server/utils/logger.ts`, thu gọn về đúng tập
 * field mà backoffice cần: event, route, method, status, sub, reason,
 * request_id. Backoffice chưa có field "đã băm bắt buộc" (không log session
 * id dưới bất kỳ hình dạng nào — phiên tra được qua `sub` + thời điểm).
 *
 * ⚠️ **KHÔNG có field nào cho token/cookie/verifier** — đây là allowlist, một
 * field không có trong danh sách thì không có đường vào dòng log kể cả khi
 * caller truyền nhầm (SR-014).
 *
 * ⚠️ Đây là điểm **duy nhất** của app được phép `console.*` (cùng ngoại lệ có
 * chủ đích với `account`) — `wrangler tail` đọc được dòng này; `no-console`
 * của `.oxlintrc.json` tắt inline tại đúng dòng duy nhất dưới đây.
 */

const ALLOWED_FIELDS = [
  'event',
  'route',
  'method',
  'status',
  'sub',
  'error_code',
  'reason',
  'request_id',
] as const;

export interface LogFields {
  /** Tên event — khoá nhóm của mọi truy vấn log; bắt buộc. */
  event: string;
  route?: string;
  method?: string;
  status?: number;
  /** Account ID nguyên vẹn (`sub_…`) — opaque identifier, không phải bí mật. */
  sub?: string;
  error_code?: string;
  /** Mã ổn định của nhánh từ chối — không phải message cho người dùng. */
  reason?: string;
  /** UUID do server sinh, nối các dòng của cùng request. */
  request_id?: string;
}

const MAX_FIELD_LENGTH = 200;

function sanitizeFieldValue(value: string): string | undefined {
  // Ký tự điều khiển LÀ thứ cần lọc (chống log injection) nên `no-control-regex`
  // tắt inline cho đúng dòng này — cùng luật với logger của `account`.
  // oxlint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001F\u007F]/gu, '');
  if (stripped.length === 0) {
    return undefined;
  }
  return stripped.length > MAX_FIELD_LENGTH ? `${stripped.slice(0, MAX_FIELD_LENGTH)}…` : stripped;
}

/**
 * Ghi một dòng log có cấu trúc — nuốt mọi lỗi, kể cả lỗi serialize (NFR-004:
 * một dòng log mất không được biến thành `500`).
 */
export function writeLog(fields: LogFields): void {
  try {
    const event = sanitizeFieldValue(fields.event);
    if (event === undefined) {
      // Không có `event` thì dòng log không group được, bỏ thay vì ghi rác.
      return;
    }
    const parts: string[] = [`event=${JSON.stringify(event)}`];
    for (const key of ALLOWED_FIELDS) {
      if (key === 'event') {
        continue;
      }
      const value = fields[key];
      if (value === undefined || value === null) {
        continue;
      }
      if (typeof value === 'number') {
        parts.push(`${key}=${value}`);
        continue;
      }
      const sanitized = sanitizeFieldValue(value);
      if (sanitized !== undefined) {
        parts.push(`${key}=${JSON.stringify(sanitized)}`);
      }
    }
    // oxlint-disable-next-line no-console
    console.log(parts.join(' '));
  } catch {
    // Cố tình im lặng — xem JSDoc trên.
  }
}
