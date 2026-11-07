/**
 * Cấu hình của `push-notification` — **một** module, và chỗ duy nhất đọc biến môi trường.
 *
 * ⚠️ **Sáu tham số SLA không được tự chọn giá trị.** `02-requirements.md` FR-008 và
 * `03-operations.md` §11 nói rõ: giá trị của `idempotency_retention` là quyết định của
 * service owner + business owner, là **launch gate**, và implementation `MUST NOT` tự
 * chọn hoặc khởi tạo một giá trị tuỳ ý — phải **fail closed** khi chưa cấu hình. Sáu tên
 * dưới đây là sáu tên đó:
 *
 * | Tên                          | Chặn trên cái gì                                                            |
 * | ---------------------------- | -------------------------------------------------------------------------- |
 * | `idempotency_retention`      | `caller_retry_window` và `max_notification_ttl + queue_retention + delivery_reconciliation_age` (FR-008) |
 * | `caller_retry_window`        | cam kết công bố cho caller về replay idempotent (FR-008)                    |
 * | `max_notification_ttl`       | hạn nghiệp vụ `expires_at` của notification (FR-008 Expiry)                  |
 * | `payload_digest_algorithm`   | `payload_digest` trong response `200` của claim — optional vì đây là open item (§8.1) |
 * | `outbox_recovery_sla`        | thời gian phát hiện + alert cho delivery `pending` không có intent (`§4.2` a3) |
 * | `delivery_reconciliation_age`| ngưỡng tuổi mà reconciliation (c) quét non-terminal delivery (`§4.2`)          |
 *
 * Hàm vi phạm: ghi một default "hợp lý" cho một trong sáu tên này. Hậu quả không phải là
 * chạy chậm hơn — nó là một cam kết sai được viết vào hành vi mà không ai đã chốt, và
 * `idempotency_retention` sai còn biến replay hợp lệ của caller thành tạo notification
 * **trùng** (FR-008 đánh dấu đây là correctness, không phải dọn dẹp).
 *
 * ⚠️ Vì sao throw thay vì trả `null`/`ok: false`: `loadConfig` được gọi **một lần** ở
 * composition root, trước khi bất kỳ request nào được phục vụ. Một config thiếu thì service
 * không có hành vi đúng để chạy nửa vời — ném ngay làm deploy fail sớm và rõ ràng, thay vì
 * để request đầu tiên tới mới phát hiện. Thông điệp chỉ nêu **tên biến**, không bao giờ nêu
 * **giá trị**: giá trị thiếu có thể là chuỗi rỗng, và log của một Worker đọc được.
 *
 * ⚠️ Vì sao không có `trim()`: một secret có khoảng trắng quanh là **secret khác**, và
 * `trim()` sẽ biến việc cấu hình sai thành việc im lặng chạy được với một giá trị operator
 * không bao giờ định viết. Bất biến "không trim" được dùng lại ở `requireSecret`.
 */

/* -------------------------------------------------------------------------------------- */
/* Hình dạng cấu hình                                                                        */
/* -------------------------------------------------------------------------------------- */

/**
 * Sáu tham số SLA — **tách riêng khỏi** tham số kỹ thuật để một lỗi kiểu là bằng chứng, không
 * phải một giá trị mặc định lọt vào chỗ không ai nhìn.
 */
export interface SlaParameters {
  /** Epoch millis. FR-008 — điều kiện xoá idempotency record (iii). */
  readonly idempotencyRetentionMs: number;
  /** Epoch millis. FR-008 — cửa sổ replay mà contract hứa với caller. */
  readonly callerRetryWindowMs: number;
  /** Epoch millis. FR-008 Expiry — `expires_at = created_at + maxNotificationTtlMs`. */
  readonly maxNotificationTtlMs: number;
  /**
   * Thuật toán digest của `payload_digest` — **tên**, không phải key.
   *
   * ⚠️ Giá trị hợp lệ duy nhất ở v1 là `none`: `01-architecture.md` §8.1 nói thuật toán digest
   * là **open item**, và `payload_digest` phải **vắng** khi chưa chốt. Nên tên biến bắt buộc,
   * nhưng giá trị hợp lệ tường minh là "không dùng" — cấu hình nó sai không phải lỗi cấu
   * hình mà là một digest bịa, và worker đối chiếu theo nó sẽ từ chối những response vốn hợp lệ.
   */
  readonly payloadDigestAlgorithm: 'none';
  /** Epoch millis. `§4.2` a3 — SLA phát hiện + alert cho delivery `pending` mồ côi. */
  readonly outboxRecoverySlaMs: number;
  /** Epoch millis. `§4.2` (c) — ngưỡng tuổi quét non-terminal delivery. */
  readonly deliveryReconciliationAgeMs: number;
}

