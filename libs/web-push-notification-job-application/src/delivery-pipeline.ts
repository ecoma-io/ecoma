/**
 * Pipeline xử lý **một** Queue message — `web-push-notification-job`.
 *
 * ⚠️ **Đây là nơi duy nhất** một message được đi từ byte trên Queue tới `ack()`/`retry()`.
 * Mọi quyết định của docs nằm ở đây theo đúng thứ tự đọc được của nó:
 *
 * 1. **Validate envelope** (`validateDeliveryCommand`) — thiếu field / sai version / secret
 *    lọt vào → poison message: không gọi provider, đường DLQ.
 * 2. **Guard scope thực thi tại ranh giới envelope** (`validateV1ExecutionTransport`) —
 *    `transport = app` là của worker khác (`§22`), không phải lỗi schema.
 * 3. **Job state**: processed marker short-circuit (redelivery), ghi envelope + attempt.
 * 4. **Claim** — thắng/thua là một bước với runtime resolution (FR-003).
 * 5. **Guard scope thực thi trên runtime material** (`validateV1ExecutionMaterialScope`) —
 *    trước khi gọi provider, vì `provider.type` chỉ có ở đây.
 * 6. **Kiểm `expires_at` MỘT lần, ngay trước** provider call (§16).
 * 7. **Gửi** qua `WebPushSender`, phân loại theo error matrix, ghi outcome, ACK/retry.
 *
 * ⚠️ **Thứ tự 2 trước 4 là bắt buộc, không phải tối ưu.** `transport = app` không thuộc scope
 * worker này: claim nó sẽ **thắng lease** một delivery mà worker không gửi được, tức giữ
 * lease tới khi hết hạn và biến một no-op thành một lần claim thất bại cho worker khác. Đó là
 * lý do §4 tách hai lớp guard thay vì một.
 *
 * ⚠️ **Không** `try { … } catch { ack() }` bao trùm: một lỗi không dự đoán được **không** được
 * biến thành một ACK mù. Đường lỗi không xác định đi qua bounded retry (rồi DLQ), đúng §11
 * và §6.
 */

import {
  validateDeliveryCommand,
  validateV1ExecutionMaterialScope,
  validateV1ExecutionTransport,
  type DeliveryClaim,
  type DeliveryCommandV1,
} from '@ecoma-io/push-notification-contracts';

import { classifySendResult, projectAttempt, type ProviderAction } from './error-matrix';
import type {
  AttemptOutcome,
  AttemptPhase,
  JobRecord,
  JobStatePort,
  StoredDeliveryEnvelope,
} from './job-state-port';
import type { DeliveryLogFields, LoggerPort, MetricsPort } from './observability-port';
import type { MessageDisposition, PipelineClock, QueueMessageInfo } from './ports';
import {
  RuntimeAuthResolutionError,
  RuntimeContractError,
  RuntimeTransportError,
  type DeliveryRuntimePort,
} from './runtime-control-plane-port';
import { WEB_PUSH_REQUEST_TIMEOUT_MS, computeTtlSeconds, queueRetryDelaySeconds } from './timing';
import type {
  WebPushSendRequest,
  WebPushSendResult,
  WebPushSender,
  WebPushTransientPhase,
} from './web-push-sender';

/** Dependency của {@link processDeliveryMessage} — toàn bộ I/O, inject được. */
export interface DeliveryPipelineDeps {
  readonly runtime: DeliveryRuntimePort;
  readonly jobs: JobStatePort;
  readonly sender: WebPushSender;
  readonly clock: PipelineClock;
  readonly metrics: MetricsPort;
  readonly logger: LoggerPort;
}

/**
 * Kết cục của việc xử lý một message — dùng **để test khẳng định hành động**, không phải để
 * production đọc.
 *
 * ⚠️ Nó là **giá trị trả về thuần** của use case; quyền ACK/retry đã được thực hiện qua
 * {@link MessageDisposition}. Test assert trên disposition **và** trên giá trị này, vì
 * disposition là thứ thực sự gọi lên Queue còn giá trị này là thứ đọc được.
 */
export type MessageProcessingOutcome =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'failed'; readonly failureClass: string }
  | { readonly kind: 'skipped'; readonly reason: SkipReason }
  | {
      readonly kind: 'retried';
      readonly releaseAttempted: boolean;
      readonly releaseSucceeded: boolean;
    }
  | { readonly kind: 'poison'; readonly reason: string }
  | { readonly kind: 'expired_before_send' };

/** Lý do skip — mỗi giá trị là một `reason` của contract claim, hoặc job state. */
export type SkipReason =
  | 'already_processed'
  | 'claim_lease_held'
  | 'claim_terminal'
  | 'claim_expired'
  | 'claim_ineligible_subscription'
  | 'claim_ineligible_provider_hold'
  | 'unsupported_transport';

/**
 * Xử lý **một** message.
 *
 * ⚠️ `disposition` là của **message này**, không phải của batch: đây là toàn bộ cơ chế
 * per-message ACK của §12.1, và một caller truyền `retryAll`/`ackAll` không thể biên dịch
 * được vào đây.
 *
 * ⚠️ **Không có `try { … } catch { ack() }` bao trùm**: một lỗi không dự đoán được **không**
 * được biến thành một ACK mù. Đường lỗi không xác định đi qua bounded retry (rồi DLQ), đúng
 * §11 và §6.
 *
 * ⚠️ **Claim là "cửa" của lease (DC-2).** Trước cửa — envelope, scope envelope, job state,
 * claim bị từ chối/ném — worker **không** giữ lease, chọn không release thừa. Sau cửa — mọi
 * nhánh trong {@link processClaimedDelivery} — worker **đang** giữ lease, nên một lỗi chưa
 * phân loại ném ra từ vùng đó được `catch` ở dưới release lease **trước** khi ném tiếp lên
 * caller (catch-all của caller vẫn `retry()` và metric/log như cũ — FR-008: retry của Queue
 * phải thực sự retry provider).
 */
