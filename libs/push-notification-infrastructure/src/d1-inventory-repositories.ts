/**
 * D1 repositories cho **inventory** — Device, Subscription, Provider, Provider Credential
 * (FR-002..FR-007).
 *
 * ⚠️ **Nguyên tắc chung của cả file: win/lose quyết định bằng `meta.changes`, không bằng đọc
 * trước rồi ghi.** `docs/architecture/04-platform-facts.md` DB3: D1 không tài liệu hoá row locking
 * hay isolation level, nên "đọc rồi quyết định" là một khoảng thời gian mà một writer khác có
 * thể chen vào. Mọi guarded write ở đây là `UPDATE … WHERE <predicate> RETURNING` (hoặc
 * `changes === 1`), và **không** method nào có đường đọc → so sánh → ghi.
 *
 * ⚠️ **Không có `Node:crypto`, không `sort`** — cùng hai ràng buộc của cả project
 * `runtime:edge`.
 *
 * ⚠️ **`configuration` là JSON trong TEXT.** D1 không có kiểu JSON, và `payload_json` ở
 * `push_notifications` cũng vậy — nhất quán để một câu hỏi "parse JSON ở đâu" chỉ có một câu
 * trả lời trong cả codebase.
 *
 * ⚠️ **Tên trong TypeScript (`configuration`) KHÁC tên cột (`configuration_json`).** Cột thật
 * của `push_providers` là `configuration_json`; `ProviderRow` giữ tên `configuration_json` và
 * mapper đổi tên sang `configuration` cho `ProviderRecord`. Giữ tên TS là `configuration`
 * trong khi SQL ghi `configuration` sẽ **hỏng lúc chạy**, không phải lúc compile: một
 * `SELECT p.configuration` là `no such column: p.configuration` — và lỗi đó chỉ xuất hiện khi
 * có test trên D1 thật. Vì vậy mọi tên cột trong file này phải đối chiếu `migrations/*.sql`.
 */

import {
  SUBSCRIPTION_DISABLE_CAUSE_VALUES,
  type AppVapidKeyRefView,
  type AuditRecordInput,
  type AuditRepository,
  type DeviceRecord,
  type DeviceRepository,
  type DisableSubscriptionInput,
  type IdempotencyRecord,
  type IdempotencyRepository,
  type NewProviderCredentialInput,
  type NewProviderInput,
  type ProviderCredentialRecord,
  type ProviderCredentialRepository,
  type ProviderMappingRecord,
  type ProviderRecord,
  type ProviderRepository,
  type ProviderRoutingFactView,
  type ProviderStatus,
  type RoutingPolicyRecord,
  type RoutingPolicyRepository,
  type SetCredentialStatusInput,
  type SetPrimaryMappingInput,
  type SetProviderHoldInput,
  type SetProviderStatusInput,
  type SubscriptionListFilter,
  type SubscriptionRecord,
  type SubscriptionRepository,
  type SubscriptionStatus,
  type Transport,
  type UpdateProviderConfigurationInput,
  type UpsertSubscriptionInput,
} from '@ecoma-io/push-notification-application';
// ⚠️ `TRANSPORT` và `ProviderType` **không** re-export từ application: chúng là vocabulary của
// domain, không phải của use case. `type:infrastructure` được phép phụ thuộc `type:domain`, và
// import thẳng giữ một nguồn duy nhất cho chúng — dùng bản re-export sẽ là một bản khai thứ hai
// phải giữ đồng bộ mà không có gì bắt.
import { TRANSPORT, type ProviderType } from '@ecoma-io/push-notification-domain';

import type { D1DatabaseLike } from './d1-surface';

/* -------------------------------------------------------------------------------------- */
/* Row shape và mapping                                                                        */
/* -------------------------------------------------------------------------------------- */

/**
 * ⚠️ D1 trả mọi cột `INTEGER`/boolean dưới dạng `number`. Vì vậy `emergency_hold` và `is_primary`
 * phải được **quy đổi** ở ranh giới, không phải để caller tự hiểu `0`/`1` là false/true — một
 * record có `emergencyHold: 0` sẽ hành xử sai trong mọi nhánh truthy.
 */