/** Tham số kỹ thuật có **default** — đổi được bằng env, không cần chốt giá trị. */
export interface EngineeringParameters {
  /** Epoch millis — độ dài lease của claim (`§8.1`: `lease_duration` do control plane cấu hình). */
  readonly deliveryLeaseDurationMs: number;
  /** Số request/1 phút theo `App` (FR-021). */
  readonly notificationRateLimit: number;
  /** Epoch millis — độ dài một cửa sổ rate limit. */
  readonly notificationRateLimitWindowMs: number;
  /** Số record claim trong một lượt publisher (`03-operations.md` §4). */
  readonly outboxBatchSize: number;
  /** Epoch millis — lease của một lần claim outbox. */
  readonly outboxLeaseDurationMs: number;
  /** Số lần publish thử lại trước khi record thành `failed` (§6.2). */
  readonly outboxMaxPublishAttempts: number;
  /** Epoch millis — backoff của một lần publish lỗi (§6.2). */
  readonly outboxPublishBackoffMs: number;
  /** Số delivery quét mỗi lượt reconciliation (c). */
  readonly reconciliationBatchSize: number;
  /** Số record quét mỗi lượt outbox reconciliation (a). */
  readonly outboxReconciliationBatchSize: number;
  /** Trần recipient mỗi request khi policy của `App` không ghi đè (FR-008). */
  readonly defaultMaxDeliveriesPerNotification: number;
  /** Trần `Idempotency-Key` (FR-008: bắt buộc ≤ 128, và CHECK của schema cũng chặn). */
  readonly maxIdempotencyKeyLength: number;
  /** Tham số cấu hình cho provider test (FR-018). */
  readonly providerTestTimeoutMs: number;
}

/** Thông tin môi trường để ghi log — **không** phải secret. */
export interface RuntimeMetadata {
  readonly environment: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly service: string;
}

/** Principal của private delivery runtime API (`§8.1`: `X-ECOMA-PRINCIPAL`). */
export interface RuntimeCallerAuth {
  /** Hằng kỳ vọng — `svc.web-push-notification-job` ở v1. */
  readonly expectedPrincipal: string;
  /** Shared secret từ Cloudflare Worker Secret (`§7.1`). */
  readonly sharedSecret: string;
}

/** Authorization của Admin API / Application API (FR-019). */
export interface ControlPlaneAuth {
  /** Bearer token của Backoffice. */
  readonly adminToken: string;
  /** Principal của Backoffice, ghi vào audit. */
  readonly adminPrincipal: string;
  /** Bearer token của application (`ecoma-io`) trên Application API. */
  readonly applicationToken: string;
  /** Principal của application; `app` của request phải khớp principal này (§8.2). */
  readonly applicationPrincipal: string;
}

export interface CredentialKeyring {
  /**
   * Version của root key dùng cho ghi mới.
   *
   * ⚠️ Đây là **tên version**, không phải key material — root key là Worker Secret và không
   * đi qua config này (`§7.4`). Keyring chỉ cần biết "phiên bản nào là current" để ghi
   * `credential_encryption_version` và "phiên bản nào còn phục vụ" để giải mã.
   */
  readonly currentVersion: string;
  /** Tất cả version còn phục vụ — trong lúc rotation `K1 → K2` phải có cả hai. */
  readonly servingVersions: readonly string[];
}

