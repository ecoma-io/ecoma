/**
 * Nạp cấu hình của `push-notification` từ biến môi trường — **fail closed**.
 *
 * ⚠️ Hàm này **ném** khi thiếu bất kỳ tham số bắt buộc nào, và thông điệp chỉ nêu **tên
 * biến**, không bao giờ nêu **giá trị**. Đó là hai quyết định độc lập cùng có chủ đích:
 *
 * 1. **Ném ở biên khởi động** thay vì trả `null`: config thiếu nghĩa là service không có
 *    hành vi đúng để phục vụ bất kỳ request nào. Fail lúc deploy rõ ràng hơn là fail ở
 *    request đầu tiên của production.
 * 2. **Chỉ nêu tên biến**: giá trị của một biến cấu hình có thể là secret (nếu nó là secret
 *    chứ không phải SLA), và thông điệp lỗi đi vào log của Worker — nơi mọi ai đọc được log
 *    đều thấy. Không có `String(env[NAME])` ở bất kỳ đâu trên đường lỗi này.
 *
 * Sáu tham số SLA ở `resolveSla` là nơi ràng buộc "fail closed" sống: chúng **không** có
 * default. Xem bảng tại `config-port.ts` vì sao mỗi tên bị chặn trên đại lượng nào.
 */

import { DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST } from './records';
import type {
  ConfigEnvironment,
  ControlPlaneAuth,
  CredentialKeyring,
  EngineeringParameters,
  PushNotificationConfig,
  RuntimeCallerAuth,
  RuntimeMetadata,
  SlaParameters,
} from './config-port';
import {
  readHostAllowlist,
  readMillisecondsWithDefault,
  readOptional,
  readPositiveIntegerWithDefault,
  readRequiredMilliseconds,
  requireSecret,
} from './config-port';

/** Biến môi trường, theo đúng tên tài liệu — không phải tên rút gọn. */
export const CONFIG_VARIABLE = {
  /* Sáu SLA — không default. */
  IdempotencyRetention: 'IDEMPOTENCY_RETENTION_MS',
  CallerRetryWindow: 'CALLER_RETRY_WINDOW_MS',
  MaxNotificationTtl: 'MAX_NOTIFICATION_TTL_MS',
  PayloadDigestAlgorithm: 'PAYLOAD_DIGEST_ALGORITHM',
  OutboxRecoverySla: 'OUTBOX_RECOVERY_SLA_MS',
  DeliveryReconciliationAge: 'DELIVERY_RECONCILIATION_AGE_MS',
  /* Engineering — có default. */
  DeliveryLeaseDuration: 'DELIVERY_LEASE_DURATION_MS',
  NotificationRateLimit: 'NOTIFICATION_RATE_LIMIT',
  NotificationRateLimitWindow: 'NOTIFICATION_RATE_LIMIT_WINDOW_MS',
  OutboxBatchSize: 'OUTBOX_BATCH_SIZE',
  OutboxLeaseDuration: 'OUTBOX_LEASE_DURATION_MS',
  OutboxMaxPublishAttempts: 'OUTBOX_MAX_PUBLISH_ATTEMPTS',
  OutboxPublishBackoff: 'OUTBOX_PUBLISH_BACKOFF_MS',
  ReconciliationBatchSize: 'RECONCILIATION_BATCH_SIZE',
  OutboxReconciliationBatchSize: 'OUTBOX_RECONCILIATION_BATCH_SIZE',
  DefaultMaxDeliveries: 'DEFAULT_MAX_DELIVERIES_PER_NOTIFICATION',
  ProviderTestTimeout: 'PROVIDER_TEST_TIMEOUT_MS',
  /* Auth / keyring / allowlist. */
  RuntimePrincipal: 'RUNTIME_API_EXPECTED_PRINCIPAL',
  RuntimeSharedSecret: 'RUNTIME_API_SHARED_SECRET',
  AdminToken: 'ADMIN_API_TOKEN',
  AdminPrincipal: 'ADMIN_API_PRINCIPAL',
  ApplicationToken: 'APPLICATION_API_TOKEN',
  ApplicationPrincipal: 'APPLICATION_API_PRINCIPAL',
  CredentialKeyVersion: 'CREDENTIAL_KEY_VERSION',
  CredentialServingVersions: 'CREDENTIAL_SERVING_VERSIONS',
  EndpointHostAllowlist: 'PUSH_ENDPOINT_HOST_ALLOWLIST',
  /* Metadata. */
  Environment: 'ENVIRONMENT',
  LogLevel: 'LOG_LEVEL',
} as const;

