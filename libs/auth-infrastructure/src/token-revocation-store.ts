import type { RevocationCheckResult } from '@ecoma-io/auth-domain';

import type { PostgresClientLike, Queryable } from './postgres';

/**
 * Store thu hồi token của `db-auth` — bảng `auth.token_revocations`.
 *
 * ## Ranh giới
 *
 * Truy vấn này từng nằm trong `apps/auth/src/authorization-store.ts` — chỗ tạm
 * của app cho tới khi lib sở hữu nó (#343). Cùng bộ luật với các module anh em
 * (`authorization-code-cas`, `authorization-transaction-store`): câu SQL là
 * bản chép của quy ước trong migration (`0006`, `0011`), lệch tên cột chỉ lộ
 * ra khi chạy với schema thật.
 *
 * ## Parity test
 *
 * Bảng ở trên KHÔNG có parity spec colocated song song từng file migration;
 * hợp đồng đọc của nó được ghim bằng suite PostgreSQL thật app-owned
 * `apps/auth/tests/integrations/authorization-store.spec.ts` (+ các đường
 * handler qua `main.spec.ts`). Quyết định này giữ nguyên khi store dời về lib
 * — suite sở hữu database thuộc app, không thuộc lib (06-testing.md §6, §9).
 */

/**
 * Kiểm thu hồi ở ba mức lồng nhau của `token_revocations` (§6.4).
 *
 * ⚠️ Append-only: mọi hàng là bằng chứng thu hồi còn hiệu lực — không có cột
 * "đã gỡ" nào để lọc, nên `SELECT ... LIMIT 1` đúng nghĩa là "đã từng bị thu hồi".
 *
 * ⚠️ `revoked_scopes` ở đây KHÔNG được suy diễn thành "thu hồi một phần ⇒ vẫn cấp
 * phần còn lại": một hàng thu hồi scope một phần kèm câu trả lời "vẫn cấp" là một
 * phép suy diễn chính sách không có gì ghim. Bất kỳ hàng nào khớp phạm vi đều trả
 * `revoked` — bảo thủ hơn, và chỉ có thể nới lỏng bằng một quyết định được kiểm.
 *
 * ⚠️ Một hàng chỉ có `token_hash` (subject_ref NULL, grant_id NULL) KHÔNG khớp câu
 * nào ở đây — nó không vô hiệu được việc cấp mới, chỉ có nghĩa khi tra theo hash
 * token cụ thể (introspection/verify). Đó là hình dạng hợp lệ của schema (0011);
 * nếu một runbook ghi mức token mà không có grant_id, hãy ghi kèm grant_id để
 * mức token thực sự chặn cả lần phát hành kế tiếp.
 */
export async function checkRevocationAtIssuance(
  client: PostgresClientLike,
  params: {
    readonly sub: string;
    readonly clientId: string;
    /** Grant đang dùng để cấp — bắt buộc để mức `token` (theo grant) có tác dụng. */
    readonly grantId?: string;
  },
): Promise<RevocationCheckResult> {
  const rows = await client.unsafe<{ id: string }>(
    `SELECT id FROM auth.token_revocations
      WHERE (level = 'subject' AND subject_ref = $1)
         OR (level = 'client' AND subject_ref = $1 AND client_id = $2)
         OR ($3::uuid IS NOT NULL AND level = 'token' AND grant_id = $3::uuid)
      LIMIT 1`,
    [params.sub, params.clientId, params.grantId ?? null],
  );
  return rows.length > 0 ? 'revoked' : 'not_revoked';
}

/**
 * Ghi MỘT hàng `token_revocations` level `client` — control plane thu hồi duy
 * nhất (FR-17a/§6.4).
 *
 * ⚠️ Shape CHECK của 0006 (`client_level_shape`) buộc `subject_ref` + `client_id`
 * cùng có mặt — caller truyền từ grant đã thu hồi, không từ request. `source`
 * `'auth'`: auth tự thực hiện thu hồi theo lệnh qua contract đã ký của account;
 * `'account_event'` dành cho event outbox, không phải đường này.
 */
export async function insertClientRevocation(
  tx: Queryable,
  params: {
    readonly subjectRef: string;
    readonly clientId: string;
    readonly grantId: string;
    readonly now: Date;
  },
): Promise<void> {
  await tx.unsafe(
    `INSERT INTO auth.token_revocations
       (level, subject_ref, client_id, grant_id, reason, source, revoked_at)
     VALUES ('client', $1, $2, $3::uuid, 'connected_application_revoked', 'auth', $4)`,
    [params.subjectRef, params.clientId, params.grantId, params.now],
  );
}
