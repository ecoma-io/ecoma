/**
 * Composition root của Worker `push-notification`.
 *
 * ⚠️ **Ba việc của file này, và ba việc đó không trộn lẫn:**
 *
 * 1. **Dựng adapter** (`buildContext`): D1 binding → repository, Worker Secret → cipher,
 *    Queue binding → publisher. Một `D1NotificationRepository` **duy nhất** được chia sẻ với
 *    `D1DeliveryRepository` qua callback `#findNotificationPayload` — vì đó là **một** bảng và
 *    **một** projection; đọc nó từ hai repository là hai nơi phải sửa khi projection đổi.
 * 2. **Nối route với use case**: mỗi route làm ba việc — xác thực (nếu có), đọc body, gọi use
 *    case, ánh xạ kết quả thành status + body. **Không có business rule nào ở đây**: `switch`
 *    ánh xạ `reason` → status trong `http.ts` là **cầu nối** giữa vocabulary đóng của use
 *    case và HTTP, không phải nơi quyết định (xem header của `http.ts`).
 * 3. **Fail-closed ở biên** (`onError`): thiếu cấu hình bắt buộc → `503` nêu **tên biến**;
 *    D1 unreachable → `503` + `Retry-After`; còn lại → `500` với thông điệp **hằng**.
 *
 * ⚠️ **Ba authorization boundary, ba cơ chế** (FR-019; `01-architecture.md` §8.1, §8.2) — và
 * cả ba đều xác thực **trước mọi lookup**:
 *
 * - **Private delivery runtime API**: shared secret + `X-ECOMA-PRINCIPAL`. Response không
 *   được phân biệt "không có quyền" với "không tìm thấy" (§8.1) — nên `404` chỉ xuất hiện
 *   sau khi caller đã qua xác thực.
 * - **Admin API**: bearer token của `Backoffice`.
 * - **Application API**: bearer token của application, và `app` **derive từ** principal đã
 *   xác thực chứ không lấy từ body (§8.2) — xem route `POST /v1/notifications`.
 *
 * ⚠️ **Cloudflare không phân biệt Service Binding với internet**
 * (`docs/architecture/04-platform-facts.md`), nên route `/internal/**` xác thực ở tầng ứng dụng
 * chứ không dựa vào "chỉ binding mới gọi được". Đây là lý do `requireRuntime` tồn tại.
 *
 * ⚠️ **`export default { fetch }`, không `export default worker`.** Một Worker có thể có
 * `scheduled` và các entry point khác; export một object rõ ràng làm contract của
 * deployment **đọc được**. `wrangler.jsonc` **không** khai cron — poll interval của Outbox
 * Publisher chưa chốt (`03-operations.md` §5.4) nên không được bịa — và vì vậy Worker này
 * cố ý không có entry point `scheduled`: `/internal/outbox/publish` và `/internal/reconcile/*`
 * được một trigger **đã chốt** gọi vào, không phải bởi một cron giả định.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';

import {
  D1AuditRepository,
  D1DeliveryRepository,
  D1DeviceRepository,
  D1IdempotencyRepository,
  D1NotificationRepository,
  D1OutboxRepository,
  D1ProviderCredentialRepository,
  D1ProviderRepository,
  D1RateLimitStore,
  D1RoutingPolicyRepository,
  D1SubscriptionRepository,
  BindingQueuePublisher,
  WebCryptoCredentialCipher,
  authenticateBearer,
  authenticateRuntimeCaller,
  createLogger,
  cryptoRandomIdGenerator,
  isRetryableStorageError,
  systemClock,
  type AuthenticatedCaller,
  type Logger,
} from '@ecoma-io/push-notification-infrastructure';

import {
  PushConfigError,
  administrativeRetry,
  claimDelivery,
  claimProviderPrimary,
  cleanupIdempotencyRecords,
  createNotification,
  createProvider,
  deleteProviderByAdmin,
  disableSubscriptionByAdmin,
  holdProvider,
  invalidateSubscription,
  listDeliveries,
  listDevices,
  listNotifications,
  listPrimaryMappings,
  listProviders,
  listSubscriptions,
  publishOutbox,
  reconcileDeliveries,
  reconcileOutbox,
  recordOutcome,
  revalidateSubscriptionEndpoints,
  releaseDelivery,
  getProvider,
  listVapidPublicKeys,
  releaseProvider,
  removeSubscriptionByAdmin,
  republishDelivery,
  rotateCredential,
  runProviderTest,
  setProviderStatus,
  toRfc3339,
  updateProvider,
  type AdminDeps,
  type AdminResult,
  type CreateNotificationDeps,
  type DeliveryRuntimeDeps,
  type FencedWriteOutcome,
  type IdGenerator,
  type IdempotencyCleanupDeps,
  type InventoryDeps,
  type PushNotificationConfig,
  type PushNotificationPorts,
  type ReconcileDecision,
  type ReconciliationDeps,
  type ResolveProviderCredential,
  type Transport,
} from '@ecoma-io/push-notification-application';

import {
  PROVIDER_TYPE_VALUES,
  TRANSPORT_VALUES,
  leaseFencedRejection,
  validateNotificationPayload,
  type LeaseFencedRejection,
  type ProviderType,
} from '@ecoma-io/push-notification-contracts';

import { pushConfig, type PushWorkerEnv } from './config';
import {
  adminRejectionStatus,
  isPlainRecord,
  json,
  notificationRejectionStatus,
  problem,
  readEmptyRequestBody,
  readJsonObject,
  readLimit,
} from './wire';
import { applicationDeviceRoutes } from './devices';
import type { RequireApplication } from './application-routes';
import { createProviderProbe } from './provider-probe';
import { applicationSubscriptionRoutes } from './subscriptions';

/**
 * ⚠️ Export nằm **cuối** file, không phải đầu file. `worker` là một `const` khai báo sau, và
 * `export default { fetch: worker.fetch }` ở đầu sẽ đọc `worker` trước khi nó được khởi tạo —
 * `fetch` bị đóng băng ở `undefined` và Worker không có entry point. Xem cuối file.
 *
 * ⚠️ **Tên Hono instance là `worker`, không phải `app`.** Mỗi route Admin API có một biến cục
 * bộ tên `app` — đó là `app` scope của request, đúng tên trong wire contract (`?app=`,
 * body `app`). Đặt instance Hono cũng tên `app` sẽ khiến `no-shadow` đỏ ở mười route, và cách
 * sửa duy nhất là đổi tên biến scope — tức đổi tên của **dữ liệu** để giữ tên của **công cụ**.
 */

/* -------------------------------------------------------------------------------------- */
/* App                                                                                        */
/* -------------------------------------------------------------------------------------- */

/**
 * `Retry-After` khi hạ tầng tạm thời không khả dụng — **một giây**, và đây là một hằng trong
 * file này chứ không phải cấu hình: hai nhánh `503` ở dưới không đại diện cho một SLA backoff
 * nào đã chốt, chúng chỉ nói "hạ tầng sẽ không giúp được nếu bạn lùi lâu". Giá trị thực tế
 * của backoff thuộc client.
 */
const STORAGE_RETRY_AFTER_SECONDS = '1';

/**
 * `Retry-After` khi `rate_limited` (FR-021).
 *
 * ⚠️ Dùng **cửa sổ rate limit** của cấu hình chứ không phải `Retry-After` dạng thời gian
 * đến hạn thực: `RateLimitOutcome.retryAfterMs` là null khi bị từ chối (xem `ports.ts`), nên
 * không có mốc chính xác để báo. Báo một giá trị nhỏ hơn thực tế chỉ khiến client thử lại
 * sớm hơn và bị từ chối lại — vô hại — còn báo quá dài thì giữ một caller hợp lệ ở ngoài.
 */
const RATE_LIMIT_RETRY_AFTER_SECONDS = '60';

const worker = new Hono();

/**
 * **Một** error handler cho mọi route.
 *
 * ⚠️ Ba nhánh theo thứ tự ưu tiên:
 *
 * 1. `PushConfigError` → `503` + `Retry-After`, thông điệp **có tên biến**. Đây không phải
 *    lỗi của caller: thiếu cấu hình bắt buộc là sự cố cấu hình của **service** (sáu tham số
 *    SLA là launch gate — `03-operations.md` §11), và `500` chung chung sẽ bảo caller gọi
 *    lại vô ích đồng thời giấu mất nguyên nhân thật.
 * 2. Lỗi D1 (mạng/throttle/timeout) → `503` + `Retry-After`: hạ tầng **tạm thời**, client
 *    nên thử lại. `500` khiến một client không có chiến lược retry mất notification.
 * 3. Còn lại → `500` với thông điệp **hằng**; message của lỗi không đi ra response (nó có
 *    thể chứa giá trị bind — endpoint, payload — và log của người gọi không được phải nơi
 *    đọc giá trị đó).
 */
worker.onError((error) => {
  if (error instanceof PushConfigError) {
    return problem(503, 'service_misconfigured', error.message, {
      'retry-after': STORAGE_RETRY_AFTER_SECONDS,
    });
  }
  if (isRetryableStorageError(error)) {
    return problem(503, 'storage_unavailable', 'Storage tạm thời không khả dụng — thử lại sau.', {
      'retry-after': STORAGE_RETRY_AFTER_SECONDS,
    });
  }
  return problem(500, 'internal_error', 'Lỗi nội bộ.');
});

/** `notFound` — không phân biệt "route không có" với "route bị giấu", và không lộ danh sách route. */
worker.notFound(() => problem(404, 'not_found', 'Không có route này.'));

/* -------------------------------------------------------------------------------------- */
/* Composition: env → adapter → port                                                           */
/* -------------------------------------------------------------------------------------- */

