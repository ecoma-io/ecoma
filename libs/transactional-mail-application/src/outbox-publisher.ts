import { MAIL_COMMAND_VERSION } from '@ecoma-io/transactional-mail-contracts';

import type { MailMessageRepository } from './mail-message-repository';
import type { MailOutboxRepository } from './mail-outbox-repository';
import type { MailOutboxRecord } from './records';

/**
 * Publish loop của control plane — `03-operations.md` §5.1.
 *
 * Chạy trong scheduled handler của chính `transactional-mail` (pha 1 của bốn pha —
 * `src/main.ts` của app; `triggers.crons` đã khai trong `wrangler.jsonc`). Lần deploy đầu
 * chưa chạy được vì chưa provisioning D1/Queue và app nằm ngoài deploy matrix — việc "đã
 * xác minh trên runtime" là gate vận hành, không phải việc của module này.
 */

/**
 * Command `mail.send` — **đúng hai field**, không thêm gì.
 *
 * ⚠️ Đây là *canonical contract* của `@ecoma-io/transactional-mail-contracts`, và type ở
 * đây được khai lại **cố ý** chứ không import: `MailSendCommand.version` là
 * `typeof MAIL_COMMAND_VERSION` (`1 as const`) nên một object literal `{ version: 1, … }`
 * gán vào đó không hợp lệ — tức là khai lại ở đây là cách duy nhất để publisher dựng
 * command mà vẫn compile được khi version được bump. Import `MAIL_COMMAND_VERSION` để
 * `version` vẫn bám hằng số đó; xem `buildMailCommand`.
 */
export interface MailSendCommandPayload {
  readonly version: 1;
  readonly delivery_id: string;
}

/** Dependency của {@link publishOutboxBatch} — xem từng field để biết ai sở hữu phần nào. */
export type MailOutboxPublisherDeps = {
  /** Đường ghi duy nhất ra `mail_outbox`. */
  readonly outbox: MailOutboxRepository;
  /**
   * **Chỉ** dùng `findByDeliveryId` — một lần đọc trong nhánh `messageQueued = false` để
   * phân biệt "message đã terminal" (hợp lệ) với "generation của message đã đổi" (bất
   * thường, alert `outbox-publish-stale-generation`).
   *
   * `mail.send` mang **đúng hai field**, nên publisher không cần message để dựng payload —
   * `QUEUE.send()` chỉ cần `delivery_id`. Field này được giữ lại cho việc phân biệt nói trên
   * và để composition root dựng deps một chỗ; xem ghi chú bên {@link queueSend}.
   */
  readonly messages: MailMessageRepository;
  /**
   * Gửi command vào Queue — **ngoài** transaction D1.
   *
   * ⚠️ `QUEUE.send()` là network call, nên nó **không** được nằm trong `db.batch()`
   * (`01-architecture.md` §6.2): claim phải commit trước, rồi mới send. Đó là lý do
   * claim → send → `markPublished` là ba bước tuần tự chứ không phải một transaction.
   *
   * Failure = **throw**; caller bắt và chuyển thành `recordPublishFailure`. Không có
   * "trả false rồi bỏ qua" — bỏ qua âm thầm là mất delivery intent trong im lặng.
   *
   * Implementation (composition root) bọc `QUEUE.send` và **serialize payload thành string
   * đúng một lần** (`JSON.stringify`): consumer yêu cầu string body và tự parse
   * (`03-operations.md` §4, `transactional-mailer-job/03-operations.md`).
   */
  readonly queueSend: (command: MailSendCommandPayload) => Promise<void>;
  /**
   * Sinh **token fencing mới cho mỗi lần claim**.
   *
   * Token này đi vào `claimed_by` và là điều kiện của `markPublished` /
   * `recordPublishFailure`. Mỗi lần claim một token mới là điều kiện để một lease holder
   * cũ (đã bị reclaim) **không** động được vào state: `claimed_by` đã đổi nên predicate
   * của mọi lệnh guarded của nó sai và nó nhận `null` / `outboxPublished = false`.
   *
   * Vì sao không dùng một token cố định theo isolate: hai lần claim của cùng một Worker
   * (hoặc hai isolate cùng token) sẽ không phân biệt được "lease này còn của tôi" với "lease
   * này đã bị người khác lấy" — fencing mất tác dụng.
   */
  readonly generateLeaseOwner: () => string;
  /**
   * Nơi phát alert — inject để test quan sát được, composition root wire `console`.
   *
   * ⚠️ Chỉ truyền **token đã sanitize**. Xem {@link MailOutboxAlert}.
   */
  readonly logAlert: (event: MailOutboxAlert) => void;
};