export async function processDeliveryMessage(
  deps: DeliveryPipelineDeps,
  messageBody: unknown,
  message: QueueMessageInfo,
  disposition: MessageDisposition,
): Promise<MessageProcessingOutcome> {
  const { clock, metrics, logger } = deps;

  /* -- (1) Validate envelope ------------------------------------------------------------ */
  const validated = validateDeliveryCommand(messageBody);
  if (!validated.ok) {
    // Poison message: contract §6 — không gửi provider, metric + log ở mức cảnh báo, và
    // **không** ACK mù để Queue đưa vào DLQ sau khi retry exhausted. Một envelope hỏng không
    // bao giờ trở thành hợp lệ bằng cách retry.
    metrics.increment('queue_consumer_errors');
    metrics.increment('dlq_messages');
    logger.log('error', 'delivery.envelope_rejected', {
      reason: validated.reason,
      attempts: message.attempts,
    });
    disposition.retry();
    return { kind: 'poison', reason: validated.reason };
  }
  const envelope = validated.command;
  metrics.increment('deliveries_consumed');

  /* -- (2) Guard scope thực thi tại ranh giới envelope ----------------------------------- */
  const transportScope = validateV1ExecutionTransport(envelope.transport);
  if (!transportScope.ok) {
    // **Không** claim: giữ lease một delivery mà worker này không gửi được là lỗi.
    // `transient` là lựa chọn fail-safe — Queue tương lai có thể đổi cách phân phối, còn ACK
    // sẽ khiến message biến mất vĩnh viễn chỉ vì worker này không đúng scope.
    metrics.increment('deliveries_skipped', { transport: envelope.transport });
    logger.log('warn', 'delivery.out_of_scope_transport', { transport: envelope.transport });
    disposition.retry();
    return { kind: 'skipped', reason: 'unsupported_transport' };
  }

  /* -- (3) Job state ------------------------------------------------------------------- */
  const storedEnvelope = toStoredEnvelope(envelope);
  const attemptNumber = message.attempts;
  const jobBefore = await deps.jobs.findByDeliveryId(envelope.delivery_id);
  if (jobBefore !== null && jobBefore.processed) {
    // Redelivery của một delivery đã có processed marker: ACK ngay, **không** gọi provider
    // (W4 — crash sau persist outcome trước ACK; và mọi duplicate Queue message).
    metrics.increment('deliveries_skipped', { provider_id: envelope.provider_id });
    logger.log('info', 'delivery.already_processed', {
      delivery_id: envelope.delivery_id,
      provider_id: envelope.provider_id,
      attempts: attemptNumber,
    });
    disposition.ack();
    return { kind: 'skipped', reason: 'already_processed' };
  }
  // ⚠️ Lỗi ném ở đây xảy ra **trước** claim ⇒ không có lease để release: caller chỉ
  // `retry()` và lease của delivery vẫn thuộc về lần claim sau.
  await deps.jobs.beginAttempt({
    envelope: storedEnvelope,
    attempt: attemptNumber,
    nowMs: clock.now(),
  });

  /* -- (4) Claim = runtime resolution ---------------------------------------------------- */
  let claimResult;
  try {
    claimResult = await deps.runtime.claim(envelope.delivery_id);
  } catch (error) {
    return handleClaimFailure(deps, envelope, message, disposition, error, attemptNumber);
  }

  if (claimResult.kind === 'lost') {
    const outcome = handleClaimRejection(deps, envelope, disposition, claimResult.rejection);
    return outcome;
  }
  const claim = claimResult.claim;

  // ⚠️ **Cửa của lease.** Từ dòng này trở đi worker **đang giữ lease** (claim đã thắng), nên
  // mọi lỗi chưa phân loại ném ra phải release lease **trước** khi caller `retry()` — theo
  // FR-008. Vì vậy phần còn lại của pipeline nằm trong một `try` bọc `catch` riêng, và
  // `catch` đó **release rồi ném tiếp** lên caller.
  try {
    return await processClaimedDelivery(deps, envelope, claim, message, disposition, attemptNumber);
  } catch (error) {
    // DC-2: claim đã thắng ⇒ worker đang giữ lease. Mọi đường retry sau cửa này phải release
    // lease TRƯỚC `retry()` — nếu không, delivery vẫn `processing` với lease còn hiệu lực,
    // redelivery gặp `409 lease_held` và bị ACK ⇒ **retry của Queue không thực sự retry
    // provider**. Release là **guarded conditional write** (predicate nằm trong statement của
    // control plane) nên nó không đổi `dispatch_generation`: generation cũ ⇒ `409 stale_write`
    // ⇒ no-op an toàn, không ghi đè state của execution thế hệ sau.
    const release = await releaseBeforeRetry(deps, envelope.delivery_id, claim.dispatch_generation);
    deps.logger.log('warn', 'delivery.lease_released_before_unhandled_retry', {
      delivery_id: envelope.delivery_id,
      lease_released: release.succeeded,
    });
    throw error;
  }
}