/**
 * Bundle dependency mà **mọi** use case nhận.
 *
 * ⚠️ Dựng lại theo từng request, không cache ở module scope: `WebCryptoCredentialCipher` giữ
 * **key material** trong instance, và một instance sống lâu hơn một deploy sẽ giữ key của
 * môi trường cũ — đúng loại node-local state mà `AGENTS.md` cấm. Cấu hình thì ngược lại:
 * nó **đã** được cache theo isolate ở `config.ts`.
 */
interface RequestContext {
  readonly config: PushNotificationConfig;
  readonly ports: PushNotificationPorts;
  readonly ids: IdGenerator;
  readonly resolveCredential: ResolveProviderCredential;
  readonly logger: Logger;
}

/** Đọc root key của một version từ Worker Secret, giải mã base64, hoặc `null` nếu thiếu. */
function readRootKey(env: Record<string, unknown>, version: string): Uint8Array | null {
  const secretName = `${ROOT_KEY_SECRET_PREFIX}${version}`;
  const encoded = env[secretName];
  if (typeof encoded !== 'string' || encoded.length === 0) {
    return null;
  }
  // ⚠️ Giải mã base64 **ngoài** try/catch của `onError`: `atob` throw khi chuỗi không phải
  // base64, và đó là lỗi cấu hình (operator set sai secret) chứ không phải lỗi hạ tầng — để nó
  // nổi thành `500` có thêm chi tiết thay vì `503` nói "thử lại" cho một thứ không đổi được
  // bằng cách thử lại.
  const decoded = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  // `WebCryptoCredentialCipher` kiểm độ dài 32 byte (AES-256) lúc khởi tạo và ném ở đó; kiểm
  // sớm ở đây chỉ để thông điệp nói đúng **tên secret** thay vì nói về version trừu tượng.
  if (decoded.byteLength !== AES_256_KEY_BYTES) {
    throw new Error(
      `Worker Secret ${secretName} phải là ${AES_256_KEY_BYTES} byte (base64 của AES-256 key), ` +
        `nhận ${decoded.byteLength}.`,
    );
  }
  return decoded;
}

/** Tiền tố Worker Secret chứa root key của từng version. */
const ROOT_KEY_SECRET_PREFIX = 'PUSH_CREDENTIAL_ROOT_KEY_';

/** AES-256 root key — 32 byte. */
const AES_256_KEY_BYTES = 32;

/**
 * Dựng cipher từ keyring + Worker Secret.
 *
 * ⚠️ **Mỗi version là một secret riêng** (`PUSH_CREDENTIAL_ROOT_KEY_K1`, `..._K2`), và đó là
 * điều kiện để rotation `K1 → K2` (`03-operations.md` §7.3) không phá credential cũ: `K2` có
 * mặt thì `K1` vẫn còn trong `CREDENTIAL_SERVING_VERSIONS`, và một record mã hoá bằng `K1` vẫn
 * đọc được bằng `K1`. Nếu dùng **một** secret chứa cả hai key thì việc thêm `K2` chính là việc
 * ghi đè `K1` — mất khả năng đọc credential đang phục vụ.
 *
 * ⚠️ Thiếu key của một version đang phục vụ → throw (fail closed ở **khởi tạo**, không phải lúc
 * ghi credential đầu tiên): lúc ghi thì lỗi xảy ra giữa một rotation và đã có credential cần
 * version đó trong D1 — tức mất khả năng ký VAPID đúng lúc cần nhất.
 *
 * ⚠️ Không có `trim()` trên đường secret: `requireSecret` phát hiện "chưa set", không phải
 * "set hơi sai", và base64 có thể chứa khoảng trắng có chủ ý trong một secret dán tay.
 */
function buildCipher(
  config: PushNotificationConfig,
  env: PushWorkerEnv,
): WebCryptoCredentialCipher {
  const keysByVersion: Record<string, Uint8Array> = {};
  for (const version of config.credentialKeyring.servingVersions) {
    const key = readRootKey(env as unknown as Record<string, unknown>, version);
    if (key === null) {
      throw new Error(
        `Thiếu Worker Secret ${ROOT_KEY_SECRET_PREFIX}${version} cho credential version đang phục vụ.`,
      );
    }
    keysByVersion[version] = key;
  }
  return new WebCryptoCredentialCipher({
    keysByVersion,
    currentVersion: config.credentialKeyring.currentVersion,
  });
}

/**
 * `RequestHasher` SHA-256 hex — hash nội bộ cho idempotency key (FR-008).
 *
 * ⚠️ **Cố ý khác `payload_digest`.** Đây là hash so sánh trong D1, không phải field của
 * contract claim; `payload_digest_algorithm` là open item nên `payload_digest` phải **vắng**
 * cho tới khi thuật toán được chốt (xem `digestIfConfigured` trong `delivery-runtime.ts`).
 * Gộp hai thứ là một digest mà worker không thể xác minh.
 */
const sha256HexHasher = {
  async hash(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  },
};

/**
 * `PayloadDigester` v1 — luôn `null`.
 *
 * ⚠️ `payload_digest_algorithm` chỉ có giá trị hợp lệ `none` ở v1, nên hàm này **không bao giờ**
 * gắn `payload_digest` vào response `200` của claim. Nó tồn tại thay vì để port là `null` vì
 * `PushNotificationPorts` khai nó bắt buộc, và một adapter luôn trả `null` là cách nói "chưa
 * chốt" mà không cần sửa kiểu của port.
 */
const noDigest = {
  async digest(_canonicalPayload: string): Promise<string | null> {
    return null;
  },
};

/**
 * Resolver credential — **đọc + giải mã theo `vapid_key_id` của subscription**.
 *
 * ⚠️ Khoá lookup là `vapid_key_id`, không phải "key hiện tại của `App`" (FR-006): push service
 * từ chối message ký bằng key khác key dùng lúc tạo subscription, nên một "key hiện tại" là
 * hỏng delivery âm thầm. `app` có mặt trong lookup và được kiểm trong repository để một
 * caller tra nhầm không nhận về key hợp lệ về hình thức.
 *
 * ⚠️ `null` khi không tìm thấy — và use case đổi nó thành `409 terminal` fail-closed, không
 * có fallback sang key khác (xem `delivery-runtime.ts`).
 */
function buildCredentialResolver(
  config: PushNotificationConfig,
  ports: PushNotificationPorts,
  cipher: WebCryptoCredentialCipher,
): ResolveProviderCredential {
  return async (app: string, providerId: string, vapidKeyId: string) => {
    const record = await ports.providerCredentials.findByVapidKeyId(app, providerId, vapidKeyId);
    if (record === null) {
      return null;
    }
    // ⚠️ Giải mã theo **version ghi trên record**, không theo `currentVersion`: một record mã
    // hoá bằng `K1` phải luôn đọc bằng `K1`, kể cả sau khi `K2` thành current (§7.3).
    const privateKey = await cipher.decrypt(
      record.credentialCiphertext,
      record.credentialEncryptionVersion,
    );
    return { privateKey, publicKey: record.publicKey };
  };
}

/** Dựng toàn bộ dependency của một request từ `env`. */
function buildContext(env: PushWorkerEnv): RequestContext {
  const config = pushConfig(env);
  const logger = createLogger({
    service: config.runtime.service,
    environment: config.runtime.environment,
    level: config.runtime.logLevel,
  });
  const cipher = buildCipher(config, env);
  // ⚠️ `cryptoRandomIdGenerator` là **một object có method `next()`**, không phải một hàm —
  // gọi nó như `cryptoRandomIdGenerator()` sẽ ra `undefined` và `deps.ids.next()` ném
  // `TypeError` ở request đầu tiên chạm tới một use case sinh id.
  const ids: IdGenerator = cryptoRandomIdGenerator;

  const notifications = new D1NotificationRepository(env.push);
  const ports: PushNotificationPorts = {
    clock: systemClock,
    queue: new BindingQueuePublisher(env.QUEUE),
    credentialCipher: cipher,
    payloadDigester: noDigest,
    rateLimit: new D1RateLimitStore(env.push),
    devices: new D1DeviceRepository(env.push),
    subscriptions: new D1SubscriptionRepository(env.push),
    providers: new D1ProviderRepository(env.push),
    providerCredentials: new D1ProviderCredentialRepository(env.push),
    notifications,
    // ⚠️ `D1DeliveryRepository` **nhận** chính repository notification để đọc
    // `payload_json`: `push_deliveries` không mang payload, và một `SELECT` thứ hai ở đây
    // sẽ là hai nơi phải giữ đúng projection `push_notifications`.
    deliveries: new D1DeliveryRepository(env.push, (notificationId: string) =>
      notifications.findById(notificationId),
    ),
    outbox: new D1OutboxRepository(env.push),
    idempotency: new D1IdempotencyRepository(env.push),
    audit: new D1AuditRepository(env.push),
    routingPolicy: new D1RoutingPolicyRepository(env.push),
  };

  return {
    config,
    ports,
    ids,
    resolveCredential: buildCredentialResolver(config, ports, cipher),
    logger,
  };
}

/* -------------------------------------------------------------------------------------- */
/* Bundle dependency cho từng nhóm use case                                                     */
/* -------------------------------------------------------------------------------------- */

function createNotificationDeps(context: RequestContext): CreateNotificationDeps {
  return {
    config: context.config,
    ports: context.ports,
    ids: context.ids,
    hasher: sha256HexHasher,
  };
}

function adminDeps(context: RequestContext): AdminDeps {
  return { config: context.config, ports: context.ports, ids: context.ids };
}

/**
 * Dependency của use case Device/Subscription.
 *
 * ⚠️ **Chia sẻ `sha256HexHasher` với `createNotificationDeps`, cố ý.** `endpoint_hash` và
 * canonical request hash phải dùng **cùng một** phép băm: `endpoint_hash` xuất hiện trong
 * unique constraint của schema và trong `WHERE` của mọi dedupe, nên một hàm hash khác ở đây là
 * một hỏng dữ liệu chứ không phải một refactor. Đó là lý do `InventoryDeps` nhận **chính** kiểu
 * `RequestHasher` thay vì một port `EndpointHasher` mới.
 */