/**
 * Giá trị hợp lệ của `PAYLOAD_DIGEST_ALGORITHM` ở v1.
 *
 * ⚠️ Vì sao chỉ có `none`: `01-architecture.md` §8.1 nói thuật toán digest là **open item** và
 * `payload_digest` phải **vắng** khi chưa chốt. Chấp nhận một tên thuật toán bất kỳ sẽ khiến
 * service ghi một digest mà worker không thể xác minh — worker đối chiếu digest theo contract
 * và sẽ từ chối những response vốn hợp lệ, tệ hơn nhiều so với không có digest. Khi thuật toán
 * được chốt, giá trị hợp lệ **thêm** vào đây cùng lúc với `PayloadDigester`.
 */
export const SUPPORTED_PAYLOAD_DIGEST_ALGORITHMS: readonly string[] = ['none'];

/**
 * Lỗi cấu hình — mang **tên biến** cần sửa, không mang giá trị.
 *
 * `problems` là danh sách vấn đề, mỗi phần tử là **tên biến** hoặc một câu mô tả ràng buộc bị
 * vi phạm có nêu tên biến. Kiểu là `readonly string[]` chứ không phải một union các loại lỗi:
 * người đọc log cần một danh sách để sửa tất cả cùng lúc, và tách nó thành nhiều lớp chỉ để
 * phân biệt "thiếu" với "sai" là chi phí không đổi lấy gì.
 */
export class PushConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `Thiếu hoặc sai cấu hình bắt buộc của push-notification: ${problems.join('; ')}. ` +
        'Giá trị của tham số SLA là quyết định của service owner (launch gate — ' +
        'docs/architecture/03-operations.md §10), nên service fail closed thay vì tự chọn default.',
    );
    this.name = 'PushConfigError';
    this.problems = problems;
  }
}

/**
 * Nạp sáu tham số SLA — **không có default nào**, kể cả khi biến có mặt nhưng sai hình dạng.
 *
 * ⚠️ `payload_digest_algorithm` được xử lý khác phần còn lại: nó không phải số mà là **tên**
 * thuật toán. Vẫn bắt buộc (FR-008/§8.1 nêu tên tham số là bắt buộc), nhưng giá trị hợp lệ ở
 * v1 chỉ có `none`. Thiếu **hoặc** sai đều là `PushConfigError`, vì cả hai đều nghĩa là
 * "chưa có một quyết định đã chốt".
 */
export function resolveSla(env: ConfigEnvironment): SlaParameters {
  const missing: string[] = [];

  const idempotencyRetentionMs = requireMilliseconds(
    env,
    CONFIG_VARIABLE.IdempotencyRetention,
    missing,
  );
  const callerRetryWindowMs = requireMilliseconds(env, CONFIG_VARIABLE.CallerRetryWindow, missing);
  const maxNotificationTtlMs = requireMilliseconds(
    env,
    CONFIG_VARIABLE.MaxNotificationTtl,
    missing,
  );
  const outboxRecoverySlaMs = requireMilliseconds(env, CONFIG_VARIABLE.OutboxRecoverySla, missing);
  const deliveryReconciliationAgeMs = requireMilliseconds(
    env,
    CONFIG_VARIABLE.DeliveryReconciliationAge,
    missing,
  );

  const algorithm = readOptional(env, CONFIG_VARIABLE.PayloadDigestAlgorithm);
  if (algorithm === null || !SUPPORTED_PAYLOAD_DIGEST_ALGORITHMS.includes(algorithm)) {
    missing.push(CONFIG_VARIABLE.PayloadDigestAlgorithm);
  }

  if (missing.length > 0) {
    throw new PushConfigError(missing);
  }
  if (algorithm !== 'none') {
    // Đã kiểm tập hợp ở trên; nhánh này chỉ để thu hẹp kiểu mà không ép cưỡng xuống union
    // `PayloadDigestAlgorithm` — TS không suy ra `includes` thu hẹp `string` về `'none'`.
    throw new PushConfigError([CONFIG_VARIABLE.PayloadDigestAlgorithm]);
  }

  return {
    idempotencyRetentionMs: idempotencyRetentionMs ?? 0,
    callerRetryWindowMs: callerRetryWindowMs ?? 0,
    maxNotificationTtlMs: maxNotificationTtlMs ?? 0,
    payloadDigestAlgorithm: 'none',
    outboxRecoverySlaMs: outboxRecoverySlaMs ?? 0,
    deliveryReconciliationAgeMs: deliveryReconciliationAgeMs ?? 0,
  };
}

