import type { MailOutboxRepository } from './mail-outbox-repository';
import type { MailMessageRepository } from './mail-message-repository';

/**
 * Reconciler của control plane — `03-operations.md` §5.3.
 *
 * ⚠️ Reconciler chạy trong scheduled handler của chính `transactional-mail` (publish →
 * reconciler → nonce prune → retention; `wrangler.jsonc` `triggers.crons`). Lần deploy đầu
 * chưa chạy được vì chưa provisioning D1/Queue và app nằm ngoài deploy matrix — thuật toán
 * ở đây đã được wiring đầy đủ ở composition root, việc "đã xác minh trên runtime" là gate
 * vận hành, không phải việc của module này.
 *
 * ⚠️ Ba ranh giới định nghĩa, mỗi cái một invariant, và cả ba đều là lý do các nhánh bên
 * dưới trông "thiếu việc":
 *
 * 1. **Không bao giờ chạm outbox `failed`.** Nguồn guard của reconciler là
 *    `pending`/`publishing`/`published`; `failed` chỉ được mở lại bởi repair **có
 *    authorize** (`03-operations.md` §5.4), và caller/permission của repair **chưa chốt**
 *    (`01-architecture.md` §10). Tự reset row `failed` ở đây sẽ lách qua cổng authorize đó.
 *    Vì vậy nhánh `failed` chỉ **phát hiện và alert** — và adapter cũng phải loại `failed`
 *    khỏi nguồn của chính SQL nó chạy (lưới cuối cùng chống race giữa lúc đọc và lúc batch).
 * 2. **Cùng generation.** Reconciler re-dispatch **không** bump `dispatch_generation`; chỉ
 *    redrive có authorize làm điều đó (`01-architecture.md` §6.5, invariant 14). Nó tái
 *    dùng generation hiện tại nên worker vẫn fencing đúng.
 * 3. **Tiêu ngân sách A.** Mỗi lần re-dispatch tăng `recovery_cycle_count` và bị chặn ở
 *    `maxRecoveryCycles`; đường tự động dừng hẳn khi hết ngân sách, không tự nới bound.
 */

/** Kết quả một lần re-dispatch do adapter của composition root thực hiện. */
export type RedispatchMailOutboxResult =
  /** Đã re-dispatch thành công — `recoveryCycleCount` là bộ đếm **sau** khi tăng. */
  | { readonly kind: 'redispatched'; readonly recoveryCycleCount: number }
  /**
   * Ngân sách A đã cạn (`recovery_cycle_count >= maxRecoveryCycles`), hoặc row không còn ở
   * nguồn guard khi statement chạy. Hai nguyên nhân này **không phân biệt được** từ kết quả
   * một statement, và việc phân biệt là việc của operator đọc alert.
   */
  | { readonly kind: 'budget-exhausted' }
  /** Message không còn ở nguồn `accepted`/`queued` — có ai đó đã xử lý nó trước. */
  | { readonly kind: 'not-eligible' };