function inventoryDeps(context: RequestContext): InventoryDeps {
  return {
    config: context.config,
    ports: context.ports,
    ids: context.ids,
    hasher: sha256HexHasher,
  };
}

function deliveryRuntimeDeps(context: RequestContext): DeliveryRuntimeDeps {
  return {
    config: context.config,
    ports: context.ports,
    resolveCredential: context.resolveCredential,
  };
}

function outboxPublisherDeps(context: RequestContext): {
  readonly config: PushNotificationConfig;
  readonly ports: PushNotificationPorts;
  readonly ids: IdGenerator;
} {
  return { config: context.config, ports: context.ports, ids: context.ids };
}

function reconciliationDeps(context: RequestContext): ReconciliationDeps {
  return { config: context.config, ports: context.ports, ids: context.ids };
}

function idempotencyCleanupDeps(context: RequestContext): IdempotencyCleanupDeps {
  return { config: context.config, ports: context.ports };
}

/* -------------------------------------------------------------------------------------- */
/* Authorization boundary                                                                     */
/* -------------------------------------------------------------------------------------- */

/**
 * Xác thực private delivery runtime API — shared secret + principal (§8.1, FR-019).
 *
 * ⚠️ **Không** so sánh principal trước secret: `authenticateRuntimeCaller` đã cố ý so secret
 * trước và dùng constant-time cho cả hai, để thời gian trả lời không phụ thuộc việc principal
 * có khớp.
 *
 * ⚠️ `401` **trước mọi lookup** — response không được phân biệt "không có quyền" với "không
 * tìm thấy" (§8.1), và Cloudflare không phân biệt Service Binding với internet nên endpoint
 * này reachable từ Internet. Thiếu header, sai scheme, sai secret, sai principal — **một**
 * câu trả lời.
 */
function requireRuntime(context: RequestContext, request: Request): Response | null {
  const caller = authenticateRuntimeCaller(
    {
      sharedSecret: request.headers.get(RUNTIME_SHARED_SECRET_HEADER),
      principal: request.headers.get(RUNTIME_PRINCIPAL_HEADER),
    },
    {
      expectedSecret: context.config.runtimeAuth.sharedSecret,
      expectedPrincipal: context.config.runtimeAuth.expectedPrincipal,
    },
  );
  return caller === null ? unauthorized() : null;
}

/** Xác thực Admin API (bearer token của `Backoffice`). */
function requireAdmin(context: RequestContext, request: Request): Response | null {
  const caller = authenticateBearer(request.headers.get('authorization'), {
    expectedSecret: context.config.controlPlaneAuth.adminToken,
    expectedPrincipal: context.config.controlPlaneAuth.adminPrincipal,
  });
  return caller === null ? unauthorized() : null;
}

/**
 * Xác thực Application API, trả về caller đã xác thực.
 *
 * ⚠️ Trả **principal**, không trả `Response`: `app` của một request là giá trị **dùng**, lấy từ
 * principal đã xác thực — nếu lấy từ body thì body là dữ liệu caller kiểm soát và FR-007/§8.2
 * cấm dùng chéo app (§8.2: `app` MUST derive từ authenticated principal).
 */
function authenticateApplication(
  context: RequestContext,
  request: Request,
): AuthenticatedCaller | Response {
  const caller = authenticateBearer(request.headers.get('authorization'), {
    expectedSecret: context.config.controlPlaneAuth.applicationToken,
    expectedPrincipal: context.config.controlPlaneAuth.applicationPrincipal,
  });
  return caller === null ? unauthorized() : caller;
}

/**
 * Header mang shared secret của private delivery runtime API.
 *
 * ⚠️ **Tên header là `authorization`, giá trị nguyên văn — không có scheme `Bearer`.**
 * Đây là contract của `docs/applications/push-notification/01-architecture.md` §8.1 và
 * `docs/applications/web-push-notification-job/01-architecture.md` §6.1: cả hai ghi rõ secret đi
 * trong `Authorization`, và client `web-push-notification-job` gửi đúng vậy.
 *
 * ⚠️ **Vì vậy `requireRuntime` cố ý KHÔNG dùng `authenticateBearer`.** `authenticateBearer` bóc
 * tiền tố `Bearer ` và từ chối mọi scheme khác — dùng nó ở đây sẽ trả `401` cho đúng những
 * request hợp lệ của Worker. `readBearerToken` tồn tại cho Admin API, không dùng cho boundary
 * này.
 *
 * ⚠️ **Giá trị `X-ECOMA-PRINCIPAL` là `svc.web-push-notification-job`** — có tiền tố `svc.`
 * theo §8.1 và §11. Một giá trị thiếu tiền tố vẫn "chạy được" với một env cấu hình lệch, nên nó
 * là một lỗi cấu hình hiển thị được (`401`), không phải lỗi âm thầm.
 */
const RUNTIME_SHARED_SECRET_HEADER = 'authorization';
const RUNTIME_PRINCIPAL_HEADER = 'x-ecoma-principal';

/**
 * `401` cho cả ba boundary — **một** body, **không** nêu cơ chế nào đã sai.
 *
 * ⚠️ Không phân biệt "thiếu header" với "sai secret": một response phân biệt hai trường hợp đó
 * là một oracle đo lời gọi đó đã thử gì. Không nêu boundary nào: đường `/internal/**` có tồn
 * tại phải là thông tin mà một caller không hợp lệ dò được từ thông điệp lỗi.
 */
function unauthorized(): Response {
  return problem(401, 'unauthorized', 'Thiếu hoặc sai thông tin xác thực.');
}

/** Kết quả auth của một route: đã xác thực thì có context, không thì có `Response` luôn trả về. */
type Authorized = { readonly context: RequestContext; readonly caller: AuthenticatedCaller };

/**
 * Dựng context rồi xác thực — gom để **mọi** route đi qua đúng một đường.
 *
 * ⚠️ Xác thực **trước** khi use case chạy, và vì `buildContext` chỉ đọc `env` nên nó không tạo
 * tác dụng phụ quan sát được: một caller không hợp lệ không chạm vào D1. Nhưng thứ tự này vẫn
 * quan trọng vì `pushConfig` có thể throw `PushConfigError` — và khi đó service đang hỏng,
 * nên câu trả lời đúng là `503` chứ không phải `401` cho một caller hoàn toàn hợp lệ.
 */
function authenticate(
  env: unknown,
  request: Request,
  kind: 'runtime' | 'admin' | 'application',
): Authorized | Response {
  const context = buildContext(env as PushWorkerEnv);
  switch (kind) {
    case 'runtime': {
      const denied = requireRuntime(context, request);
      return (
        denied ?? {
          context,
          caller: { principal: context.config.runtimeAuth.expectedPrincipal, app: null },
        }
      );
    }
    case 'admin': {
      const denied = requireAdmin(context, request);
      return (
        denied ?? {
          context,
          caller: { principal: context.config.controlPlaneAuth.adminPrincipal, app: null },
        }
      );
    }
    case 'application': {
      const authenticated = authenticateApplication(context, request);
      return authenticated instanceof Response ? authenticated : { context, caller: authenticated };
    }
  }
}

/** `env` của một route + auth đã qua → context; `Response` nếu auth fail. */
function guard(context: Context, kind: 'runtime' | 'admin' | 'application'): Authorized | Response {
  const authenticated = authenticate(context.env, context.req.raw, kind);
  return authenticated;
}

/**
 * Chuyển `AdminResult` thành response.
 *
 * ⚠️ `201` cho `createProvider` và `200` cho phần còn lại: `201` chỉ đúng khi thao tác **tạo**
 * một resource, và áp nó cho mọi `AdminResult` sẽ khiến một `PATCH` trả `201` — một status sai
 * mà client dựa vào để phân biệt "đã tạo" với "đã sửa".
 *
 * ⚠️ Mọi rejection — kể cả `configuration_invalid` của một provider test — đều đi qua
 * `adminRejectionStatus`: provider test trả **luôn** `200` (xem route `/test`), nên nhánh này
 * chỉ gặp rejection thật của một use case quản trị.
 */
function adminResultResponse<T>(result: AdminResult<T>, status = 200): Response {
  if (!result.ok) {
    return problem(adminRejectionStatus(result.reason), result.reason, result.detail);
  }
  return json(result.value, status);
}

/**
 * Đọc path param của một route có đúng một placeholder.
 *
 * ⚠️ Kiểm `null` ở đây thay vì ép `!`: kiểu của `c.req.param()` là `string | undefined` vì
 * Hono không biết route nào đang chạy, và `!` chỉ là một lời hứa với trình biên dịch mà không
 * có bằng chứng. Route không có placeholder sẽ **không match** nên Hono trả `404` — nhưng một
 * `undefined` lọt tới use case là một `delivery_id` `undefined` đi vào SQL, và D1 sẽ trả lỗi
 * kiểu "không phải string" thay vì một `400` có nghĩa.
 */
function readPathParam(context: Context, name: string): string | Response {
  const value = context.req.param(name);
  return value === undefined || value.length === 0
    ? problem(400, 'invalid_payload', `Thiếu path param \`${name}\`.`)
    : value;
}

/* -------------------------------------------------------------------------------------- */
/* Input helpers — đọc body ở biên, không có business rule                                     */
/* -------------------------------------------------------------------------------------- */

