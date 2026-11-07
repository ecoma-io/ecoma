import type { OutboxReconcileRepository } from './outbox-reconcile-repository';

export interface ReconciliationCycleDeps {
  readonly outbox: OutboxReconcileRepository;
  /** Tuổi tối đa của `published_at` trước khi row bị coi là stale (ms). */
  readonly staleAfterMs: number;
  /** Trần số row một lượt quét — phải là số nguyên dương và không vượt quá MAX_LIMIT. */
  readonly limit: number;
  /** Clock injection cho test — production dùng `Date.now()`. */
  readonly clock?: { now(): number };
  /**
   * Optional redrive callback (ADR-0014 settle evidence). Khi có, reconciler
   * redrive các row published nhưng chưa settle quá deadline. Khi không có,
   * giữ alert-only (backward compatible).
   */
  readonly redrive?: (eventId: string) => Promise<boolean>;
}

/** Trần số row tối đa một lượt quét — tránh quét toàn bảng outbox. */
export const MAX_RECONCILIATION_LIMIT = 10_000;

export interface ReconciliationCycleResult {
  readonly stalePublished: number;
  readonly limit: number;
  readonly staleAfterMs: number;
  /**
   * IDs của các outbox row đã publish nhưng còn stale — dùng để log/alert
   * điều tra (P2.4: alert-only, không redrive).
   *
   * ⚠️ **Logs/alerts only — KHÔNG bao giờ dùng làm metric label.** Đây là UUID
   * của từng row (high-cardinality): gắn vào metric label sẽ làm metric không
   * dùng được (ADR-0009 §11). Metric contract của delivery freshness
   * (`entitlement-delivery-metrics-contract.ts`) chỉ cho phép label
   * `event_class` — `staleEventIds` không phải là label, là payload để operator
   * truy vấn row cụ thể khi alert fired.
   */
  readonly staleEventIds: readonly string[];
  /** Số row đã redrive (chỉ khi có settle evidence + callback). */
  readonly redriven: number;
}

/**
 * Một lượt reconciliation: quét outbox đã publish quá ngưỡng, expose tín hiệu
 * điều tra (metric + log) — **không redrive** trong PR đầu.
 *
 * ⚠️ **Alert-only (issue #453).** Job này KHÔNG tự redrive nếu chưa có settle
 * path. Lý do: schema 0004 không có cột settle từ phía consumer — không có cách
 * biết row nào thực sự đã được consume, chỉ biết row đã được publish. Redrive
 * ngầm ở đây sẽ publish duplicate mà không có bằng chứng delivery thất bại thật.
 * Redrive vẫn là con đường vận hành đã có của relay (`replay(event_id)`, P2.2)
 * do operator gọi sau khi điều tra.
 *
 * ⚠️ **Ngưỡng `published_at` là proxy alert-only, không phải bằng chứng delivery
 * rớt.** Row cũ hơn ngưỡng có thể đã được consume bình thường — job chỉ phát
 * tín hiệu để điều tra, không kết luận. Khi cơ chế settle của ADR-0014 (cột
 * settle consumer-side) xuất hiện, thay proxy bằng điều kiện settle thật — đó
 * là PR sau, và khi đó mới có thể redrive có chọn lọc.
 *
 * ⚠️ **Không log payload body.** Kết quả chỉ mang `event_id`/`event_type`/tuổi
 * publish — envelope đã commit trong outbox là nguồn sự thật, không lọt ra log.
 *
 * ⚠️ **Không throw khi quét rỗng** — no-op thuần, cùng pattern relay.
 */
export async function runReconciliationCycle(
  deps: ReconciliationCycleDeps,
  nowMsOverride?: number,
): Promise<ReconciliationCycleResult> {
  const nowMs = nowMsOverride ?? deps.clock?.now() ?? Date.now();

  // ⚠️ `nowMs` phải là một số hữu hạn trước khi tính cutoff — NaN/Infinity sẽ
  // làm `new Date(nowMs)` thành Invalid Date và cutoff lan truyền vào SQL.
  if (!Number.isFinite(nowMs)) {
    throw new Error(`reconciliation cycle nowMs must be a finite number: ${nowMs}`);
  }

  // ⚠️ `limit` là tham số điều khiển số row quét — validate ở application layer
  // trước khi truyền xuống port. Trong PostgreSQL, `LIMIT -1` (hoặc giá trị
  // âm) có nghĩa là không giới hạn số row, nên nếu caller truyền limit ≤ 0,
  // job có thể quét toàn bộ outbox (hàng chục thousand row) mỗi lần — không
  // chỉ là performance issue mà còn là read amplification trên bảng outbox
  // lớn. Validate here (fail-fast) để infrastructure port không bao giờ nhận
  // được giá trị không hợp lệ; infra vẫn clamp defensively như lớp thứ hai.
  if (!Number.isInteger(deps.limit) || deps.limit < 1) {
    throw new Error(`reconciliation cycle limit must be a positive integer: ${deps.limit}`);
  }
  if (deps.limit > MAX_RECONCILIATION_LIMIT) {
    throw new Error(
      `reconciliation cycle limit must not exceed ${MAX_RECONCILIATION_LIMIT}: ${deps.limit}`,
    );
  }

  // ⚠️ `staleAfterMs` phải là số nguyên không âm — mirror infra layer để job
  // không bao giờ truyền giá trị sai xuống port. Trong PostgreSQL, cutoff =
  // now - staleAfterMs, và `staleAfterMs` âm sẽ pushes cutoff vào tương lai,
  // coi TẤT CẢ published row là stale (kể cả row vừa publish), làm job quét
  // toàn bộ outbox mỗi lần. Throw fail-closed (không silently clamp về 0).
  if (!Number.isInteger(deps.staleAfterMs) || deps.staleAfterMs < 0) {
    throw new Error(
      `reconciliation cycle staleAfterMs must be a non-negative integer: ${deps.staleAfterMs}`,
    );
  }

  const stale = await deps.outbox.listStalePublished({
    nowMs,
    staleAfterMs: deps.staleAfterMs,
    limit: deps.limit,
  });

  let redriven = 0;
  if (deps.redrive) {
    // Chỉ redrive row chưa settle (settled_at === null). listStalePublished đã
    // filter settled_at IS NULL ở infra; double-check ở đây để an toàn.
    // Redrive tuần tự (không Promise.all) để tránh thundering herd / rate-limit
    // khi nhiều event cùng redrive; mỗi redrive reset published_at + attempts.
    for (const row of stale) {
      if (row.settled_at !== null) continue;
      try {
        const ok = await deps.redrive(row.event_id);
        if (ok) redriven += 1;
      } catch (err) {
        // Best-effort: một event redrive fail không chặn các event còn lại
        // trong cùng batch; reconciler sẽ retry ở chu kỳ sau. Chỉ log event_id,
        // không log payload body (observability rule).
        // oxlint-disable-next-line no-console
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'redrive failed',
            event_id: row.event_id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        continue;
      }
    }
  }

  return {
    stalePublished: stale.length,
    limit: deps.limit,
    staleAfterMs: deps.staleAfterMs,
    staleEventIds: stale.map((row) => row.event_id),
    redriven,
  };
}
