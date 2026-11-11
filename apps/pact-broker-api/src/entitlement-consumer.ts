/**
 * Queue consumer của `ecoma-staff-access-entitlement-events` — áp dụng event
 * entitlement vào membership Pact Broker (roadmap P3.2, issue #457).
 *
 * ⚠️ Chỉ có `queue` entrypoint: worker này có cả `fetch` (API) và `queue`
 * (consumer). `queue` nhận batch message từ Cloudflare Queues, mỗi message là
 * envelope `EntitlementEvent` đã được Staff Access-relay publish (P2.2).
 *
 * Mỗi message xử lý tuần tự: parse envelope → `shouldApplyEntitlementEvent`
 * (compare-and-drop theo revision) → nếu áp dụng được, tra cứu READ ONLY
 * tenant canonical `ecoma` (provision sẵn first_party bởi đường bootstrap;
 * serving path KHÔNG bao giờ tạo tenant) + upsert membership role `Member`
 * (sub = event.staff_id) → ghi revision đã áp dụng. Ném lỗi khi port vi phạm
 * hợp đồng (DB lỗi, tenant canonical thiếu/không active lúc grant) để Queue
 * retry theo `max_retries` + DLQ (không nuốt thành ack).
 *
 * ⚠️ Không log envelope đầy đủ — chỉ tổng kết một dòng JSON mỗi batch.
 */

import type { Pool } from 'pg';

import {
  provisionEntitlementMembership,
  type EntitlementSyncRepo,
  type MembershipRepo,
} from '@ecoma-io/pact-broker-api-application';
import {
  createPool,
  isConnectionTerminatedError,
  PgEntitlementSyncRepo,
  PgTenantRepo,
  PgAuditRepo,
} from '@ecoma-io/pact-broker-api-infrastructure';
import {
  validateEntitlementEvent,
  ENTITLEMENT_DELIVERY_DEADLINE_MS,
  ENTITLEMENT_FRESHNESS_FAIL_CLOSED_TOTAL_METRIC,
} from '@ecoma-io/staff-access-contracts';

/** Log một dòng JSON (pattern `writeLog` của auth-nonce-prune-job / relay). */
function writeLog(event: Record<string, unknown>): void {
  try {
    // oxlint-disable-next-line no-console
    console.log(JSON.stringify(event));
  } catch {
    // Cố tình im lặng — observability không được nằm trên serving path.
  }
}

/** Pool pg của Hyperdrive binding — cùng pattern relay/transactional-mailer-job. */
function createEntitlementPool(connectionString: string): Pool {
  const pool = createPool(connectionString);
  pool.on('error', (error: unknown) => {
    if (isConnectionTerminatedError(error)) {
      writeLog({ event: 'entitlement_consumer.db_pool.idle_client_error' });
    }
  });
  return pool;
}

/** Adapter repo Membership: delegate PgTenantRepo (tra cứu read-only + membership). */
function membershipRepoAdapter(pool: Pool): MembershipRepo {
  const tenantRepo = new PgTenantRepo(pool);
  return {
    getTenantByName: (name: string) => tenantRepo.getTenantByName(name),
    upsertMember: (tenantId: string, sub: string, role: string, provenance?) =>
      tenantRepo.upsertMember(tenantId, sub, role, provenance),
    markEntitlementRevoked: (tenantId: string, sub: string, eventId: string, revision: number) =>
      tenantRepo.markEntitlementRevoked(tenantId, sub, eventId, revision),
  };
}

/** Risk class của event entitlement theo ADR-0002/ADR-0014 — revoked là `high`, còn lại `normal`. */
function eventClassForEvent(event: { type: string }): 'high' | 'normal' {
  return event.type === 'entitlement.revoked' ? 'high' : 'normal';
}