/** Đọc `app` trong body: chuỗi không rỗng, hoặc `null`. */
function readBodyApp(body: Readonly<Record<string, unknown>>): string | null {
  const value = body.app;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Đọc `reason` trong body — bắt buộc cho mọi thao tác có tác dụng phụ ngoài (FR-020). */
function readBodyReason(body: Readonly<Record<string, unknown>>): string | null {
  const value = body.reason;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Đọc query `app`. */
function readQueryApp(url: URL): string | null {
  const value = url.searchParams.get('app');
  return value === null || value.length === 0 ? null : value;
}

/** Đọc query `reason`. */
function readQueryReason(url: URL): string | null {
  const value = url.searchParams.get('reason');
  return value === null || value.length === 0 ? null : value;
}

/**
 * Đọc `dispatch_generation` — fencing token worker gửi kèm mọi write (§8.1).
 *
 * ⚠️ Kiểm **số nguyên dương** chứ không ép kiểu: `Number('3.5')` và `Number(true)` đều ra giá trị
 * mà domain chấp nhận, và một token không phải số nguyên dương là một request hỏng — trả
 * `400` ở biên rẻ hơn để nó thành `409 stale_write` mang thông điệp sai nguyên nhân.
 */
function readDispatchGeneration(body: Readonly<Record<string, unknown>>): number | null {
  const value = body.dispatch_generation;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return null;
  }
  return value;
}

/**
 * Đọc `recipients` — một `user_id` hoặc một tập `user_id`.
 *
 * ⚠️ Cả hai hình dạng được chuẩn hoá về **một** danh sách ngay ở đây, vì FR-008 nói
 * "`recipient` (`user_id` hoặc nhiều `user_id`)" và canonical request hash phải **ổn định
 * theo nghĩa ngữ nghĩa** — `recipient` và `recipients` cùng nội dung là **cùng** một request.
 *
 * ⚠️ Mảng rỗng bị từ chối ở biên: một notification tới **không** recipient không tạo delivery
 * nào, và use case sẽ trả `no_eligible_subscription` — một lý do sai cho nguyên nhân thật
 * (thiếu dữ liệu, không phải không ai nhận được).
 */
function readRecipients(body: Readonly<Record<string, unknown>>): readonly string[] | null {
  const single = body.recipient;
  if (typeof single === 'string' && single.length > 0) {
    return [single];
  }
  const many = body.recipients;
  if (!Array.isArray(many) || many.length === 0) {
    return null;
  }
  const users: string[] = [];
  for (const entry of many) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return null;
    }
    users.push(entry);
  }
  return users;
}

/* -------------------------------------------------------------------------------------- */
/* Application API — POST /v1/notifications (FR-008, FR-013, FR-021)                          */
/* -------------------------------------------------------------------------------------- */

/**
 * ⚠️ **`app` lấy từ principal, `requestedApp` lấy từ body, và use case so sánh chúng** — đó
 * là lớp chống vi phạm namespace của FR-007/§8.2. Giá trị được **dùng** là `authenticatedApp`,
 * không phải giá trị body: một body khớp vẫn là dữ liệu do caller kiểm soát.
 *
 * ⚠️ Payload validate bằng `validateNotificationPayload` của **contracts** (FR-013: tập khoá
 * đóng `title`/`body`/`url`/`data`; khoá ngoài bốn khoá này `MUST NOT` có mặt), còn ngân sách
 * octet thì **use case** đo trên chính chuỗi canonical sẽ persist — đo một chuỗi rồi lưu một
 * chuỗi khác là cách một notification vượt budget vẫn persist.
 *
 * ⚠️ **Không** giới hạn kích thước body ở đây: giới hạn thật của FR-008 là ngân sách payload
 * 3993 octet, mà use case đo trên canonical payload đã validate; một `Content-Length` cap ở
 * biên sẽ là một con số khác với con số đó, tức thêm một giới hạn không ai chốt.
 */
worker.post('/v1/notifications', async (context) => {
  const authorizedCall = guard(context, 'application');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps, caller } = authorizedCall;

  const body = await readJsonObject(context.req.raw);
  if (!body.ok) {
    return problem(400, 'invalid_payload', body.detail);
  }

  const requestedApp = readBodyApp(body.value);
  const recipients = readRecipients(body.value);
  const payload = validateNotificationPayload(body.value.notification);
  if (requestedApp === null) {
    return problem(400, 'invalid_payload', 'Thiếu `app` trong body.');
  }
  if (recipients === null) {
    return problem(
      400,
      'invalid_payload',
      'Cần `recipient` (một user_id) hoặc `recipients` (tập user_id) không rỗng.',
    );
  }
  if (!payload.ok) {
    return problem(400, 'invalid_payload', `notification: ${payload.detail}`);
  }

  const result = await createNotification(createNotificationDeps(deps), {
    requestedApp,
    authenticatedApp: caller.principal,
    // ⚠️ `principal_id` của scope idempotency là **định danh ổn định của caller đã xác thực**
    // (FR-008), không phải giá trị header tự khai. Ở v1 Application API có đúng một
    // application token, nên principal đã xác thực **chính là** định danh đó.
    principalId: caller.principal,
    idempotencyKey: context.req.header('idempotency-key') ?? '',
    recipients,
    payload: payload.payload,
  });

  if (!result.ok) {
    return problem(
      notificationRejectionStatus(result.reason),
      result.reason,
      result.detail,
      // FR-021: vượt rate limit phải **từ chối rõ ràng** và cho client biết chờ bao lâu.
      result.reason === 'rate_limited' ? { 'retry-after': RATE_LIMIT_RETRY_AFTER_SECONDS } : {},
    );
  }

  // FR-008: replay trả **cùng** `notification_id` và `200` — không tạo notification mới.
  if (result.replayed) {
    return json({ notification_id: result.notificationId, replayed: true }, 200);
  }
  return json(
    {
      notification_id: result.notificationId,
      replayed: false,
      deliveries_created: result.deliveriesCreated,
      expires_at: toRfc3339(result.expiresAt),
    },
    201,
  );
});

/**
 * Application API — `Device` · `Push Subscription` (FR-002, FR-003, FR-004, §4.1).
 *
 * ⚠️ **Sáu route, một `requireAuth`, và mọi business rule nằm ở application lib.**
 * `registerDevice` / `getDevice` / `unregisterDevice` / `registerSubscription` /
 * `disableSubscriptionByApplication` / `unregisterSubscription` ở
 * `@ecoma-io/push-notification-application`. Ở đây chỉ có xác thực → đọc input → ánh xạ
 * `reason` → status. Compose dedupe/transition/VAPID ở đây là viết business rule ở tầng HTTP:
 * không guard, không audit, không domain transition — đúng thứ kiến trúc cấm.
 *
 * ⚠️ **`app` derive từ `caller.principal`** (§8.2): sáu route này **không** nhận `app` từ body
 * nên không có dữ liệu nào để so sánh sai. Route `POST /v1/notifications` thì có, và use
 * case ở đó so sánh — hai hình dạng khác nhau vì `02-requirements.md` FR-008 bắt `app` trong
 * body của request tạo notification, còn §4.1 không bắt nó cho các request inventory.
 *
 * ⚠️ **Cùng một `requireAuth` cho cả hai nhóm route** — không phải tiện lợi: một đường xác
 * thực duy nhất là điều kiện để "route nào xác thực trước lookup" là một câu hỏi có đáp án.
 * `tests/inventory-routes.spec.ts` đo nó bằng cách đếm lệnh D1 thật.
 */
const requireApplication = (context: Context): ReturnType<RequireApplication> => {
  const authenticated = guard(context, 'application');
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { context: deps, caller } = authenticated;
  return {
    deps: inventoryDeps(deps),
    // ⚠️ `caller.principal` là `app` scope: `authenticateBearer` trả principal đã xác thực,
    // và FR-019 nói `app` identity derive từ đó chứ không từ body.
    principal: caller.principal,
  };
};

applicationDeviceRoutes(worker, requireApplication);
applicationSubscriptionRoutes(worker, requireApplication);

/* -------------------------------------------------------------------------------------- */
/* Private delivery runtime API (§8.1) — operation set đóng, KHÔNG có `GET`                     */
/* -------------------------------------------------------------------------------------- */

/**
 * ⚠️ **Không có `GET` nào ở đây, và đó là quyết định của §8.1 chứ không phải thiếu sót.**
 * Operation set của private interface không có operation đọc delivery: `claim` đã trả đủ
 * material cho execution đang giữ lease và là operation duy nhất cấp quyền thực thi. Một
 * endpoint chỉ trả metadata không phục vụ use case nào thì `MUST NOT` được giữ lại chỉ vì tài
 * liệu trước đây từng liệt kê nó.
 */

worker.post('/internal/deliveries/:deliveryId/claim', async (context) => {
  const authorizedCall = guard(context, 'runtime');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  // §8.1: request claim **rỗng** — nhận tham số điều khiển state (lease_duration/now/generation)
  // là biến lease thành thứ caller kiểm soát và phá "predicate claim là nguồn duy nhất của
  // thắng/thua". `now` và `lease_duration` do control plane quyết định.
  const body = await readEmptyRequestBody(context.req.raw);
  if (!body.ok) {
    return problem(400, 'invalid_payload', body.detail);
  }
  const deliveryId = readPathParam(context, 'deliveryId');
  if (deliveryId instanceof Response) {
    return deliveryId;
  }
  const outcome = await claimDelivery(deliveryRuntimeDeps(authorizedCall.context), deliveryId);
  // §8.1: thắng → `200` + `DeliveryClaim`; thua → `409` + `ClaimRejection` (`reason`, và
  // `state` **chỉ** khi `terminal`). Thân `409` là body đóng 2 field của contracts, nên nó được
  // trả nguyên vẹn — không bọc thêm `problem()`.
  return json(outcome.body, outcome.kind === 'won' ? 200 : 409);
});

