import type { InternalNonceStore } from './internal-nonce-store';

/**
 * Dọn nonce hết hạn — `01-architecture.md` §7.4.
 *
 * ⚠️ Đây là **bảo trì ký hiệu replay guard**, không phải nghiệp vụ mail: nonce đã hết hạn
 * không còn tác dụng gì (replay guard chỉ có ý nghĩa trong cửa sổ `timestamp + skew + buffer`),
 * và bảng `mail_internal_nonces` không có đường nào khác ngoài claim và prune — port cũng
 * phản ánh đúng điều đó bằng việc không có method nào khác.
 */

/** Dependency của {@link runNoncePrune} — chỉ một method, vì chỉ một method là cần thiết. */
export type MailNoncePruneDeps = {
  readonly nonces: Pick<InternalNonceStore, 'deleteExpiredNonces'>;
};

/**
 * Ngưỡng của một lô prune — **giá trị truyền vào**, không hằng trong module.
 *
 * `batchLimit` là bắt buộc chứ không phải tuỳ chọn: `DELETE` của SQLite không có `LIMIT` ở
 * D1, nên port giới hạn bằng một nhánh con có `LIMIT`. Một lô bị kill giữa chừng thì lô sau
 * tiếp tục với phần còn lại — tiến độ là **số hàng đã xoá**, không phải một job "đã xong".
 */
export type RunNoncePruneConfig = {
  /** Số hàng tối đa một lô. */
  readonly batchLimit: number;
  /** Epoch ms — nonce nào `expires_at <= nowMs` thì là ứng viên xoá. */
  readonly nowMs: number;
};

/**
 * Xoá **một lô** nonce đã hết hạn.
 *
 * Một lô trên mỗi lần gọi, có chủ đích: caller (cron) lặp bao nhiêu lần thì bấy nhiêu lô,
 * và mỗi lô đều biên nên một lần chạy không thể bị kéo dài vô hạn. `batchLimit <= 0` là một
 * no-op hợp lệ — port tự trả `0` mà không chạm database, đúng như mọi đường quét theo lô.
 *
 * ⚠️ Biên prune là `expires_at <= nowMs` và **không bao giờ** sớm hơn: một nonce có
 * `expires_at = T` còn nguyên khi `nowMs < T`. Xoá sớm hơn mốc mà giao thức đã tính là **mở**
 * cửa sổ replay, tức đúng thứ mà kho này sinh ra để đóng.
 */
export async function runNoncePrune(
  deps: MailNoncePruneDeps,
  config: RunNoncePruneConfig,
): Promise<{ readonly deleted: number }> {
  const deleted = await deps.nonces.deleteExpiredNonces({
    nowMs: config.nowMs,
    limit: config.batchLimit,
  });

  return { deleted };
}