/**
 * Thân của pipeline **sau khi claim đã thắng** — tức mọi đường ở đây đều đang giữ lease.
 *
 * ⚠️ **Tách riêng để có đúng MỘT `catch` cho cả vùng hậu-claim.** Gộp vào thân hàm thì mỗi
 * đường lỗi mới thêm vào phải tự nhớ "có phải release trước không", và một đường quên là
 * một lỗi im lặng đắt nhất ở đây (§12/FR-008) — nó chỉ biểu hiện dưới tải thật thành
 * "retry không bao giờ thử lại provider". Ở đây cả vùng hậu-claim chỉ có **một** lối thoát
 * lỗi, và lối thoát đó luôn release trước.
 */
async function processClaimedDelivery(
  deps: DeliveryPipelineDeps,
  envelope: DeliveryCommandV1,
  claim: DeliveryClaim,
  message: QueueMessageInfo,
  disposition: MessageDisposition,
  attemptNumber: number,
): Promise<MessageProcessingOutcome> {
  const { clock, metrics, logger } = deps;

  /* -- (5) Guard scope thực thi trên runtime material ----------------------------------- */
  const materialScope = validateV1ExecutionMaterialScope({
    transport: claim.transport,
    provider_type: claim.provider.type,
  });
  if (!materialScope.ok) {
    // Material của provider ngoài scope là contract violation. Worker giữ lease (đã claim
    // thắng) nên **phải** release trước `retry()` — nếu không, retry của Queue không thực
    // sự retry (FR-008). Không gọi provider, không ghi outcome (material không thuộc scope
    // thì không có kết cục delivery hợp lệ để ghi).
    const releaseOutcome = await releaseBeforeRetry(
      deps,
      envelope.delivery_id,
      claim.dispatch_generation,
    );
    await finishAttempt(deps, envelope.delivery_id, attemptNumber, {
      outcome: 'contract_violation',
      phase: 'no_provider_call',
      httpStatus: null,
      retryAfterMs: null,
    });
    metrics.increment('queue_consumer_errors', { provider_id: envelope.provider_id });
    logger.log('error', 'delivery.material_out_of_scope', {
      delivery_id: envelope.delivery_id,
      provider_id: envelope.provider_id,
      reason: materialScope.reason,
    });
    disposition.retry();
    return {
      kind: 'retried',
      releaseAttempted: releaseOutcome.attempted,
      releaseSucceeded: releaseOutcome.succeeded,
    };
  }

  // §7: material phải khớp envelope. `transport` đã qua guard rồi nên phần còn lại là
  // **đối chiếu identity**: control plane trả material của một delivery khác là lỗi contract
  // nghiêm trọng hơn một field lệch, và gửi payload của delivery A tới endpoint của delivery B
  // là vi phạm SR-002 (recipient sai).
  const identityMismatch = findIdentityMismatch(envelope, claim);
  if (identityMismatch !== null) {
    const releaseOutcome = await releaseBeforeRetry(
      deps,
      envelope.delivery_id,
      claim.dispatch_generation,
    );
    await finishAttempt(deps, envelope.delivery_id, attemptNumber, {
      outcome: 'contract_violation',
      phase: 'no_provider_call',
      httpStatus: null,
      retryAfterMs: null,
    });
    metrics.increment('queue_consumer_errors', { provider_id: envelope.provider_id });
    logger.log('error', 'delivery.material_identity_mismatch', {
      delivery_id: envelope.delivery_id,
      field: identityMismatch,
    });
    disposition.retry();
    return {
      kind: 'retried',
      releaseAttempted: releaseOutcome.attempted,
      releaseSucceeded: releaseOutcome.succeeded,
    };
  }

  /* -- (6) expires_at — kiểm MỘT lần, ngay trước provider call ------------------------ */
  const nowMs = clock.now();
  const ttlSeconds = computeTtlSeconds(claim.expires_at, nowMs);
  if (ttlSeconds === null) {
    const releaseOutcome = await releaseBeforeRetry(
      deps,
      envelope.delivery_id,
      claim.dispatch_generation,
    );
    await finishAttempt(deps, envelope.delivery_id, attemptNumber, {
      outcome: 'contract_violation',
      phase: 'no_provider_call',
      httpStatus: null,
      retryAfterMs: null,
    });
    metrics.increment('queue_consumer_errors', { provider_id: envelope.provider_id });
    logger.log('error', 'delivery.expires_at_unparseable', {
      delivery_id: envelope.delivery_id,
      provider_id: envelope.provider_id,
    });
    disposition.retry();
    return {
      kind: 'retried',
      releaseAttempted: releaseOutcome.attempted,
      releaseSucceeded: releaseOutcome.succeeded,
    };
  }
  if (ttlSeconds <= 0) {
    // §16: hết hạn → **không** gọi provider, **không** ghi outcome, **không** invalidate,
    // **không** release (lease tự hết hạn), chỉ ghi attempt rồi ACK. Delivery vẫn non-terminal
    // và control plane chuyển `expired` bằng reconciliation (c).
    await finishAttempt(deps, envelope.delivery_id, attemptNumber, {
      outcome: 'expired_before_send',
      phase: 'no_provider_call',
      httpStatus: null,
      retryAfterMs: null,
    });
    await deps.jobs.markProcessed({
      deliveryId: envelope.delivery_id,
      terminalOutcome: 'expired',
      nowMs: clock.now(),
    });
    metrics.increment('deliveries_skipped', {
      provider_id: envelope.provider_id,
      transport: envelope.transport,
    });
    logger.log('info', 'delivery.expired_before_send', {
      delivery_id: envelope.delivery_id,
      notification_id: envelope.notification_id,
      subscription_id: envelope.subscription_id,
      provider_id: envelope.provider_id,
      app: claim.app,
      attempts: attemptNumber,
    });
    disposition.ack();
    return { kind: 'expired_before_send' };
  }

  /* -- (7) Gửi provider + error matrix -------------------------------------------------- */
  const sendRequest = buildSendRequest(claim, envelope, ttlSeconds);
  if (sendRequest === null) {
    // Runtime material thiếu khoá VAPID cần để ký: permanent của attempt (§18), và adapter
    // là nơi quyết định nó là `vapid_key_missing` — pipeline chỉ cần truyền `null` cho
    // `vapidSubject` và `vapidPrivateKey` **không** phải cách khác để nói "thiếu". Ở đây
    // `buildSendRequest` trả `null` khi credential không có **cả** cặp khoá, tức material
    // hỏng theo nghĩa khác: coi là contract violation, không phải provider failure.
    const releaseOutcome = await releaseBeforeRetry(
      deps,
      envelope.delivery_id,
      claim.dispatch_generation,
    );
    await finishAttempt(deps, envelope.delivery_id, attemptNumber, {
      outcome: 'contract_violation',
      phase: 'no_provider_call',
      httpStatus: null,
      retryAfterMs: null,
    });
    metrics.increment('queue_consumer_errors', { provider_id: envelope.provider_id });
    logger.log('error', 'delivery.vapid_material_missing', {
      delivery_id: envelope.delivery_id,
      provider_id: envelope.provider_id,
    });
    disposition.retry();
    return {
      kind: 'retried',
      releaseAttempted: releaseOutcome.attempted,
      releaseSucceeded: releaseOutcome.succeeded,
    };
  }

  const startedAt = clock.now();
  let sendResult: WebPushSendResult | undefined;
  // Phase suy ra khi adapter **throw** (lỗi contract của adapter): không có kết quả adapter
  // để đọc phase, nên suy từ lỗi. AbortError ⇒ request có thể đã rời worker ⇒ `after_send`
  // (nguồn duplicate tiềm năng, §12 nhóm iii); mọi lỗi khác ⇒ `before_send`.
  // ⚠️ Adapter hiện đã phân loại timeout nội bộ và **trả** kết quả thay vì throw, nên nhánh
  // throw chỉ còn cho lỗi contract thật sự — nhưng vẫn phải đọc phase từ "kết quả adapter"
  // (ở đây là kết quả tổng hợp) thay vì hard-code, để test AbortError từ adapter đi đúng nhánh.
  let threwPhase: WebPushTransientPhase | null = null;
  try {
    sendResult = await deps.sender.send(sendRequest);
  } catch (error) {
    // Adapter throw = lỗi contract của adapter. Đường an toàn: coi như transient. Phase lấy
    // từ lỗi thay vì hard-code 'before_send' (B-2): AbortError ⇒ after_send.
    threwPhase =
      (error as { readonly name?: unknown } | null)?.name === 'AbortError'
        ? 'after_send'
        : 'before_send';
  }
  const durationMs = Math.max(0, clock.now() - startedAt);
  metrics.observe('provider_request_latency_ms', durationMs, {
    provider_id: envelope.provider_id,
    transport: envelope.transport,
  });
  metrics.increment('provider_request_total', {
    provider_id: envelope.provider_id,
    transport: envelope.transport,
  });

  // Nếu adapter throw, dựng một kết quả transient từ phase suy ra rồi đi qua cùng
  // `classifySendResult` — "đọc phase từ kết quả adapter" thay vì hard-code action.
  const effectiveResult: WebPushSendResult | undefined =
    sendResult === undefined && threwPhase !== null
      ? { outcome: 'transient', phase: threwPhase, retryAfterMs: null, httpStatus: null }
      : sendResult;
  const action: ProviderAction =
    effectiveResult === undefined
      ? { kind: 'release_then_retry', phase: 'before_send', retryAfterMs: null }
      : classifySendResult(effectiveResult);
  const projection = projectAttempt(action);
  const httpStatus = effectiveResult === undefined ? null : readHttpStatus(effectiveResult);
  const retryAfterMs = readRetryAfterMs(action);

  return applyProviderAction(
    deps,
    envelope,
    claim.dispatch_generation,
    claim.app,
    attemptNumber,
    action,
    { outcome: projection.outcome, phase: projection.phase, httpStatus, retryAfterMs },
    message,
    disposition,
  );
}