worker.post('/internal/deliveries/:deliveryId/release', async (context) => {
  const authorizedCall = guard(context, 'runtime');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const body = await readJsonObject(context.req.raw);
  if (!body.ok) {
    return problem(400, 'invalid_payload', body.detail);
  }
  const generation = readDispatchGeneration(body.value);
  if (generation === null) {
    return problem(400, 'invalid_payload', 'Cần `dispatch_generation` là số nguyên dương.');
  }
  const deliveryId = readPathParam(context, 'deliveryId');
  if (deliveryId instanceof Response) {
    return deliveryId;
  }
  const outcome = await releaseDelivery(
    deliveryRuntimeDeps(authorizedCall.context),
    deliveryId,
    generation,
  );
  if (outcome.kind === 'ok') {
    return json(outcome.ack, 200);
  }
  // §8.1: `409` của `release` dẫn tới ACK an toàn phía worker, và body là hợp đồng đóng của
  // contracts — `state` **bắt buộc** khi `reason = 'terminal'` (`validateLeaseFencedRejection`
  // bên job từ chối body thiếu `state` thành `RuntimeContractError`, biến một conflict lành
  // thành một chuỗi retry thừa). Builder chạy validator canonical nên body không thể sai shape.
  return json(fencedConflictBody(outcome), 409);
});

/**
 * Body `409` cho release/outcome conflict — đi qua `leaseFencedRejection` để bất biến
 * "chỉ nhánh `terminal` được kèm `state`" được chính contracts bảo đảm, thay vì được giữ
 * bằng kỷ luật thủ công ở từng route.
 *
 * ⚠️ `state` trong body là **trạng thái terminal thật** của delivery (use case đọc được trước
 * khi quyết), không phải một hằng: một hằng khiến validator xanh nhưng người debug một incident
 * đọc body 409 nhận thông tin sai. Khi conflict không phải `terminal`, use case không mang
 * state nào — và hợp đồng cũng **cấm** kèm state ở đó.
 */
function fencedConflictBody(
  outcome: Extract<FencedWriteOutcome, { kind: 'conflict' }>,
): LeaseFencedRejection {
  if (outcome.reason === 'terminal') {
    return leaseFencedRejection('terminal', outcome.terminalState);
  }
  return leaseFencedRejection(outcome.reason);
}

worker.post('/internal/deliveries/:deliveryId/outcome', async (context) => {
  const authorizedCall = guard(context, 'runtime');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const body = await readJsonObject(context.req.raw);
  if (!body.ok) {
    return problem(400, 'invalid_payload', body.detail);
  }
  const generation = readDispatchGeneration(body.value);
  // ⚠️ `outcome` chỉ nhận `delivered`/`failed`: `expired`/`cancelled` thuộc control plane
  // (FR-015), và nhận chúng ở đây là cố ghi một terminal state không thuộc delivery plane.
  const outcome = body.value.outcome;
  if (generation === null || (outcome !== 'delivered' && outcome !== 'failed')) {
    return problem(
      400,
      'invalid_payload',
      'Cần `dispatch_generation` là số nguyên dương và `outcome` là "delivered" hoặc "failed".',
    );
  }
  const deliveryId = readPathParam(context, 'deliveryId');
  if (deliveryId instanceof Response) {
    return deliveryId;
  }
  const result = await recordOutcome(
    deliveryRuntimeDeps(authorizedCall.context),
    deliveryId,
    generation,
    outcome,
  );
  if (result.kind === 'ok') {
    return json(result.ack, 200);
  }
  // Cùng hợp đồng body với `release`: `reason = 'terminal'` **bắt buộc** kèm `state` —
  // validator bên job từ chối body thiếu `state` thành `RuntimeContractError`, biến một
  // conflict lành thành một chuỗi retry thừa trước khi claim kế trả đúng terminal-ACK.
  return json(fencedConflictBody(result), 409);
});

worker.post('/internal/subscriptions/:subscriptionId/invalidate', async (context) => {
  const authorizedCall = guard(context, 'runtime');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  // §8.1: `invalidate` nhận `{}` — KHÔNG evidence/payload/credential. Điều kiện "provider
  // chứng minh endpoint chết" là policy phía worker; control plane không verify được bằng
  // chứng đó và `MUST NOT` tự fetch endpoint để kiểm chứng (FR-003).
  const body = await readEmptyRequestBody(context.req.raw);
  if (!body.ok) {
    return problem(400, 'invalid_payload', body.detail);
  }
  const subscriptionId = readPathParam(context, 'subscriptionId');
  if (subscriptionId instanceof Response) {
    return subscriptionId;
  }
  const outcome = await invalidateSubscription(
    deliveryRuntimeDeps(authorizedCall.context),
    subscriptionId,
  );
  // `404` chỉ trả cho caller **đã xác thực** — `401` xảy ra trước lookup ở `guard` ở trên.
  return outcome.kind === 'ok'
    ? json(outcome.body, 200)
    : problem(404, 'not_found', 'Subscription không tồn tại.');
});

/* -------------------------------------------------------------------------------------- */
/* Control plane — outbox publisher và reconciliation (§6.2, §4.2)                             */
/* -------------------------------------------------------------------------------------- */

/**
 * ⚠️ Route này xác thực như **Admin API** chứ không như runtime API: publisher là operation
 * của control plane với tác dụng phụ ra **Queue** (tức ra ngoài), và `web-push-notification-job`
 * không có quyền điều khiển lịch publish của nó. Nó cũng không phải Application API vì đây
 * không phải capability mà application token đại diện.
 *
 * ⚠️ `wrangler.jsonc` **không** khai cron — poll interval của Outbox Publisher chưa chốt
 * (`03-operations.md` §5.4) và trigger mechanism chưa chốt nên **không** được bịa. Route tồn
 * tại để một trigger **đã chốt** gọi vào.
 */
worker.post('/internal/outbox/publish', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  // `claimedBy` phải là **id sinh ra**, không phải timestamp: hai lượt chạy cùng mili giây
  // sẽ sinh `claimed_by` giống nhau và một lượt sẽ ghi được lên record của lượt kia.
  const result = await publishOutbox(outboxPublisherDeps(deps), deps.ids.next());
  return json({
    claimed: result.claimed,
    send_calls: result.sendCalls,
    published: result.published,
    exhausted: result.exhausted,
    deferred: result.deferred,
    lease_lost: result.leaseLost,
    skipped: result.skipped,
  });
});

/**
 * `POST /internal/reconcile/outbox` — lượt quét (a) của §4.2.
 *
 * ⚠️ Lượt quét này **không ghi gì** (xem `reconcileOutbox`): recovery thuộc publisher (lease hết
 * hạn thì claim lại), backoff (publisher tự catch up) và operator (`republish`). Một
 * reconciliation tự sửa sẽ phá ranh giới "control plane `MUST NOT` tự phục hồi" của a3.
 */
worker.post('/internal/reconcile/outbox', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const result = await reconcileOutbox(reconciliationDeps(authorizedCall.context));
  return json({
    aged_open: result.agedOpen,
    failed: result.failed,
    oldest_open_created_at:
      result.oldestOpenCreatedAt === null ? null : toRfc3339(result.oldestOpenCreatedAt),
    // §4.2 a3: mỗi delivery `pending` mồ côi phải được phát hiện trong `outbox_recovery_sla`;
    // con số này là thứ **đo được** — phần alert thuộc lớp observability, không phải response.
    orphaned_pending_deliveries: result.orphanedPendingDeliveries,
  });
});

/**
 * `POST /internal/reconcile/deliveries` — lượt quét (c) của §4.2 (bảng a1–a6).
 *
 * ⚠️ `intents_suppressed_by_index` được trả riêng và **không** phải lỗi: §4.2 nói rõ
 * reconciler thua ghi intent nhận lỗi unique-constraint và bỏ qua, không phải lỗi cần alert.
 * Đếm nó riêng làm một lượt cho ra đúng số tài liệu yêu cầu thay vì gộp vào `intents_created`.
 */
worker.post('/internal/reconcile/deliveries', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const result = await reconcileDeliveries(reconciliationDeps(authorizedCall.context));
  return json({
    scanned: result.scanned,
    expired: result.expired,
    intents_created: result.intentsCreated,
    intents_suppressed_by_index: result.intentsSuppressedByIndex,
    decisions: result.decisions.map((decision: ReconcileDecision) => ({
      delivery_id: decision.deliveryId,
      action: decision.action,
      reason: decision.reason,
    })),
  });
});

/**
 * `POST /internal/idempotency/cleanup` — cleanup idempotency record theo **đúng ba điều
 * kiện canonical của FR-008** (điều kiện xoá an toàn).
 *
 * ⚠️ **Điều kiện nằm trong statement, không phải read-then-write.** Ba điều kiện (i)/(ii)/(iii)
 * của FR-008 được kiểm tra trong chính predicate của `DELETE` (guarded conditional write,
 * Invariant B) — thiếu bất kỳ điều kiện nào thì hàng không nằm trong tập xoá. Điều kiện (i)
 * tổng hợp trên **tất cả** delivery của notification (`NOT EXISTS` delivery non-terminal); điều
 * kiện (ii) kiểm **outbox record** `pending`/`publishing` (KHÔNG phải job record); điều kiện
 * (iii) so `created_at + retention` với `now`.
 *
 * ⚠️ **Retention lấy từ config**, không tự chọn: `IDEMPOTENCY_RETENTION_MS` (launch gate,
 * `03-operations.md` §11/§13). `queue_retention` **không** thay thế được.
 *
 * ⚠️ **Admin guard** (cùng boundary với reconciliation/publisher): đây là operation control
 * plane xoá dữ liệu theo retention — không phải delivery runtime, cũng không phải capability
 * của Application API. Trigger định kỳ là một quyết định vận hành chưa chốt (cùng nhóm với
 * cron của publisher) — route cho phép gọi thủ công/automation khi đã chốt, không tự bịa lịch.
 *
 * ⚠️ **Idempotent**: gọi lại nhiều lần không phá hỏng gì — đã thoả thì xoá, chưa thoả thì giữ;
 * không hồi sinh delivery terminal nào (FR-008 replay semantics giữ nguyên).
 */