/**
 * Đọc một epoch-millis bắt buộc, ghi tên biến vào `missing` khi thiếu **hoặc** sai.
 *
 * Vì sao trả `number | null` rồi dùng `?? 0` ở nơi dựng kết quả: `missing` rỗng là bất biến
 * của nhánh thành công, nhưng TypeScript không đi theo nó. `?? 0` ở đây **không** phải
 * default — nhánh đó đã ném; giá trị ở đây chỉ để thỏa bộ kiểu và không bao giờ quan sát
 * được. `readRequiredMilliseconds` vẫn là nơi kiểm hình dạng.
 */
function requireMilliseconds(
  env: ConfigEnvironment,
  name: string,
  missing: string[],
): number | null {
  const value = readRequiredMilliseconds(env, name);
  if (value === null) {
    missing.push(name);
    return null;
  }
  return value;
}

/**
 * Tham số kỹ thuật — **có default**, đổi được bằng env.
 *
 * ⚠️ Vì sao default ở đây được phép còn SLA thì không: các giá trị dưới đây là **lựa chọn kỹ
 * thuật** mà control plane phải có một giá trị nào để chạy (lease bao lâu, poll bao nhiêu
 * record), và tài liệu giao chúng cho vận hành quyết định. Không giá trị nào trong số đó là
 * một **cam kết correctness với bên ngoài**: đổi default không phá tính đúng của hệ thống,
 * còn đổi mặc định của `idempotency_retention` thì phá.
 *
 * ⚠️ `maxIdempotencyKeyLength` là **hằng hợp đồng**, không phải tham số cấu hình: FR-008 nói
 * `Idempotency-Key` ≤ 128 và CHECK của schema cũng chặn 128. Cho nó ghi đè được qua env là
 * mở đường để service chấp nhận key dài hơn hợp đồng đã công bố cho caller.
 */
export function resolveEngineering(env: ConfigEnvironment): EngineeringParameters {
  return {
    deliveryLeaseDurationMs: readMillisecondsWithDefault(
      env,
      CONFIG_VARIABLE.DeliveryLeaseDuration,
      60_000,
    ),
    notificationRateLimit: readPositiveIntegerWithDefault(
      env,
      CONFIG_VARIABLE.NotificationRateLimit,
      600,
    ),
    notificationRateLimitWindowMs: readMillisecondsWithDefault(
      env,
      CONFIG_VARIABLE.NotificationRateLimitWindow,
      60_000,
    ),
    outboxBatchSize: readPositiveIntegerWithDefault(env, CONFIG_VARIABLE.OutboxBatchSize, 50),
    outboxLeaseDurationMs: readMillisecondsWithDefault(
      env,
      CONFIG_VARIABLE.OutboxLeaseDuration,
      30_000,
    ),
    outboxMaxPublishAttempts: readPositiveIntegerWithDefault(
      env,
      CONFIG_VARIABLE.OutboxMaxPublishAttempts,
      5,
    ),
    outboxPublishBackoffMs: readMillisecondsWithDefault(
      env,
      CONFIG_VARIABLE.OutboxPublishBackoff,
      5_000,
    ),
    reconciliationBatchSize: readPositiveIntegerWithDefault(
      env,
      CONFIG_VARIABLE.ReconciliationBatchSize,
      100,
    ),
    outboxReconciliationBatchSize: readPositiveIntegerWithDefault(
      env,
      CONFIG_VARIABLE.OutboxReconciliationBatchSize,
      100,
    ),
    defaultMaxDeliveriesPerNotification: readPositiveIntegerWithDefault(
      env,
      CONFIG_VARIABLE.DefaultMaxDeliveries,
      100,
    ),
    maxIdempotencyKeyLength: 128,
    providerTestTimeoutMs: readMillisecondsWithDefault(
      env,
      CONFIG_VARIABLE.ProviderTestTimeout,
      5_000,
    ),
  };
}