/* -------------------------------------------------------------------------------------- */
/* Nhánh phụ                                                                                  */
/* -------------------------------------------------------------------------------------- */

/**
 * Claim thất bại theo ba nhóm: contract violation / auth resolution / transport. Cả ba đều
 * **không** gọi provider và **không** ACK mù (§11 hàng cuối) — bounded retry rồi DLQ.
 */
async function handleClaimFailure(
  deps: DeliveryPipelineDeps,
  envelope: DeliveryCommandV1,
  message: QueueMessageInfo,
  disposition: MessageDisposition,
  error: unknown,
  attemptNumber: number,
): Promise<MessageProcessingOutcome> {
  const { logger, metrics } = deps;
  // ⚠️ **Phân biệt ba lỗi** bằng `instanceof`, không bằng `String(error)`: một lỗi cấu hình
  // (thiếu secret) và một lỗi mạng có cùng hậu quả cho message nhưng khác hẳn cho operator, và
  // `runtime_resolution_errors` là metric mà §12 alert.
  const authFailure = error instanceof RuntimeAuthResolutionError;
  const contractFailure = error instanceof RuntimeContractError;
  const transportFailure = error instanceof RuntimeTransportError;
  const classifyUnknown = !authFailure && !contractFailure && !transportFailure;

  await finishAttempt(deps, envelope.delivery_id, attemptNumber, {
    outcome:
      authFailure || contractFailure || classifyUnknown
        ? 'contract_violation'
        : 'runtime_unavailable',
    phase: 'no_provider_call',
    httpStatus: null,
    retryAfterMs: null,
  });

  if (transportFailure) {
    // FR-017: runtime API tạm thời unavailable → transient. **Không** fallback sang D1 của
    // control plane, alternate subscription/provider hay bất kỳ nguồn nào khác.
    metrics.increment('runtime_resolution_errors', { provider_id: envelope.provider_id });
    logger.log('warn', 'delivery.runtime_unavailable', {
      delivery_id: envelope.delivery_id,
      provider_id: envelope.provider_id,
      attempts: message.attempts,
    });
  } else {
    metrics.increment('runtime_resolution_errors', { provider_id: envelope.provider_id });
    metrics.increment('queue_consumer_errors', { provider_id: envelope.provider_id });
    logger.log('error', 'delivery.runtime_contract_violation', {
      delivery_id: envelope.delivery_id,
      provider_id: envelope.provider_id,
      attempts: message.attempts,
      error_kind: authFailure ? 'auth_resolution' : contractFailure ? 'contract' : 'unknown',
    });
  }
  metrics.increment('retry_count', { provider_id: envelope.provider_id });
  disposition.retry();
  return { kind: 'retried', releaseAttempted: false, releaseSucceeded: false };
}