worker.post('/internal/idempotency/cleanup', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const result = await cleanupIdempotencyRecords(idempotencyCleanupDeps(authorizedCall.context));
  return json({ deleted: result.deleted });
});

/**
 * `POST /internal/revalidate-endpoints?app=…` — lượt quét re-validate endpoint **đã lưu**
 * (FR-003): allowlist/policy thay đổi hoặc định kỳ, endpoint không còn hợp lệ → subscription
 * disabled với cause `endpoint_revalidation_failed`.
 *
 * ⚠️ **Admin guard** (cùng boundary với reconciliation): đây là đường ghi hàng loạt state
 * subscription — không phải đường private delivery runtime (job không gọi nó), và cũng
 * không mở công khai. Trigger định kỳ ở production là một quyết định vận hành chưa chốt
 * (cùng nhóm với cron của reconciliation) — route cho phép gọi thủ công/automation khi đã
 * chốt, không tự bịa lịch.
 */
worker.post('/internal/revalidate-endpoints', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const url = new URL(context.req.url);
  const app = readQueryApp(url);
  if (app === null) {
    return problem(400, 'invalid_payload', 'Thiếu query `app`.');
  }
  const result = await revalidateSubscriptionEndpoints(reconciliationDeps(authorizedCall.context), {
    app,
  });
  return json({
    scanned: result.scanned,
    disabled: result.disabled,
    valid: result.valid,
    skipped_corrupt: result.skippedCorrupt,
    disabled_subscription_ids: result.disabledSubscriptionIds,
  });
});

/* -------------------------------------------------------------------------------------- */
/* Admin API — provider (FR-005, FR-006, FR-017, FR-018)                                      */
/* -------------------------------------------------------------------------------------- */

/**
 * `POST /admin/v1/providers` — tạo provider.
 *
 * ⚠️ Provider mới sinh ở `status = 'disabled'` và use case tự quyết định việc đó (xem
 * `admin-provider.ts`): chỉ `disabled → enabled` sau khi pass credential availability ·
 * validity · connectivity · test delivery, và control plane không tự chạy provider test
 * (FR-018 là Admin API operation riêng, có audit). Sinh ở `enabled` sẽ đưa một provider
 * **chưa** credential vào routing production.
 */
worker.post('/admin/v1/providers', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  const body = await readJsonObject(context.req.raw);
  if (!body.ok) {
    return problem(400, 'invalid_payload', body.detail);
  }
  const app = readBodyApp(body.value);
  const name = body.value.name;
  const configuration = body.value.configuration;
  const transport = body.value.transport;
  const type = body.value.type;
  if (
    app === null ||
    typeof name !== 'string' ||
    name.length === 0 ||
    !isPlainRecord(configuration) ||
    !isTransportValue(transport) ||
    !isProviderTypeValue(type)
  ) {
    return problem(
      400,
      'invalid_payload',
      'Cần `app`, `name`, `configuration` (object), `transport` và `type` hợp lệ.',
    );
  }
  // ⚠️ WB-5: `make_primary` **không** được chấp nhận ở create. Bản đầu forward nó xuống
  // use case, và use case tạo provider **trước** rồi mới tuyên bố primary — nên một
  // `make_primary:true` bị từ chối vẫn để lại một provider row **và** một audit
  // `provider_created`, tức hai bằng chứng của hai thao tác trong khi chỉ một cái được
  // chấp nhận. Tuyên bố primary là operation riêng (`POST /admin/v1/providers/:id/primary`)
  // và nó có guard riêng (§6.1) — nên ở đây ta từ chối **trước khi** insert.
  if (body.value.make_primary === true) {
    return problem(
      400,
      'invalid_payload',
      '`make_primary` không được dùng khi tạo provider — tạo provider trước, rồi tuyên bố primary bằng `POST /admin/v1/providers/:id/primary`.',
    );
  }
  const result = await createProvider(adminDeps(deps), {
    app,
    providerId: deps.ids.next(),
    transport,
    type,
    name,
    configuration,
    // `make_primary` là tuỳ chọn: scope chưa có primary là một trạng thái hợp lệ (routing
    // fail-safe), nên default `false` — tuyên bố primary là một quyết định có chủ ý (§6.1).
    makePrimary: false,
    actor: deps.config.controlPlaneAuth.adminPrincipal,
  });
  return adminResultResponse(result, 201);
});

/**
 * `GET /admin/v1/providers` — list provider của `App`, kèm mapping primary.
 *
 * ⚠️ `primary_mappings` đi cùng response: FR-005 nói một `(app, transport)` có **đúng một**
 * active primary, và một scope chưa có primary là một trạng thái hợp lệ mà operator phải
 * nhìn thấy được — không phải một lỗi cần che.
 */
worker.get('/admin/v1/providers', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  const url = new URL(context.req.url);
  const app = readQueryApp(url);
  if (app === null) {
    return problem(400, 'invalid_payload', 'Thiếu query `app`.');
  }
  const limit = readLimit(url);
  return json({
    providers: await listProviders(adminDeps(deps), app, limit),
    primary_mappings: await listPrimaryMappings(adminDeps(deps), app, TRANSPORT_VALUES),
  });
});

/**
 * `GET /admin/v1/providers/:providerId` — xem configuration và trạng thái của một provider
 * (§4.2, FR-017). Response là `ProviderRecord` của use case — credential không bao giờ nằm
 * trong record này; không tìm thấy hoặc thuộc app khác cùng trả `404 provider_not_found`
 * (không phân biệt hai case cho caller ngoài scope).
 */
worker.get('/admin/v1/providers/:providerId', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  const url = new URL(context.req.url);
  const app = readQueryApp(url);
  if (app === null) {
    return problem(400, 'invalid_payload', 'Thiếu query `app`.');
  }
  const providerId = readPathParam(context, 'providerId');
  if (providerId instanceof Response) {
    return providerId;
  }
  const result = await getProvider(adminDeps(deps), { app, providerId });
  if (!result.ok) {
    return problem(404, result.reason, result.detail);
  }
  return json(result.value);
});

/**
 * `GET /admin/v1/providers/:providerId/credentials` — phân phối **public** VAPID key theo
 * scope (đóng gap phân phối public key: client không thể tự biết public key ứng với
 * `vapid_key_id` phải gửi khi subscribe). View trả ra là tập đóng
 * `{vapid_key_id, public_key, status}` — ciphertext và private key **không bao giờ** đi qua
 * route này; không tìm thấy hoặc thuộc app khác cùng trả `404 provider_not_found`.
 */
worker.get('/admin/v1/providers/:providerId/credentials', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  const url = new URL(context.req.url);
  const app = readQueryApp(url);
  if (app === null) {
    return problem(400, 'invalid_payload', 'Thiếu query `app`.');
  }
  const providerId = readPathParam(context, 'providerId');
  if (providerId instanceof Response) {
    return providerId;
  }
  const result = await listVapidPublicKeys(adminDeps(deps), { app, providerId });
  if (!result.ok) {
    return problem(404, result.reason, result.detail);
  }
  return json({
    credentials: result.value.map((credential) => ({
      vapid_key_id: credential.vapidKeyId,
      public_key: credential.publicKey,
      status: credential.status,
    })),
  });
});

/**
 * `PATCH /admin/v1/providers/:id` — đổi `name`/`configuration`, **hoặc** bật/tắt.
 *
 * ⚠️ Ba axis của provider (`status` · `emergency_hold` · `is_primary`) tách riêng cố ý: mỗi cái
 * có guard và audit riêng, và gộp chúng là một đường vòng qua những guard đó. `updateProvider`
 * ghi `provider_updated`; `setProviderStatus` ghi `provider_enabled`/`provider_disabled`; hold
 * và primary có route riêng ở dưới.
 */
worker.patch('/admin/v1/providers/:providerId', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  const url = new URL(context.req.url);
  const app = readQueryApp(url);
  if (app === null) {
    return problem(400, 'invalid_payload', 'Thiếu query `app`.');
  }
  const body = await readJsonObject(context.req.raw);
  if (!body.ok) {
    return problem(400, 'invalid_payload', body.detail);
  }
  const routeDeps = adminDeps(deps);
  const providerId = readPathParam(context, 'providerId');
  if (providerId instanceof Response) {
    return providerId;
  }
  const actor = deps.config.controlPlaneAuth.adminPrincipal;

  const name = body.value.name;
  const configuration = body.value.configuration;
  if (name !== undefined || configuration !== undefined) {
    if (typeof name !== 'string' || name.length === 0 || !isPlainRecord(configuration)) {
      return problem(400, 'invalid_payload', 'PATCH provider: cần cả `name` và `configuration`.');
    }
    return adminResultResponse(
      await updateProvider(routeDeps, { app, providerId, name, configuration, actor }),
    );
  }

  const status = body.value.status;
  const expected = body.value.expected;
  if (status !== undefined || expected !== undefined) {
    if (!isProviderStatusValue(status) || !isProviderStatusValue(expected)) {
      return problem(
        400,
        'invalid_payload',
        'PATCH provider: `status` và `expected` phải cùng có mặt và là trạng thái hợp lệ ' +
          '(`disabled` | `enabled`).',
      );
    }
    // ⚠️ `expected` nằm **trong** statement ghi (guarded conditional write): hai admin bật/tắt
    // cùng scope chạy đồng thời thì đúng một thắng, và tài liệu không cần giả định row locking.
    return adminResultResponse(
      await setProviderStatus(routeDeps, { app, providerId, status, expected, actor }),
    );
  }

  return problem(
    400,
    'invalid_payload',
    'PATCH provider: cần `name`+`configuration`, hoặc `status`+`expected`.',
  );
});

