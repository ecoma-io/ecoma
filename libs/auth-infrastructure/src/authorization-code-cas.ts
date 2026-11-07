import type { PostgresClientLike, Queryable } from './postgres';

/**
 * Tiêu thụ một authorization code đúng MỘT LẦN (FR-006, FR-013, SR-013).
 *
 * ⚠️ Đây là chỗ duy nhất trong hệ thống nơi "một lần" được bảo đảm bằng cơ chế
 * lưu trữ, và vì vậy nó là chỗ dễ hỏng nhất. Hai yêu cầu trùng nhau với cùng một
 * code phải cho đúng MỘT thắng. Cơ chế: `UPDATE ... WHERE consumed_at IS NULL`
 * trả về số hàng đã cập nhật, và PostgreSQL bảo đảm một `UPDATE` chỉ match một
 * hàng cho mỗi transaction — kết hợp với `READ COMMITTED`, tức là lệnh đầu tiên
 * commit sẽ khoá hàng, lệnh thứ hai thấy `consumed_at` đã khác NULL sau khi chờ,
 * và update 0 hàng.
 *
 * ⚠️ Vì sao KHÔNG dùng `SELECT` rồi `UPDATE`:
 * `SELECT` xong rồi `UPDATE` ở giữa là một race, và trong đọc-ghi trên cùng
 * transaction với `READ COMMITTED` thì lệnh `UPDATE` thứ hai SẼ vẫn khớp hàng
 * (nó không chặn ở `SELECT`), nên cả hai request đều cập nhật và cả hai đều thắng.
 * Một `UPDATE` có điều kiện là toàn bộ điều kiện cần.
 *
 * ⚠️ Câu SQL này là **bản chép** của `0004_authorization_codes.sql`, và mọi
 * khác biệt với migration là một lỗi, không phải một lựa chọn. Migration là nơi
 * khai báo schema và constraint; adapter là nơi dùng nó. Lệch tên cột ở đây
 * chỉ lộ ra khi chạy với schema thật — `nx test` với `search_path` mặc định
 * có thể xanh trong khi production đỏ.
 */

/** Kết quả tiêu thụ code: thắng thì `won`, thua thì `lost`. */
export type RedemptionOutcome = 'won' | 'lost';

export interface RedemptionResult {
  outcome: RedemptionOutcome;
  /** Hàng code sau khi cập nhật — chỉ có ý nghĩa khi `outcome === 'won'`. */
  row: AuthorizationCodeRow | undefined;
}

/**
 * Cột của `auth.authorization_codes` mà tầng này đọc.
 *
 * ⚠️ Tên và kiểu ở đây lấy từ migration, không tự chọn: `id` là `uuid`,
 * `authorization_transaction_id` là `uuid`, `granted_scopes` là `text[]`.
 * `scope`/`code_id` là tên của một bản thiết kế cũ và không tồn tại.
 */
export interface AuthorizationCodeRow {
  id: string;
  /** Hash của code, KHÔNG phải giá trị code dạng rõ (FR-006a). */
  code_hash: string;
  authorization_transaction_id: string;
  /** `sub` opaque của subject; không FK sang db-account (NFR-002b). */
  sub: string;
  client_id: string;
  redirect_uri: string;
  /** Code challenge PKCE đã lưu, dạng base64url. */
  code_challenge: string;
  /** Luôn `S256`: migration có CHECK chặn giá trị khác (FR-010). */
  code_challenge_method: string;
  granted_scopes: string[];
  /** Chép từ transaction, đưa vào `id_token` (SR-007). */
  nonce: string | null;
  expires_at: Date;
  consumed_at: Date | null;
}

/**
 * Tiêu thụ code trong MỘT transaction.
 *
 * ⚠️ **Tên bảng qualify `auth.`, không dựa vào `search_path`.** Hyperdrive pool
 * transaction-mode nên `SET search_path` bị `RESET` khi connection quay về pool
 * (`04` HD5). SQL không qualify sẽ hỏng ngay khi chạy qua Hyperdrive, dù chạy
 * được ở local — một lỗi chỉ lộ ra ở môi trường deploy. Mọi migration cũng
 * qualify theo cùng quy ước.
 *
 * ⚠️ `consumed_by` đi **cùng** `consumed_at` vì migration có CHECK
 * `(consumed_at IS NOT NULL) = (consumed_by IS NOT NULL)`. Thiếu nó là
 * `INSERT`/`UPDATE` bị constraint từ chối — và CHECK này tồn tại để chặn một
 * đường né CAS mà không để lại dấu vết thời gian.
 *
 * ⚠️ `expires_at > $2` nằm **trong** cùng câu `UPDATE`, không phải kiểm tra
 * trước. Tách ra nghĩa là code hết hạn vẫn bị đánh dấu consumed — tức là burn
 * một code vốn đã chết.
 *
 * @param params.consumedBy Định danh phía consumer của `/token`, để điều tra khi
 *   phát hiện `codes_reused_total > 0`. KHÔNG phải credential.
 * @param params.now Thời điểm kiểm hạn do caller kiểm soát, để test giữ được
 *   thời điểm kiểm tra thay vì phụ thuộc đồng hồ database.
 */
export async function redeemAuthorizationCode(
  client: PostgresClientLike,
  params: {
    codeHash: string;
    consumedBy: string;
    now: Date;
  },
): Promise<RedemptionResult> {
  const { codeHash, consumedBy, now } = params;

  return client.begin(async (tx: Queryable) => {
    const updated = await tx.unsafe<AuthorizationCodeRow>(
      `
        UPDATE auth.authorization_codes
           SET consumed_at = $2,
               consumed_by = $3
         WHERE code_hash = $1
           AND consumed_at IS NULL
           AND expires_at > $2
      RETURNING id, code_hash, authorization_transaction_id, sub, client_id,
                redirect_uri, code_challenge, code_challenge_method,
                granted_scopes, nonce, expires_at, consumed_at
      `,
      [codeHash, now, consumedBy],
    );

    // 0 hàng nghĩa là: đã tiêu thụ, HOẶC hết hạn, HOẶC không tồn tại. Ta không
    // phân biệt ở đây và không được phân biệt — cả ba đều phải cho cùng một câu
    // trả lời về phía client, nếu không thì chính sự phân biệt đó lộ ra việc
    // code có tồn tại hay không (oracle). Tầng trên ánh xạ thành `invalid_grant`
    // cho cả ba.
    const row = updated[0];
    if (row === undefined) {
      return { outcome: 'lost', row: undefined } satisfies RedemptionResult;
    }

    return { outcome: 'won', row } satisfies RedemptionResult;
  });
}
