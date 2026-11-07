/**
 * Kho nonce bền của chính `transactional-mail` cho replay guard nội bộ
 * (`01-architecture.md` §7.4).
 *
 * ⚠️ Đây là **persistence primitive**, không phải receiver: C1 không cung cấp middleware xác
 * thực, không verify chữ ký, không đọc credential — chỉ có chỗ để `claimNonce` ghi vào.
 *
 * ⚠️ Khác với các port khác, port này **không** nhận epoch milligiây. `expiresAtEpochSeconds`
 * là epoch **giây** vì nó được tính ra từ timestamp của envelope theo hằng của giao thức
 * (`timestamp + skew + NONCE_TTL_BUFFER_SECONDS`, `libs/internal-auth-contracts/src/internal-auth.ts`)
 * — việc đổi sang đơn vị bảng (`*_at` = epoch ms) là việc của implementation, tại một chỗ duy
 * nhất. Neo theo `now` của receiver thì trôi: nonce sẽ hết hạn trước khi envelope thôi phát
 * lại được, mở cửa sổ replay thay vì đóng nó.
 */
export interface InternalNonceStore {
  /**
   * "Kiểm tra **VÀ** ghi" trong một statement duy nhất:
   * `INSERT … ON CONFLICT (principal, nonce) DO NOTHING RETURNING` rồi đếm số hàng trả về.
   *
   * - Không có hàng trả về = khoá đã tồn tại = **đã có request nào đó claim nonce này** →
   *   trả `true`.
   * - Có hàng = claim thành công → trả `false`.
   *
   * Giá trị trả về chính là hợp đồng của `VerifyRequestInput.claimNonce`
   * (`libs/internal-auth-contracts/src/internal-auth.ts`): **`true` = replay** — `verifyRequest`
   * từ chối khi callback trả `true`. Hai request mang cùng nonce thì chỉ một cái claim được,
   * bất kể tải.
   *
   * ⚠️ Cài đặt bằng `SELECT` rồi `INSERT` ở statement **khác** sẽ mất đúng tính chất này dưới
   * tải đồng thời — đó là lỗi mà FR-006c2 của `account` cũng cấm.
   *
   * ⚠️ Khoá là **`(principal, nonce)`**, không phải `nonce`: không có tính toàn cục, và cũng
   * không bao giờ *được* có — nếu khoá là `nonce` thì một consumer giữ credential hợp lệ có
   * thể ký envelope hợp lệ dưới key của mình với nonce lấy từ log của consumer khác rồi "đốt"
   * nó, biến claim của principal này thành hiệu lực chặn principal kia (từ chối dịch vụ chéo-
   * principal). Xem ghi chú đầy đủ trong `0004_mail_internal_nonces.sql`.
   *
   * Không có `UPDATE` trên bảng này: nới `expires_at` của nonce đã ghi là nới cửa sổ replay —
   * dữ liệu kiểm soát bảo mật, không được sửa ngang. Port phản ánh điều đó bằng cách không
   * có method ghi nào khác ngoài claim và prune.
   */
  claimNonce(input: ClaimMailNonceInput): Promise<boolean>;

  /**
   * Xoá nonce đã hết hạn **tại thời điểm `nowMs`**, tối đa `limit` hàng.
   *
   * Predicate là `expires_at <= nowMs` — đúng biên: một nonce có `expires_at = T` còn nguyên
   * khi `nowMs < T` và chỉ bị xoá khi `nowMs >= T`. Không có đường nào xoá sớm hơn mốc mà
   * giao thức đã tính (invariant "expiry không xoá trước boundary").
   *
   * ⚠️ `limit` là **bắt buộc**: prune là lô (`apps/auth/migrations/0010_internal_nonces.sql`
   * — "dọn nonce hết hạn theo lô"), và một `DELETE` không biên trên Worker có thể chạy quá
   * lâu rồi bị kill giữa chừng. Một lô bị kill thì lô sau tiếp tục — tiến độ là số hàng đã
   * xoá, không phải một job "đã xong".
   *
   * Trả về **số hàng đã xoá**. Số này lấy từ `RETURNING` chứ không từ `meta.changes`: local
   * wrangler không điền `meta.changes` cho file-based runs
   * (`docs/architecture/04-platform-facts.md` DB3), nên đọc nó sẽ cho `0` giả và prune im lặng
   * không dọn gì.
   */
  deleteExpiredNonces(input: DeleteExpiredMailNoncesInput): Promise<number>;
}

/** Input của {@link InternalNonceStore.claimNonce}. */
export interface ClaimMailNonceInput {
  /** Chủ thể đã authenticate được — scope của uniqueness (§7.4). Không rỗng. */
  readonly principal: string;
  /** Giá trị nonce của envelope. Tối đa `MAX_NONCE_CHARS` (128) do application layer kiểm. */
  readonly nonce: string;
  /**
   * `timestamp của envelope + skew chấp nhận + buffer độ trễ đồng hồ`, epoch **giây**.
   *
   * Phải lớn hơn `DEFAULT_SKEW_SECONDS` (300s): TTL nhỏ hơn skew thì prune xoá nonce còn
   * hiệu lực và replay thành công trong cửa sổ. Application layer kiểm bằng
   * `assertNonceExpirySeconds` trước khi truyền vào.
   */
  readonly expiresAtEpochSeconds: number;
}

/** Input của {@link InternalNonceStore.deleteExpiredNonces}. */
export interface DeleteExpiredMailNoncesInput {
  /** Epoch ms — mọi nonce có `expires_at <= nowMs` là ứng viên bị xoá. */
  readonly nowMs: number;
  /** Số hàng tối đa một lô; `<= 0` không xoá gì. */
  readonly limit: number;
}
