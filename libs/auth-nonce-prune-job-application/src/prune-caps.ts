/**
 * Trần của thuật toán prune nonce — hằng số TẬP TRUNG, không override qua env.
 *
 * ⚠️ **Hằng số của thuật toán**, không phải cấu hình môi trường: script cũ
 * (`PRUNE_SCRIPT` — `.github/workflows/identity-nonce-prune.yaml` đã bị xoá) cũng đặt
 * chúng trong chính script để không bao giờ bị "một lần sửa YAML xoá dòng env" gỡ mất
 * biên mà không có gì đỏ. Đặt chúng ở đây (không phải inline nhiều nơi) là để spec đối
 * chiếu trần thời gian tổng không lại trôi; **không** thêm env var nào cho override —
 * một override chưa ai review là một ngân sách tự điền.
 */

/** Số hàng mỗi lô. Giữ nguyên từ script cũ (20 000): đủ nhỏ để khoá hàng không giữ lâu, đủ lớn để backlog thường trực drain trong vài lô. */
export const BATCH_SIZE = 20_000;

/** Số lô tối đa mỗi run, mỗi kho. Giữ nguyên từ script cũ. */
export const MAX_BATCHES = 50;

/**
 * Trần thời gian của VÒNG LÔ (kể từ khi Worker bắt đầu run), mỗi kho.
 *
 * Trần đặt theo mốc **tổng wall-clock** của Cron invocation — WK4: trần `scheduled()` là
 * **15 phút** (900 giây) wall-clock, hai kho chạy **song song** qua `Promise.all` nên
 * tổng thời gian run = `max(kho1, kho2)`, KHÔNG phải `sum` — song song hai bên không nhân
 * đôi nhu cầu trần, chỉ cần **một kho** nằm dưới 900s là đủ.
 *
 * Bảng tính đường xấu nhất **một kho** (mỗi lần gọi `pg` bị bao bởi `statement_timeout`
 * 60s + `lock_timeout` 30s + `connect_timeout` 10s, retry tối đa `MAX_ATTEMPTS` với
 * backoff 5s + 10s → một call ≤ 3 × 70 + 15 = **225 giây**; script cũ ghi mốc cùng một
 * cách — `docs/applications/auth/03-operations.md` §3.3):
 *
 *   phần                   ≤ …
 *   checkpoint cuối trần   ≤ MAX_SECONDS  (chỉ số này khống chế thời lượng của vòng lô,
 *                                        tính từ khi handler bắt đầu — preflight chiếm
 *                                        chỗ của trần với cùng cách tính của script
 *                                        cũ: `SECONDS - started` gồm cả preflight)
 *   một lô cuối đang chạy  ≤ 225s
 *   backlog probe          ≤ 225s
 *   ─────────────────────────────────────────────────────
 *   tổng một kho           ≤ MAX_SECONDS + 450s
 *
 * Hai kho chạy song song ⇒ tổng run của invocation ≤ `max(kho1, kho2)` ≤
 * `MAX_SECONDS + 450`. Chừa 50 giây slack (jitter của cron + phần chạy trước hai mốc
 * trên): MAX_SECONDS = 400 → tổng ≤ 850 giây < 900 giây trần WK4. Cùng cách tính, script
 * cũ chiếm 600 + 450 = 1050 giây trên một trần `timeout-minutes: 25` (1500 giây) của
 * GitHub; con số 400 ở đây là vì trần Worker (900) nhỏ hơn trần GitHub (1500).
 *
 * ⚠️ Trần này không phải một đối chiếu checkpoint chặt: vòng lô kiểm trần **trước** mỗi
 * lô (cùng hình script cũ), nên một lô bắt đầu ngay trước mốc có thể kéo xa hơn
 * `MAX_SECONDS` tới hết lô đó, cộng một lô cuối ≤ 225s và một probe ≤ 225s — tất cả đã
 * nằm trong bảng tính trên. Preflight treo (3 lần retry + backoff) cũng chiếm ngân sách
 * cùng một trần, theo đúng học thuyết "phí của preflight bị trừ khỏi trần của vòng lô".
 */
export const MAX_SECONDS = 400;

/** Trần thử một call transport (postgres connection-class errors) mỗi kho — giữ nguyên từ script cũ. */
export const MAX_ATTEMPTS = 3;

/**
 * `statement_timeout` của **một lô**, giây. Giữ nguyên từ script cũ (60, giá trị đếm từ
 * lô 20 000 trên bảng hình trăm nghìn tới vài triệu hàng).
 */
export const STATEMENT_TIMEOUT_SECONDS = 60;

/**
 * `lock_timeout` của **một lô**, giây. Việc một DELETE chậm giữ khoá cho tới hết statement
 * timeout là đường xấu nhất bình thường; chờ lock lâu hơn 30s nghĩa là đang chờ một transaction
 * khác làm ngược — abort nhanh hơn là giữ khoá lâu hơn.
 */
export const LOCK_TIMEOUT_SECONDS = 30;

/** `connect_timeout` của một connection `pg` mới, giây. Giữ nguyên từ script cũ (PGCONNECT_TIMEOUT=10). */
export const CONNECT_TIMEOUT_SECONDS = 10;

/** Backoff giữa hai lần thử lại, giây, tuyến tính theo lần thứ (`attempt * 5`). Giữ nguyên từ script cũ. */
export function retryBackoffSeconds(attempt: number): number {
  return attempt * 5;
}
