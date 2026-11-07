/**
 * Ràng buộc `login_handoffs` — handle X ↔ session đã trình nó (§3.6 của
 * `01-architecture.md`).
 *
 * ## Biên của module
 *
 * Cùng biên với `server/lib/otp.ts` và `server/lib/session.ts`: mọi **policy**
 * (TTL) là hằng số export để test khoá; mọi **I/O** (PostgreSQL, đồng hồ) do
 * caller truyền vào. Không import `node:*` (runtime:edge), không giữ state ở
 * module scope. Mọi giá trị handle rõ **không bao giờ** vào log hay DB — chỉ
 * `handle_hash` được lưu (X đi qua query string và có thể lọt vào access log
 * của tầng trung gian, §3.6).
 *
 * ## Vì sao đây là một module riêng thay vì nhét vào `session` hay `otp`
 *
 * Ba route (`challenge`, `verify`, `handoff`) cùng chạm bảng này nhưng ở ba thời
 * điểm khác nhau của một luồng: cấp handle (bind lần đầu), xoay session (chuyển
 * binding), hoàn tất bàn giao (so khớp rồi consume). Tách module cho mỗi luật
 * của FR-006c2/c3/c4/d2 đứng đúng một chỗ — route không tự viết SQL so khớp,
 * nên một sửa đổi của máy trạng thái không phải được chép tay ở ba nơi.
 */

/**
 * TTL của một binding handoff (giây) — **TTL ngắn**, cùng mốc 10 phút với TTL
 * transaction phía `auth` (`TRANSACTION_TTL_MS` của
 * `libs/auth-application`, §3.6: "`expires_at` — TTL ngắn, bằng TTL
 * transaction phía auth").
 *
 * ⚠️ Đây là TTL **không gia hạn**: FR-006g cấm đường gia hạn âm thầm, trigger
 * `login_handoffs_rebind_guard` (0001) cũng không có đường nào đẩy mốc
 * `expires_at` ra xa cho hàng đã kết thúc. Hết TTL ⇒ `handoff` fail-closed,
 * browser quay về `/authorize` mới.
 */
export const LOGIN_HANDOFF_TTL_SECONDS = 600;

/** Hàng `login_handoffs` phần cần cho handoff route — cùng cột của bảng (0001). */
export interface LoginHandoffRow {
  readonly handle_hash: string;
  readonly session_ref: string;
  readonly state: string;
  readonly expires_at: Date;
}

/**
 * SHA-256 hex của handle X — giá trị **duy nhất** được ghi DB (không lưu X rõ).
 *
 * Cùng thuật toán với `hashSessionIdentifier`: cột không ràng buộc thuật toán,
 * nhưng một thuật toán duy nhất cho một cột tra cứu là điều kiện của so khớp —
 * hash hai kiểu là hai khoá không bao giờ gặp nhau.
 */
export async function hashHandle(handle: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(handle));
  let out = '';
  for (const byte of new Uint8Array(digest)) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Ghi binding **lần đầu tiên** cho handle X — FR-006c2, AC-008b2.
 *
 * ## Một thao tác atomic duy nhất — không đọc-rồi-ghi
 *
 * Câu lệnh là `INSERT ... ON CONFLICT (handle_hash) DO NOTHING`: thắng thua do
 * ràng buộc PK quyết định ở tầng database, bất kể bao nhiêu Worker cùng tranh.
 * Đọc rồi so rồi ghi là hai thao tác — dưới tải đồng thời hai request cùng
 * thấy "chưa có" rồi cùng ghi, và toàn bộ first-binding-wins biến mất (AC-
 * 008b2). Sau khi conflict, **không** có đường nào của luồng này ghi đè binding
 * cũ (FR-006c3): mọi UPDATE khác trên hàng đều bị trigger
 * `login_handoffs_rebind_guard` chặn, duy nhất đường chuyển binding khi rotate
 * ({@link carryHandoffToNewSession}, trong đúng transaction xoay — FR-006c4)
 * được phép đổi `session_ref`.
 *
 * ## Trả về binding hiện tại, không phân nhánh thắng/thua
 *
 * Caller (route) chỉ so `session_ref` trả về với session của mình — cùng giá
 * trị nghĩa là mình là session đã giữ binding (vừa thắng, hoặc đã có từ trước
 * — retry idempotent, AC-008b4); khác giá trị nghĩa là session khác đã bind
 * trước, và đường đúng là từ chối, không phải ghi đè (FR-006c5: pre-binding
 * không chống được ở lớp này — lớp 2 là `browser_confirmed` phía auth).
 *
 * @returns Binding hiện tại của handle sau lệnh INSERT.
 */