/**
 * Alert của publish loop.
 *
 * ⚠️ Không field nào ở đây mang recipient, subject/body render hay raw error: `deliveryId` là
 * định danh logical delivery đã được whitelist trong `03-operations.md` §6, và `event` là
 * hằng cố định. Không có field "message" của lỗi vì message của `QUEUE.send()` có thể chứa
 * tên Queue, endpoint hay credential.
 */
export type MailOutboxAlert =
  | { readonly event: 'outbox-publish-failed-attempts-exhausted'; readonly deliveryId: string }
  | { readonly event: 'outbox-publish-lease-lost'; readonly deliveryId: string }
  | { readonly event: 'outbox-publish-stale-generation'; readonly deliveryId: string };

/**
 * Ngưỡng vận hành của một lần publish — **giá trị truyền vào**, không hằng trong module.
 *
 * `maxPublishAttempts`, `leaseMs` và `backoffBaseMs` cùng nhóm với `maxRecoveryCycles`:
 * đổi chúng là đổi config lúc deploy, không phải migration (cùng lý lẽ với `limit` của
 * rate limit).
 */
export type PublishOutboxBatchConfig = {
  /** Thời hạn lease của một lần claim. Hết hạn thì lần claim sau reclaim được. */
  readonly leaseMs: number;
  /** Số row tối đa một lần claim. */
  readonly batchLimit: number;
  /** Ngưỡng chu kỳ publish — chạm ngưỡng thì row sang `failed`. */
  readonly maxPublishAttempts: number;
  /** Gốc của backoff lũy thừa (xem {@link backoffDelayMs}). */
  readonly backoffBaseMs: number;
  /** Epoch ms — mốc của claim, `available_at` sau backoff và `updated_at`. */
  readonly nowMs: number;
};

/** Tổng kết quả một lần chạy publish loop. */
export type PublishOutboxBatchResult = {
  /** Số row claim được (kể cả row `publishing` bị reclaim). */
  readonly claimed: number;
  /** Số row đã đóng outbox bằng `markPublished`. */
  readonly published: number;
  /** Số row đã sang `failed` vì chạm `maxPublishAttempts`. */
  readonly failed: number;
  /**
   * Số lần publish mất lease (hoặc mất generation) trước khi ghi được kết quả.
   *
   * Đây **không phải** lỗi của lần publish: `QUEUE.send()` có thể đã thành công và chỉ
   * phần ghi D1 mới hỏng. Đếm riêng vì nó là tín hiệu vận hành khác hẳn `failed` — row vẫn
   * còn nguyên delivery intent và lần claim sau sẽ xử lý lại.
   */
  readonly leaseLost: number;
};

/**
 * Trần số mũ của backoff.
 *
 * `2 ** 16` ≈ 65 536 lần `backoffBaseMs`. Trần này tồn tại vì lý do toán học, không phải vì
 * ngưỡng vận hành: một `publishAttempts` không bị chặn trên (cột là `INTEGER >= 0` không
 * có trần) sẽ biến `2 ** attempts` thành `Infinity`, rồi `nowMs + Infinity` thành
 * `Infinity` — một `available_at` vô hạn khiến row **không bao giờ** được claim lại, tức
 * im lặng giữ một delivery intent vô thời hạn. Trần là biên an toàn của phép tính, còn
 * `maxPublishAttempts` mới là ngưỡng chốt ở deploy.
 */
const BACKOFF_EXPONENT_CAP = 16;

/**
 * Độ trễ trước lần thử publish kế tiếp: `backoffBaseMs * 2 ** min(publishAttempts, 16)`.
 *
 * `publishAttempts` là bộ đếm của record **lúc claim** (tức trước lần thử vừa thất bại),
 * nên lần thất bại đầu tiên (attempts = 0) nhận đúng `backoffBaseMs`, lần sau gấp đôi.
 *
 * Trả về **khoảng cách** (không phải mốc tuyệt đối) và luôn `>= 1`: `available_at` phải
 * luôn ở tương lai so với `nowMs` của lần ghi, nếu không row quay lại `pending` với
 * `available_at <= nowMs` sẽ bị claim lại ngay ở lần sau và backoff trở thành vô nghĩa.
 */