/** Dependency của {@link runOutboxReconciler}. */
export type MailOutboxReconcilerDeps = {
  /**
   * Chỉ những method reconciler thật sự gọi — `renewLease` có mặt vì guard của re-dispatch
   * là conditional update + lease (`03-operations.md` §5.3), và adapter có thể dùng nó để
   * giành quyền trước khi mở một chu kỳ recovery.
   */
  readonly outbox: Pick<
    MailOutboxRepository,
    'findByDeliveryId' | 'claim' | 'renewLease' | 'markPublished' | 'recordPublishFailure'
  >;
  /** Chỉ `findByDeliveryId` — đủ để biết message đang ở trạng thái nào. */
  readonly messages: Pick<MailMessageRepository, 'findByDeliveryId'>;
  /**
   * Re-dispatch một delivery — **callback do composition root cung cấp**, không phải port
   * trong file này.
   *
   * ⚠️ Vì sao là callback mà không phải method của `MailOutboxRepository`: re-dispatch phải
   * đổi **cả hai bảng** trong **một** `db.batch()` (`recovery_cycle_count++` cùng reset outbox
   * row — `01-architecture.md` §6.5 hàng 5), và application layer không được chạm D1. Một
   * port repository không diễn đạt được "một transaction hai bảng" mà vẫn giữ ranh giới này,
   * nên seam được đặt ở composition root — nơi duy nhất biết `D1SubsetDatabase`.
   *
   * **Hợp đồng mà adapter phải giữ** (adapter do composition root viết, dùng
   * `D1SubsetDatabase.batch()`):
   *
   * 1. `UPDATE mail_outbox SET status = 'pending', publish_attempts = 0, available_at = ?,
   *    claimed_at = NULL, claimed_by = NULL, published_at = NULL, last_error = NULL,
   *    dispatch_generation = (SELECT dispatch_generation FROM mail_messages WHERE delivery_id = ?),
   *    updated_at = ? WHERE delivery_id = ? AND status IN ('pending','publishing','published')
   *    AND (claimed_at IS NULL OR claimed_at <= ?) AND EXISTS (message còn ở nguồn
   *    'accepted'/'queued' với recovery_cycle_count < maxRecoveryCycles)`
   * 2. `UPDATE mail_messages SET recovery_cycle_count = recovery_cycle_count + 1,
   *    status = 'queued', updated_at = ? WHERE delivery_id = ? AND status IN
   *    ('accepted','queued') AND recovery_cycle_count < ? AND EXISTS (outbox row vừa bị
   *    statement 1 reset: status = 'pending' AND claimed_at IS NULL)
   *    RETURNING recovery_cycle_count`
   *    → 0 hàng trả về thì kết quả là `budget-exhausted`.
   *
   * Hai statement chạy **trong cùng một batch** (một implicit transaction của D1) và guard
   * của chúng **đối xứng** — mỗi cái kiểm điều kiện của bảng kia qua `EXISTS`. Tách thành hai
   * lần commit là cửa sổ crash (message tăng ngân sách A mà outbox còn `published` — delivery
   * kẹt vĩnh viễn vì A chỉ tăng); bỏ guard lease là giành quyền với publisher đang sống và mở
   * recovery loop publisher ↔ reconciler (§5.3). `dispatch_generation` **không** bị bump ở
   * bất kỳ statement nào — bump generation là đặc quyền của redrive có authorize
   * (`01-architecture.md` §6.5, invariant 14).
   */
  readonly redispatch: (deliveryId: string, nowMs: number) => Promise<RedispatchMailOutboxResult>;
  /**
   * Nơi phát alert — inject để test quan sát được, composition root wire `console`.
   *
   * ⚠️ Chỉ mang `deliveryId` (đã whitelist ở `03-operations.md` §6) và tên event hằng cố
   * định. Không subject/body/recipient/raw error.
   */
  readonly logAlert: (event: MailReconcilerAlert) => void;
  /**
   * Quét một lô message có thể re-dispatch — **callback do composition root cung cấp**.
   *
   * ⚠️ Vì sao không dùng `listStaleNonTerminalMessages`: port đó **gồm cả `blocked`**, mà
   * `blocked` tuyệt đối không được re-dispatch tự động (`03-operations.md` §5.3: "alert Page
   * trước, không tự re-enqueue theo vòng"; redrive là thao tác có authorize mà caller/permission
   * còn **chưa chốt**). Quét bằng port đó rồi lọc ở application layer sẽ kéo `blocked` vào mọi
   * lần quét — tức phụ thuộc vào một danh sách rộng hơn điều kiện thật, và ngày nào đó ai đó
   * "tối ưu" bằng cách bỏ vế lọc thì `blocked` được re-dispatch âm thầm.
   *
   * **Câu mà adapter phải dùng**: `SELECT id, delivery_id FROM mail_messages
   * WHERE status IN ('accepted','queued') AND updated_at < ? ORDER BY updated_at, id LIMIT ?`
   * — index `mail_messages_status_updated_idx (status, updated_at)` phục vụ đúng câu này.
   */
  readonly listDispatchIncomplete: (input: {
    readonly updatedBeforeMs: number;
    readonly limit: number;
  }) => Promise<readonly { readonly messageId: string; readonly deliveryId: string }[]>;
};