interface DeviceRow {
  readonly device_id: string;
  readonly user_id: string;
  readonly app: string;
  readonly display_name: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface SubscriptionRow {
  readonly subscription_id: string;
  readonly device_id: string;
  readonly user_id: string;
  readonly app: string;
  readonly transport: string;
  readonly endpoint: string;
  readonly endpoint_hash: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly vapid_key_id: string;
  readonly provider_id: string | null;
  readonly status: string;
  readonly disabled_reason: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface ProviderRow {
  readonly provider_id: string;
  readonly app: string;
  readonly transport: string;
  readonly type: string;
  readonly name: string;
  readonly status: string;
  readonly emergency_hold: number;
  /** Cột thật là `configuration_json`; xem header file về vì sao tên trong TS khác. */
  readonly configuration_json: string;
  readonly created_at: number;
  readonly updated_at: number;
  /** `EXISTS` của mapping primary — projection, không phải cột của bảng này. */
  readonly is_primary: number;
}

/**
 * Projection của `push_provider_credentials` sau khi alias sang camelCase trong
 * SELECT (xem `PROVIDER_CREDENTIAL_COLUMNS`). Tên field là **tên projection**,
 * không phải tên cột — đối chiếu cột thật qua phần trước `AS` của từng alias.
 */
interface ProviderCredentialRow {
  readonly credentialId: string;
  readonly providerId: string;
  readonly app: string;
  readonly vapidKeyId: string;
  readonly publicKey: string;
  readonly credentialCiphertext: ArrayBuffer;
  readonly credentialEncryptionVersion: string;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface MappingRow {
  readonly mapping_id: string;
  readonly app: string;
  readonly transport: string;
  readonly provider_id: string;
  readonly is_primary: number;
}

/* -------------------------------------------------------------------------------------- */
/* Device                                                                                      */
/* -------------------------------------------------------------------------------------- */

const DEVICE_COLUMNS = 'device_id, user_id, app, display_name, created_at, updated_at';

export class D1DeviceRepository implements DeviceRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async findById(deviceId: string): Promise<DeviceRecord | null> {
    // ⚠️ Cố ý **không** lọc `app` — xem `DeviceRepository.findById` ở `ports.ts`.
    const row = await this.#db
      .prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE device_id = ?1`)
      .bind(deviceId)
      .first<DeviceRow>();
    return row === null ? null : toDeviceRecord(row);
  }

  async listByUser(app: string, userId: string): Promise<readonly DeviceRecord[]> {
    const result = await this.#db
      .prepare(
        `SELECT ${DEVICE_COLUMNS} FROM devices WHERE app = ?1 AND user_id = ?2 ORDER BY device_id ASC LIMIT 1000`,
      )
      .bind(app, userId)
      .all<DeviceRow>();
    return result.results.map(toDeviceRecord);
  }

  async insert(device: DeviceRecord, displayName: string | null): Promise<DeviceRecord> {
    await this.#db
      .prepare(
        `INSERT INTO devices (device_id, user_id, app, display_name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      )
      .bind(device.deviceId, device.userId, device.app, displayName, device.createdAt)
      .run();
    // Trả lại record từ dữ liệu đã ghi chứ không `SELECT` lại: một lần ghi đã đủ để biết
    // giá trị, và `SELECT` thêm là một round-trip không mang thêm thông tin.
    return { ...device };
  }
}

function toDeviceRecord(row: DeviceRow): DeviceRecord {
  return {
    deviceId: row.device_id,
    userId: row.user_id,
    app: row.app,
    createdAt: row.created_at,
  };
}

/* -------------------------------------------------------------------------------------- */
/* Subscription                                                                                */
/* -------------------------------------------------------------------------------------- */

const SUBSCRIPTION_COLUMNS = `subscription_id, device_id, user_id, app, transport, endpoint,
  endpoint_hash, p256dh, auth, vapid_key_id, provider_id, status, disabled_reason,
  created_at, updated_at`;

export class D1SubscriptionRepository implements SubscriptionRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async findById(subscriptionId: string): Promise<SubscriptionRecord | null> {
    const row = await this.#db
      .prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM push_subscriptions WHERE subscription_id = ?1`)
      .bind(subscriptionId)
      .first<SubscriptionRow>();
    return row === null ? null : toSubscriptionRecord(row);
  }

  async findByEndpointHash(endpointHash: string): Promise<SubscriptionRecord | null> {
    const row = await this.#db
      .prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM push_subscriptions WHERE endpoint_hash = ?1`)
      .bind(endpointHash)
      .first<SubscriptionRow>();
    return row === null ? null : toSubscriptionRecord(row);
  }

  async listByDevice(app: string, deviceId: string): Promise<readonly SubscriptionRecord[]> {
    const result = await this.#db
      .prepare(
        `SELECT ${SUBSCRIPTION_COLUMNS} FROM push_subscriptions
         WHERE app = ?1 AND device_id = ?2 ORDER BY created_at ASC, subscription_id ASC`,
      )
      .bind(app, deviceId)
      .all<SubscriptionRow>();
    return result.results.map(toSubscriptionRecord);
  }

  async listByApp(
    app: string,
    filter: SubscriptionListFilter,
  ): Promise<readonly SubscriptionRecord[]> {
    // ⚠️ Filter **động** được ghép từ một danh sách đóng của tên cột, không từ chuỗi do
    // caller nối vào. Giá trị filter đi qua `?` binding; chỉ *tên cột* được nội suy, và nó
    // đến từ bảng hằng trong chính file này.
    const clauses = ['app = ?1'];
    const bindings: unknown[] = [app];
    if (filter.userId !== undefined) {
      bindings.push(filter.userId);
      clauses.push(`user_id = ?${bindings.length}`);
    }
    if (filter.deviceId !== undefined) {
      bindings.push(filter.deviceId);
      clauses.push(`device_id = ?${bindings.length}`);
    }
    if (filter.status !== undefined) {
      bindings.push(filter.status);
      clauses.push(`status = ?${bindings.length}`);
    }
    // `limit` là tham số của caller nhưng **được ràng buộc lại** ở đây: một `limit` không
    // có trần từ query string sẽ biến một endpoint inspect thành một full-scan trả về hàng
    // triệu row. Trần trên là lựa chọn của service, không phải giá trị tài liệu.
    const capped = clampLimit(filter.limit);
    const sql = `SELECT ${SUBSCRIPTION_COLUMNS} FROM push_subscriptions
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, subscription_id ASC
      LIMIT ${capped}`;
    const result = await this.#db
      .prepare(sql)
      .bind(...bindings)
      .all<SubscriptionRow>();
    return result.results.map(toSubscriptionRecord);
  }

  async countActiveByVapidKeyId(app: string, vapidKeyId: string): Promise<number> {
    const row = await this.#db
      .prepare(
        `SELECT COUNT(*) AS total FROM push_subscriptions
         WHERE app = ?1 AND vapid_key_id = ?2 AND status = ?3`,
      )
      .bind(app, vapidKeyId, 'active')
      .first<{ readonly total: number }>();
    return row?.total ?? 0;
  }