/**
 * Claim `409` — bảng ánh xạ của §11, đúng từng dòng.
 *
 * ⚠️ **`pending` là nhóm duy nhất đi vào `retry()`, và nó là nhóm duy nhất KHÔNG release**:
 * chưa có lease để trả (§12 "Quy tắc này chỉ áp dụng khi claim **đã** thắng"). Mọi `reason`
 * còn lại là **no-op an toàn** — ACK, không ghi state nào (worker không sở hữu terminal state).
 */
function handleClaimRejection(
  deps: DeliveryPipelineDeps,
  envelope: DeliveryCommandV1,
  disposition: MessageDisposition,
  rejection: { readonly reason: string; readonly state?: string },
): MessageProcessingOutcome {
  const { logger, metrics } = deps;
  const dimensions = { provider_id: envelope.provider_id, transport: envelope.transport };
  if (rejection.reason === 'pending') {
    metrics.increment('deliveries_retried', dimensions);
    metrics.increment('retry_count', dimensions);
    logger.log('debug', 'delivery.claim_pending', {
      delivery_id: envelope.delivery_id,
      provider_id: envelope.provider_id,
    });
    disposition.retry();
    return { kind: 'retried', releaseAttempted: false, releaseSucceeded: false };
  }
  metrics.increment('deliveries_skipped', dimensions);
  logger.log('info', 'delivery.claim_rejected', {
    delivery_id: envelope.delivery_id,
    notification_id: envelope.notification_id,
    subscription_id: envelope.subscription_id,
    provider_id: envelope.provider_id,
    reason: rejection.reason,
    ...(rejection.state === undefined ? {} : { state: rejection.state }),
  });
  disposition.ack();
  return { kind: 'skipped', reason: toSkipReason(rejection.reason) };
}

/**
 * `reason` của claim → lý do skip đã đóng.
 *
 * ⚠️ `unknown_reason` **không** có ở đây: `validateClaimRejection` đã chặn nó ở tầng client và
 * nó thành `RuntimeContractError` (bounded retry), chứ không phải một no-op ACK. Hàm này chỉ
 * nhận `reason` đã qua validator, nên `default` là `assertNever` chứ không phải một giá trị
 * bịa.
 */
function toSkipReason(reason: string): SkipReason {
  switch (reason) {
    case 'lease_held':
      return 'claim_lease_held';
    case 'terminal':
      return 'claim_terminal';
    case 'expired':
      return 'claim_expired';
    case 'ineligible_subscription':
      return 'claim_ineligible_subscription';
    case 'ineligible_provider_hold':
      return 'claim_ineligible_provider_hold';
    default:
      return assertNeverReason(reason);
  }
}

function assertNeverReason(reason: string): never {
  throw new Error(`Claim rejection reason outside the closed set reached the pipeline: ${reason}`);
}

/* -------------------------------------------------------------------------------------- */
/* Release + outcome                                                                         */
/* -------------------------------------------------------------------------------------- */

/**
 * Release lease trước `retry()` — bắt buộc mọi khi claim **đã thắng** (§12, FR-008).
 *
 * ⚠️ **Release fail vẫn `retry()`**: lease sẽ tự hết hạn và fence chính nó, nên lần claim kế
 * tiệp sẽ thắng trở lại. Ngược lại, không release **và** không retry (ACK) là mất việc; còn
 * release fail rồi bỏ retry là chờ lease hết hạn mà không có backoff — tệ hơn một lần claim thừa.
 *
 * ⚠️ **Hai caller, chung cơ chế.** Một là các nhánh đã phân loại trong thân pipeline
 * (`processClaimedDelivery`); hai là catch-all hậu-claim của
 * {@link processDeliveryMessage} khi một lỗi chưa phân loại ném ra sau cửa lease — thứ tự
 * release trước retry là bất biến FR-008, không phụ thuộc việc lỗi đã được phân loại hay chưa.
 */
async function releaseBeforeRetry(
  deps: DeliveryPipelineDeps,
  deliveryId: string,
  dispatchGeneration: number,
): Promise<{ readonly attempted: true; readonly succeeded: boolean }> {
  try {
    const result = await deps.runtime.release(deliveryId, dispatchGeneration);
    return { attempted: true, succeeded: result.kind === 'applied' };
  } catch (error) {
    deps.logger.log('warn', 'delivery.release_failed', {
      delivery_id: deliveryId,
      error_kind: error instanceof RuntimeContractError ? 'contract' : 'transport',
    });
    return { attempted: true, succeeded: false };
  }
}