/**
 * `POST /admin/v1/providers/:id/primary` — tuyên bố primary của `(app, transport)`.
 *
 * ⚠️ Đây là **axis thứ ba** và nó có route riêng vì guard thật của nó là partial unique index
 * `push_app_provider_mappings_one_primary`: hai admin tuyên bố primary cho cùng scope chạy
 * đồng thời thì lệnh thứ hai bị D1 từ chối — một race hợp lệ, không phải lỗi (xem
 * `claimProviderPrimary`).
 */
worker.post('/admin/v1/providers/:providerId/primary', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  const url = new URL(context.req.url);
  const app = readQueryApp(url);
  if (app === null) {
    return problem(400, 'invalid_payload', 'Thiếu query `app`.');
  }
  const providerId = readPathParam(context, 'providerId');
  if (providerId instanceof Response) {
    return providerId;
  }
  return adminResultResponse(
    await claimProviderPrimary(adminDeps(deps), {
      app,
      providerId,
      actor: deps.config.controlPlaneAuth.adminPrincipal,
    }),
  );
});

/**
 * `DELETE /admin/v1/providers/:id` — logical revoke (§4.3, FR-017).
 *
 * ⚠️ `reason` **bắt buộc**: `DELETE` ở đây là thu hồi một provider đang phục vụ production, và
 * không có gì phân biệt một quyết định có chủ ý với một thao tác nhầm. `DELETE` = disable,
 * **không** = emergency hold: hold là thao tác khẩn cấp có audit `provider_held` và runbook riêng
 * (§6.5), gộp chúng tạo một trạng thái mà runbook không mô tả.
 */
worker.delete('/admin/v1/providers/:providerId', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  const url = new URL(context.req.url);
  const app = readQueryApp(url);
  const reason = readQueryReason(url);
  if (app === null || reason === null) {
    return problem(400, 'invalid_payload', 'DELETE provider: cần query `app` và `reason`.');
  }
  const providerId = readPathParam(context, 'providerId');
  if (providerId instanceof Response) {
    return providerId;
  }
  return adminResultResponse(
    await deleteProviderByAdmin(adminDeps(deps), {
      app,
      providerId,
      reason,
      actor: deps.config.controlPlaneAuth.adminPrincipal,
    }),
  );
});

/**
 * `POST /admin/v1/providers/:id/hold` — emergency hold (`03-operations.md` §6.5).
 *
 * ⚠️ **Không** phải alias của `disable`: hold giữ nguyên `status`, chỉ đặt `emergency_hold`, và
 * nó chặn delivery **đã materialize** chưa bắt đầu trong khi `disable` chỉ dừng routing mới.
 */
worker.post('/admin/v1/providers/:providerId/hold', (context) => runProviderHold(context, true));

/**
 * `POST /admin/v1/providers/:id/release` — bỏ emergency hold.
 *
 * ⚠️ **Không** bỏ `disable` một cách gầm: một provider `disabled` sau khi release hold vẫn
 * `disabled` và routing mới vẫn dừng. Gộp hai thứ khiến một runbook tưởng provider đã trở lại
 * phục vụ trong khi nó không.
 */
worker.post('/admin/v1/providers/:providerId/release', (context) =>
  runProviderHold(context, false),
);

async function runProviderHold(context: Context, hold: boolean): Promise<Response> {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  const app = readQueryApp(new URL(context.req.url));
  if (app === null) {
    return problem(400, 'invalid_payload', 'Thiếu query `app`.');
  }
  const providerId = readPathParam(context, 'providerId');
  if (providerId instanceof Response) {
    return providerId;
  }
  const input = { app, providerId, actor: deps.config.controlPlaneAuth.adminPrincipal };
  const routeDeps = adminDeps(deps);
  // ⚠️ `hold` giữ nguyên `status` và chỉ đặt `emergency_hold`; `release` **không** bỏ `disable`
  // một cách gầm — một provider `disabled` sau khi release vẫn `disabled`.
  const result = hold
    ? await holdProvider(routeDeps, input)
    : await releaseProvider(routeDeps, input);
  return adminResultResponse(result);
}

/**
 * `POST /admin/v1/providers/:id/test` — FR-018.
 *
 * ⚠️ **Mọi phân loại trả `200`**, kể cả `authentication_failed` / `configuration_invalid`: một
 * test fail là một **kết quả** của một Admin API operation (và có audit record kể cả khi fail —
 * một test fail lặp lại là bằng chứng cho incident §15.3), không phải lỗi HTTP. Trả
 * `4xx`/`5xx` ở đây khiến một `Backoffice` phân biệt "provider hỏng" với "service hỏng" bằng
 * status code và chọn nhầm remediation (§15.3: 401/403 → credential path, không retry).
 *
 * ⚠️ **Probe thật — mỗi test là một Web Push request tới push service** (`provider-probe.ts`).
 * FR-018 đòi test gồm configuration test **+ actual delivery**, nên control plane **không** tự
 * trả một phân loại thay cho provider: adapter bọc `createWebPushSender` của delivery plane
 * (import hợp lệ theo tag — `type:composition` → `type:infrastructure`) và gửi một request
 * thật. Mapping HTTP → classification (5 nhánh FR-018) nằm ở adapter, không ở đây.
 *
 * ⚠️ Payload test **không** phải payload thật: FR-018 nói test không chứa dữ liệu nhạy cảm
 * không cần thiết, nên default là một thông điệp không chứa PII.
 */
worker.post('/admin/v1/providers/:providerId/test', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  const body = await readJsonObject(context.req.raw);
  if (!body.ok) {
    return problem(400, 'invalid_payload', body.detail);
  }
  const app = readBodyApp(body.value);
  const subscriptionId = body.value.subscription_id;
  if (app === null || typeof subscriptionId !== 'string' || subscriptionId.length === 0) {
    return problem(
      400,
      'invalid_payload',
      'Cần `app` và `subscription_id` (target của test delivery — FR-018 đòi một delivery thật).',
    );
  }
  const payloadJson = body.value.payload;
  const providerId = readPathParam(context, 'providerId');
  if (providerId instanceof Response) {
    return providerId;
  }
  return adminResultResponse(
    await runProviderTest(adminDeps(deps), createProviderProbe(), {
      app,
      providerId,
      subscriptionId,
      actor: deps.config.controlPlaneAuth.adminPrincipal,
      payloadJson: typeof payloadJson === 'string' ? payloadJson : DEFAULT_TEST_PAYLOAD_JSON,
    }),
    200,
  );
});

/** Payload mặc định của provider test — không chứa dữ liệu người dùng (FR-018). */
const DEFAULT_TEST_PAYLOAD_JSON = JSON.stringify({
  title: 'Push notification configuration test',
  body: 'This is a test delivery from the push-notification control plane.',
});

/**
 * `POST /admin/v1/providers/:id/rotate-credential` — rotate VAPID key pair (§7.2).
 *
 * ⚠️ **Không** revoke credential cũ ở đây: §7.2 cấm đảo thứ tự (`revoke old → deploy new`)
 * và subscription cũ **giữ** `vapid_key_id` cũ. Việc retire là một bước **sau**, khi đếm được 0
 * subscription `active` tham chiếu key cũ — đó là `checkEncryptionKeyRetirement`, một
 * operation riêng, và chưa có route vì nó cần một quyết định vận hành đã chốt.
 *
 * ⚠️ `private_key` đi thẳng vào use case để **mã hoá ngay** và không đi qua log/audit/response
 * (FR-006, §7.2). Route này cũng không log body.
 */
worker.post('/admin/v1/providers/:providerId/rotate-credential', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  const body = await readJsonObject(context.req.raw);
  if (!body.ok) {
    return problem(400, 'invalid_payload', body.detail);
  }
  const app = readBodyApp(body.value);
  const vapidKeyId = body.value.vapid_key_id;
  const publicKey = body.value.public_key;
  const privateKey = body.value.private_key;
  const retireVapidKeyId = body.value.retire_vapid_key_id;
  if (
    app === null ||
    typeof vapidKeyId !== 'string' ||
    vapidKeyId.length === 0 ||
    typeof publicKey !== 'string' ||
    publicKey.length === 0 ||
    typeof privateKey !== 'string' ||
    privateKey.length === 0
  ) {
    return problem(
      400,
      'invalid_payload',
      'Cần `app`, `vapid_key_id`, `public_key` và `private_key`.',
    );
  }
  if (
    retireVapidKeyId !== undefined &&
    retireVapidKeyId !== null &&
    typeof retireVapidKeyId !== 'string'
  ) {
    return problem(400, 'invalid_payload', '`retire_vapid_key_id` phải là string hoặc null.');
  }
  const providerId = readPathParam(context, 'providerId');
  if (providerId instanceof Response) {
    return providerId;
  }
  const result = await rotateCredential(adminDeps(deps), {
    app,
    providerId,
    credentialId: deps.ids.next(),
    vapidKeyId,
    publicKey,
    privateKey,
    retireVapidKeyId: typeof retireVapidKeyId === 'string' ? retireVapidKeyId : null,
    actor: deps.config.controlPlaneAuth.adminPrincipal,
  });
  return adminResultResponse(result);
});

/* -------------------------------------------------------------------------------------- */
/* Admin API — subscription / device / notification / delivery (FR-017)                        */
/* -------------------------------------------------------------------------------------- */

/**
 * `GET /admin/v1/subscriptions` — list subscription của `App`.
 *
 * ⚠️ `endpoint`/`p256dh`/`auth`/`endpoint_hash` **không** lọt vào response (projection
 * `SubscriptionView` loại bỏ chúng ở tầng application): chúng là material chỉ delivery plane
 * cần, và một list endpoint là bề mặt bị lạm dụng nhiều nhất. `endpoint_hash` đủ để operator
 * đối chiếu với một endpoint họ đã biết.
 */