/** Metadata runtime — không phải secret, nên có default hợp lý. */
export function resolveRuntimeMetadata(env: ConfigEnvironment): RuntimeMetadata {
  const level = readOptional(env, CONFIG_VARIABLE.LogLevel);
  return {
    service: 'push-notification',
    environment: readOptional(env, CONFIG_VARIABLE.Environment) ?? 'local',
    logLevel: level === 'debug' || level === 'warn' || level === 'error' ? level : 'info',
  };
}

/**
 * Keyring của root encryption key — **chỉ tên version**, không phải key material.
 *
 * ⚠️ `servingVersions` phải **chứa** `currentVersion`: ghi bằng `K2` trong khi `K2` không
 * được phục vụ nghĩa là mọi credential mới ghi ra đều không đọc được, và lỗi đó chỉ lộ ra ở
 * claim — tức lúc đã gửi notification thật (`§7.3`).
 */
export function resolveCredentialKeyring(env: ConfigEnvironment): CredentialKeyring {
  const missing: string[] = [];
  const currentVersion = requireSecret(env, CONFIG_VARIABLE.CredentialKeyVersion);
  if (currentVersion === null) {
    missing.push(CONFIG_VARIABLE.CredentialKeyVersion);
  }
  const rawServing = readOptional(env, CONFIG_VARIABLE.CredentialServingVersions);
  if (rawServing === null) {
    missing.push(CONFIG_VARIABLE.CredentialServingVersions);
  }
  const servingVersions = parseServingVersions(rawServing);
  if (currentVersion !== null && !servingVersions.includes(currentVersion)) {
    missing.push(CONFIG_VARIABLE.CredentialServingVersions);
  }
  if (missing.length > 0) {
    throw new PushConfigError(missing);
  }
  return { currentVersion: currentVersion ?? '', servingVersions };
}