export interface PushNotificationConfig {
  readonly sla: SlaParameters;
  readonly engineering: EngineeringParameters;
  readonly runtime: RuntimeMetadata;
  readonly runtimeAuth: RuntimeCallerAuth;
  readonly controlPlaneAuth: ControlPlaneAuth;
  readonly credentialKeyring: CredentialKeyring;
  /** Allowlist host của Browser Push Service (FR-003). */
  readonly pushEndpointHostAllowlist: readonly string[];
}

/* -------------------------------------------------------------------------------------- */
/* Env source                                                                                */
/* -------------------------------------------------------------------------------------- */

/**
 * Nguồn biến môi trường — một interface nhỏ để test cấu hình **không** cần chạm Worker global.
 *
 * `ENVIRONMENT` là `Env` của Worker khi chạy thật; test truyền một object thuần. Đây cũng là
 * chỗ duy nhất trong control plane được phép đọc `globalThis` kiểu env — application layer
 * không có binding nào (`type:application` không được phụ thuộc Cloudflare).
 */
export interface ConfigEnvironment {
  readonly [key: string]: unknown;
}

/* -------------------------------------------------------------------------------------- */
/* Đọc biến: ba hàm, ba hành vi khác nhau                                                    */
/* -------------------------------------------------------------------------------------- */

/**
 * Biến **bắt buộc**: thiếu → `null`.
 *
 * ⚠️ Cố ý **không** `trim()` và **không** coi chuỗi rỗng là hợp lệ: một biến được set thành
 * `""` là cấu hình sai, và im lặng dùng `""` là cách một service chạy với secret rỗng.
 */
export function readOptional(env: ConfigEnvironment, name: string): string | null {
  const raw = env[name];
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  return raw;
}

/**
 * Số nguyên epoch millis **bắt buộc**: thiếu → `null`; có nhưng không phải số nguyên dương →
 * `null` **và** tên biến bị nêu trong thông điệp của `loadConfig`.
 *
 * ⚠️ Vì sao validate ngay ở đây thay vì để tầng dưới phát hiện: một `NaN` lọt xuống
 * `expires_at` làm cổng `expires_at <= now` **luôn sai** (so sánh với `NaN` cho `false`),
 * tức một notification đã hết hạn vẫn đi qua đường requeue — đúng cái fail-open mà FR-015
 * cấm. Validate ở biên cấu hình là chỗ rẻ nhất để bắt.
 */
export function readRequiredMilliseconds(env: ConfigEnvironment, name: string): number | null {
  const raw = readOptional(env, name);
  if (raw === null) {
    return null;
  }
  if (!/^[0-9]+$/u.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Số nguyên có default — cho tham số kỹ thuật. */
export function readMillisecondsWithDefault(
  env: ConfigEnvironment,
  name: string,
  fallback: number,
): number {
  const raw = readOptional(env, name);
  if (raw === null) {
    return fallback;
  }
  if (!/^[0-9]+$/u.test(raw)) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Số nguyên có default. */
export function readPositiveIntegerWithDefault(
  env: ConfigEnvironment,
  name: string,
  fallback: number,
): number {
  return readMillisecondsWithDefault(env, name, fallback);
}

/**
 * Secret bắt buộc — thiếu → `null`, và **không** `trim()`.
 *
 * ⚠️ `no-trim` là bất biến có chủ đích: `trim()` làm một secret bị copy-paste kèm newline
 * trở thành secret **khác** mà vẫn dùng được, nên lỗi cấu hình biến thành lỗi xác thực
 * (401) ở runtime thay vì lỗi deploy. Nói thẳng hơn: `requireSecret` phải phát hiện "chưa
 * set" chứ không phải "set hơi sai".
 */
export function requireSecret(env: ConfigEnvironment, name: string): string | null {
  return readOptional(env, name);
}

/** Danh sách host allowlist ở dạng JSON array (FR-003). Hàm parse dùng cho `ENDPOINT_HOST_ALLOWLIST`. */
export function readHostAllowlist(
  env: ConfigEnvironment,
  name: string,
  fallback: readonly string[],
): readonly string[] {
  const raw = readOptional(env, name);
  if (raw === null) {
    return fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!Array.isArray(parsed)) {
    return fallback;
  }
  const hosts = parsed.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
  return hosts.length > 0 ? hosts : fallback;
}