export async function bindHandleFirst(
  pool: import('pg').Pool | import('pg').PoolClient,
  params: {
    /** Hash của handle X — không truyền handle rõ. */
    handleHash: string;
    /** `session_ref` của session đang trình X (anonymous hay authenticated). */
    presentSessionRef: string;
    /** Mốc hết hạn TTL — caller tính theo {@link LOGIN_HANDOFF_TTL_SECONDS}. */
    expiresAt: Date;
  },
): Promise<{ session_ref: string; state: string }> {
  const result = await pool.query<{ session_ref: string; state: string }>(
    `INSERT INTO account.login_handoffs (handle_hash, session_ref, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (handle_hash) DO NOTHING
     RETURNING session_ref, state`,
    [params.handleHash, params.presentSessionRef, params.expiresAt],
  );
  if (result.rowCount === 1) {
    const row = result.rows[0];
    if (row === undefined) {
      // `rowCount = 1` mà `RETURNING` trống là driver trả sai — ném coi như lỗi
      // DB: một binding "không ai biết là của ai" là trạng thái hỏng.
      throw new Error('login_handoffs: insert claimed one row but RETURNING is empty');
    }
    return { session_ref: row.session_ref, state: row.state };
  }
  // Conflict: đọc binding của bên thắng (một SELECT — so khớp, không phải ghi
  // thứ hai). Không có hàng nào sau bước này được ghi thêm.
  const winner = await pool.query<{ session_ref: string; state: string }>(
    `SELECT session_ref, state FROM account.login_handoffs WHERE handle_hash = $1`,
    [params.handleHash],
  );
  const row = winner.rows[0];
  if (row === undefined) {
    throw new Error('login_handoffs: conflict claimed binding exists but none found');
  }
  return { session_ref: row.session_ref, state: row.state };
}

/**
 * Chuyển binding khi xoay session — FR-006c4, AC-008b5, §3.6.2.
 *
 * ⚠️ Phải chạy **trong cùng transaction** với việc thu hồi session cũ và tạo
 * session mới (caller là `insertAuthenticatedSession` của `session.ts`): chuyển
 * binding là một thao tác atomic duy nhất với rotation — nếu tách ra, có một
 * khoảng thời gian binding trỏ tới session đã bị thu hồi (§3.6.2 gọi đó là
 * cách làm login hỏng).
 *
 * Đây là đường **duy nhất** trong codebase được phép làm `session_ref` của một
 * binding đổi — guard trigger (0001) chỉ cho phép `bound → session_rotated`
 * kèm đổi `session_ref`, mọi UPDATE khác bị raise ở tầng database.
 *
 * Điều kiện `state = 'bound'` là điều kiện của chính máy trạng thái: một
 * binding đã rời `bound` không rơi lại và không có session thứ ba thừa kế X.
 *
 * @returns Số hàng đã chuyển — 0 khi session cũ không giữ binding nào (xoay
 *   mà không có binding là luồng bình thường: đăng nhập account thuần).
 */
export async function carryHandoffToNewSession(
  client: import('pg').PoolClient,
  params: { fromSessionRef: string; toSessionRef: string },
): Promise<number> {
  const result = await client.query(
    `UPDATE account.login_handoffs
        SET session_ref = $2, state = 'session_rotated'
      WHERE session_ref = $1 AND state = 'bound'`,
    [params.fromSessionRef, params.toSessionRef],
  );
  return result.rowCount ?? 0;
}

/**
 * Đọc binding của handle X — so khớp trước khi relay payload (§3.6, FR-006c).
 *
 * @returns Binding hiện tại, hoặc `null` khi handle chưa từng được bind.
 */
export async function lookupHandoff(
  pool: import('pg').Pool,
  handleHash: string,
): Promise<LoginHandoffRow | null> {
  const result = await pool.query<{
    handle_hash: string;
    session_ref: string;
    state: string;
    expires_at: Date;
  }>(
    `SELECT handle_hash, session_ref, state, expires_at
       FROM account.login_handoffs
      WHERE handle_hash = $1`,
    [handleHash],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        handle_hash: row.handle_hash,
        session_ref: row.session_ref,
        state: row.state,
        expires_at: row.expires_at,
      };
}

/** Kết quả so khớp binding trước khi push — fail-closed phân nhóm ở route. */
export type HandoffMatchResult =
  /** Handle chưa từng được bind — `/login` không đi qua đường này. */
  | { readonly kind: 'missing' }
  /** Binding trỏ vào session khác — đạo nghĩa của "session khác trình X". */
  | { readonly kind: 'binding_mismatch' }
  /** Binding đã kết thúc hoặc quá TTL — không có đường dùng lại (FR-006d2). */
  | { readonly kind: 'unusable' }
  /** Binding khớp session đang trình và còn dùng được. */
  | { readonly kind: 'matched' };