/**
 * Alert của reconciler.
 *
 * ⚠️ `reconciler-outbox-failed-repair-required` là tín hiệu **duy nhất** cho một row `failed`:
 * nó đi qua đường repair có authorize mà caller/permission chưa chốt, nên hành động đúng là
 * alert để operator vào xử lý, không phải tự reset.
 */
export type MailReconcilerAlert =
  | { readonly event: 'reconciler-dispatch-incomplete'; readonly deliveryId: string }
  | { readonly event: 'reconciler-budget-exhausted'; readonly deliveryId: string }
  | {
      readonly event: 'reconciler-outbox-failed-repair-required';
      readonly deliveryId: string;
    };

/**
 * Ngưỡng của một lần quét reconciler.
 *
 * ⚠️ `recoveryBudgetLimit?: never` là **cố ý**: ngân sách A là một quyết định vận hành của
 * composition root, và port này **không** nhận nó. Lý do là thuộc tính của guard, không phải
 * tham số của vòng quét — ngưỡng nằm trong `WHERE` của statement mà adapter viết
 * (`recovery_cycle_count < maxRecoveryCycles`), truyền vào đây sẽ tạo cảm giác sai rằng
 * reconciler tự quyết ngân sách. Adapter đọc `maxRecoveryCycles` từ env của nó.
 */
export type RunOutboxReconcilerConfig = {
  /** Tuổi tối đa của một delivery `accepted`/`queued` trước khi được coi là kẹt. */
  readonly maxAgeMs: number;
  /** Số candidate tối đa một lần quét. */
  readonly batchLimit: number;
  /** Epoch ms — mốc so với `updated_at` và mốc truyền cho adapter. */
  readonly nowMs: number;
  /** Độ dài lease mà adapter dùng cho lần re-dispatch. */
  readonly leaseMs: number;
  /** Ngưỡng chu kỳ publish của chu kỳ publish mà re-dispatch vừa mở lại. */
  readonly maxPublishAttempts: number;
  /** Gốc backoff của lần publish sau re-dispatch. */
  readonly backoffBaseMs: number;
  /** Ngân sách A **không** đi qua đây — xem JSDoc của type. */
  readonly recoveryBudgetLimit?: never;
};

/** Tổng kết quả một lần chạy reconciler. */
export type RunOutboxReconcilerResult = {
  /** Số candidate đã đọc. */
  readonly scanned: number;
  /** Số candidate thực sự được re-dispatch. */
  readonly redispatched: number;
  /**
   * Số candidate bị **bỏ qua có chủ đích** — gồm cả những cái đang chờ publisher, những cái
   * cần repair có authorize, và những cái hết ngân sách A.
   *
   * Không phải lỗi: phần lớn candidate ở trạng thái bình thường thuộc nhóm này.
   */
  readonly skipped: number;
};

/**
 * Chạy **một** lần quét reconciler, tuần tự từng candidate.
 *
 * Tuần tự (không `Promise.all`) là **có chủ ý**: adapter re-dispatch là một `db.batch()`
 * hai bảng, và hai adapter chạy song song trên D1 sẽ tranh cùng một outbox row. Chạy tuần tự
 * giữ mỗi lần chuyển tiếp có đúng một chủ sở hữu; chi phí là không đáng kể so với một lô ≤
 * `batchLimit`.
 */
export async function runOutboxReconciler(
  deps: MailOutboxReconcilerDeps,
  config: RunOutboxReconcilerConfig,
): Promise<RunOutboxReconcilerResult> {
  const candidates = await deps.listDispatchIncomplete({
    updatedBeforeMs: config.nowMs - config.maxAgeMs,
    limit: config.batchLimit,
  });

  let redispatched = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const outcome = await reconcileOne(deps, config, candidate.deliveryId);
    if (outcome === 'redispatched') {
      redispatched += 1;
    } else {
      skipped += 1;
    }
  }

  return { scanned: candidates.length, redispatched, skipped };
}

