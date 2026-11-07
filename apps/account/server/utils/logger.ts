/**
 * Structured logging với whitelist field — ranh giới observability đầu tiên của
 * `account`.
 *
 * ## Vì sao file này tồn tại
 *
 * `03-operations.md` §6 và SR-001 (`02-requirements.md`) chốt cùng một luật: log
 * **chỉ** chứa field trong whitelist, và **không bao giờ** chứa password, session
 * cookie, `account_session_ref`, `code_verifier`, token hay assertion. Vì vậy
 * logger ở đây **không** nhận object tuỳ ý rồi lọc — nó nhận một *danh sách
 * field đóng* và chỉ ghi những field đó. Mọi thứ ngoài danh sách không có đường
 * để đi vào dòng log, kể cả khi caller truyền nhầm.
 *
 * ⚠️ **Đây là ngoại lệ CÓ CHỦ ĐÍCH với `no-console` của `.oxlintrc.json`.** Rule đó
 * cấm `console.*` trong `apps/**` và `libs/**` — đúng, nhưng nó chỉ trả lời được
 * "có console ở đây không", **không** trả lời được "in ra cái gì". Nếu logger
 * không dùng `console` thì Workers log (`wrangler tail`) không thấy gì, trong khi
 * `observability.enabled` trong `wrangler.jsonc` lại bật sẵn. Đây là **điểm duy
 * nhất** trong app nơi `console.*` được phép, và lý do phải nói rõ bằng comment
 * thay vì để lint tắt im lặng.
 *
 * Lớp guard cho **giá trị** in ra là Semgrep rule `security-sensitive-value-logged`
 * trong `.github/semgrep/security.yml`, không phải oxlint. Vì vậy tên biến cục bộ
 * trong file này không được bắt đầu bằng từ khoá nhạy cảm của rule đó (`prompt`,
 * `response`, `authorization`, `cookie`, `token`, `secret`, `password`,
 * `credential`, `apiKey`) trừ khi giá trị đã qua phép băm.
 *
 * ## Observability KHÔNG phải serving-path dependency
 *
 * NFR-004 / `03-operations.md` §6: lỗi logging không được làm hỏng request. Vì vậy
 * {@link writeLog} bọc trong `try`/`catch` và **nuốt** mọi lỗi — kể cả lỗi do chính
 * việc serialize. Một dòng log mất không được biến thành một `500`.
 */

/**
 * Danh sách field được phép xuất hiện trong dòng log.
 *
 * Đây là **allowlist**, không phải denylist: field không có trong đây thì không
 * bao giờ được ghi, kể cả khi caller truyền. Danh sách bám sát SR-001 và
 * `03-operations.md` §6: event, route, method, status, `sub`, `session_id` đã
 * hash, error code.
 *
 * ⚠️ `sub` được phép nguyên vẹn vì nó là **opaque identifier không phải bí mật**
 * (xem `account-domain/src/subject.ts` — entropy tự nó không phải credential),
 * và nó là thứ cho phép nối một dòng log với một account. `session_id` thì **không**
 * — đó là giá trị session thật, nên chỉ dạng đã hash mới được ghi.
 *
 * `reason` và `request_id` được thêm vào danh sách SR-001 vì chúng không mang dữ
 * liệu định danh: `reason` là **mã** ổn định của một nhánh từ chối (không phải thông
 * báo cho người dùng), còn `request_id` là UUID sinh ở server để nối các dòng log
 * của cùng một request. Cả hai đều là metadata điều hành, không phải dữ liệu user.
 */
const ALLOWED_FIELDS = [
  'event',
  'route',
  'method',
  'status',
  'sub',
  'session_id',
  'error_code',
  'reason',
  'request_id',
  // `handle_hash` — giá trị đã băm của handle X, không phải giá trị rõ. Luật của
  // §3.6 ("không log handle rõ") chặn giá trị rõ, không phải hash của nó; hash
  // là định danh điều tra của một binding.
  'handle_hash',
  // Phân nhóm of binding: `missing` | `binding_mismatch` | `unusable` | `matched` —
  // mã nội bộ của nhánh so khớp, mang dữ liệu hành chính, không mang handle.
  'binding_kind',
  // "Binding này có thuộc về session đang trình X không" — boolean kết luận của
  // phép so khớp, không dẫn được về giá trị handle hay về session_ref.
  'bound_to_current',
] as const;

/** Field trong allowlist mà giá trị bắt buộc phải đã băm trước. */
const HASHED_ONLY_FIELDS: ReadonlySet<string> = new Set(['session_id', 'handle_hash']);

