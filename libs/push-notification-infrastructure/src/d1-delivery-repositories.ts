/**
 * D1 repositories cho **delivery** — Notification, Delivery, Outbox (FR-012, FR-013, FR-015,
 * FR-016) và idempotency write.
 *
 * ⚠️ **Đây là file quan trọng nhất của tầng infrastructure.** Mọi claim ở đây là guarded
 * conditional write mà §5.6 yêu cầu: predicate **nằm trong** statement, thắng/thua quyết định
 * bằng số hàng **thật sự** đổi (`docs/architecture/04-platform-facts.md` DB3), và
 * `dispatch_generation` tăng **trong cùng statement**. Không có một `SELECT` nào trong đường
 * claim.
 *
 * ⚠️ **`RETURNING` là hình thức đọc kết quả của một write, không phải đường "đọc rồi quyết".**
 * Một hàng được `RETURNING` về nghĩa là statement đó vừa thắng; thua thì không có hàng nào trả
 * về — đó là lý do `firstDeliveryRow` trả `null` chứ không phải một record rỗng. Xem
 * `d1-surface.ts` về `changes`.
 *
 * ⚠️ **`ORDER BY` là deterministic.** Mọi lô đều có `ORDER BY` trên một khoá tie-break
 * (`delivery_id`/`outbox_id`) bên cạnh khoá sắp xếp chính. Không có nó thì hai lượt claim chạy
 * song song có thể nhận **cùng** một tập hàng theo thứ tự ngẫu nhiên, và một lượt sẽ bị bỏ đói
 * trong khi lượt kia đói ở tập khác — một hiện tượng định kỳ mà rất khó tái hiện.
 */

import type {
  ApplyPublisherSuccessInput,
  ClaimDeliveryInput,
  ClaimDueOutboxInput,
  ClaimedOutboxRecord,
  CreateOutboxIntentInput,
  DeliveryClaimDiagnostics,
  DeliveryListFilter,
  DeliveryRecord,
  DeliveryRepository,
  DeliveryStatus,
  ListAgedNonTerminalInput,
  ListAgedOutboxInput,
  MarkDeliveryExpiredInput,
  NotificationRecord,
  NotificationRepository,
  OutboxRecord,
  OutboxRepository,
  PersistNotificationInput,
  ProviderStatus,
  RecordOutcomeInput,
  RecordPublishFailureInput,
  ReleaseLeaseInput,
  RetryFailedDeliveryInput,
  SubscriptionStatus,
} from '@ecoma-io/push-notification-application';

import type { D1DatabaseLike, D1PreparedStatement } from './d1-surface';

/* -------------------------------------------------------------------------------------- */
/* Row shapes                                                                                  */
/* -------------------------------------------------------------------------------------- */

interface NotificationRow {
  readonly notification_id: string;
  readonly app: string;
  readonly principal_id: string;
  readonly payload_json: string;
  readonly payload_bytes: number;
  readonly expires_at: number;
  readonly created_at: number;
}

interface DeliveryRow {
  readonly delivery_id: string;
  readonly notification_id: string;
  readonly subscription_id: string;
  readonly provider_id: string;
  readonly user_id: string;
  readonly device_id: string;
  readonly app: string;
  readonly transport: string;
  readonly status: string;
  readonly dispatch_generation: number;
  readonly lease_expires_at: number | null;
  readonly expires_at: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface OutboxRow {
  readonly outbox_id: string;
  readonly delivery_id: string;
  readonly status: string;
  readonly attempts: number;
  readonly available_at: number;
  readonly lease_expires_at: number | null;
  readonly claimed_by: string | null;
  readonly published_at: number | null;
  readonly last_error: string | null;
  readonly created_at: number;
}

/** Projection của Admin list — **không** có `payload_json` (xem `admin-delivery.ts`). */
type NotificationListRow = Omit<NotificationRow, 'payload_json'>;

interface DiagnosticColumns {
  readonly subscription_status: string;
  readonly provider_status: string;
  readonly provider_emergency_hold: number;
}

/* -------------------------------------------------------------------------------------- */
/* Notification                                                                                */
/* -------------------------------------------------------------------------------------- */

const NOTIFICATION_COLUMNS = `notification_id, app, principal_id, payload_json, payload_bytes,
  expires_at, created_at`;

export class D1NotificationRepository implements NotificationRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async persistNotificationWithDeliveries(input: PersistNotificationInput): Promise<void> {
    // ⚠️ **Một** `db.batch()` cho notification + mọi delivery + mọi outbox intent +
    // idempotency record. FR-008 yêu cầu idempotency record nằm trong cùng batch và §6.1 yêu
    // cầu outbox intent nằm trong cùng batch — đó là hai ràng buộc **về hình dạng lời gọi**, và
    // `db.batch()` là cách duy nhất biểu diễn chúng với D1 (không có `BEGIN`/`COMMIT`,
    // `docs/architecture/04-platform-facts.md` DB2).
    //
    // ⚠️ **Intent được ghép theo `delivery_id`, không theo chỉ số mảng.** `outboxIntents` là
    // một mảng riêng trong input, và khớp theo vị trí sẽ là một ghép âm thầm sai lệch khi use
    // case dựng hai mảng không cùng thứ tự. Use case đã bảo đảm **một intent cho mỗi delivery**,
    // nên ở đây chỉ cần tra cứu và **phải** ném nếu thiếu — một delivery không có intent là
    // một delivery sẽ không bao giờ được publish, và im lặng bỏ qua nó chỉ lộ ra ở
    // reconciliation, tức rất lâu sau khi notification đã trả `201`.
    const intentsByDelivery = new Map<string, CreateOutboxIntentInput>();
    for (const intent of input.outboxIntents) {
      intentsByDelivery.set(intent.deliveryId, intent);
    }