/**
 * So khớp binding với session đang trình X — **thuần**, test được không cần DB.
 *
 * Thứ tự phân loại: chưa tồn tại → sai session (mismatch) → kết thúc/quá TTL
 * (unusable). `binding_mismatch` được kiểm **trước** `unusable`: một binding
 * trỏ vào session khác là thông tin quan trọng hơn trạng thái chết của nó —
 * nếu dừng ở `unusable`, session sai cũng nhận cùng mã như session đúng; phân
 * loại mismatch trước cho đúng điều §3.6 mô tả ("session đang xử lý X có phải
 * đúng session đã trình X không").
 *
 * ⚠️ TTL so trực tiếp với mốc `nowMs` caller truyền — không tin hàng đã được
 * mark `expired` hay chưa: `expires_at <= now` là chính sự thật của TTL, mark
 * chỉ là hygiene vòng đời.
 */
export function checkHandoffBinding(
  row: LoginHandoffRow | null,
  params: { sessionRef: string; nowMs: number },
): HandoffMatchResult {
  if (row === null) {
    return { kind: 'missing' };
  }
  if (row.session_ref !== params.sessionRef) {
    return { kind: 'binding_mismatch' };
  }
  if (row.state === 'consumed' || row.state === 'expired') {
    return { kind: 'unusable' };
  }
  if (params.nowMs >= row.expires_at.getTime()) {
    return { kind: 'unusable' };
  }
  return { kind: 'matched' };
}

/**
 * Consume binding — FR-006d2: handoff được dùng xong thì chuyển `consumed`,
 * hết hiệu lực, không có đường dùng lại.
 *
 * Điều kiện `session_ref` + dải state là điều kiện cạnh tranh trong câu UPDATE
 * (cùng hình thức với `consumeChallenge` của `otp.ts`): chỉ session đúng, còn
 * đang sống mới consume được; request song song khác cùng thua — không có đường
 * nào consume lại hay hồi sinh (guard trigger chặn mọi UPDATE trên hàng
 * terminal).
 *
 * @returns `true` khi request này consume được; `false` khi binding không nằm
 *   đúng `session_ref` đó hoặc đã ở trạng thái kết thúc.
 */
export async function consumeHandoff(
  pool: import('pg').Pool,
  params: { handleHash: string; sessionRef: string },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE account.login_handoffs
        SET state = 'consumed'
      WHERE handle_hash = $1
        AND session_ref = $2
        AND state IN ('bound', 'session_rotated')`,
    [params.handleHash, params.sessionRef],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Đánh dấu `expired` các binding quá TTL — hygiene vòng đời, FR-006g.
 *
 * ⚠️ Hàm này **không** phải prune job: nó mark đúng **một** handle mà route
 * đang chạm, không quét theo mốc thời gian. Index
 * `login_handoffs_expires_at_idx (expires_at)` của `0001` được tạo cho một câu
 * `DELETE` theo TTL **chưa tồn tại** ở bất kỳ đâu trong repo — cùng hình thức
 * gap đã ghi cho `otp_challenges` (`docs/applications/account/03-operations.md`
 * §3.3: "grant DELETE đã có, nhưng chưa có job nào dùng nó"). Follow-up prune
 * nên gộp hai bảng này vào cùng một job. growth tại đây không thiếu an toàn:
 * TTL 600s chặn cứng tuổi hàng, và một hàng chỉ sinh mỗi lần `/login?handle=`
 * được gọi — nhưng comment của index (0001) mô tả một query thực tế chưa có
 * caller; đừng đọc comment đó mà tưởng job đã tồn tại.
 *
 * Quyết định fail-closed **không** phụ thuộc việc hàng đã được mark hay chưa:
 * `checkHandoffBinding` so `expires_at` trực tiếp với mốc thời gian, mark chỉ
 * để dọn state cho đúng máy trạng thái của §3.6.
 *
 * @returns Số hàng chuyển sang `expired`.
 */
export async function expireHandoff(
  pool: import('pg').Pool,
  handleHash: string,
  nowMs: number,
): Promise<number> {
  const result = await pool.query(
    `UPDATE account.login_handoffs
        SET state = 'expired'
      WHERE handle_hash = $1
        AND state IN ('bound', 'session_rotated')
        AND expires_at <= $2`,
    [handleHash, new Date(nowMs)],
  );
  return result.rowCount ?? 0;
}