/**
 * Áp dụng hành động của error matrix.
 *
 * ⚠️ **Thứ tự trong nhánh invalidate là cố ý**: báo invalidate **trước** khi ghi outcome, và
 * kết quả invalidate **không** chặn outcome. Lý do: `404` nói endpoint chết, đó là một sự
 * thật đã quan sát; để một lỗi mạng khi gọi `invalidate` làm mất cả bằng chứng đó thì
 * subscription chết sẽ không bao giờ bị disable và delivery mới vẫn tiếp tục được tạo cho nó
 * (FR-009 yêu cầu cả hai, theo thứ tự này).
 */
async function applyProviderAction(
  deps: DeliveryPipelineDeps,
  envelope: DeliveryCommandV1,
  dispatchGeneration: number,
  app: string,
  attemptNumber: number,
  action: ProviderAction,
  attempt: {
    readonly outcome: AttemptOutcome;
    readonly phase: AttemptPhase;
    readonly httpStatus: number | null;
    readonly retryAfterMs: number | null;
  },
  message: QueueMessageInfo,
  disposition: MessageDisposition,
): Promise<MessageProcessingOutcome> {
  const { logger, metrics } = deps;
  const dimensions = { provider_id: envelope.provider_id, transport: envelope.transport };
  const baseFields: DeliveryLogFields = {
    delivery_id: envelope.delivery_id,
    notification_id: envelope.notification_id,
    subscription_id: envelope.subscription_id,
    provider_id: envelope.provider_id,
    app,
    attempts: attemptNumber,
  };
  await finishAttempt(deps, envelope.delivery_id, attemptNumber, attempt);

  switch (action.kind) {
    case 'record_delivered': {
      await writeOutcome(deps, envelope.delivery_id, dispatchGeneration, 'delivered');
      await deps.jobs.markProcessed({
        deliveryId: envelope.delivery_id,
        terminalOutcome: 'delivered',
        nowMs: deps.clock.now(),
      });
      metrics.increment('deliveries_delivered', dimensions);
      metrics.increment('provider_request_success', dimensions);
      logger.log('info', 'delivery.delivered', { ...baseFields, outcome: 'delivered' });
      disposition.ack();
      return { kind: 'delivered' };
    }
    case 'record_failed_and_invalidate': {
      // Fire, không chặn: xem JSDoc hàm.
      const invalidated = await invalidateSubscription(deps, envelope.subscription_id);
      if (invalidated) {
        metrics.increment('subscriptions_invalidated', dimensions);
      }
      await writeOutcome(deps, envelope.delivery_id, dispatchGeneration, 'failed');
      await deps.jobs.markProcessed({
        deliveryId: envelope.delivery_id,
        terminalOutcome: 'failed',
        nowMs: deps.clock.now(),
      });
      metrics.increment('deliveries_failed', dimensions);
      metrics.increment('provider_request_failure', {
        ...dimensions,
        http_status: attempt.httpStatus ?? 0,
      });
      logger.log('info', 'delivery.failed', {
        ...baseFields,
        outcome: 'failed',
        failure_class: action.failureClass,
        http_status: attempt.httpStatus ?? 0,
        subscription_invalidated: invalidated,
      });
      disposition.ack();
      return { kind: 'failed', failureClass: action.failureClass };
    }
    case 'record_failed': {
      await writeOutcome(deps, envelope.delivery_id, dispatchGeneration, 'failed');
      await deps.jobs.markProcessed({
        deliveryId: envelope.delivery_id,
        terminalOutcome: 'failed',
        nowMs: deps.clock.now(),
      });
      metrics.increment('deliveries_failed', dimensions);
      metrics.increment('provider_request_failure', {
        ...dimensions,
        http_status: attempt.httpStatus ?? 0,
      });
      // `provider_auth` và `redirect_not_followed` là hai failure có alert-level trong §12 —
      // log `error`, không phải `info`.
      const level =
        action.failureClass === 'provider_auth' || action.failureClass === 'redirect_not_followed'
          ? 'error'
          : 'info';
      logger.log(level, 'delivery.failed', {
        ...baseFields,
        outcome: 'failed',
        failure_class: action.failureClass,
        http_status: attempt.httpStatus ?? 0,
      });
      disposition.ack();
      return { kind: 'failed', failureClass: action.failureClass };
    }
    case 'release_then_retry': {
      const release = await releaseBeforeRetry(deps, envelope.delivery_id, dispatchGeneration);
      metrics.increment('deliveries_retried', dimensions);
      metrics.increment('provider_request_failure', {
        ...dimensions,
        http_status: attempt.httpStatus ?? 0,
      });
      metrics.increment('retry_count', dimensions);
      logger.log('warn', 'delivery.retrying', {
        ...baseFields,
        outcome: 'retrying',
        failure_phase: action.phase,
        http_status: attempt.httpStatus ?? 0,
        retry_after_ms: attempt.retryAfterMs ?? -1,
        lease_released: release.succeeded,
      });
      const delaySeconds = queueRetryDelaySeconds({
        attempts: message.attempts,
        retryAfterMs: action.retryAfterMs,
      });
      disposition.retry(delaySeconds === undefined ? undefined : { delaySeconds });
      return {
        kind: 'retried',
        releaseAttempted: release.attempted,
        releaseSucceeded: release.succeeded,
      };
    }
    default:
      return assertNeverAction(action);
  }
}

function assertNeverAction(action: never): never {
  throw new Error(`Unhandled provider action: ${JSON.stringify(action)}`);
}