export function backoffDelayMs(backoffBaseMs: number, publishAttempts: number): number {
  const exponent = Math.min(Math.max(Math.trunc(publishAttempts), 0), BACKOFF_EXPONENT_CAP);
  return Math.max(1, Math.trunc(backoffBaseMs * 2 ** exponent));
}

/**
 * Rút lỗi thành **một token đã sanitize** để ghi vào `mail_outbox.last_error`.
 *
 * ⚠️ Không bao giờ ghi nguyên văn `error.message`: message của một lỗi Queue có thể chứa
 * tên binding, endpoint, tên Queue hay đoạn credential (`NFR-001`). Cột `last_error` không
 * có CHECK nào chặn nội dung — nghĩa là sanitize là việc **của caller này**, và port
 * `recordPublishFailure` nói rõ điều đó.
 *
 * Chỉ giữ `error.name` khi nó là một **identifier hợp lệ** (chữ/số/gạch dưới/gạch nối, không
 * rỗng, không quá dài). Mọi thứ khác — bao gồm cả một `name` do dữ liệu nhạy cảm dựng ra —
 * rơi về hằng `'queue-send-failed'`. Hằng này là thứ **duy nhất** được ghi khi không xác
 * định được class lỗi, và nó không chứa dữ liệu nào của caller.
 */
export function sanitizePublishErrorToken(error: unknown): string {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  if (typeof name === 'string' && /^[A-Za-z0-9_]{1,64}$/u.test(name)) {
    return name;
  }
  return 'queue-send-failed';
}

/**
 * Chạy **một** lô của publish loop: claim → send → ghi kết quả, tuần tự từng row.
 *
 * Không có retry trong vòng lặp: một row thất bại đã được `recordPublishFailure` đẩy ra
 * sau backoff và sẽ được claim lại ở một lần chạy sau. Retry ngay trong cùng lô vừa tốn thời
 * gian của invocation vừa phá backoff — tức phá luôn cơ chế giới hạn tần suất mà
 * `maxPublishAttempts` dựa vào.
 *
 * Không có trạng thái nào giữ giữa các lần gọi: mỗi lần chạy là idempotent và có thể bị
 * kill giữa chừng mà không mất gì (lần chạy sau reclaim lease).
 */
export async function publishOutboxBatch(
  deps: MailOutboxPublisherDeps,
  config: PublishOutboxBatchConfig,
): Promise<PublishOutboxBatchResult> {
  // Một token fencing cho **cả** lô: claim là một statement, nên mọi row trong lô đều
  // cùng `claimed_by`. Token mới cho từng row vẫn đúng fencing (mỗi row là một lease riêng),
  // nhưng một token cho cả lô đơn giản hơn và không mất tính chất nào — hai lần claim
  // khác nhau vẫn khác token.
  const leaseOwner = deps.generateLeaseOwner();

  const claimedRows = await deps.outbox.claim({
    nowMs: config.nowMs,
    leaseDurationMs: config.leaseMs,
    leaseOwner,
    limit: config.batchLimit,
  });

  let published = 0;
  let failed = 0;
  let leaseLost = 0;

  for (const record of claimedRows) {
    const outcome = await publishOne(deps, config, record, leaseOwner);
    if (outcome === 'published') {
      published += 1;
    } else if (outcome === 'failed') {
      failed += 1;
    } else if (outcome === 'lease-lost') {
      leaseLost += 1;
    }
    // `retrying` cố ý không vào counter nào: row đã được ghi về `pending` với backoff, và
    // số row đó suy ra được từ `claimed - published - failed - leaseLost`.
  }

  return { claimed: claimedRows.length, published, failed, leaseLost };
}

/**
 * Kết cục của một row trong lô — nội bộ {@link publishOutboxBatch}.
 *
 * `retrying` là nhánh thất bại **chưa** kiệt `maxPublishAttempts`: nó không phải
 * `published` (không có gì được publish thành công) và cũng không phải `failed` (row chưa
 * bị loại khỏi chu kỳ). Gộp nó vào `published` sẽ làm metric đo sai, còn gộp vào `failed`
 * sẽ báo Page oang oang cho một row mà lần chạy sau vẫn xử lý được.
 */
type RowOutcome = 'published' | 'retrying' | 'failed' | 'lease-lost';

/**
 * Một row của lô: `QUEUE.send()` rồi ghi kết quả — không retry, không ghi trạng thái message
 * ngoài `markPublished`.
 */