    const statements: D1PreparedStatement[] = [
      this.#db
        .prepare(
          `INSERT INTO push_notifications
             (notification_id, app, principal_id, payload_json, payload_bytes, expires_at,
              created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
        )
        .bind(
          input.notification.notificationId,
          input.notification.app,
          input.notification.principalId,
          input.notification.payloadJson,
          input.notification.payloadBytes,
          input.notification.expiresAt,
          input.notification.createdAt,
        ),
      this.#db
        .prepare(
          `INSERT INTO notification_idempotency
             (app, principal_id, idempotency_key, request_hash, notification_id, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(
          input.idempotency.app,
          input.idempotency.principalId,
          input.idempotency.idempotencyKey,
          input.idempotency.requestHash,
          input.idempotency.notificationId,
          input.idempotency.createdAt,
        ),
    ];

    for (const delivery of input.deliveries) {
      statements.push(
        this.#db
          .prepare(
            `INSERT INTO push_deliveries
               (delivery_id, notification_id, subscription_id, provider_id, user_id, device_id,
                app, transport, status, dispatch_generation, lease_expires_at, expires_at,
                created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, NULL, ?10, ?11, ?11)`,
          )
          .bind(
            delivery.deliveryId,
            delivery.notificationId,
            delivery.subscriptionId,
            delivery.providerId,
            delivery.userId,
            delivery.deviceId,
            delivery.app,
            delivery.transport,
            // ⚠️ `pending` là hằng của schema, không lấy từ input: FR-012 nói delivery được
            // tạo ở `pending` và routing xảy ra TRƯỚC enqueue, nên lúc commit chưa có message
            // nào trong Queue. `queued` chỉ có sau `Queue.send()` thành công (§6.2).
            'pending',
            // ⚠️ `expires_at` ghi **trùng** với `push_notifications.expires_at` **có chủ ý** —
            // predicate claim chạy trên `push_deliveries` và reconciliation quét
            // `push_deliveries(expires_at)`; hai cột được ghi trong **cùng** batch nên không
            // thể lệch nhau (xem header `0002_push_delivery_outbox.sql`).
            delivery.expiresAt,
            delivery.createdAt,
          ),
      );

      const intent = intentsByDelivery.get(delivery.deliveryId);
      if (intent === undefined) {
        throw new Error(
          `push-notification: thiếu outbox intent cho delivery ${delivery.deliveryId}`,
        );
      }
      statements.push(
        this.#db
          .prepare(
            `INSERT INTO push_outbox
               (outbox_id, delivery_id, status, attempts, available_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, 0, ?4, ?5, ?5)`,
          )
          .bind(
            intent.outboxId,
            intent.deliveryId,
            'pending',
            // ⚠️ `available_at` lấy từ **intent**, không phải `createdAt` của delivery: đó là
            // giá trị use case đã quyết định (v1 = `now`), và ghi ở đây một giá trị khác sẽ làm
            // intent đến hạn sớm hơn hoặc muộn hơn điều mà tài liệu quy định.
            intent.availableAt,
            intent.createdAt,
          ),
      );
    }

    await this.#db.batch(statements);
  }

  async findById(notificationId: string): Promise<NotificationRecord | null> {
    const row = await this.#db
      .prepare(`SELECT ${NOTIFICATION_COLUMNS} FROM push_notifications WHERE notification_id = ?1`)
      .bind(notificationId)
      .first<NotificationRow>();
    return row === null ? null : toNotificationRecord(row);
  }

  async listByApp(
    app: string,
    limit: number,
  ): Promise<readonly Omit<NotificationRecord, 'payloadJson'>[]> {
    // ⚠️ Danh sách chọn **tường minh** các cột không phải payload. Viết `SELECT *` rồi
    // `delete row.payload_json` sẽ để một payload lọt vào log/metric của một lỗi sau này.
    const result = await this.#db
      .prepare(
        `SELECT notification_id, app, principal_id, payload_bytes, expires_at, created_at
         FROM push_notifications
         WHERE app = ?1
         ORDER BY created_at DESC, notification_id ASC
         LIMIT ${clampLimit(limit)}`,
      )
      .bind(app)
      .all<NotificationListRow>();
    return result.results.map((row) => ({
      notificationId: row.notification_id,
      app: row.app,
      principalId: row.principal_id,
      payloadBytes: row.payload_bytes,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));
  }
}

function toNotificationRecord(row: NotificationRow): NotificationRecord {
  return {
    notificationId: row.notification_id,
    app: row.app,
    principalId: row.principal_id,
    payloadJson: row.payload_json,
    payloadBytes: row.payload_bytes,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/* -------------------------------------------------------------------------------------- */
/* Delivery                                                                                    */
/* -------------------------------------------------------------------------------------- */

const DELIVERY_COLUMNS = `delivery_id, notification_id, subscription_id, provider_id, user_id,
  device_id, app, transport, status, dispatch_generation, lease_expires_at, expires_at,
  created_at, updated_at`;

/**
 * `DELIVERY_COLUMNS` với mọi cột được tiền tố bằng alias của bảng.
 *
 * ⚠️ **Vì sao không `DELIVERY_COLUMNS.split(', ')`.** Bản đầu tiên tách hằng đó bằng chuỗi
 * `', '`, và hằng được viết **nhiều dòng** — nên `split(', ')` không cắt được ở newline và
 * cột `device_id`/`created_at` bị nuốt vào phần tử trước, mất tiền tố `d.`. Query sinh ra có
 * `d.user_id,\n  device_id` và SQLite từ chối bằng `ambiguous column name: device_id`, vì cột
 * đó tồn tại ở **cả** `push_deliveries` lẫn `push_subscriptions`. Lỗi này chỉ lộ ra ở
 * nhánh **claim thua** — tức đường chẩn đoán, chạy sau mọi lần claim thành công — nên một bộ
 * test chỉ khẳng định "claim thắng" sẽ không thấy nó.
 *
 * Vì vậy tách theo **dấu phẩy** rồi `trim()`, và giữ một assertion bên dưới bắt buộc hằng phải
 * là **một** cột mỗi phần tử.
 */
function deliveryColumnsQualifiedBy(alias: string): string {
  const columns = DELIVERY_COLUMNS.split(',').map((column) => column.trim());
  for (const column of columns) {
    if (!/^[a-z_]+$/u.test(column)) {
      throw new Error(
        `DELIVERY_COLUMNS phải là danh sách tên cột đơn giản, không phải biểu thức; gặp "${column}".`,
      );
    }
  }
  return columns.map((column) => `${alias}.${column}`).join(', ');
}

export class D1DeliveryRepository implements DeliveryRepository {
  readonly #db: D1DatabaseLike;

  /**
   * Tra `payload_json` của một notification.
   *
   * ⚠️ **Tiêm vào thay vì tự query.** `findNotificationPayload` đọc `push_notifications`, không
   * phải `push_deliveries` — và composition root **đã** giữ một `D1NotificationRepository`.
   * Tự query ở đây tạo ra hai đường cho cùng một bảng trong cùng một process, và một sửa đổi
   * projection của notification sẽ phải làm hai lần.
   */
  readonly #findNotificationPayload: (notificationId: string) => Promise<NotificationRecord | null>;

  constructor(
    db: D1DatabaseLike,
    findNotificationPayload?: (notificationId: string) => Promise<NotificationRecord | null>,
  ) {
    this.#db = db;
    this.#findNotificationPayload =
      findNotificationPayload ?? ((): Promise<NotificationRecord | null> => Promise.resolve(null));
  }

  async claimDelivery(input: ClaimDeliveryInput): Promise<DeliveryRecord | null> {
    // ⚠️ **Predicate đầy đủ của §8.1, trong MỘT statement.** Từng điều kiện và lý do nó ở đây:
    //
    // 1. `expires_at > now` — notification chưa quá hạn (FR-008).
    // 2. `(status = 'queued' OR (status = 'processing' AND lease_expires_at <= now))` —
    //    lease hết hạn thì claim lại (takeover). `processing` với lease còn hiệu lực thì
    //    execution khác **đang giữ** delivery.
    // 3. `EXISTS (subscription active)` — FR-016: không tạo/gửi delivery cho subscription
    //    đã biết không hợp lệ.
    // 4. `EXISTS (provider NOT emergency_hold)` — chỉ hold mới chặn delivery **đã
    //    materialize** (FR-005, §6.5).
    //
    // ⚠️ **`provider.status` CỐ Ý KHÔNG có trong predicate.** FR-005: `disabled` chỉ dừng
    // routing delivery **mới**; delivery đã materialize giữ `provider_id` và **tiếp tục**
    // được xử lý. Đưa `status = 'enabled'` vào đây là một lỗi phổ biến và rất đắt: nó biến
    // `disable` một provider thành việc hủy hàng loạt delivery đang chờ, thay vì dừng thêm
    // giao thông mới.
    //
    // ⚠️ `dispatch_generation + 1` **trong** `SET` — fencing token chỉ có nghĩa nếu nó tăng đúng
    // ở nơi predicate được đánh giá. Tính ở TypeScript rồi truyền vào sẽ mở ra đúng lớp hỏng mà
    // fencing sinh ra để chặn.
    //
    // ⚠️ `lease_expires_at` và `status = 'processing'` được ghi **cùng nhau** — schema có
    // CHECK `processing ⇔ lease_expires_at IS NOT NULL`, nên viết một mà không viết cái kia là
    // một constraint violation, tức lỗi D1 chứ không phải lỗi âm thầm.
    const result = await this.#db
      .prepare(
        `UPDATE push_deliveries SET
           status = ?3,
           dispatch_generation = dispatch_generation + 1,
           lease_expires_at = ?4,
           updated_at = ?2
         WHERE delivery_id = ?1
           AND expires_at > ?2
           AND (
             status = ?5
             OR (status = ?6 AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?2)
           )
           AND EXISTS (
             SELECT 1 FROM push_subscriptions s
             WHERE s.subscription_id = push_deliveries.subscription_id AND s.status = ?7
           )
           AND EXISTS (
             SELECT 1 FROM push_providers p
             WHERE p.provider_id = push_deliveries.provider_id AND p.emergency_hold = 0
           )
         RETURNING ${DELIVERY_COLUMNS}`,
      )
      .bind(
        input.deliveryId,
        input.now,
        'processing',
        input.now + input.leaseDurationMs,
        'queued',
        'processing',
        'active',
      )
      .run<DeliveryRow>();

    return firstDeliveryRow(result);
  }

  async findClaimDiagnostics(
    deliveryId: string,
    diagnosedAt: number,
  ): Promise<DeliveryClaimDiagnostics | null> {
    // ⚠️ Gom **cả** điều kiện của `decideDeliveryClaim` vào **một** lần đọc. Nếu repository trả
    // từng field bằng nhiều query thì "đọc chẩn đoán" biến thành read-then-decide với nhiều cửa
    // sổ, và `reason` được báo có thể không khớp state mà một nhánh khác sẽ thấy.
    //
    // ⚠️ `diagnosedAt` là **cùng** `now` mà claim vừa dùng (do use case truyền vào), không lấy
    // lại ở đây — xem `DeliveryRepository.findClaimDiagnostics`. Vì vậy nó **không** xuất hiện
    // trong SQL: đọc lại thời gian ở tầng lưu trữ sẽ cho phép một mốc khác với mốc predicate.
    void diagnosedAt;
    const row = await this.#db
      .prepare(
        `SELECT ${deliveryColumnsQualifiedBy('d')},
           COALESCE(s.status, 'missing') AS subscription_status,
           COALESCE(p.status, 'missing') AS provider_status,
           COALESCE(p.emergency_hold, 1) AS provider_emergency_hold
         FROM push_deliveries d
         LEFT JOIN push_subscriptions s ON s.subscription_id = d.subscription_id
         LEFT JOIN push_providers p ON p.provider_id = d.provider_id
         WHERE d.delivery_id = ?1`,
      )
      .bind(deliveryId)
      .first<DeliveryRow & DiagnosticColumns>();
    if (row === null) {
      return null;
    }
    return {
      delivery: toDeliveryRecord(row),
      subscriptionStatus: toDiagnosticSubscriptionStatus(row.subscription_status),
      providerStatus: toDiagnosticProviderStatus(row.provider_status),
      providerEmergencyHold: row.provider_emergency_hold === 1,
    };
  }

  async releaseLease(input: ReleaseLeaseInput): Promise<DeliveryRecord | null> {
    // ⚠️ **`dispatch_generation` KHÔNG đổi** (§5.6): `release` không cấp generation mới —
    // generation mới chỉ sinh ở lần claim kế tiếp. Viết `+ 1` ở đây sẽ khiến một execution
    // khác đang giữ generation hiện hành bị fence oan, tức một delivery bị bỏ rơi.
    //
    // ⚠️ Chấp nhận `status = 'queued'` **và** `processing`: gọi lặp sau một lần release trước là
    // một no-op idempotent mà vẫn trả hàng về (xem `decideFencedWrite` của domain) — miễn là
    // generation phải khớp và delivery chưa quá hạn.
    const result = await this.#db
      .prepare(
        `UPDATE push_deliveries SET status = ?3, lease_expires_at = NULL, updated_at = ?4
         WHERE delivery_id = ?1
           AND dispatch_generation = ?2
           AND status IN (?5, ?6)
           AND expires_at > ?4
         RETURNING ${DELIVERY_COLUMNS}`,
      )
      .bind(input.deliveryId, input.dispatchGeneration, 'queued', input.now, 'processing', 'queued')
      .run<DeliveryRow>();
    return firstDeliveryRow(result);
  }

  async recordOutcome(input: RecordOutcomeInput): Promise<DeliveryRecord | null> {
    // ⚠️ `status = 'processing'` **và** generation khớp **và** lease còn hiệu lực: ba điều kiện
    // của §8.1 cho `outcome`. Bỏ điều kiện lease còn hiệu lực sẽ cho một execution đã hết hạn
    // ghi đè kết quả của execution thế hệ sau.
    //
    // ⚠️ `delivered_at`/`failed_at` được gói trong `CASE` theo `outcome` **trong** statement:
    // một `delivered_at` set trên một `failed` (hoặc ngược lại) là một record không đọc
    // được, và viết nó bằng hai statement là hai transaction.
    const result = await this.#db
      .prepare(
        `UPDATE push_deliveries SET
           status = ?3,
           delivered_at = CASE WHEN ?3 = ?8 THEN ?4 ELSE delivered_at END,
           failed_at = CASE WHEN ?3 = ?9 THEN ?4 ELSE failed_at END,
           lease_expires_at = NULL,
           updated_at = ?4
         WHERE delivery_id = ?1
           AND dispatch_generation = ?2
           AND status = ?5
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at > ?4
         RETURNING ${DELIVERY_COLUMNS}`,
      )
      .bind(
        input.deliveryId,
        input.dispatchGeneration,
        input.outcome,
        input.now,
        'processing',
        input.deliveryId,
        input.deliveryId,
        'delivered',
        'failed',
      )
      .run<DeliveryRow>();
    return firstDeliveryRow(result);
  }

  async markExpired(input: MarkDeliveryExpiredInput): Promise<DeliveryRecord | null> {
    // Guard `status IN ('pending','queued','processing')` **trong** statement — đây là a1 + a6
    // của §4.2: terminal state không bị đụng, và không có đường nào hồi sinh terminal.
    //
    // ⚠️ `lease_expires_at = NULL` đi cùng: schema có CHECK `processing ⇔ lease NOT NULL`, nên
    // đánh dấu `expired` mà để lại lease là một constraint violation.
    // ⚠️ **Vế lease là bắt buộc, không phải phòng xa.** `01-architecture.md` §5.6 nói rõ: "Execution
    // **đang giữ lease** khi `expires_at` trôi qua **vẫn** ghi được `delivered`/`failed` — expiry
    // chặn claim **mới**, **không** huỷ một lần gửi đã bắt đầu". Nên một `processing` còn lease
    // **chưa** đủ điều kiện `expired`.
    //
    // Bỏ vế này thì một lượt reconciliation chạy đúng lúc một worker đang gửi sẽ đánh dấu
    // `expired` — một transition **một chiều** (`expired` MUST NOT requeue, §5.6). Message đã
    // tới provider, và hàng của nó không còn nơi ghi kết quả.
    //
    // ⚠️ Điều kiện lease **ở trong** statement, không phải một điều kiện ở application: hai
    // lượt reconciliation chạy song song (hoặc một lượt chạy đúng lúc claim) phải cùng bị quyết
    // định bởi cùng một predicate.
    const result = await this.#db
      .prepare(
        `UPDATE push_deliveries SET
           status = ?2, expired_at = ?3, lease_expires_at = NULL, updated_at = ?3
         WHERE delivery_id = ?1
           AND status IN (?4, ?5, ?6)
           AND expires_at <= ?3
           AND (status <> ?6 OR lease_expires_at IS NULL OR lease_expires_at <= ?3)
         RETURNING ${DELIVERY_COLUMNS}`,
      )
      .bind(input.deliveryId, 'expired', input.now, 'pending', 'queued', 'processing')
      .run<DeliveryRow>();
    return firstDeliveryRow(result);
  }

  async retryFailed(input: RetryFailedDeliveryInput): Promise<DeliveryRecord | null> {
    // ⚠️ Guard `status = 'failed'` — **transition duy nhất** rời terminal state (FR-015). Queue
    // redelivery `MUST NOT` hồi sinh delivery terminal.
    //
    // ⚠️ Generation **mới** do domain tính và truyền vào đây, không phải `+ 1` tại SQL: domain
    // cần chặn overflow (`nextDispatchGeneration` trả `null` khi tràn), và một generation âm
    // sẽ làm guard `AND dispatch_generation = :generation` của execution khác khớp trầm — tức
    // fencing bị **đảo chiều**.
    const result = await this.#db
      .prepare(
        `UPDATE push_deliveries SET
           status = ?2,
           dispatch_generation = ?3,
           lease_expires_at = NULL,
           updated_at = ?4
         WHERE delivery_id = ?1
           AND status = ?5
         RETURNING ${DELIVERY_COLUMNS}`,
      )
      .bind(input.deliveryId, 'queued', input.dispatchGeneration, input.now, 'failed')
      .run<DeliveryRow>();
    return firstDeliveryRow(result);
  }

  async findById(deliveryId: string): Promise<DeliveryRecord | null> {
    const row = await this.#db
      .prepare(`SELECT ${DELIVERY_COLUMNS} FROM push_deliveries WHERE delivery_id = ?1`)
      .bind(deliveryId)
      .first<DeliveryRow>();
    return row === null ? null : toDeliveryRecord(row);
  }

  async listAgedNonTerminal(input: ListAgedNonTerminalInput): Promise<readonly DeliveryRecord[]> {
    // ⚠️ `limit` **bắt buộc**: một lượt quét không giới hạn sẽ giữ một D1 transaction mở tới hết
    // đời request trên một bảng có thể có hàng triệu delivery mắc kẹt.
    //
    // ⚠️ Ngưỡng là `created_at <= olderThan`, **không** phải `expires_at`. `olderThan` là
    // `delivery_reconciliation_age` (§4.2 c) và đo **tuổi của delivery**; `expires_at` là hạn
    // nghiệp vụ của notification và là predicate của decision a1, được use case kiểm sau khi
    // đọc. Trộn hai mốc ở đây sẽ biến một lượt quét thành một bộ lọc nghiệp vụ im lặng.
    const result = await this.#db
      .prepare(
        `SELECT ${DELIVERY_COLUMNS} FROM push_deliveries
         WHERE status IN (?1, ?2, ?3)
           AND created_at <= ?4
         ORDER BY created_at ASC, delivery_id ASC
         LIMIT ${clampLimit(input.limit)}`,
      )
      .bind('pending', 'queued', 'processing', input.olderThan)
      .all<DeliveryRow>();
    return result.results.map(toDeliveryRecord);
  }

  async findNotificationPayload(notificationId: string): Promise<NotificationRecord | null> {
    return this.#findNotificationPayload(notificationId);
  }

  async listByApp(app: string, filter: DeliveryListFilter): Promise<readonly DeliveryRecord[]> {
    // ⚠️ Filter động ghép từ **tên cột** trong bảng hằng của file này; **giá trị** đi qua
    // binding. Nội suy tên cột từ input sẽ là SQL injection; nội suy ở đây chỉ dùng các literal
    // do chính file này viết.
    const clauses = ['app = ?1'];
    const bindings: unknown[] = [app];
    if (filter.notificationId !== undefined) {
      bindings.push(filter.notificationId);
      clauses.push(`notification_id = ?${String(bindings.length)}`);
    }
    if (filter.userId !== undefined) {
      bindings.push(filter.userId);
      clauses.push(`user_id = ?${String(bindings.length)}`);
    }
    if (filter.status !== undefined) {
      bindings.push(filter.status);
      clauses.push(`status = ?${String(bindings.length)}`);
    }
    const result = await this.#db
      .prepare(
        `SELECT ${DELIVERY_COLUMNS} FROM push_deliveries
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, delivery_id ASC
         LIMIT ${clampLimit(filter.limit)}`,
      )
      .bind(...bindings)
      .all<DeliveryRow>();
    return result.results.map(toDeliveryRecord);
  }
}

function firstDeliveryRow(result: {
  readonly results: readonly DeliveryRow[];
}): DeliveryRecord | null {
  const row = result.results[0];
  return row === undefined ? null : toDeliveryRecord(row);
}

function toDeliveryRecord(row: DeliveryRow): DeliveryRecord {
  return {
    deliveryId: row.delivery_id,
    notificationId: row.notification_id,
    subscriptionId: row.subscription_id,
    providerId: row.provider_id,
    userId: row.user_id,
    deviceId: row.device_id,
    app: row.app,
    transport: row.transport === 'app' ? 'app' : 'web',
    status: toDeliveryStatus(row.status),
    dispatchGeneration: row.dispatch_generation,
    leaseExpiresAt: row.lease_expires_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * `status` của một hàng ngoài CHECK.
 *
 * ⚠️ CHECK của schema là nguồn duy nhất, nên nhánh này chỉ để **không** để một hàng hỏng làm
 * hỏng cả tầng trên. Fallback là `failed` — **terminal** — chứ không phải một trạng thái
 * non-terminal: một hàng không nhận diện được phải không bao giờ được coi là có thể claim, và
 * `failed` là lựa chọn duy nhất trong 7 giá trị đạt điều đó.
 */
function toDeliveryStatus(value: string): DeliveryStatus {
  switch (value) {
    case 'pending':
    case 'queued':
    case 'processing':
    case 'delivered':
    case 'expired':
    case 'cancelled':
      return value;
    default:
      return 'failed';
  }
}

/**
 * `missing` từ `LEFT JOIN` là subscription không tồn tại → fail-closed `disabled`.
 *
 * ⚠️ Đây chỉ là **nhãn** cho `reason` của `409` (xem `DeliveryRepository.findClaimDiagnostics`),
 * không phải quyết định thắng/thua — nhưng fail-closed vẫn đúng vì nó là hướng duy nhất không
 * khiến một lời gọi chẩn đoán báo "eligible" cho một delivery không thể gửi.
 */
function toDiagnosticSubscriptionStatus(value: string): SubscriptionStatus {
  return value === 'active' ? 'active' : 'disabled';
}

/** `missing` từ `LEFT JOIN` là provider không tồn tại → fail-closed `disabled`. */
function toDiagnosticProviderStatus(value: string): ProviderStatus {
  return value === 'enabled' ? 'enabled' : 'disabled';
}

/* -------------------------------------------------------------------------------------- */
/* Outbox                                                                                      */
/* -------------------------------------------------------------------------------------- */

const OUTBOX_COLUMNS = `outbox_id, delivery_id, status, attempts, available_at, lease_expires_at,
  claimed_by, published_at, last_error, created_at`;

export class D1OutboxRepository implements OutboxRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async claimDue(input: ClaimDueOutboxInput): Promise<readonly ClaimedOutboxRecord[]> {
    // ⚠️ **Claim cả lô bằng MỘT statement.** `UPDATE … WHERE … IN (SELECT … LIMIT ?)` để
    // predicate (`status`/`available_at`/lease) và giới hạn lô nằm trong **cùng** câu lệnh — một
    // lượt lấy danh sách `outbox_id` trước rồi claim từng dòng sẽ để một lượt khác chen vào
    // giữa hai bước, và cả hai sẽ cùng thắng trên một record.
    //
    // ⚠️ `attempts` **không** tăng ở claim. `attempts` đếm số lần **publish thất bại** (§6.2),
    // và `recordPublishFailure` mới tăng nó — tăng ở claim sẽ đốt ngân sách retry cho những
    // lượt claim mà publisher crash trước khi kịp ghi.
    //
    // ⚠️ `failed` **không** nằm trong predicate: record `failed` không claimable, chỉ operator
    // mới đưa nó về đường publish qua `republish` (§4.3).
    const result = await this.#db
      .prepare(
        `UPDATE push_outbox SET
           status = ?3,
           claimed_at = ?1,
           lease_expires_at = ?4,
           claimed_by = ?5,
           updated_at = ?1
         WHERE outbox_id IN (
           SELECT outbox_id FROM push_outbox
           WHERE (
             (status = ?6 AND available_at <= ?1)
             OR (status = ?3 AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?1)
           )
           ORDER BY available_at ASC, outbox_id ASC
           LIMIT ?2
         )
         RETURNING ${OUTBOX_COLUMNS}`,
      )
      .bind(
        input.now,
        input.limit,
        'publishing',
        input.now + input.leaseDurationMs,
        input.claimedBy,
        'pending',
      )
      .all<OutboxRow>();
    // ⚠️ `leaseExpiresAt` là `now + leaseDurationMs` chứ không phải cột đọc về: nó là mốc quyết
    // định của **lần claim này**, và đọc lại nó sẽ cho một giá trị đã trôi theo độ trễ giữa
    // `UPDATE` và lúc `RETURNING`.
    return result.results.map((row) => ({
      record: toOutboxRecord(row),
      leaseExpiresAt: input.now + input.leaseDurationMs,
    }));
  }

  async findById(outboxId: string): Promise<OutboxRecord | null> {
    const row = await this.#db
      .prepare(`SELECT ${OUTBOX_COLUMNS} FROM push_outbox WHERE outbox_id = ?1`)
      .bind(outboxId)
      .first<OutboxRow>();
    return row === null ? null : toOutboxRecord(row);
  }

  async applyPublisherSuccess(input: ApplyPublisherSuccessInput): Promise<OutboxRecord | null> {
    // ⚠️ **Một** `db.batch()` gồm cả hai lệnh: đóng outbox record **và** (tuỳ §6.2) đặt delivery
    // `pending → queued`. Nếu tách thành hai transaction thì có một khoảng thời gian record
    // `published` mà delivery vẫn `pending` — và một lượt publisher khác quét `pending` sẽ tạo
    // **intent thứ hai** cho một delivery đã publish rồi.
    //
    // ⚠️ `deliveryWrite` là một union do `applyPublisherSuccess` của domain quyết định, không
    // phải một `status` tùy ý: chỉ khi delivery **vẫn** `pending` mới được ghi `queued`. Đã rời
    // `pending` thì chỉ ghi outbox — publish đã thật sự xảy ra nên record không được retry vô
    // hạn, và terminal state **không** được hồi sinh.
    //
    // ⚠️ Guard lease là `claimed_by = ?` **và** `status = 'publishing'`: một publisher không
    // còn giữ claim thì `MUST NOT` ghi, kể cả khi nó vừa gọi `send()` thành công. Kết quả là một
    // duplicate **có thể** xảy ra (đã chấp nhận ở §7) — hướng an toàn, vì hướng ngược lại là mất
    // message.
    // ⚠️ **Thứ tự hai lệnh trong batch là load-bearing, và đảo nó sẽ hỏng.** Các lệnh trong
    // `db.batch()` chạy **tuần tự** theo thứ tự mảng. Lệnh chuyển delivery lên đầu và **tự
    // mang điều kiện lease của chính nó** (`EXISTS` trên `push_outbox`), rồi lệnh đóng intent
    // chạy sau.
    //
    // ⚠️ **Vì sao không được để lệnh đóng intent chạy trước.** Nó xoá `claimed_by` và ghi
    // `status = 'published'`. Lệnh sau muốn kiểm "lease còn của mình" thì đọc một hàng đã bị
    // xoá dấu vết đó — nên phải chạy trước, và khi đó nó **không** còn kiểm được gì.
    //
    // ⚠️ **Vì sao lệnh đầu KHÔNG được vô điều kiện.** Batch của D1 rollback khi một lệnh
    // **ném**; còn `UPDATE … RETURNING` có predicate không khớp thì **không ném** — nó trả
    // **zero rows** và coi như thành công. Nên nếu lệnh chuyển delivery không tự guard lease,
    // một `claimed_by` sai vẫn khiến nó ghi, còn lệnh đóng intent thì không — tức một delivery
    // `queued` mà **không intent nào được publish**. Message không tới Queue, và không có gì
    // trong D1 để biết điều đó xảy ra. Đây là lý do điều kiện lease nằm **trong** lệnh đầu.
    const statements: D1PreparedStatement[] = [];

    if (input.deliveryWrite.kind === 'advance_to_queued') {
      statements.push(
        this.#db
          .prepare(
            `UPDATE push_deliveries SET status = ?2, updated_at = ?3
             WHERE delivery_id = ?1
               AND status = ?4
               AND EXISTS (
                 SELECT 1 FROM push_outbox o
                 WHERE o.outbox_id = ?5 AND o.claimed_by = ?6 AND o.status = ?7
               )
             RETURNING delivery_id`,
          )
          .bind(
            input.deliveryId,
            'queued',
            input.now,
            'pending',
            input.outboxId,
            input.claimedBy,
            'publishing',
          ),
      );
    }

    statements.push(
      this.#db
        .prepare(
          `UPDATE push_outbox SET
             status = ?3, published_at = ?4, lease_expires_at = NULL,
             claimed_by = NULL, claimed_at = NULL, updated_at = ?4
           WHERE outbox_id = ?1 AND claimed_by = ?2 AND status = ?5
           RETURNING ${OUTBOX_COLUMNS}`,
        )
        .bind(input.outboxId, input.claimedBy, 'published', input.now, 'publishing'),
    );

    const results = await this.#db.batch<OutboxRow>(statements);
    const closed = results[results.length - 1];
    if (closed === undefined) {
      return null;
    }
    const row = closed.results[0];
    // ⚠️ Không có hàng `RETURNING` ⇒ lease đã mất ⇒ **không lệnh nào được ghi** (nhờ điều
    // kiện lease ở lệnh đầu), và publisher phải coi đây là một lượt bị bỏ qua an toàn.
    return row === undefined ? null : toOutboxRecord(row);
  }

  async recordPublishFailure(input: RecordPublishFailureInput): Promise<OutboxRecord | null> {
    // ⚠️ `status` **do câu lệnh quyết định**: `failed` khi `attempts + 1 >= maxAttempts`, ngược
    // lại `pending` với `available_at = now + backoff`. Viết `status` từ TypeScript sẽ phải đọc
    // `attempts` trước để so với ngưỡng — read-then-write, và hai lượt sẽ cùng tính một `attempts`
    // khác nhau.
    //
    // ⚠️ Khi về `failed`, `available_at` **không** được đẩy theo backoff: cột này là "lúc nào
    // claimable" và một record `failed` không claimable (§6.1).
    const result = await this.#db
      .prepare(
        `UPDATE push_outbox SET
           attempts = attempts + 1,
           status = CASE WHEN attempts + 1 >= ?5 THEN ?6 ELSE ?7 END,
           available_at = CASE WHEN attempts + 1 >= ?5 THEN available_at ELSE ?4 END,
           lease_expires_at = NULL,
           claimed_by = NULL,
           claimed_at = NULL,
           published_at = NULL,
           last_error = ?8,
           updated_at = ?4
         WHERE outbox_id = ?1 AND claimed_by = ?2 AND status = ?3
         RETURNING ${OUTBOX_COLUMNS}`,
      )
      .bind(
        input.outboxId,
        input.claimedBy,
        'publishing',
        input.now + input.backoffMs,
        input.maxAttempts,
        'failed',
        'pending',
        // ⚠️ `sanitizedError` do use case đã khử; schema còn giữ một trần 512 ký tự làm chốt
        // chặn cuối ở tầng database.
        input.sanitizedError,
      )
      .run<OutboxRow>();
    return firstOutboxRow(result);
  }

  async createIntent(input: CreateOutboxIntentInput): Promise<OutboxRecord | null> {
    // ⚠️ **`INSERT OR IGNORE`, không phải `INSERT`.** Partial unique index
    // `push_outbox_one_open_intent` chặn intent thứ hai cho một `delivery_id`; với `INSERT`
    // thuần, lỗi đó nổi lên như một exception. Và nó **không** phải lỗi cần alert: §4.2 nói rõ
    // index này là guard chống dồn intent, tức một race hợp lệ giữa hai reconciler hoặc giữa hai
    // lời gọi `republish`. `OR IGNORE` biến nó thành `null` — cùng kết quả với "intent đã tồn
    // tại" — mà reconciliation vẫn **đếm** nó để "không có lỗi" và "chưa từng chạy" không trông
    // giống nhau trong metric.
    //
    // ⚠️ `OR IGNORE` chỉ bỏ qua **vi phạm ràng buộc**, không bỏ qua CHECK. Một `delivery_id`
    // không tồn tại vẫn tạo được intent (không có foreign key), và publisher sẽ bỏ qua nó với
    // một `skip` đếm được — có đếm, có audit path, không im lặng.
    const result = await this.#db
      .prepare(
        `INSERT OR IGNORE INTO push_outbox
           (outbox_id, delivery_id, status, attempts, available_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, ?4, ?5, ?5)
         RETURNING ${OUTBOX_COLUMNS}`,
      )
      .bind(input.outboxId, input.deliveryId, 'pending', input.availableAt, input.createdAt)
      .run<OutboxRow>();
    return firstOutboxRow(result);
  }

  async hasOpenIntent(deliveryId: string): Promise<boolean> {
    const row = await this.#db
      .prepare(
        `SELECT 1 AS present FROM push_outbox
         WHERE delivery_id = ?1 AND status IN (?2, ?3) LIMIT 1`,
      )
      .bind(deliveryId, 'pending', 'publishing')
      .first<{ readonly present: number }>();
    return row !== null;
  }

  async countOpenIntents(deliveryId: string): Promise<number> {
    const row = await this.#db
      .prepare(
        `SELECT COUNT(*) AS total FROM push_outbox
         WHERE delivery_id = ?1 AND status IN (?2, ?3)`,
      )
      .bind(deliveryId, 'pending', 'publishing')
      .first<{ readonly total: number }>();
    return row?.total ?? 0;
  }

  async listAgedOpen(input: ListAgedOutboxInput): Promise<readonly OutboxRecord[]> {
    const result = await this.#db
      .prepare(
        `SELECT ${OUTBOX_COLUMNS} FROM push_outbox
         WHERE status IN (?1, ?2)
           AND created_at <= ?3
         ORDER BY created_at ASC, outbox_id ASC
         LIMIT ${clampLimit(input.limit)}`,
      )
      .bind('pending', 'publishing', input.olderThan)
      .all<OutboxRow>();
    return result.results.map(toOutboxRecord);
  }

  async listFailed(limit: number): Promise<readonly OutboxRecord[]> {
    // ⚠️ **Không lọc `app`.** `push_outbox` cố ý không lưu `app` (§6.1: `delivery_id` là tham
    // chiếu duy nhất), nên một list scoped theo App sẽ cần join delivery — và đó là một query khác
    // hẳn về hình dạng. `listFailed` phục vụ quét cho **operator** (§4.2 a3: không tự phục hồi),
    // nên nó là một danh sách toàn hệ thống theo mức độ hỏng, và đó là đúng.
    const result = await this.#db
      .prepare(
        `SELECT ${OUTBOX_COLUMNS} FROM push_outbox
         WHERE status = ?1
         ORDER BY updated_at ASC, outbox_id ASC
         LIMIT ${clampLimit(limit)}`,
      )
      .bind('failed')
      .all<OutboxRow>();
    return result.results.map(toOutboxRecord);
  }
}

function firstOutboxRow(result: { readonly results: readonly OutboxRow[] }): OutboxRecord | null {
  const row = result.results[0];
  return row === undefined ? null : toOutboxRecord(row);
}

function toOutboxRecord(row: OutboxRow): OutboxRecord {
  return {
    outboxId: row.outbox_id,
    deliveryId: row.delivery_id,
    status: toOutboxStatus(row.status),
    attempts: row.attempts,
    availableAt: row.available_at,
    leaseExpiresAt: row.lease_expires_at,
    claimedBy: row.claimed_by,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

function toOutboxStatus(value: string): 'pending' | 'publishing' | 'published' | 'failed' {
  switch (value) {
    case 'publishing':
    case 'published':
    case 'failed':
      return value;
    default:
      // ⚠️ Fallback `pending`, **không** phải `failed`: một record ta không nhận diện được phải
      // không biến thành một cái cần operator, và cũng không được là `publishing` (giữ một lease
      // không tồn tại). `pending` là trạng thái duy nhất mà một lượt claim sau có thể xử lý lại
      // an toàn.
      return 'pending';
  }
}

/** Trần `limit` — lựa chọn của service, không phải giá trị tài liệu. */
function clampLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return 100;
  }
  return Math.min(limit, 500);
}
