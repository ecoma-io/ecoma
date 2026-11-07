import type {
  ClaimMailNonceInput,
  DeleteExpiredMailNoncesInput,
  InternalNonceStore,
} from '@ecoma-io/transactional-mail-application';

import type { D1SubsetDatabase } from './d1-surface';

/**
 * "Kiểm tra VÀ ghi" trong đúng một statement.
 *
 * `ON CONFLICT (principal, nonce) DO NOTHING` + `RETURNING` là toàn bộ hợp đồng: không có hàng
 * trả về nghĩa là khoá đã tồn tại. Hai request đồng thời thì đúng một cái nhận hàng, bất kể
 * thứ tự.
 */
const CLAIM = `
INSERT INTO mail_internal_nonces (principal, nonce, expires_at)
VALUES (?, ?, ?)
ON CONFLICT (principal, nonce) DO NOTHING
RETURNING principal
`;

/**
 * Prune có **biên**.
 *
 * `DELETE` của SQLite không có `LIMIT` (cần `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, không có ở
 * D1), nên phạm vi xoá được giới hạn bằng một nhánh con có `LIMIT` trước: statement chỉ xoá
 * đúng tối đa `limit` hàng cũ nhất. Một lô bị kill giữa chừng thì lô sau tiếp tục với đúng
 * phần còn lại — tiến độ là số hàng đã xoá, không phải một job "đã xong".
 *
 * `ORDER BY expires_at` (dùng index `mail_internal_nonces_expires_at_idx`) làm lô luôn lấy
 * hàng sắp hết hạn trước, nên cắt giữa chừng vẫn là một cắt hợp lý.
 *
 * `rowid` có sẵn vì bảng là rowid table với PK ghép (`principal, nonce`).
 */
const DELETE_EXPIRED = `
DELETE FROM mail_internal_nonces
WHERE rowid IN (
  SELECT rowid FROM mail_internal_nonces
  WHERE expires_at <= ?
  ORDER BY expires_at, rowid
  LIMIT ?
)
RETURNING principal, nonce
`;

/** Kho nonce D1 của chính `transactional-mail`. Xem JSDoc của từng method trong port. */
export class D1InternalNonceStore implements InternalNonceStore {
  readonly #db: D1SubsetDatabase;

  constructor(db: D1SubsetDatabase) {
    this.#db = db;
  }

  async claimNonce(input: ClaimMailNonceInput): Promise<boolean> {
    // Epoch giây → epoch miligiây (đơn vị của bảng) — chỗ đổi đơn vị duy nhất trong toàn bộ
    // persistence. Lệch chỗ này là lệch TTL replay, nên kiểm input **trước** khi nhân: giá trị
    // không nguyên an toàn sẽ tràn precision thành một mốc hết hạn khác với mốc giao thức tính
    // ra, và tràn theo chiều **dài hơn** TTL thì cửa sổ replay mở ra thay vì đóng lại.
    if (!Number.isSafeInteger(input.expiresAtEpochSeconds) || input.expiresAtEpochSeconds <= 0) {
      throw new Error(
        'claimNonce: expiresAtEpochSeconds must be a positive safe integer in epoch seconds',
      );
    }
    if (input.principal === '' || input.nonce === '') {
      // DB cũng có CHECK cho việc này, nhưng fail sớm cho lỗi rõ hơn và không tạo một dòng
      // đang tranh chấp ở giữa.
      throw new Error('claimNonce: principal and nonce must be non-empty');
    }

    const claimed = await this.#db
      .prepare(CLAIM)
      .bind(input.principal, input.nonce, input.expiresAtEpochSeconds * 1000)
      .all();

    // Không có hàng = khoá đã tồn tại = đã có request claim nonce này = **replay** (`true`).
    return claimed.results.length === 0;
  }

  async deleteExpiredNonces(input: DeleteExpiredMailNoncesInput): Promise<number> {
    if (input.limit < 1) {
      return 0;
    }

    const deleted = await this.#db.prepare(DELETE_EXPIRED).bind(input.nowMs, input.limit).all();

    // Số hàng lấy từ `RETURNING`, không từ `meta.changes`: local `wrangler d1 execute` không
    // điền `meta.changes` (DB3) — đọc nó sẽ cho 0 giả và prune im lặng không dọn gì.
    return deleted.results.length;
  }
}