worker.get('/admin/v1/subscriptions', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  const url = new URL(context.req.url);
  const app = readQueryApp(url);
  if (app === null) {
    return problem(400, 'invalid_payload', 'Thiếu query `app`.');
  }
  const userId = url.searchParams.get('user_id');
  const deviceId = url.searchParams.get('device_id');
  const status = url.searchParams.get('status');
  return json({
    subscriptions: await listSubscriptions(adminDeps(deps), app, {
      ...(userId === null ? {} : { userId }),
      ...(deviceId === null ? {} : { deviceId }),
      ...(status === null ? {} : { status: status as never }),
      limit: readLimit(url),
    }),
  });
});

/**
 * `PATCH /admin/v1/subscriptions/:id` — disable có chủ ý (`admin_disable`), `reason` bắt buộc.
 *
 * ⚠️ Đây là `PATCH` chứ không phải `DELETE` (`disable` — vẫn dữ liệu lịch sử), và nó khác
 * `invalidate` của delivery runtime: `invalidate` là policy phía worker khi provider chứng minh
 * endpoint chết, còn đây là quyết định của operator (FR-017).
 */
worker.patch('/admin/v1/subscriptions/:subscriptionId', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  const body = await readJsonObject(context.req.raw);
  if (!body.ok) {
    return problem(400, 'invalid_payload', body.detail);
  }
  const app = readBodyApp(body.value);
  const reason = readBodyReason(body.value);
  const subscriptionId = readPathParam(context, 'subscriptionId');
  if (subscriptionId instanceof Response) {
    return subscriptionId;
  }
  if (app === null || reason === null) {
    return problem(
      400,
      'invalid_payload',
      'Cần `app` và `reason` (audit bắt buộc có lý do — FR-020).',
    );
  }
  return adminResultResponse(
    await disableSubscriptionByAdmin(adminDeps(deps), {
      app,
      subscriptionId,
      reason,
      actor: deps.config.controlPlaneAuth.adminPrincipal,
    }),
  );
});

/**
 * `DELETE /admin/v1/subscriptions/:id` — logical revoke (§4.3), audit `subscription_removed`.
 *
 * ⚠️ **Không** xoá vật lý: historical references cần cho audit và delivery history `MUST NOT`
 * xoá trước retention policy cho phép (§4.3).
 */
worker.delete('/admin/v1/subscriptions/:subscriptionId', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  const url = new URL(context.req.url);
  const app = readQueryApp(url);
  const reason = readQueryReason(url);
  const subscriptionId = readPathParam(context, 'subscriptionId');
  if (subscriptionId instanceof Response) {
    return subscriptionId;
  }
  if (app === null || reason === null) {
    return problem(400, 'invalid_payload', 'DELETE subscription: cần query `app` và `reason`.');
  }
  return adminResultResponse(
    await removeSubscriptionByAdmin(adminDeps(deps), {
      app,
      subscriptionId,
      reason,
      actor: deps.config.controlPlaneAuth.adminPrincipal,
    }),
  );
});

/**
 * `GET /admin/v1/devices` — device của **một** user trong `App`.
 *
 * ⚠️ `user_id` **bắt buộc**: device thuộc một `User` (FR-002), và một list device toàn bộ `App`
 * là một bề mặt đọc không có use case nào dùng.
 */
worker.get('/admin/v1/devices', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  const url = new URL(context.req.url);
  const app = readQueryApp(url);
  const userId = url.searchParams.get('user_id');
  if (app === null || userId === null || userId.length === 0) {
    return problem(400, 'invalid_payload', 'Cần query `app` và `user_id`.');
  }
  return json({ devices: await listDevices(adminDeps(deps), app, userId) });
});

/**
 * `GET /admin/v1/notifications` — list notification của `App`.
 *
 * ⚠️ `payload_json` **không** nằm trong response (projection của `listNotifications` loại bỏ
 * nó): notification chứa payload của application, và đưa nó vào một list endpoint quản trị
 * là một đường rò payload ra ngoài phạm vi cần thiết. `payload_bytes` vẫn có — đó là thứ
 * operator cần để điều tra một notification quá lớn.
 */
worker.get('/admin/v1/notifications', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  const url = new URL(context.req.url);
  const app = readQueryApp(url);
  if (app === null) {
    return problem(400, 'invalid_payload', 'Thiếu query `app`.');
  }
  return json({ notifications: await listNotifications(adminDeps(deps), app, readLimit(url)) });
});

/** `GET /admin/v1/deliveries` — list delivery có filter, theo `App`. */
worker.get('/admin/v1/deliveries', async (context) => {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  const url = new URL(context.req.url);
  const app = readQueryApp(url);
  if (app === null) {
    return problem(400, 'invalid_payload', 'Thiếu query `app`.');
  }
  const notificationId = url.searchParams.get('notification_id');
  const userId = url.searchParams.get('user_id');
  const status = url.searchParams.get('status');
  return json({
    deliveries: await listDeliveries(adminDeps(deps), app, {
      ...(notificationId === null ? {} : { notificationId }),
      ...(userId === null ? {} : { userId }),
      ...(status === null ? {} : { status: status as never }),
      limit: readLimit(url),
    }),
  });
});

/**
 * `POST /admin/v1/deliveries/:id/retry` — `failed → queued`, transition duy nhất ra terminal
 * (`03-operations.md` §4.3).
 *
 * ⚠️ Đòi delivery **terminal `failed`**, khác `republish` (non-terminal). Cả hai đều tạo
 * duplicate **bên ngoài** system, nên `reason` bắt buộc ở cả hai.
 */
worker.post('/admin/v1/deliveries/:deliveryId/retry', (context) => runRecovery(context, 'retry'));

/**
 * `POST /admin/v1/deliveries/:id/republish` — tạo **đúng một** outbox intent mới cho cùng
 * `delivery_id` (§5.6.3), **không** đổi state và **không** cấp generation.
 */
worker.post('/admin/v1/deliveries/:deliveryId/republish', (context) =>
  runRecovery(context, 'republish'),
);

async function runRecovery(context: Context, kind: 'retry' | 'republish'): Promise<Response> {
  const authorizedCall = guard(context, 'admin');
  if (authorizedCall instanceof Response) {
    return authorizedCall;
  }
  const { context: deps } = authorizedCall;
  const body = await readJsonObject(context.req.raw);
  if (!body.ok) {
    return problem(400, 'invalid_payload', body.detail);
  }
  const app = readBodyApp(body.value);
  const reason = readBodyReason(body.value);
  if (app === null || reason === null) {
    return problem(
      400,
      'invalid_payload',
      'Cần `app` và `reason` (bắt buộc cho recovery — FR-020).',
    );
  }
  const deliveryId = readPathParam(context, 'deliveryId');
  if (deliveryId instanceof Response) {
    return deliveryId;
  }
  const command = {
    app,
    deliveryId,
    reason,
    actor: deps.config.controlPlaneAuth.adminPrincipal,
  };
  const routeDeps = adminDeps(deps);
  // ⚠️ Hai nhánh được gọi ở **hai kiểu khác nhau** (`DeliveryRecord` và
  // `{ delivery, intent }`) nên `adminResultResponse` phải được gọi ở từng nhánh thay vì
  // gộp: một lời gọi chung sẽ phải tự suy luận `T` từ union của hai `AdminResult`, và đó là
  // kiểu mà không ai kiểm tra được.
  return kind === 'retry'
    ? adminResultResponse(await administrativeRetry(routeDeps, command))
    : adminResultResponse(await republishDelivery(routeDeps, command));
}

/* -------------------------------------------------------------------------------------- */
/* Vocabulary validators — đóng ở biên, không nới lỏng ở tầng dưới                             */
/* -------------------------------------------------------------------------------------- */

/**
 * ⚠️ Ba hàm này **thu hẹp `unknown` về union** ở biên HTTP, thay vì ép kiểu rồi để use case lo
 * một giá trị sai. Một `as never` ở đây sẽ đẩy một giá trị ngoài vocabulary tới tầng domain, và
 * domain sẽ trả một rejection có lý do sai nguyên nhân (`invalid_payload` thay vì "bạn gửi
 * `transport` không tồn tại").
 */
function isTransportValue(value: unknown): value is Transport {
  return typeof value === 'string' && (TRANSPORT_VALUES as readonly string[]).includes(value);
}

/**
 * `app` trong body là **không đủ** — nó chỉ là tên scope, và `config` thuộc loại khoá
 * nghiệp vụ (`PUSH_ENDPOINT_HOST_ALLOWLIST` → host push endpoint, FR-003/FR-016). Thêm nó vào
 * response là một phần của bề mặt provider mà không có use case nào cần.
 */
function isProviderTypeValue(value: unknown): value is ProviderType {
  return typeof value === 'string' && (PROVIDER_TYPE_VALUES as readonly string[]).includes(value);
}

function isProviderStatusValue(value: unknown): value is 'enabled' | 'disabled' {
  return value === 'enabled' || value === 'disabled';
}

/* -------------------------------------------------------------------------------------- */
/* Worker entry point                                                                          */
/* -------------------------------------------------------------------------------------- */

/**
 * ⚠️ `fetch: worker.fetch` — `fetch` của Hono **không** cần `this` (nó đóng over `app`), nên
 * tách method ra khỏi object là an toàn. Và export một **object** chứ không `export default app`:
 * một Worker có thể có `scheduled` và các entry point khác, nên contract của deployment phải
 * đọc được. `wrangler.jsonc` không khai cron (poll interval của Outbox Publisher chưa chốt —
 * `03-operations.md` §5.4) nên Worker này cố ý chỉ có `fetch`.
 */
export default { fetch: worker.fetch };
