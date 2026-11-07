import type { Queryable } from './postgres';

/**
 * Store audit của `db-auth` — bảng append-only `auth.authorization_audit_events`
 * (SR-010).
 *
 * ## Ranh giới
 *
 * Truy vấn này từng nằm trong `apps/auth/src/authorization-store.ts` — chỗ tạm
 * của app cho tới khi lib sở hữu nó (#343). Cùng bộ luật với các module anh em
 * (`authorization-code-cas`, `authorization-transaction-store`): câu SQL là
 * bản chép của quy ước trong migration (`0008`, `0009`), lệch tên cột chỉ lộ
 * ra khi chạy với schema thật.
 *
 * ## Parity test
 *
 * Bảng ở trên KHÔNG có parity spec colocated song song từng file migration;
 * hợp đồng ghi của nó được ghim bằng suite PostgreSQL thật app-owned
 * `apps/auth/tests/integrations/authorization-store.spec.ts` (+ các đường
 * handler qua `main.spec.ts`). Quyết định này giữ nguyên khi store dời về lib
 * — suite sở hữu database thuộc app, không thuộc lib (06-testing.md §6, §9).
 */

/**
 * Một hàng audit, allowlist cột của migration `0008`.
 *
 * ⚠️ KHÔNG BAO GIỜ đưa token, code, `code_verifier`, handle, secret hay
 * `account_session_ref` vào `details` — kể cả dạng hash (SR-002, invariant 20):
 * hash của handle trong audit biến audit thành nguồn đối chiếu cho kẻ đọc được
 * log. Allowlist đây là điểm enforce tầng ứng dụng; bảng enforce tầng DB bằng
 * CHECK `event_type` và thu quyền UPDATE/DELETE (0009).
 */
export interface AuditEventInput {
  /** Giá trị thuộc CHECK allowlist của `0008` — ngoài danh sách là lỗi DB, chủ ý. */
  readonly eventType: string;
  readonly subjectRef?: string;
  readonly clientId?: string;
  readonly authorizationTransactionId?: string;
  readonly authorizationCodeId?: string;
  readonly grantId?: string;
  readonly kid?: string;
  readonly outcome?: string;
  readonly errorCode?: string;
  readonly details?: Record<string, string | number | boolean | null>;
}

/**
 * INSERT một hàng audit.
 *
 * ⚠️ Đây là câu lệnh append thuần — không ON CONFLICT, không UPSERT: audit là
 * bằng chứng, hai hàng giống hệt nhau cho hai lần thử là ĐÚNG dữ liệu. Cột do
 * allowlist interface ghim; mọi giá trị đi qua bind parameter, không có chuỗi
 * request nào chạm SQL (cùng bộ luật với mọi hàm khác của module này).
 *
 * Nhận `Queryable` (không phải `PostgresClientLike`) để gọi được trong một
 * `client.begin(tx)` — audit của consent decide là CÙNG sự kiện với CAS nên
 * phải đi qua tx của nó.
 */
export async function insertAuditEvent(client: Queryable, event: AuditEventInput): Promise<void> {
  await client.unsafe(
    `INSERT INTO auth.authorization_audit_events
       (event_type, subject_ref, client_id, authorization_transaction_id,
        authorization_code_id, grant_id, kid, outcome, error_code, details)
     VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid, $7, $8, $9, $10::jsonb)`,
    [
      event.eventType,
      event.subjectRef ?? null,
      event.clientId ?? null,
      event.authorizationTransactionId ?? null,
      event.authorizationCodeId ?? null,
      event.grantId ?? null,
      event.kid ?? null,
      event.outcome ?? null,
      event.errorCode ?? null,
      event.details === undefined ? null : JSON.stringify(event.details),
    ],
  );
}
