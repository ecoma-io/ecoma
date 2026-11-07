/**
 * **Job reconciliation** (FR-022) — cơ chế (b), đọc D1 `push-job` và re-deliver envelope gốc
 * của việc đang kẹt.
 *
 * ⚠️ **Giới hạn phạm vi, không phải chi tiết hiện thực.** Cơ chế này chỉ phát hiện việc **đã có
 * job record**. Message **chưa từng** được consume không để lại job record nào, nên không thuộc
 * phạm vi này — nó thuộc cơ chế (c) logical delivery reconciliation của control plane, đọc D1
 * `push` và re-dispatch **cùng `delivery_id`**. Job reconciliation **không** giả lập việc phát
 * hiện nó, và một test "job reconciliation tìm thấy message chưa từng consume" là một test
 * đang khẳng định sai phạm vi.
 *
 * ⚠️ **Re-deliver là MỘT envelope bất biến của CÙNG `delivery_id`.** Port `QueueProducerPort`
 * nhận **nguyên envelope đã lưu**, không nhận `delivery_id` + `provider_id` + `transport` rời —
 * nên không có đường nào để đổi provider, đổi transport, đổi subscription hay tạo delivery
 * mới (FR-022: "quyền được cấp tường minh", và §23.2 "không reroute"). An toàn lặp lại đến từ
 * atomic claim của control plane: hai lần re-deliver cùng `delivery_id` thì chỉ một execution
 * thắng.
 *
 * ⚠️ **Không** ghi logical delivery state ở đây — kể cả khi sweep thất bại. Điều duy nhất được
 * ghi là: đã re-deliver (và vì sao). Một reconciliation sweep ghi vào delivery của control plane
 * là vi phạm ownership hai chiều của §11b.
 *
 * ⚠️ **Trigger là một quyết định CHƯA CHỐT.** Docs nêu "job reconciliation định kỳ" nhưng chưa
 * chốt lịch, và `scheduled()` là một cron trigger — Lead đã quyết định **cấm** trong phiên bản
 * này. Vì vậy entrypoint là hàm thuần {@link runJobReconciliation}, được composition root expose
 * tại `POST /internal/reconcile/jobs` sau khi xác thực; khi quyết định trigger chốt, chỉ cần
 * gọi hàm này, không phải viết lại logic.
 */

import type { JobStatePort } from './job-state-port';
import type { DeliveryLogFields, LoggerPort, MetricsPort } from './observability-port';
import type { PipelineClock, QueueProducerPort } from './ports';
import { deliveryCommandV1, validateDeliveryCommand } from '@ecoma-io/push-notification-contracts';

/** Dependency của {@link runJobReconciliation} — D1 + producer + clock + observability. */
export interface JobReconciliationDeps {
  readonly jobs: JobStatePort;
  readonly queue: QueueProducerPort;
  readonly clock: PipelineClock;
  readonly metrics: MetricsPort;
  readonly logger: LoggerPort;
}

/** Tham số sweep — chỉ những gì thực sự cần quyết định chạy sweep. */
export interface JobReconciliationOptions {
  /**
   * Ngưỡng "kẹt": job đã nhận mà `last_consumed_at` cũ hơn ngưỡng này thì được coi là kẹt.
   *
   * ⚠️ **Do caller truyền, không phải hằng trong lib.** Docs §9 liệt kê
   * `delivery_reconciliation_age` là operational gate **chưa chốt**; hằng ở đây sẽ biến một
   * quyết định vận hành thành một quyết định lập trình. Giá trị mặc định của composition root là
   * nơi duy nhất cần sửa khi operator chốt.
   */
  readonly stuckAfterMs: number;
  /** Trần số job re-deliver trong một sweep — giữ một lần sweep có thời gian hữu hạn. */
  readonly limit: number;
  /**
   * Trần attempt cho attempt budget của job reconciliation — job đã bị consume quá số lần
   * này thì bị coi là **đã kiệt** và không được re-deliver nữa (chống hồi sinh việc đã vào
   * DLQ / đã kiệt).
   *
   * ⚠️ **Giá trị placeholder/gate, chưa phải quyết định vận hành** — đúng văn phong của
   * `RECONCILE_STUCK_AFTER_MS`: `docs/architecture/03-operations.md` §10 liệt kê retry policy là
   * operational item chưa chốt, và `max_retries` của Cloudflare Queues còn mâu thuẫn nội bộ
   * (QU2). Vì vậy đây là hằng **đặt tên rõ** ở composition root, không phải con số "đúng"
   * của vận hành; khi operator chốt chỉ có hằng đó phải sửa. Ngân sách được áp **trong SQL
   * predicate** của `listStuck` (không lọc sau `LIMIT`) để không bỏ sót job kẹt thật.
   *
   * Tuỳ chọn: khi vắng mặt, không áp ngân sách (giữ tương thích với caller cũ) — nhưng job
   * reconciliation **bắt buộc** truyền giá trị này.
   */
  readonly maxAttempts?: number;
}

/** Kết quả một lần sweep — số đếm quan sát được từ D1 và producer. */
export interface JobReconciliationReport {
  /** Số job tìm thấy kẹt (đã lọc trong D1, không phải trong bộ nhớ). */
  readonly stuckFound: number;
  /** Số job đã re-deliver thành công. */
  readonly redelivered: number;
  /** Số job **không** re-deliver được — envelope hỏng, publish fail, hoặc producer lỗi. */
  readonly failed: number;
  /** Số job bị bỏ qua vì đã processed trong lúc sweep chạy (race với consumer). */
  readonly skippedProcessed: number;
  /** Số job bị bỏ qua vì đã kiệt ngân sách attempt (consume_count hoặc attempt cuối >= maxAttempts). */
  readonly skippedExhausted: number;
}