async function publishOne(
  deps: MailOutboxPublisherDeps,
  config: PublishOutboxBatchConfig,
  record: MailOutboxRecord,
  leaseOwner: string,
): Promise<RowOutcome> {
  try {
    await deps.queueSend(buildMailCommand(record.deliveryId));
  } catch (error) {
    return recordFailure(deps, config, record, leaseOwner, sanitizePublishErrorToken(error));
  }

  // `QUEUE.send()` đã trả về: **phải** ghi sự thật đó vào outbox, kể cả khi message đã
  // terminal (khi đó `messageQueued = false` là hợp lệ, không phải lỗi).
  const marked = await deps.outbox.markPublished({
    outboxId: record.id,
    deliveryId: record.deliveryId,
    leaseOwner,
    dispatchGeneration: record.dispatchGeneration,
    nowMs: config.nowMs,
  });

  if (!marked.outboxPublished) {
    // Lease đã mất: **không có gì được ghi**. Không thử lại trong lô này — lần claim sau sẽ
    // xử lý, và `QUEUE.send()` đã thành công nên duplicate command là an toàn (§5.2).
    deps.logAlert({ event: 'outbox-publish-lease-lost', deliveryId: record.deliveryId });
    return 'lease-lost';
  }

  if (!marked.messageQueued) {
    // `false` có **hai** nguyên nhân mà contract của `markPublished` gộp lại: message đã
    // terminal (hợp lệ — Queue `send()` đã thành công nên outbox phải ghi sự thật đó), hoặc
    // generation của message không còn khớp (bất thường — redrive đã đổi generation nhưng
    // publisher này vẫn claim row ở generation cũ). Đọc lại để phân biệt: một query chỉ-đọc
    // là giá rẻ cho việc phát hiện publisher đang đóng outbox ở generation cũ — đúng cảnh
    // báo mà đường redrive có authorize cần khi nó tồn tại (§6.5).
    const message = await deps.messages.findByDeliveryId(record.deliveryId);
    if (message !== null && message.dispatchGeneration !== record.dispatchGeneration) {
      deps.logAlert({
        event: 'outbox-publish-stale-generation',
        deliveryId: record.deliveryId,
      });
    }
  }

  return 'published';
}

/**
 * Ghi thất bại của một row rồi phân loại kết quả.
 *
 * `nextAvailableAtMs` tính từ `publishAttempts` của record **lúc claim**, nên backoff lần
 * thất bại đầu tiên là `backoffBaseMs` và mỗi lần sau gấp đôi (xem {@link backoffDelayMs}).
 */
async function recordFailure(
  deps: MailOutboxPublisherDeps,
  config: PublishOutboxBatchConfig,
  record: MailOutboxRecord,
  leaseOwner: string,
  sanitizedToken: string,
): Promise<RowOutcome> {
  const updated = await deps.outbox.recordPublishFailure({
    outboxId: record.id,
    deliveryId: record.deliveryId,
    leaseOwner,
    dispatchGeneration: record.dispatchGeneration,
    lastError: sanitizedToken,
    nextAvailableAtMs: config.nowMs + backoffDelayMs(config.backoffBaseMs, record.publishAttempts),
    maxPublishAttempts: config.maxPublishAttempts,
    nowMs: config.nowMs,
  });

  // `null` = lease mất (hoặc generation lệch): không có gì được ghi, nên lần thất bại này
  // không được ghi nhận là `failed` — row vẫn ở trạng thái của chủ lease trước đó.
  if (updated === null) {
    deps.logAlert({ event: 'outbox-publish-lease-lost', deliveryId: record.deliveryId });
    return 'lease-lost';
  }

  if (updated.status === 'failed') {
    deps.logAlert({
      event: 'outbox-publish-failed-attempts-exhausted',
      deliveryId: record.deliveryId,
    });
    return 'failed';
  }

  return 'retrying';
}

/**
 * Dựng command `mail.send` — **đúng hai field** (`01-architecture.md` §5).
 *
 * `version` lấy từ hằng `MAIL_COMMAND_VERSION` của contracts nên bump version ở đó được
 * phản ánh ngay ở đây, thay vì một literal `1` rơi rác trong application layer.
 *
 * ⚠️ Command là **wake-up signal, không phải authorization token**: `dispatch_generation`
 * cố ý **không** có mặt ở đây. Worker tự tra generation hiện tại qua private interface và
 * tự chịu fencing.
 */
function buildMailCommand(deliveryId: string): MailSendCommandPayload {
  return { version: MAIL_COMMAND_VERSION, delivery_id: deliveryId };
}