/**
 * Ghi outcome — lỗi ở đây **không** được nuốt thành ACK.
 *
 * ⚠️ Khác với `invalidate`: nếu ghi outcome thất bại thì provider **đã** được gọi và kết quả
 * **đã** xảy ra; ACK lúc đó là mất kết quả đó vĩnh viễn (delivery vẫn `processing`, và
 * reconciliation phải đoán lại bằng cách gửi lại → duplicate). Nên lỗi ở đây → `throw` để
 * caller batch **không** ACK message đó; Queue sẽ redeliver và claim `409 terminal` hoặc
 * `409 pending` sẽ dẫn tới kết cục an toàn.
 */
async function writeOutcome(
  deps: DeliveryPipelineDeps,
  deliveryId: string,
  dispatchGeneration: number,
  outcome: 'delivered' | 'failed',
): Promise<void> {
  const result = await deps.runtime.writeOutcome(deliveryId, dispatchGeneration, outcome);
  if (result.kind === 'rejected') {
    // `stale_write`/`terminal`: coi là duplicate/conflict, ACK an toàn (§11) — nhưng
    // **không** coi là lỗi: không có lỗi nào để retry.
    deps.logger.log('info', 'delivery.outcome_stale', {
      delivery_id: deliveryId,
      reason: result.reason,
    });
  }
}

/**
 * Báo invalidate subscription — **fire**, kết quả không quyết định outcome.
 *
 * ⚠️ `invalidate` là idempotent theo kết quả, nên một lần gọi lỗi **không** phải lý do bỏ việc
 * disable: delivery tới subscription này vẫn tiếp tục được tạo (FR-009). Đó là lý do nhánh
 * này nuốt lỗi và trả boolean thay vì ném.
 */
async function invalidateSubscription(
  deps: DeliveryPipelineDeps,
  subscriptionId: string,
): Promise<boolean> {
  try {
    const result = await deps.runtime.invalidateSubscription(subscriptionId);
    if (result === 'auth_rejected') {
      deps.metrics.increment('runtime_resolution_errors');
      deps.logger.log('error', 'delivery.invalidate_rejected', { subscription_id: subscriptionId });
      return false;
    }
    return result === 'disabled';
  } catch (error) {
    deps.logger.log('warn', 'delivery.invalidate_failed', {
      subscription_id: subscriptionId,
      error_kind: error instanceof RuntimeContractError ? 'contract' : 'transport',
    });
    return false;
  }
}

/**
 * Đóng attempt trong job state của chính worker.
 *
 * ⚠️ **Lỗi ở đây KHÔNG được ném ra** — khác với {@link writeOutcome}, và sự khác biệt là có
 * chủ đích. `outcome` là logical delivery state của control plane: ghi hỏng thì kết quả thật
 * của provider bị mất, nên phải ném để message không bị ACK. Còn attempt row trên `push-job`
 * là **job state của tôi**: provider **đã** trả lời, kết quả **đã** xảy ra, và `push-job`
 * nằm ngoài Backup/DR scope (§11b).
 *
 * Nếu lỗi này ném ra giữa `claim` thắng và `writeOutcome`, message không được ACK, Queue
 * redeliver, và lần đó gặp `409 lease_held` (lease còn hiệu lực) — vốn là **no-op an toàn**
 * được ACK. Hệ quả: delivery treo `processing` vĩnh viễn, mất luôn kết quả đã quan sát được,
 * và chỉ cơ chế (c) của control plane mới dọn được. Nuốt lỗi ở đây là đánh đổi đúng: một attempt
 * row hở (đọc được, reconciliation thấy) thay vì một kết cục vĩnh viễn không bao giờ được ghi.
 */
async function finishAttempt(
  deps: DeliveryPipelineDeps,
  deliveryId: string,
  attempt: number,
  result: {
    readonly outcome: AttemptOutcome;
    readonly phase: AttemptPhase;
    readonly httpStatus: number | null;
    readonly retryAfterMs: number | null;
  },
): Promise<void> {
  try {
    await deps.jobs.completeAttempt({
      deliveryId,
      attempt,
      outcome: result.outcome,
      phase: result.phase,
      httpStatus: result.httpStatus,
      retryAfterMs: result.retryAfterMs,
      nowMs: deps.clock.now(),
    });
  } catch {
    // Không ném: xem JSDoc. Đường đi tiếp (ghi outcome, marker, ACK/retry) là đường đúng vì
    // kết cục provider không phụ thuộc vào việc tôi có ghi được hàng của mình hay không.
    deps.metrics.increment('queue_consumer_errors');
    deps.logger.log('warn', 'delivery.attempt_close_failed', {
      delivery_id: deliveryId,
      attempt,
      attempt_outcome: result.outcome,
    });
  }
}

/* -------------------------------------------------------------------------------------- */
/* Dựng tham số gửi                                                                         */
/* -------------------------------------------------------------------------------------- */

/**
 * Dựng `WebPushSendRequest` từ runtime material.
 *
 * ⚠️ **Credential là `Record<string, unknown>` opaque** — control plane không chốt tên khoá
 * (`decryptedKey`/`decryptedPublicKey` là camelCase của record trong control plane, còn claim
 * trả `credential: { ...credential }` sau khi validate JSON-compatibility). Vì vậy hàm này thử
 * **cả hai** cách đặt tên và trả `null` khi không tìm được **cả cặp** — đó là lý do thiếu cặp
 * khoá được coi là contract violation chứ không phải provider failure: adapter sẽ phân loại
 * nó thành `vapid_key_missing` (permanent, không retry) và một material hỏng đúng sẽ không
 * bao giờ được retry vô hạn.
 *
 * ⚠️ **Endpoint dùng nguyên văn** — FR-005 cấm re-validate allowlist và cấm tự lọc/đổi endpoint.
 */