/**
 * Quét D1 `push-job`, re-deliver **chính xác** envelope gốc của mọi job kẹt.
 *
 * ⚠️ **Mỗi job độc lập**: một publish fail không làm dừng sweep, và một envelope hỏng không
 * làm mất các job còn lại. Đó là cùng nguyên tắc per-message của Queue, áp cho batch.
 *
 * ⚠️ **Không ACK, không claim, không ghi outcome** ở đây. Reconciliation chỉ *đưa message về
 * Queue*; mọi quyết định về delivery thuộc execution sẽ consume message đó.
 */
export async function runJobReconciliation(
  deps: JobReconciliationDeps,
  options: JobReconciliationOptions,
): Promise<JobReconciliationReport> {
  const nowMs = deps.clock.now();
  const stuck = await deps.jobs.listStuck({
    stuckAfterMs: options.stuckAfterMs,
    nowMs,
    maxAttempts: options.maxAttempts,
    limit: options.limit,
  });

  let redelivered = 0;
  let failed = 0;
  let skippedProcessed = 0;
  let skippedExhausted = 0;

  for (const job of stuck) {
    // Chống race: consumer có thể vừa đặt processed marker trong lúc sweep đọc danh sách.
    // Re-deliver một việc đã xong là tạo một message không có lý do, và message đó sẽ bị
    // skip ở consumer — tức lãng phí một lượt claim cho điều đã xong.
    const current = await deps.jobs.findByDeliveryId(job.deliveryId);
    if (current !== null && current.processed) {
      skippedProcessed += 1;
      continue;
    }

    // Attempt budget: job đã bị consume quá số lần cho phép thì **không** re-deliver —
    // đó là việc đã kiệt (đã vào DLQ hoặc đã retry hết), hồi sinh nó là đúng cái mà
    // reconciliation vs DLQ resurrection cấm. Job bị bỏ qua **không** được đánh dấu
    // `processed` (đó là state của control plane / processed marker của worker): đánh
    // dấu processed ở đây sẽ biến "bỏ qua vì hết ngân sách" thành một ACK mù của việc
    // chưa xong, và reconciliation sau này không còn cơ hội quan sát nó. Chỉ đếm + log
    // + metric để operator thấy, và để lại `processed = 0` cho control plane xử lý.
    const target = current ?? job;
    if (
      options.maxAttempts !== undefined &&
      (target.consumeCount >= options.maxAttempts ||
        (target.lastAttempt !== null && target.lastAttempt.attempt >= options.maxAttempts))
    ) {
      skippedExhausted += 1;
      deps.metrics.increment('deliveries_skipped', { reason: 'attempt_budget_exhausted' });
      deps.logger.log('warn', 'reconcile.attempt_budget_exhausted', {
        delivery_id: job.deliveryId,
        consume_count: target.consumeCount,
        last_attempt: target.lastAttempt === null ? 0 : target.lastAttempt.attempt,
        has_last_attempt: target.lastAttempt !== null,
        max_attempts: options.maxAttempts,
      });
      continue;
    }

    // Envelope đã lưu phải **qua lại** validator canonical trước khi publish: job state là
    // dữ liệu bền vững, và một hàng hỏng (do một migration, do một bug ghi) không được đẩy
    // thành một message mà consumer sẽ reject rồi đẩy vào DLQ. Reject ở đây nghĩa là log +
    // đếm `failed`, và sweep vẫn đi tiếp.
    const rebuilt = validateDeliveryCommand(job.envelope);
    if (!rebuilt.ok) {
      failed += 1;
      deps.metrics.increment('queue_consumer_errors');
      deps.logger.log('error', 'reconcile.stored_envelope_invalid', {
        delivery_id: job.deliveryId,
        reason: rebuilt.reason,
      });
      continue;
    }

    try {
      // ⚠️ `deliveryCommandV1` chạy lại validator canonical trên kết quả dựng: envelope lưu
      // trong D1 được **dựng lại** từ bảy field (thứ tự khoá JSON của D1 không mang ý nghĩa),
      // và builder là chỗ bảo đảm cái được publish **đúng** là envelope hợp lệ.
      await deps.queue.send(deliveryCommandV1(rebuilt.command));
      redelivered += 1;
      const fields: DeliveryLogFields = {
        delivery_id: job.deliveryId,
        notification_id: job.envelope.notification_id,
        provider_id: job.envelope.provider_id,
        consume_count: job.consumeCount,
        last_consumed_at: job.lastConsumedAt,
        age_ms: nowMs - job.lastConsumedAt,
      };
      deps.logger.log('info', 'reconcile.redelivered', fields);
    } catch {
      failed += 1;
      deps.metrics.increment('queue_consumer_errors');
      deps.logger.log('warn', 'reconcile.publish_failed', { delivery_id: job.deliveryId });
    }
  }

  if (redelivered > 0) {
    deps.metrics.increment('deliveries_retried', { job_reconciliation: true });
  }
  deps.logger.log('info', 'reconcile.sweep_completed', {
    stuck_found: stuck.length,
    redelivered,
    failed,
    skipped_processed: skippedProcessed,
    skipped_exhausted: skippedExhausted,
  });

  return { stuckFound: stuck.length, redelivered, failed, skippedProcessed, skippedExhausted };
}