/** Xử lý một message entitlement event — trả kết quả để caller quyết định ack/retry. */
async function handleMessage(
  message: { body: unknown; ack(): Promise<void>; retry(): Promise<void> },
  deps: { membership: MembershipRepo; sync: EntitlementSyncRepo },
): Promise<void> {
  // Parse envelope: không phải event hợp lệ là dữ liệu hỏng → ack (không retry
  // vì payload lỗi sẽ không bao giờ thành công), ghi log-level failure.
  // `message.body` có thể là object (runtime Cloudflare) hoặc string (đã
  // stringify). `validateEntitlementEvent` mong đợi object nên parse JSON
  // trước khi validate, nếu là string.
  let candidate: unknown = message.body;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      // Giữ nguyên chuỗi — validateEntitlementEvent sẽ trả invalid_payload.
    }
  }
  const parsed = validateEntitlementEvent(candidate);
  if (!parsed.ok) {
    writeLog({
      event: 'entitlement_consumer.invalid_payload',
      reason: parsed.reason,
      detail: parsed.detail,
    });
    // ⚠️ ack() có thể throw (runtime Cloudflare). Nếu throw, exception này
    // lan truyền lên `catch` của batch → message.retry() → payload lỗi (poison
    // pill) retry cũng không bao giờ thành công. Bóc ack: ack thất bại → ghi log
    // ack_failed, KHÔNG retry (runtime redelivery sẽ ack lại sau); ack thành
    // công → bỏ qua, không retry.
    try {
      await message.ack();
    } catch (ackError) {
      writeLog({
        event: 'entitlement_consumer.ack_failed',
        error: ackError instanceof Error ? ackError.message : String(ackError),
      });
    }
    return;
  }

  const event = parsed.payload;

  // Freshness bound (ADR-0014): state cũ hơn deadline của event class → fail-closed.
  // Producer đã drop event quá deadline; consumer vẫn tự bảo vệ: không áp dụng
  // state stale, ghi metric, ack (không retry — retry cũng không làm state mới hơn).
  const eventClass = eventClassForEvent(event);
  const deadlineMs = ENTITLEMENT_DELIVERY_DEADLINE_MS[eventClass];
  const occurredAtMs = Date.parse(event.occurred_at);
  const nowMs = Date.now();
  if (!Number.isFinite(occurredAtMs) || nowMs - occurredAtMs > deadlineMs) {
    writeLog({
      event: 'entitlement_consumer.freshness_fail_closed',
      metric: ENTITLEMENT_FRESHNESS_FAIL_CLOSED_TOTAL_METRIC,
      event_class: eventClass,
      event_id: event.event_id,
      revision: event.revision,
      age_ms: Number.isFinite(occurredAtMs) ? nowMs - occurredAtMs : null,
      deadline_ms: deadlineMs,
    });
    try {
      await message.ack();
    } catch (ackError) {
      writeLog({
        event: 'entitlement_consumer.ack_failed',
        error: ackError instanceof Error ? ackError.message : String(ackError),
      });
    }
    return;
  }

  const result = await provisionEntitlementMembership(event, deps);

  writeLog({
    event: 'entitlement_consumer.message',
    event_id: event.event_id,
    type: event.type,
    product: event.product,
    staff_id: event.staff_id,
    revision: event.revision,
    applied: result.applied,
    reason: result.reason,
  });

  // Event đã được xử lý (dù áp dụng hay bỏ qua duplicate/stale/not-product) → ack.
  // Chỉ ném khi port vi phạm hợp đồng (DB lỗi) để Queue retry.
  await message.ack();
}

/**
 * Handler queue của Cloudflare Queues — MỘT message mỗi lần, tuần tự (không
 * `Promise.all` trên batch): state entitlement là single-writer theo cặp
 * (staff_id, product) qua revision, song song là hai execution tranh cùng row.
 */
export async function entitlementQueueBatch(
  batch: {
    queue: string | undefined;
    messages: readonly {
      id: string;
      body: unknown;
      ack(): Promise<void>;
      retry(): Promise<void>;
    }[];
  },
  env: {
    ENTITLEMENT_EVENTS_QUEUE?: unknown;
    HYPERDRIVE?: { connectionString: string };
  },
): Promise<void> {
  void batch.queue; // tên queue đã được runtime đảm bảo khớp binding khai báo
  if (batch.messages.length === 0) return;

  const connectionString = env.HYPERDRIVE?.connectionString;
  if (typeof connectionString !== 'string' || connectionString === '') {
    throw new Error(
      'Hyperdrive binding HYPERDRIVE khong co connectionString; entitlement consumer fail-closed',
    );
  }

  const pool = createEntitlementPool(connectionString);
  try {
    const deps = {
      membership: membershipRepoAdapter(pool),
      sync: new PgEntitlementSyncRepo(pool),
      audit: new PgAuditRepo(pool),
    };

    // Tuần tự: mỗi message một lần xử lý, ack/retry có kiểm soát từng message.
    // Không throw giữa batch — một message lỗi không làm gián đoạn các message
    // còn lại (pattern transactional-mailer-job).
    for (const message of batch.messages) {
      try {
        await handleMessage(message, deps);
      } catch (error) {
        // ⚠️ Không nuốt lỗi im lặng: ghi log-level failure để operator có thể
        // điều tra. `retry()` có thể throw (runtime Cloudflare) — bọc thêm để
        // không lan truyền exception lên vòng lặp và làm gián đoạn các message
        // còn lại. Retry thất bại → message này sẽ được Queue retry theo
        // `max_retries` + DLQ.
        writeLog({
          event: 'entitlement_consumer.message_error',
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          await message.retry();
        } catch (retryError) {
          writeLog({
            event: 'entitlement_consumer.retry_failed',
            messageId: message.id,
            error: retryError instanceof Error ? retryError.message : String(retryError),
          });
        }
      }
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}