/** Parse danh sách version phục vụ dạng CSV. Rỗng → `[]` để caller báo lỗi theo. */
function parseServingVersions(raw: string | null): readonly string[] {
  if (raw === null) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Auth của private delivery runtime API — shared secret bắt buộc (`§7.1`). */
export function resolveRuntimeAuth(env: ConfigEnvironment): RuntimeCallerAuth {
  const missing: string[] = [];
  const expectedPrincipal = readOptional(env, CONFIG_VARIABLE.RuntimePrincipal);
  if (expectedPrincipal === null) {
    missing.push(CONFIG_VARIABLE.RuntimePrincipal);
  }
  const sharedSecret = requireSecret(env, CONFIG_VARIABLE.RuntimeSharedSecret);
  if (sharedSecret === null) {
    missing.push(CONFIG_VARIABLE.RuntimeSharedSecret);
  }
  if (missing.length > 0) {
    throw new PushConfigError(missing);
  }
  return {
    expectedPrincipal: expectedPrincipal ?? '',
    sharedSecret: sharedSecret ?? '',
  };
}

/** Auth của Admin API + Application API — token bắt buộc (FR-019). */
export function resolveControlPlaneAuth(env: ConfigEnvironment): ControlPlaneAuth {
  const missing: string[] = [];
  const adminToken = requireSecret(env, CONFIG_VARIABLE.AdminToken);
  if (adminToken === null) {
    missing.push(CONFIG_VARIABLE.AdminToken);
  }
  const adminPrincipal = readOptional(env, CONFIG_VARIABLE.AdminPrincipal);
  if (adminPrincipal === null) {
    missing.push(CONFIG_VARIABLE.AdminPrincipal);
  }
  const applicationToken = requireSecret(env, CONFIG_VARIABLE.ApplicationToken);
  if (applicationToken === null) {
    missing.push(CONFIG_VARIABLE.ApplicationToken);
  }
  const applicationPrincipal = readOptional(env, CONFIG_VARIABLE.ApplicationPrincipal);
  if (applicationPrincipal === null) {
    missing.push(CONFIG_VARIABLE.ApplicationPrincipal);
  }
  if (missing.length > 0) {
    throw new PushConfigError(missing);
  }
  return {
    adminToken: adminToken ?? '',
    adminPrincipal: adminPrincipal ?? '',
    applicationToken: applicationToken ?? '',
    applicationPrincipal: applicationPrincipal ?? '',
  };
}

/**
 * Nạp toàn bộ cấu hình. Đây là hàm mà composition root gọi **một lần** lúc khởi động.
 *
 * ⚠️ Không cache ở đây: cache thuộc composition root (`apps/push-notification/src/config.ts`)
 * vì cache là quyết định về vòng đời của Worker isolate, không phải về hình dạng cấu hình. Giữ
 * nó ở application layer khiến test không kiểm soát được cache và dễ dẫn tới một promise bị
 * cache **cùng với** rejection — tức một config sai sẽ không bao giờ được nạp lại sau khi
 * operator sửa xong.
 */
export function resolvePushNotificationConfig(env: ConfigEnvironment): PushNotificationConfig {
  const config: PushNotificationConfig = {
    sla: resolveSla(env),
    engineering: resolveEngineering(env),
    runtime: resolveRuntimeMetadata(env),
    runtimeAuth: resolveRuntimeAuth(env),
    controlPlaneAuth: resolveControlPlaneAuth(env),
    credentialKeyring: resolveCredentialKeyring(env),
    pushEndpointHostAllowlist: readHostAllowlist(
      env,
      CONFIG_VARIABLE.EndpointHostAllowlist,
      DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
    ),
  };
  assertConfigCoherence(config);
  return config;
}

/**
 * Kiểm các ràng buộc giữa những tham số đã nạp — chạy **sau** khi tất cả đều có mặt.
 *
 * ⚠️ Đây là kiểm của **tài liệu**, không phải phán đoán: FR-008 nói `idempotency_retention`
 * **MUST** ≥ `caller_retry_window`. Hai giá trị đều là quyết định của owner; đặt retention
 * nhỏ hơn retry window là một cam kết tự mâu thuẫn, và service **phải** báo chứ không nên
 * "làm cho nó chạy được".
 *
 * ⚠️ Nó **không** kiểm `idempotency_retention` ≥ `max_notification_ttl + queue_retention +
 * delivery_reconciliation_age`: `queue_retention` là thuộc tính của Queue của delivery
 * plane, không phải biến của control plane này, và suy ra nó ở đây là bịa một ràng buộc mà
 * không ai chốt. Ba đại lượng đó là điều kiện của **operator** khi chốt giá trị.
 *
 * ⚠️ Nó **không** kiểm `delivery_lease_duration` ≤ `max_notification_ttl` như một ràng buộc
 * tài liệu: tài liệu không yêu cầu điều đó, và tự đặt ra sẽ là tự bịa thêm một cam kết. Lease
 * dài hơn TTL không sai — claim vẫn chặn ở `expires_at > now`, và worker kiểm `expires_at`
 * một lần trước khi gọi provider (`§8.1`).
 */
export function assertConfigCoherence(config: PushNotificationConfig): void {
  const { sla } = config;
  const problems: string[] = [];
  if (sla.idempotencyRetentionMs < sla.callerRetryWindowMs) {
    problems.push(
      `${CONFIG_VARIABLE.IdempotencyRetention} phải ≥ ${CONFIG_VARIABLE.CallerRetryWindow} (FR-008)`,
    );
  }
  if (sla.callerRetryWindowMs > sla.maxNotificationTtlMs) {
    problems.push(
      `${CONFIG_VARIABLE.CallerRetryWindow} phải ≤ ${CONFIG_VARIABLE.MaxNotificationTtl} (FR-008)`,
    );
  }
  if (problems.length > 0) {
    throw new PushConfigError(problems);
  }
}