/** Bảng ghi log chuẩn hoá — mọi dòng đều có `event` để group được. */
export interface LogFields {
  /** Tên event; bắt buộc, đây là khoá nhóm của mọi truy vấn log. */
  event: string;
  route?: string;
  method?: string;
  status?: number;
  /** Subject dạng nguyên vẹn (`sub_…`) — opaque identifier, không phải bí mật. */
  sub?: string;
  /** **Đã hash**. Giá trị session thật không bao giờ được ghi. */
  session_id?: string;
  error_code?: string;
  /** Mã ổn định của nhánh từ chối — không phải thông báo cho người dùng. */
  reason?: string;
  /** UUID sinh ở server để nối các dòng log của cùng một request. */
  request_id?: string;
  /** **Đã băm** — hash của handle X; giá trị rõ không bao giờ được ghi (§3.6). */
  handle_hash?: string;
  /** Nhánh so khớp binding — mã nội bộ, không mang handle hay session_ref. */
  binding_kind?: 'missing' | 'binding_mismatch' | 'unusable' | 'matched';
  /** Kết luận so khớp "binding có thuộc session trình X không". */
  bound_to_current?: boolean;
}

/** Bao nhiêu ký tự được giữ lại cho mỗi field trước khi cắt. */
const MAX_FIELD_LENGTH = 200;

/**
 * Lọc một chuỗi bất kỳ thành giá trị an toàn để ghi log.
 *
 * - Bỏ hết ký tự điều khiển, gồm newline và carriage return (chống log injection).
 * - Cắt còn {@link MAX_FIELD_LENGTH} ký tự để một payload lớn không làm phình log.
 * - Trả `undefined` khi còn lại rỗng, để caller không ghi `"event": ""`.
 */
export function sanitizeFieldValue(value: string): string | undefined {
  // `no-control-regex` bật ở `.oxlintrc.json` và nó đúng — regex chứa ký tự điều
  // khiển thường là dấu hiệu lỗi. Ở đây chính ký tự điều khiển LÀ THỨ CẦN LỌC
  // (chống log injection), nên tắt rule cho đúng dòng này.
  // oxlint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001F\u007F]/gu, '');
  if (stripped.length === 0) {
    return undefined;
  }
  return stripped.length > MAX_FIELD_LENGTH ? `${stripped.slice(0, MAX_FIELD_LENGTH)}…` : stripped;
}

/**
 * Chuyển danh sách field của caller thành object chỉ gồm key trong allowlist.
 *
 * Đây là **điểm kiểm duy nhất** giữa caller và sink, nên đây là chỗ để đặt luật.
 * Ba luật:
 * 1. Key ngoài {@link ALLOWED_FIELDS} bị loại — không có `...rest` để lọt.
 * 2. Field trong {@link HASHED_ONLY_FIELDS} bị loại nếu giá trị không phải hex digest
 *    — độ dài và alphabet của SHA-256 là công khai, nên hình dạng này không lộ bí
 *    mật gì, và nó chặn được cả trường hợp người gọi quên băm.
 * 3. Mọi giá trị string đi qua {@link sanitizeFieldValue}.
 */
export function pickLogFields(fields: LogFields): Record<string, string | number> {
  const out: Record<string, string | number> = {};

  for (const key of ALLOWED_FIELDS) {
    const value = fields[key];
    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value === 'boolean') {
      out[key] = value ? 1 : 0;
      continue;
    }

    if (typeof value === 'number') {
      out[key] = value;
      continue;
    }

    const sanitized = sanitizeFieldValue(value);
    if (sanitized === undefined) {
      continue;
    }

    if (HASHED_ONLY_FIELDS.has(key) && !looksLikeSha256Hex(sanitized)) {
      // Không ghi giá trị chưa băm: bỏ field còn hơn ghi session id thật.
      continue;
    }

    out[key] = sanitized;
  }

  return out;
}

/** SHA-256 hex là 64 ký tự `[0-9a-f]`; chỉ dạng đó mới được nhận cho `session_id`. */
function looksLikeSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

/**
 * Ghi một dòng log có cấu trúc.
 *
 * ⚠️ **Nuốt mọi lỗi.** Đây là ranh giới NFR-004: observability không được nằm trên
 * serving path. `console.*` có thể ném, và mọi lỗi ở đây đều **không** được lan ra
 * caller.
 */
export function writeLog(fields: LogFields): void {
  try {
    const payload = pickLogFields(fields);
    if (payload.event === undefined) {
      // Không có `event` thì dòng log không group được, nên bỏ thay vì ghi rác.
      return;
    }
    // Nối tay thay vì `console.log(obj)`: log đi qua `wrangler tail` là text, và
    // stringify tại đây giữ một dòng = một event cho mọi consumer phía sau.
    const line = Object.entries(payload)
      .map(([key, value]) => `${key}=${typeof value === 'number' ? value : JSON.stringify(value)}`)
      .join(' ');
    // `no-console` tắt ở đây là **ngoại lệ có chủ đích** — xem JSDoc đầu file.
    // Đây là dòng duy nhất trong app được phép `console.*`, và lý do nằm ngay cạnh
    // dòng đó thay vì ở một override trong `.oxlintrc.json` (repo-level) che mất nó.
    // oxlint-disable-next-line no-console
    console.log(line);
  } catch {
    // Cố tình im lặng — xem JSDoc trên `writeLog`.
  }
}
