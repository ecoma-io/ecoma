/**
 * Repository port của reconciliation job — ĐỌC outbox đã publish nhưng có dấu
 * hiệu delivery rớt (ADR-0014: outbox là nguồn sự thật; reconciliation bắt
 * delivery rớt).
 *
 * ⚠️ **ĐỌC-ONLY, alert-only.** Job này KHÔNG ghi gì vào outbox — không claim,
 * không tăng attempts, không reset published_at. Replay/redrive thuộc về con
 * đường vận hành đã có của relay (`replay(event_id)`, P2.2); trước khi có đường
 * settle từ phía consumer (ADR-0014 deadline model), việc job tự đụng state là
 * redrive ngầm — cấm trong PR đầu (issue #453: alert-only).
 *
 * ⚠️ Một service sở hữu một database: job đọc `db-staff-access` qua role
 * runtime với đúng grant SELECT đã cấp ở migration 0004 — không grant nào mới
 * cần thiết cho việc đọc.
 */

/** Một outbox row đã publish mà job đánh dấu là stale. */
export interface StalePublishedEvent {
  readonly event_id: string;
  readonly event_type: string;
  /** Thời điểm producer commit event (ISO 8601). */
  readonly occurred_at: string;
  /** Thời điểm relay publish (ISO 8601) — mốc đo của stale check. */
  readonly published_at: string;
  /** Số attempts relay đã dùng — chẩn đoán, không phải lệnh replay. */
  readonly attempts: number;
  /** Token lỗi cuối của relay (nếu có) — chuỗi đã được sanitize ở infrastructure.
   *
   * ⚠️ **Hợp đồng bắt buộc (hard contract).** `last_error` phải là một chuỗi
   * đã được sanitize: không raw SQL, không stack trace, không ký tự điều khiển,
   * không vượt quá độ dài tối đa. Việc enforce và verify invariant này là
   * trách nhiệm của infrastructure (`postgres-outbox-reconcile-repository.ts`,
   * hàm `sanitizeRelayError`) — adapter throw fail-closed nếu row vi phạm, nó
   * KHÔNG bao giờ trả raw error qua port. Application layer không enforce và
   * không verify: port này chỉ expose giá trị đã được infrastructure trả về.
   * Nếu infrastructure vi phạm hợp đồng, job fail — không rò rỉ raw error vào
   * diagnostics. Đây là ranh giới đã biết: job này alert-only, không redrive,
   * không log body — `last_error` chỉ để chẩn đoán, không phải lệnh replay.
   */
  readonly last_error: string | null;
  /** Consumer-side settlement timestamp (ISO 8601) — null = not settled. */
  readonly settled_at: string | null;
}

/** Input của một lượt quét stale published. */
export interface ListStalePublishedInput {
  /** Mốc thời gian hiện tại (epoch ms) — inject để test. */
  readonly nowMs: number;
  /** Tuổi tối đa của `published_at` trước khi row bị coi là stale (ms). */
  readonly staleAfterMs: number;
  /** Trần số row một lượt quét — phải là số nguyên dương.
   *
   * ⚠️ Trong PostgreSQL, `LIMIT -1` (hoặc giá trị âm) có nghĩa là không giới hạn
   * số row — caller truyền `limit ≤ 0` sẽ làm job quét toàn bộ outbox mỗi lần.
   * `runReconciliationCycle` validate `limit ≥ 1` trước khi truyền xuống port
   * (fail-fast ở application layer); infrastructure port vẫn clamp defensively
   * như lớp thứ hai.
   */
  readonly limit: number;
}

export interface OutboxReconcileRepository {
  /**
   * Liệt kê outbox row đã publish mà `published_at` cũ hơn ngưỡng — dấu hiệu
   * delivery rớt sau khi relay đã giao cho Queue (ADR-0014).
   *
   * ⚠️ Không có xác nhận settle từ phía consumer trong schema 0004 — cột settle
   * chưa tồn tại (cơ chế settle do ADR-0014 deadline model định nghĩa, thiết kế
   * chi tiết là PR sau). Ngưỡng tuổi `published_at` là **proxy alert-only**:
   * row cũ hơn ngưỡng có thể đã được consume bình thường (không có bằng chứng
   * ngược lại), nên kết quả là tín hiệu điều tra, không phải kết luận delivery
   * thất bại. Giả định này được ghi ở `runReconciliationCycle`.
   */
  listStalePublished(input: ListStalePublishedInput): Promise<readonly StalePublishedEvent[]>;
}