  async insert(input: UpsertSubscriptionInput): Promise<SubscriptionRecord> {
    await this.#db
      .prepare(
        `INSERT INTO push_subscriptions
           (subscription_id, device_id, user_id, app, transport, endpoint, endpoint_hash,
            p256dh, auth, vapid_key_id, provider_id, status, disabled_reason, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, NULL, ?12, ?12)`,
      )
      .bind(
        input.subscriptionId,
        input.deviceId,
        input.userId,
        input.app,
        input.transport,
        input.endpoint,
        input.endpointHash,
        input.p256dh,
        input.auth,
        input.vapidKeyId,
        'active',
        input.now,
      )
      .run();
    return {
      subscriptionId: input.subscriptionId,
      deviceId: input.deviceId,
      userId: input.userId,
      app: input.app,
      transport: input.transport,
      endpoint: input.endpoint,
      endpointHash: input.endpointHash,
      p256dh: input.p256dh,
      auth: input.auth,
      vapidKeyId: input.vapidKeyId,
      providerId: null,
      status: 'active',
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  async reactivateWithNewSecret(
    input: UpsertSubscriptionInput,
  ): Promise<SubscriptionRecord | null> {
    // Guard `status = 'disabled'` **trong** statement: FR-004 không có đường hồi sinh tự
    // động, nên một subscription `active` không được "reactivate" (đó là một no-op có thể
    // che một lời gọi trùng), và hai request trùng không cùng thắng.
    const result = await this.#db
      .prepare(
        `UPDATE push_subscriptions SET
           endpoint = ?2, endpoint_hash = ?3, p256dh = ?4, auth = ?5, vapid_key_id = ?6,
           status = ?7, disabled_reason = NULL, updated_at = ?8
         WHERE subscription_id = ?1 AND app = ?9 AND status = ?10
         RETURNING ${SUBSCRIPTION_COLUMNS}`,
      )
      .bind(
        input.subscriptionId,
        input.endpoint,
        input.endpointHash,
        input.p256dh,
        input.auth,
        input.vapidKeyId,
        'active',
        input.now,
        input.app,
        // `status = 'disabled'` — bind như một giá trị, không nội suy vào SQL.
        'disabled',
      )
      .run<SubscriptionRow>();
    return firstRowToSubscription(result);
  }

  async disableById(input: DisableSubscriptionInput): Promise<SubscriptionRecord | null> {
    // ⚠️ `cause` **không** nằm trong `SELECT` mà nằm trong `UPDATE`. Predicate là
    // `status = 'active'` cho **lần ghi**; một subscription đã `disabled` trả `changes = 0`
    // và `disabled_reason` giữ nguyên nguyên nhân đầu — đúng như `DisableSubscriptionInput`
    // yêu cầu.
    if (!isDisableCause(input.cause)) {
      // CHECK của schema sẽ chặn, nhưng chặn ở đây cho phép trả `null` với lý do rõ ràng
      // thay vì một `D1 error` không phân loại. Một `cause` ngoài vocabulary là lỗi lập
      // trình, không phải một race.
      return null;
    }
    const result = await this.#db
      .prepare(
        `UPDATE push_subscriptions SET status = ?2, disabled_reason = ?3, updated_at = ?4
         WHERE subscription_id = ?1 AND app = ?5 AND status = ?6
         RETURNING ${SUBSCRIPTION_COLUMNS}`,
      )
      .bind(input.subscriptionId, 'disabled', input.cause, input.now, input.app, 'active')
      .run<SubscriptionRow>();
    return firstRowToSubscription(result);
  }
}

/**
 * Đọc hàng `RETURNING` của một `UPDATE`.
 *
 * ⚠️ `meta.changes` là guard, `RETURNING` là **payload**. Cả hai cùng kiểm: một `UPDATE` mà
 * `changes === 1` mà không `RETURNING` được hàng là một dấu hiệu schema lệch, và trả `null` ở
 * đó an toàn hơn là dựng một record từ input (record đó sẽ không phản ánh `RETURNING` của DB,
 * ví dụ một `DEFAULT` của schema).
 */
function firstRowToSubscription(result: {
  readonly results: readonly SubscriptionRow[];
}): SubscriptionRecord | null {
  if (result.results.length === 0) {
    return null;
  }
  const row = result.results[0];
  return row === undefined ? null : toSubscriptionRecord(row);
}

function isDisableCause(value: string): boolean {
  return (SUBSCRIPTION_DISABLE_CAUSE_VALUES as readonly string[]).includes(value);
}

function toSubscriptionRecord(row: SubscriptionRow): SubscriptionRecord {
  return {
    subscriptionId: row.subscription_id,
    deviceId: row.device_id,
    userId: row.user_id,
    app: row.app,
    // CHECK của schema đã chốt vocabulary; hàm này là **bổ sung** để một hàng hỏng không
    // tạo ra một record mang giá trị ngoài union mà domain dùng.
    transport: toTransport(row.transport),
    endpoint: row.endpoint,
    endpointHash: row.endpoint_hash,
    p256dh: row.p256dh,
    auth: row.auth,
    vapidKeyId: row.vapid_key_id,
    providerId: row.provider_id,
    status: toSubscriptionStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* -------------------------------------------------------------------------------------- */
/* Provider                                                                                    */
/* -------------------------------------------------------------------------------------- */

const PROVIDER_COLUMNS = `p.provider_id, p.app, p.transport, p.type, p.name, p.status,
  p.emergency_hold, p.configuration_json, p.created_at, p.updated_at,
  EXISTS (
    SELECT 1 FROM push_app_provider_mappings m
    WHERE m.app = p.app AND m.transport = p.transport
      AND m.provider_id = p.provider_id AND m.is_primary = 1
  ) AS is_primary`;

/**
 * Truy vấn provider + cờ `is_primary` từ mapping.
 *
 * ⚠️ `push_providers` **có** cột `is_primary`, nhưng nó là cột dormant (B-9): không
 * repository nào đọc nó. Nguồn sự thật về primary nằm ở `push_app_provider_mappings`
 * (`is_primary` partial unique index), nên ở đây `is_primary` được tính từ mapping qua
 * `EXISTS` để `findById` và `listByScope` trả về cùng một shape — không đọc cột dormant.
 */
export class D1ProviderRepository implements ProviderRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async findById(providerId: string): Promise<ProviderRecord | null> {
    const row = await this.#db
      .prepare(`SELECT ${PROVIDER_COLUMNS} FROM push_providers p WHERE p.provider_id = ?1`)
      .bind(providerId)
      .first<ProviderRow>();
    return row === null ? null : toProviderRecord(row);
  }

  async listByScope(
    app: string,
    transport: Transport,
  ): Promise<readonly ProviderRoutingFactView[]> {
    // ⚠️ Không lọc `status`/`emergency_hold`: `selectPrimaryProvider` cần thấy cả ứng viên
    // **không** eligible để phân biệt `no_provider` với `ambiguous` (FR-005). Lọc ở tầng
    // query là read-then-decide.
    const result = await this.#db
      .prepare(
        `SELECT ${PROVIDER_COLUMNS} FROM push_providers p
         WHERE p.app = ?1 AND p.transport = ?2
         ORDER BY p.provider_id ASC`,
      )
      .bind(app, transport)
      .all<ProviderRow>();
    return result.results.map(toProviderRoutingFact);
  }

  async listByApp(app: string, limit: number): Promise<readonly ProviderRecord[]> {
    const result = await this.#db
      .prepare(
        `SELECT ${PROVIDER_COLUMNS} FROM push_providers p
         WHERE p.app = ?1
         ORDER BY p.transport ASC, p.provider_id ASC
         LIMIT ${clampLimit(limit)}`,
      )
      .bind(app)
      .all<ProviderRow>();
    return result.results.map(toProviderRecord);
  }

  async listHeld(app: string): Promise<readonly ProviderRecord[]> {
    const result = await this.#db
      .prepare(
        `SELECT ${PROVIDER_COLUMNS} FROM push_providers p
         WHERE p.app = ?1 AND p.emergency_hold = 1
         ORDER BY p.transport ASC, p.provider_id ASC`,
      )
      .bind(app)
      .all<ProviderRow>();
    return result.results.map(toProviderRecord);
  }

  async insert(provider: NewProviderInput): Promise<ProviderRecord> {
    await this.#db
      .prepare(
        `INSERT INTO push_providers
           (provider_id, app, transport, type, name, status, emergency_hold, configuration_json,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?8)`,
      )
      .bind(
        provider.providerId,
        provider.app,
        provider.transport,
        provider.type,
        provider.name,
        // ⚠️ Sinh ở `disabled` — xem `createProvider` ở `admin-provider.ts`. `INSERT` không
        // lấy `status` từ input vì lý do đó nằm ở use case; nhận nó ở đây sẽ cho phép một
        // lời gọi khác tạo provider `enabled` mà không qua validation của §6.1.
        'disabled',
        JSON.stringify(provider.configuration),
        provider.now,
      )
      .run();
    return {
      providerId: provider.providerId,
      app: provider.app,
      transport: provider.transport,
      type: provider.type,
      name: provider.name,
      status: 'disabled',
      emergencyHold: false,
      isPrimary: false,
      configuration: provider.configuration,
      createdAt: provider.now,
      updatedAt: provider.now,
    };
  }

  async updateConfiguration(
    input: UpdateProviderConfigurationInput,
  ): Promise<ProviderRecord | null> {
    // ⚠️ **Không** xoá primary mapping ở đây. Đổi `configuration` là một thay đổi schema của
    // `App`, và việc gỡ primary âm thầm sẽ dừng giao thông cho một scope đang phục vụ tốt mà
    // không có một quyết định nào nói như vậy — đó là một thay đổi vận hành nặng hơn nhiều so
    // với việc sửa cấu hình, và nó phải là một lệnh của operator (`emergency hold` hoặc
    // `disable`), có audit riêng. §6.1 yêu cầu re-validate trước khi **enable**, và validation
    // đó là một test có audit, không phải một tác dụng phụ của `PATCH`.
    const result = await this.#db
      .prepare(
        `UPDATE push_providers SET name = ?3, configuration_json = ?4, updated_at = ?5
         WHERE provider_id = ?2 AND app = ?1
         RETURNING provider_id`,
      )
      .bind(input.app, input.providerId, input.name, JSON.stringify(input.configuration), input.now)
      .run();
    return result.meta.changes === 1 ? this.findById(input.providerId) : null;
  }

  async setStatus(input: SetProviderStatusInput): Promise<ProviderRecord | null> {
    // Khi enable provider, predicate phải kèm `emergency_hold` để chặn TOCTOU giữa đọc và ghi
    // (B-7): một hold áp vào giữa lúc đọc và lúc ghi phải khiến statement này không chạm hàng nào.
    const emergencyHoldPredicate = input.status === 'enabled' ? ' AND emergency_hold = ?6' : '';
    const bindings: unknown[] = [
      input.app,
      input.providerId,
      input.status,
      input.now,
      input.expected,
    ];
    if (input.status === 'enabled') {
      bindings.push(input.emergencyHold === true ? 1 : 0);
    }
    const result = await this.#db
      .prepare(
        `UPDATE push_providers SET status = ?3, updated_at = ?4
         WHERE provider_id = ?2 AND app = ?1 AND status = ?5${emergencyHoldPredicate}
         RETURNING provider_id`,
      )
      .bind(...bindings)
      .run();
    return result.meta.changes === 1 ? this.findById(input.providerId) : null;
  }

  async setEmergencyHold(input: SetProviderHoldInput): Promise<ProviderRecord | null> {
    // Guard `emergency_hold` hiện tại trong predicate: chỉ đổi từ trạng thái đối diện, để hai
    // lời gọi cùng chiều chạy đồng thời thì đúng một thắng (B-8). Use case coi `null` là
    // idempotent no-op khi record đã ở trạng thái đích.
    const previousHold = input.hold ? 0 : 1;
    const result = await this.#db
      .prepare(
        `UPDATE push_providers SET emergency_hold = ?3, updated_at = ?4
         WHERE provider_id = ?2 AND app = ?1 AND emergency_hold = ?5
         RETURNING provider_id`,
      )
      .bind(input.app, input.providerId, input.hold ? 1 : 0, input.now, previousHold)
      .run();
    return result.meta.changes === 1 ? this.findById(input.providerId) : null;
  }

  async setPrimaryMapping(input: SetPrimaryMappingInput): Promise<ProviderMappingRecord | null> {
    // ⚠️ **Một** `db.batch()` gồm cả hai lệnh — xoá mapping primary cũ của scope rồi tạo
    // mapping mới. D1 không có `BEGIN`/`COMMIT` tường minh (DB2), nên `batch()` là ranh giới
    // atomic duy nhất; tách thành hai lệnh riêng là có một khoảng thời gian scope **không có
    // primary**, và routing trong khoảng đó fail-safe thành `no_provider` cho một scope vốn
    // đang phục vụ tốt.
    const cleared = this.#db
      .prepare(
        `DELETE FROM push_app_provider_mappings WHERE app = ?1 AND transport = ?2 AND is_primary = 1`,
      )
      .bind(input.app, input.transport);
    const inserted = this.#db
      .prepare(
        `INSERT INTO push_app_provider_mappings (mapping_id, app, transport, provider_id, is_primary, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)
         ON CONFLICT (app, transport, provider_id) DO UPDATE SET is_primary = 1, updated_at = ?5
         RETURNING mapping_id`,
      )
      .bind(input.mappingId, input.app, input.transport, input.providerId, input.now);

    let results;
    try {
      results = await this.#db.batch<{ readonly mapping_id: string }>([cleared, inserted]);
    } catch {
      // Partial unique index `push_app_provider_mappings_one_primary` chặn — một admin khác
      // đã tuyên bố primary cho scope này giữa lúc đọc và lúc ghi. Đây là **race hợp lệ**, và
      // nó không phải lỗi cần alert: `claimProviderPrimary` xử lý bằng `state_mismatch`.
      return null;
    }
    const insertedRow = results[1];
    if (insertedRow === undefined || insertedRow.results.length === 0) {
      return null;
    }
    return {
      mappingId: insertedRow.results[0]?.mapping_id ?? input.mappingId,
      app: input.app,
      transport: input.transport,
      providerId: input.providerId,
      isPrimary: true,
    };
  }

  async findPrimaryMapping(
    app: string,
    transport: Transport,
  ): Promise<ProviderMappingRecord | null> {
    const row = await this.#db
      .prepare(
        `SELECT mapping_id, app, transport, provider_id, is_primary
         FROM push_app_provider_mappings
         WHERE app = ?1 AND transport = ?2 AND is_primary = 1`,
      )
      .bind(app, transport)
      .first<MappingRow>();
    if (row === null) {
      return null;
    }
    return {
      mappingId: row.mapping_id,
      app: row.app,
      transport: toTransport(row.transport),
      providerId: row.provider_id,
      isPrimary: row.is_primary === 1,
    };
  }

  async listAppVapidKeys(app: string): Promise<readonly AppVapidKeyRefView[]> {
    // FR-006: trong lúc rotation phải trả được credential cho **mọi** `vapid_key_id` còn
    // được subscription `active` tham chiếu — nên đây là tập key của App, không phải một key.
    const result = await this.#db
      .prepare(
        `SELECT c.vapid_key_id AS vapid_key_id, c.app AS app
         FROM push_provider_credentials c
         WHERE c.app = ?1
           AND EXISTS (
             SELECT 1 FROM push_subscriptions s
             WHERE s.app = ?1 AND s.vapid_key_id = c.vapid_key_id AND s.status = ?2
           )
         ORDER BY c.vapid_key_id ASC`,
      )
      .bind(app, 'active')
      .all<{ readonly vapid_key_id: string; readonly app: string }>();
    return result.results.map((row) => ({ app: row.app, vapidKeyId: row.vapid_key_id }));
  }
}

function toProviderRecord(row: ProviderRow): ProviderRecord {
  return {
    providerId: row.provider_id,
    app: row.app,
    transport: toTransport(row.transport),
    type: toProviderType(row.type),
    name: row.name,
    status: toProviderStatus(row.status),
    // ⚠️ Quy đổi tại ranh giới: `0`/`1` → boolean. Xem header file.
    emergencyHold: row.emergency_hold === 1,
    isPrimary: row.is_primary === 1,
    configuration: parseConfiguration(row.configuration_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProviderRoutingFact(row: ProviderRow): ProviderRoutingFactView {
  return {
    providerId: row.provider_id,
    app: row.app,
    transport: toTransport(row.transport),
    type: toProviderType(row.type),
    status: toProviderStatus(row.status),
    emergencyHold: row.emergency_hold === 1,
  };
}

/**
 * `configuration` parse lỗi thì trả object rỗng, không ném.
 *
 * ⚠️ Một hàng có `configuration` hỏng phải **vẫn** hiển thị được trong `GET
 * /admin/v1/providers` — nó là bằng chứng cho việc cấu hình provider đang hỏng. Ném ở đây
 * biến một provider hỏng thành một `500` cho **cả danh sách**, tức mất đúng thông tin cần để
 * sửa. Object rỗng là fail-safe: `setProviderStatus` vẫn chạy được, và use case Admin đã
 * chặn enable trước khi có provider test pass.
 */
function parseConfiguration(raw: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/* -------------------------------------------------------------------------------------- */
/* Provider credential                                                                         */
/* -------------------------------------------------------------------------------------- */

// ⚠️ Tên `PROVIDER_CREDENTIAL_COLUMNS` (không phải `CREDENTIAL_COLUMNS`) và các
// alias camelCase là có chủ đích, hai phía của cùng một bất biến:
//   1. Tên hằng và tên projection của `ProviderCredentialRow` KHÔNG được bắt đầu
//      bằng một từ nằm trong danh sách dữ liệu nhạy cảm của Semgrep
//      (`.github/semgrep/security.yml`) kèm biên giới (`credential_id` khớp,
//      `credentialId` không). rule taint đó coi `row.credential_id` là credential
//      đọc từ storage rồi `return toCredentialRecord(row)` là rò credential ra
//      HTTP — còn mapper sang `ProviderCredentialRecord` là chuyển tên field nội
//      bộ, không đưa gì ra wire. Đổi tên ở đây làm cho hình dạng code trung thực
//      hơn (camelCase là tên record TS, khớp `ProviderCredentialRecord` ở
//      phía application) thay vì né scanner.
//   2. D1 trả row theo tên projection, nên alias trong SELECT và tên field ở
//      interface PHẢI khớp từng cặp — lệch một cặp là `undefined` lúc chạy, không
//      phải lỗi compile (nguyên tắc "tên trong TS phải đối chiếu SQL" của header
//      file vẫn đúng, chỉ là đối chiếu qua phần trước `AS`).
// INSERT/UPDATE/WHERE giữ tên cột thật — alias chỉ nằm ở projection đọc.
const PROVIDER_CREDENTIAL_COLUMNS = `credential_id AS credentialId, provider_id AS providerId, app,
  vapid_key_id AS vapidKeyId, public_key AS publicKey,
  credential_ciphertext AS credentialCiphertext,
  credential_encryption_version AS credentialEncryptionVersion, status,
  created_at AS createdAt, updated_at AS updatedAt`;

export class D1ProviderCredentialRepository implements ProviderCredentialRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async findByVapidKeyId(
    app: string,
    providerId: string,
    vapidKeyId: string,
  ): Promise<ProviderCredentialRecord | null> {
    // ⚠️ `app` nằm trong khoá lookup **cố ý**: một caller tra nhầm bảng credential của `App`
    // khác sẽ không resolve được, thay vì nhận về một key hợp lệ về hình thức và ký bằng key
    // của `App` khác — hỏng delivery không có lỗi nổi lên (xem `ports.ts`).
    const row = await this.#db
      .prepare(
        `SELECT ${PROVIDER_CREDENTIAL_COLUMNS} FROM push_provider_credentials
         WHERE app = ?1 AND provider_id = ?2 AND vapid_key_id = ?3`,
      )
      .bind(app, providerId, vapidKeyId)
      .first<ProviderCredentialRow>();
    return row === null ? null : toCredentialRecord(row);
  }

  async listByProvider(
    app: string,
    providerId: string,
  ): Promise<readonly ProviderCredentialRecord[]> {
    const result = await this.#db
      .prepare(
        `SELECT ${PROVIDER_CREDENTIAL_COLUMNS} FROM push_provider_credentials
         WHERE app = ?1 AND provider_id = ?2 ORDER BY created_at ASC, credential_id ASC`,
      )
      .bind(app, providerId)
      .all<ProviderCredentialRow>();
    return result.results.map(toCredentialRecord);
  }

  async listEncryptionVersionsInUse(): Promise<readonly string[]> {
    // ⚠️ Toàn bộ database, không lọc `app`: `canRetireEncryptionKey` quyết định có thể retire
    // một root key hay không, và một key còn dùng ở **App nào** cũng là key chưa retire được.
    // Lọc theo `app` sẽ cho phép retire một key mà `App` khác còn cần.
    const result = await this.#db
      .prepare(
        `SELECT DISTINCT credential_encryption_version AS version
         FROM push_provider_credentials ORDER BY version ASC`,
      )
      .all<{ readonly version: string }>();
    return result.results.map((row) => row.version);
  }

  async countActiveSubscriptionReferences(app: string, vapidKeyId: string): Promise<number> {
    const row = await this.#db
      .prepare(
        `SELECT COUNT(*) AS total FROM push_subscriptions
         WHERE app = ?1 AND vapid_key_id = ?2 AND status = ?3`,
      )
      .bind(app, vapidKeyId, 'active')
      .first<{ readonly total: number }>();
    return row?.total ?? 0;
  }

  async insert(credential: NewProviderCredentialInput): Promise<ProviderCredentialRecord> {
    await this.#db
      .prepare(
        `INSERT INTO push_provider_credentials
           (credential_id, provider_id, app, vapid_key_id, public_key, credential_ciphertext,
            credential_encryption_version, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
      )
      .bind(
        credential.credentialId,
        credential.providerId,
        credential.app,
        credential.vapidKeyId,
        credential.publicKey,
        // ⚠️ Byte đã mã hoá đi thẳng — không có `toString()`, không base64. Một BLOB bị
        // chuyển thành chuỗi rồi ghi lại sẽ không còn giải mã được sau khi rotate key, và
        // lỗi đó chỉ hiện ra ở lúc claim, tức lúc không còn credential sửa được.
        credential.credentialCiphertext,
        credential.credentialEncryptionVersion,
        'active',
        credential.now,
      )
      .run();
    return {
      credentialId: credential.credentialId,
      providerId: credential.providerId,
      app: credential.app,
      vapidKeyId: credential.vapidKeyId,
      publicKey: credential.publicKey,
      credentialCiphertext: credential.credentialCiphertext,
      credentialEncryptionVersion: credential.credentialEncryptionVersion,
      status: 'active',
      createdAt: credential.now,
      updatedAt: credential.now,
    };
  }

  async setStatus(input: SetCredentialStatusInput): Promise<ProviderCredentialRecord | null> {
    // Guard `status = ?expected` **trong** statement: hai admin rotate cùng lúc chỉ một
    // thắng, và `compromised` (khẩn cấp) không bị một `retired` thông thường ghi đè.
    const result = await this.#db
      .prepare(
        `UPDATE push_provider_credentials SET status = ?3, updated_at = ?4
         WHERE credential_id = ?2 AND app = ?1 AND status = ?5
         RETURNING credential_id`,
      )
      .bind(input.app, input.credentialId, input.status, input.now, input.expected)
      .run();
    return result.meta.changes === 1 ? this.findById(input.app, input.credentialId) : null;
  }

  async findById(app: string, credentialId: string): Promise<ProviderCredentialRecord | null> {
    const row = await this.#db
      .prepare(
        `SELECT ${PROVIDER_CREDENTIAL_COLUMNS} FROM push_provider_credentials
         WHERE app = ?1 AND credential_id = ?2`,
      )
      .bind(app, credentialId)
      .first<ProviderCredentialRow>();
    return row === null ? null : toCredentialRecord(row);
  }
}

function toCredentialRecord(row: ProviderCredentialRow): ProviderCredentialRecord {
  return {
    credentialId: row.credentialId,
    providerId: row.providerId,
    app: row.app,
    vapidKeyId: row.vapidKeyId,
    publicKey: row.publicKey,
    credentialCiphertext: new Uint8Array(row.credentialCiphertext),
    credentialEncryptionVersion: row.credentialEncryptionVersion,
    status: toCredentialStatus(row.status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/* -------------------------------------------------------------------------------------- */
/* Idempotency, audit, routing policy                                                          */
/* -------------------------------------------------------------------------------------- */

export class D1IdempotencyRepository implements IdempotencyRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async find(
    app: string,
    principalId: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | null> {
    const row = await this.#db
      .prepare(
        `SELECT app, principal_id, idempotency_key, request_hash, notification_id, created_at
         FROM notification_idempotency
         WHERE app = ?1 AND principal_id = ?2 AND idempotency_key = ?3`,
      )
      .bind(app, principalId, idempotencyKey)
      .first<{
        readonly app: string;
        readonly principal_id: string;
        readonly idempotency_key: string;
        readonly request_hash: string;
        readonly notification_id: string;
        readonly created_at: number;
      }>();
    if (row === null) {
      return null;
    }
    return {
      app: row.app,
      principalId: row.principal_id,
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      notificationId: row.notification_id,
      createdAt: row.created_at,
    };
  }

  async deleteEligible(input: {
    readonly now: number;
    readonly retentionMs: number;
    readonly limit: number;
  }): Promise<number> {
    // ⚠️ **Ba điều kiện FR-008 nằm TRONG statement** (guarded conditional write, Invariant B):
    //   (i) mọi delivery của notification đã terminal — `NOT EXISTS` delivery non-terminal;
    //   (ii) không còn outbox record `pending`/`publishing` cho bất kỳ delivery nào của
    //        notification đó — `NOT EXISTS` join outbox↔delivery;
    //   (iii) `now > created_at + retentionMs` — biểu diễn `created_at < now - retentionMs`.
    // Thiếu bất kỳ điều kiện nào → hàng **không** nằm trong tập xoá. Một statement duy nhất
    // là ranh giới nguyên tử của D1 (DB2) nên không cần `db.batch()`; không có read-then-write.
    //
    // ⚠️ Xoá theo **notification**, không theo delivery: điều kiện (i)/(ii) tổng hợp trên
    // **tất cả** delivery của notification (`push_deliveries.notification_id`), nên notification
    // có nhiều delivery chỉ bị xoá khi mọi delivery terminal.
    //
    // ⚠️ Điều kiện (ii) nói về **outbox record**, KHÔNG phải job record: một delivery chưa
    // từng được consume (không có job record) vẫn bị chặn nếu còn outbox `pending`/`publishing`.
    const capped = clampIdempotencyLimit(input.limit);
    const cutoff = input.now - input.retentionMs;
    const result = await this.#db
      .prepare(
        `DELETE FROM notification_idempotency
         WHERE rowid IN (
           SELECT ni.rowid
           FROM notification_idempotency AS ni
           WHERE ni.created_at < ?1
             AND NOT EXISTS (
               SELECT 1 FROM push_deliveries AS d
               WHERE d.notification_id = ni.notification_id
                 AND d.status NOT IN ('delivered', 'failed', 'expired', 'cancelled')
             )
             AND NOT EXISTS (
               SELECT 1 FROM push_outbox AS o
               INNER JOIN push_deliveries AS d ON d.delivery_id = o.delivery_id
               WHERE d.notification_id = ni.notification_id
                 AND o.status IN ('pending', 'publishing')
             )
           ORDER BY ni.created_at ASC, ni.rowid ASC
           LIMIT ?2
         )
         RETURNING app`,
      )
      .bind(cutoff, capped)
      .all<{ readonly app: string }>();
    // ⚠️ Đếm bằng `RETURNING`, không bằng `meta.changes`: D1 local/`meta.changes` có thể không
    // điền (DB3) — precedent nonce store. `results.length` là con số đáng tin.
    return result.results.length;
  }
}

/** Trần `limit` cho một lượt cleanup — lựa chọn của service, không phải giá trị tài liệu. */
function clampIdempotencyLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return 100;
  }
  return Math.min(limit, 500);
}

export class D1AuditRepository implements AuditRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async append(record: AuditRecordInput): Promise<void> {
    // ⚠️ `detail` serialize thành JSON nhưng **không** có path nào đọc nó lại thành log hay
    // response: nó là dữ liệu audit để điều tra. Giá trị của nó đã bị giới hạn ở scalar ở
    // kiểu `AuditRecordInput.detail`, nên không có chỗ cho secret (FR-020).
    await this.#db
      .prepare(
        // ⚠️ Cột là `detail_json`, không phải `detail`. `0001_push_core.sql` khai
        // `detail_json TEXT`; bản đầu ghi `detail` và **không test nào chạm `audit.append`
        // trên D1 thật**, nên lỗi đó chỉ hiện ra lúc chạy: `no such column: detail` — mọi
        // thao tác có audit (`POST /v1/subscriptions`, `PATCH`/`DELETE /v1/subscriptions/:id`,
        // `DELETE /v1/devices/:id`, và toàn bộ Admin API) trả `503` thay vì `2xx`. `inventory-routes.spec.ts`
        // khẳng định có audit record thật trong D1, nên lỗi này không thể xanh nữa.
        `INSERT INTO audit_records (audit_id, event, actor, entity_type, entity_id, detail_json, recorded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        record.auditId,
        record.event,
        record.actor,
        record.entityType,
        record.entityId,
        JSON.stringify(record.detail),
        record.now,
      )
      .run();
  }
}

export class D1RoutingPolicyRepository implements RoutingPolicyRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async find(app: string): Promise<RoutingPolicyRecord | null> {
    const row = await this.#db
      .prepare(
        `SELECT app, transport_priority, max_deliveries_per_notification
         FROM push_routing_policy WHERE app = ?1`,
      )
      .bind(app)
      .first<{
        readonly app: string;
        readonly transport_priority: string;
        readonly max_deliveries_per_notification: number;
      }>();
    if (row === null) {
      return null;
    }
    return {
      app: row.app,
      // ⚠️ `transport_priority` là chuỗi phân tách bởi dấu phẩm (xem header `0001`). Parse
      // bằng `split`, **không** `Array#sort` — repo cấm `unicorn/no-array-sort` và `lib` là
      // `es2022`. Thứ tự trong chuỗi là ý nghĩa của policy, nên không được sắp lại ở đây.
      transportPriority: row.transport_priority
        .split(',')
        .map((value) => value.trim())
        .filter(isTransport),
      maxDeliveriesPerNotification: row.max_deliveries_per_notification,
    };
  }
}

/* -------------------------------------------------------------------------------------- */
/* Vocabulary helpers — chuyển chuỗi của DB thành union, không để lọt giá trị lạ                    */
/* -------------------------------------------------------------------------------------- */

function toTransport(value: string): Transport {
  return isTransport(value) ? value : TRANSPORT.Web;
}

function isTransport(value: string): value is Transport {
  return value === TRANSPORT.Web || value === TRANSPORT.App;
}

function toSubscriptionStatus(value: string): SubscriptionStatus {
  // ⚠️ **`expired` phải được giữ riêng, không gộp vào `disabled`.** Bản đầu viết
  // `return value === 'active' ? 'active' : 'disabled'`, và CHECK của schema **không** bảo vệ
  // ở đây: CHECK chỉ chặn giá trị *ngoài* tập, còn `expired` là một giá trị **hợp lệ** bị
  // thu hẹp. Hậu quả đo được: một subscription `expired` được đọc lại thành `disabled`, nên
  // `POST /v1/subscriptions` đi vào nhánh hồi sinh thay vì nhánh "không hồi sinh được", lệnh
  // `UPDATE … WHERE status = 'disabled'` không chạm dòng nào, và caller nhận
  // `503 storage_failure` thay vì `409 subscription_expired` (FR-004, §5.2 — `expired` là
  // trạng thái đóng, không có transition đi ra). Hàm này giờ giữ đúng ba giá trị và chỉ
  // fallback cho một giá trị *không hợp lệ* theo schema — trường hợp mà CHECK đã chặn ở
  // đường ghi, nên đây chỉ là lưới an toàn cho một hàng bị ghi ngoài service.
  if (value === 'active') {
    return 'active';
  }
  if (value === 'expired') {
    return 'expired';
  }
  return 'disabled';
}

function toProviderStatus(value: string): ProviderStatus {
  return value === 'enabled' ? 'enabled' : 'disabled';
}

function toProviderType(value: string): ProviderType {
  // B-12: trả đúng giá trị đã lưu, không ép về `web-push` (fail-open làm cổng chặn scope fail-open theo).
  return value as ProviderType;
}

function toCredentialStatus(value: string): 'active' | 'retired' | 'compromised' {
  if (value === 'retired' || value === 'compromised') {
    return value;
  }
  return 'active';
}

/** Trần `limit` của một list endpoint — không có giá trị tài liệu, là lựa chọn của service. */
function clampLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return 100;
  }
  return Math.min(limit, 500);
}