/** Kết cục của một candidate — nội bộ {@link runOutboxReconciler}. */
type CandidateOutcome = 'redispatched' | 'skipped';

/**
 * Một candidate: đọc state của cả hai bảng rồi quyết định — `03-operations.md` §5.3.
 *
 * ⚠️ Việc quyết định dựa trên **cả** message lẫn outbox chứ không chỉ một trong hai: hai lớp
 * state không bao giờ ghi lên nhau (`01-architecture.md` §6.2.1), nên trạng thái của một
 * delivery chỉ có nghĩa khi đọc cả hai cùng lúc.
 */
async function reconcileOne(
  deps: MailOutboxReconcilerDeps,
  config: RunOutboxReconcilerConfig,
  deliveryId: string,
): Promise<CandidateOutcome> {
  const [message, outbox] = await Promise.all([
    deps.messages.findByDeliveryId(deliveryId),
    deps.outbox.findByDeliveryId(deliveryId),
  ]);

  // Message biến mất thì không có gì để re-dispatch; outbox biến mất thì tương tự. Cả hai
  // đều là dữ liệu không nhất quán, nhưng đây **không** phải đường để tự sửa — bỏ qua và
  // để lần quét sau thấy lại nếu còn.
  if (message === null || outbox === null) {
    return 'skipped';
  }

  // Outbox `failed`: **không** tự re-enqueue. Row đã kiệt `maxPublishAttempts` trong chu kỳ
  // đó và chỉ được mở lại bởi repair có authorize (§5.4) — tự reset ở đây là lách cổng đó.
  if (outbox.status === 'failed') {
    deps.logAlert({ event: 'reconciler-outbox-failed-repair-required', deliveryId });
    return 'skipped';
  }

  // Message `accepted` còn outbox `pending`/`publishing` → **còn trong chu kỳ publish**.
  // Publisher sẽ xử lý; nếu outbox `publishing` quá lease thì chính `claim` của publisher
  // reclaim được. Đó không phải việc của reconciler, và re-dispatch ở đây sẽ tranh cùng một
  // row với publisher — hai đường enqueue khác nhau nhưng phải dùng chung lease + backoff
  // + ngân sách A trong control plane, nếu không sẽ có recovery loop giữa chúng (§5.3).
  if (message.status === 'accepted') {
    return 'skipped';
  }

  if (message.status !== 'queued') {
    // `blocked` không lọt vào `listDispatchIncomplete`; nhánh này chỉ để fail-safe nếu một
    // adapter đổi câu quét. `blocked` tuyệt đối không re-dispatch tự động (§5.3).
    return 'skipped';
  }

  // `queued` + outbox `published`: dispatch-incomplete — `QUEUE.send()` đã thành công
  // nhưng không có job nào ở D1 `mail-job` được tạo (Queue retention, hoặc worker chưa kịp
  // tạo job row). Đây là nhánh mà guard phải nhận `published` (`01-architecture.md` §6.2.2).
  deps.logAlert({ event: 'reconciler-dispatch-incomplete', deliveryId });

  const result = await deps.redispatch(deliveryId, config.nowMs);

  if (result.kind === 'redispatched') {
    return 'redispatched';
  }

  // Ngân sách A cạn: đường tự động **dừng hẳn** từ đây (§6.5 hàng 10). Alert là hành động
  // đúng; không có cách nào tự nới bound vì `recovery_cycle_count` chỉ tăng.
  if (result.kind === 'budget-exhausted') {
    deps.logAlert({ event: 'reconciler-budget-exhausted', deliveryId });
  }

  // `not-eligible`: có ai đó đã xử lý message này trước (terminal, hoặc `blocked`) — bỏ qua
  // im lặng là đúng, không phải sự cố.
  return 'skipped';
}