function buildSendRequest(
  claim: {
    readonly subscription: { endpoint: string; p256dh: string; auth: string };
    readonly provider: {
      readonly configuration: Readonly<Record<string, unknown>>;
      readonly credential: Readonly<Record<string, unknown>>;
    };
  },
  envelope: DeliveryCommandV1,
  ttlSeconds: number,
): WebPushSendRequest | null {
  const privateKey = readCredentialString(claim.provider.credential, [
    'privateKey',
    'private_key',
    'decryptedKey',
  ]);
  const publicKey = readCredentialString(claim.provider.credential, [
    'publicKey',
    'public_key',
    'decryptedPublicKey',
  ]);
  if (privateKey === null || publicKey === null) {
    return null;
  }
  return {
    endpoint: claim.subscription.endpoint,
    p256dh: claim.subscription.p256dh,
    auth: claim.subscription.auth,
    vapidPrivateKey: privateKey,
    vapidPublicKey: publicKey,
    // `sub` chỉ có ở `provider.configuration`; không có thì `null` — **không** bịa default,
    // vì RFC 8292 yêu cầu contact URI thật.
    vapidSubject: readCredentialString(claim.provider.configuration, [
      'vapidSubject',
      'vapid_subject',
      'subject',
    ]),
    // Payload của **envelope** là nguồn sự thật duy nhất (§5, FR-012): serialize theo thứ tự
    // khoá canonical của contracts để byte đo được khớp ngân sách của control plane.
    payloadJson: serializeEnvelopePayload(envelope),
    ttlSeconds,
    timeoutMs: WEB_PUSH_REQUEST_TIMEOUT_MS,
  };
}

/** Đọc một khoá chuỗi từ object opaque, thử lần lượt các tên khả dụng. */
function readCredentialString(
  source: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Serialize `payload` của envelope theo **đúng** thứ tự khoá canonical FR-013.
 *
 * ⚠️ Hàm này phải khớp `serializePayloadCanonically` của `@ecoma-io/push-notification-domain`
 * (control plane đo ngân sách byte bằng đó). Cùng nội dung phải cho **cùng số octet** — vì
 * `JSON.stringify` theo thứ tự chèn, đảo thứ tự sẽ đổi byte đo được mà không ai thấy.
 */
export function serializeEnvelopePayload(envelope: DeliveryCommandV1): string {
  const payload = envelope.payload;
  const ordered: Record<string, unknown> = { title: payload.title, body: payload.body };
  if (payload.url !== undefined) {
    ordered.url = payload.url;
  }
  if (payload.data !== undefined) {
    ordered.data = payload.data;
  }
  return JSON.stringify(ordered);
}

/**
 * Đối chiếu identity giữa envelope và runtime material.
 *
 * ⚠️ **Chỉ** ba field mà envelope sở hữu: `delivery_id`, `subscription_id`, `provider_id`.
 * `notification_id` cũng thuộc envelope nhưng `app`/`transport` không thuộc — và `transport`
 * đã được guard ở tầng trên. Trả **tên field** lệch, không trả giá trị: tên field là hằng từ
 * danh sách đóng này, nên nối nó vào log là an toàn.
 */
function findIdentityMismatch(
  envelope: DeliveryCommandV1,
  claim: {
    readonly delivery_id: string;
    readonly subscription_id: string;
    readonly provider_id: string;
  },
): 'delivery_id' | 'subscription_id' | 'provider_id' | null {
  if (envelope.delivery_id !== claim.delivery_id) {
    return 'delivery_id';
  }
  if (envelope.subscription_id !== claim.subscription_id) {
    return 'subscription_id';
  }
  if (envelope.provider_id !== claim.provider_id) {
    return 'provider_id';
  }
  return null;
}

/**
 * HTTP status của provider, hoặc `null`.
 *
 * ⚠️ Nhận `unknown` và tự kiểm vì đây là **hàng phòng thủ cuối**: `classifySendResult` đã quyết
 * định xong rằng một kết quả ngoài union là transient, nhưng đọc `result.outcome` trên một
 * giá trị không phải object sẽ ném `TypeError` **ra khỏi pipeline** — tức biến một lỗi adapter
 * đã được phân loại thành một crash không phân loại, đúng thứ mà `error-matrix.ts` cấm.
 */
function readHttpStatus(result: unknown): number | null {
  if (typeof result !== 'object' || result === null) {
    return null;
  }
  const record = result as { readonly outcome?: unknown; readonly httpStatus?: unknown };
  if (record.outcome === 'delivered') {
    return 200;
  }
  return typeof record.httpStatus === 'number' ? record.httpStatus : null;
}

function readRetryAfterMs(action: ProviderAction): number | null {
  return action.kind === 'release_then_retry' ? action.retryAfterMs : null;
}

/**
 * Chuyển envelope đã validate thành dạng lưu ở D1 `push-job`.
 *
 * ⚠️ Bảy field, không hơn — FR-022. `payload` được mang **nguyên văn** vì đây là thứ duy
 * nhất cho phép re-deliver đúng message gốc khi message trên Queue đã biến mất sau retention.
 */
function toStoredEnvelope(envelope: DeliveryCommandV1): StoredDeliveryEnvelope {
  return {
    version: envelope.version,
    delivery_id: envelope.delivery_id,
    notification_id: envelope.notification_id,
    subscription_id: envelope.subscription_id,
    provider_id: envelope.provider_id,
    transport: envelope.transport,
    payload: envelope.payload as unknown as Readonly<Record<string, unknown>>,
  };
}

/** Re-export để test/consistency check đọc cùng một nguồn. */
export type { JobRecord };
