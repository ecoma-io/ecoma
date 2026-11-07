/**
 * Fixture `PushNotificationPorts` trên D1 thật — dùng chung cho mọi spec của app.
 *
 * ⚠️ **Port nào thật, port nào bị kiểm soát, và vì sao.**
 *
 * - **Thật trên D1**: `rateLimit`, `devices`, `subscriptions`, `providers`,
 *   `providerCredentials`, `notifications`, `deliveries`, `outbox`, `idempotency`, `audit`,
 *   `routingPolicy`. Đây là 11 repository mà `buildContext` dựng trong production, dựng lại
 *   y hệt ở đây — một test chạy trên fake thì đang kiểm một hệ thống không tồn tại.
 * - **Cố định**: `clock` trả `T0`. `claimDelivery` **không** nhận `now` từ ngoài (§8.1: một
 *   mốc cho cả predicate lẫn `lease_expires_at`), nên điều khiển thời gian là việc của
 *   `PushClock` — đây là port thật, chỉ là tham số của nó bị ghim.
 * - **Ghi lại lời gọi**: `queue` và `credentialCipher` không thuộc D1. Chúng được thay bằng
 *   bộ ghi, **không** phải bằng hành vi bịa: `queue` trả `true`/`false` theo kịch bản test
 *   chọn, và `credentialCipher` **thật sự mã hoá/giải mã** bằng `WebCryptoCredentialCipher`.
 *   Một cipher giả sẽ khiến mọi test credential xanh mà không chạm vào AES-GCM.
 */

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
  WebCryptoCredentialCipher,
  type D1DatabaseLike,
} from '@ecoma-io/push-notification-infrastructure';

import type {
  CredentialCipher,
  IdGenerator,
  PushNotificationConfig,
  PushNotificationPorts,
  QueuePublisher,
  ResolveProviderCredential,
} from '@ecoma-io/push-notification-application';

import { APP, T0, type SeededScope, type TestDatabase } from './d1-harness';

/* -------------------------------------------------------------------------------------- */
/* Cipher thật — không phải bản giả                                                            */
/* -------------------------------------------------------------------------------------- */

/** Root key 32 byte cho version `K1` — sinh từ byte cố định để test tái lập được. */
export function rootKeyK1(): Uint8Array {
  return new Uint8Array(Array.from({ length: 32 }, (_unused, index) => index + 1));
}

/** Root key 32 byte cho version `K2` — **khác hoàn toàn** `K1`, để test key routing thấy khác. */
export function rootKeyK2(): Uint8Array {
  return new Uint8Array(Array.from({ length: 32 }, (_unused, index) => 200 - index));
}

/** Cipher thật với keyring `K1` current — mặc định của hầu hết test. */
export function cipherK1(): WebCryptoCredentialCipher {
  return new WebCryptoCredentialCipher({
    keysByVersion: { K1: rootKeyK1() },
    currentVersion: 'K1',
  });
}

/* -------------------------------------------------------------------------------------- */
/* Config                                                                                      */
/* -------------------------------------------------------------------------------------- */

/**
 * Cấu hình hợp lệ cho test.
 *
 * ⚠️ Sáu giá trị SLA ở đây là **hằng của test**, không phải giá trị service: test cần một
 * config *hợp lệ* để chạy use case, và việc chọn giá trị nào là quyết định của service owner
 * ở production (`03-operations.md` §11). Test fail-closed của config kiểm chính là việc
 * service **không** tự chọn — nó nằm ở `config.spec.ts`, không ở đây.
 */
export function testConfig(): PushNotificationConfig {
  return {
    sla: {
      idempotencyRetentionMs: 24 * 3_600_000,
      callerRetryWindowMs: 3_600_000,
      maxNotificationTtlMs: 86_400_000,
      payloadDigestAlgorithm: 'none',
      outboxRecoverySlaMs: 15 * 60_000,
      deliveryReconciliationAgeMs: 30 * 60_000,
    },
    engineering: {
      deliveryLeaseDurationMs: 60_000,
      notificationRateLimit: 600,
      notificationRateLimitWindowMs: 60_000,
      outboxBatchSize: 50,
      outboxLeaseDurationMs: 30_000,
      outboxMaxPublishAttempts: 5,
      outboxPublishBackoffMs: 5_000,
      reconciliationBatchSize: 100,
      outboxReconciliationBatchSize: 100,
      defaultMaxDeliveriesPerNotification: 100,
      maxIdempotencyKeyLength: 128,
      providerTestTimeoutMs: 5_000,
    },
    runtime: { service: 'push-notification', environment: 'test', logLevel: 'error' },
    runtimeAuth: {
      expectedPrincipal: 'svc.web-push-notification-job',
      sharedSecret: 'runtime-secret',
    },
    controlPlaneAuth: {
      adminToken: 'admin-token',
      adminPrincipal: 'backoffice',
      applicationToken: 'application-token',
      applicationPrincipal: APP,
    },
    credentialKeyring: { currentVersion: 'K1', servingVersions: ['K1'] },
    pushEndpointHostAllowlist: [
      'fcm.googleapis.com',
      'updates.push.services.mozilla.com',
      'webkit.push.apple.com',
    ],
  };
}

/* -------------------------------------------------------------------------------------- */
/* Id generator                                                                                */
/* -------------------------------------------------------------------------------------- */

/**
 * Id generator **đếm được** — mỗi id là `id-1`, `id-2`, …
 *
 * ⚠️ Vì sao không `crypto.randomUUID()`: một test phải assert được *chính xác* id nào được
 * ghi vào bảng nào (idempotency record trỏ tới notification nào, outbox intent trỏ tới
 * delivery nào). Một id ngẫu nhiên buộc phải đọc lại D1 để biết nó, và assertion biến thành
 * "so sánh hai thứ đã lấy từ cùng một nguồn" — tức không có assertion.
 */
export function sequentialIds(): IdGenerator & { readonly issued: readonly string[] } {
  const issued: string[] = [];
  let counter = 0;
  return {
    issued,
    next(): string {
      counter += 1;
      const id = `id-${String(counter)}`;
      issued.push(id);
      return id;
    },
  };
}

/* -------------------------------------------------------------------------------------- */
/* Queue publisher ghi lại lời gọi                                                              */
/* -------------------------------------------------------------------------------------- */

/** Kịch bản `Queue.send()` trả về — mặc định thành công. */
export interface QueueProbe {
  /** Trả về `succeed` cho mỗi lời gọi; mảng rỗng = luôn `succeed`. */
  readonly outcomes?: readonly boolean[];
  /** Ném thay vì trả `false` — chứng minh `sendAndClassify` nuốt exception. */
  readonly throwOnCall?: readonly number[];
}

/** `QueuePublisher` ghi lại mọi message, với kịch bản thành công/thất bại do test chọn. */
export function recordingQueue(probe: QueueProbe = {}): QueuePublisher & {
  readonly sent: readonly unknown[];
} {
  const sent: unknown[] = [];
  const outcomes = probe.outcomes ?? [];
  return {
    sent,
    async send(message: unknown): Promise<boolean> {
      sent.push(message);
      const index = sent.length - 1;
      if ((probe.throwOnCall ?? []).includes(index)) {
        throw new Error('queue send exploded');
      }
      return outcomes[index] ?? true;
    },
  };
}

/* -------------------------------------------------------------------------------------- */
/* Ports trên D1 thật                                                                          */
/* -------------------------------------------------------------------------------------- */

/** Bundle port đầy đủ, dựng trên D1 thật của `testDb`. */
export interface PortFixture {
  readonly ports: PushNotificationPorts;
  readonly clock: { now(): number };
  readonly ids: ReturnType<typeof sequentialIds>;
  readonly cipher: WebCryptoCredentialCipher;
  readonly deliveries: D1DeliveryRepository;
  readonly notifications: D1NotificationRepository;
  readonly outbox: D1OutboxRepository;
  readonly idempotency: D1IdempotencyRepository;
  readonly rateLimit: D1RateLimitStore;
  readonly subscriptions: D1SubscriptionRepository;
  readonly providers: D1ProviderRepository;
}

/** Một `PushClock` ghim ở `T0` nhưng **cho phép dời mốc** giữa các bước của một test. */
export interface MutableClock {
  now(): number;
  set(millis: number): void;
  advance(millis: number): void;
}

export function fixedClock(at = T0): MutableClock {
  let current = at;
  return {
    now: (): number => current,
    set(millis: number): void {
      current = millis;
    },
    advance(millis: number): void {
      current += millis;
    },
  };
}

/**
 * Dựng port trên D1 thật.
 *
 * ⚠️ `D1DeliveryRepository` **nhận** chính `notifications` để đọc `payload_json` — đúng cách
 * `buildContext` dựng trong production. Dựng riêng hai repository không chia sẻ sẽ là một
 * đường đọc khác với production, và `publishOutbox` là use case duy nhất cần đường đó.
 */
export function buildPorts(
  testDb: TestDatabase,
  overrides: {
    readonly clock?: MutableClock;
    readonly queue?: QueuePublisher;
    readonly cipher?: WebCryptoCredentialCipher;
  } = {},
): PortFixture {
  const clock = overrides.clock ?? fixedClock();
  const notifications = new D1NotificationRepository(testDb.db as unknown as D1DatabaseLike);
  const ports: PushNotificationPorts = {
    clock,
    queue: overrides.queue ?? recordingQueue(),
    credentialCipher: (overrides.cipher ?? cipherK1()) as CredentialCipher,
    // ⚠️ `none` là thuật toán hợp lệ duy nhất ở v1, nên digester trả `null` — **giống hệt**
    // `noDigest` của `buildContext`. Một digester trả digest sẽ khiến claim gắn
    // `payload_digest` mà worker không thể xác minh.
    payloadDigester: { digest: async (): Promise<string | null> => null },
    rateLimit: new D1RateLimitStore(testDb.db as unknown as D1DatabaseLike),
    devices: new D1DeviceRepository(testDb.db as unknown as D1DatabaseLike),
    subscriptions: new D1SubscriptionRepository(testDb.db as unknown as D1DatabaseLike),
    providers: new D1ProviderRepository(testDb.db as unknown as D1DatabaseLike),
    providerCredentials: new D1ProviderCredentialRepository(testDb.db as unknown as D1DatabaseLike),
    notifications,
    deliveries: new D1DeliveryRepository(
      testDb.db as unknown as D1DatabaseLike,
      (notificationId: string) => notifications.findById(notificationId),
    ),
    outbox: new D1OutboxRepository(testDb.db as unknown as D1DatabaseLike),
    idempotency: new D1IdempotencyRepository(testDb.db as unknown as D1DatabaseLike),
    audit: new D1AuditRepository(testDb.db as unknown as D1DatabaseLike),
    routingPolicy: new D1RoutingPolicyRepository(testDb.db as unknown as D1DatabaseLike),
  };
  const ids = sequentialIds();
  return {
    ports,
    clock,
    ids,
    cipher: overrides.cipher ?? cipherK1(),
    deliveries: ports.deliveries as D1DeliveryRepository,
    notifications,
    outbox: ports.outbox as D1OutboxRepository,
    idempotency: ports.idempotency as D1IdempotencyRepository,
    rateLimit: ports.rateLimit as D1RateLimitStore,
    subscriptions: ports.subscriptions as D1SubscriptionRepository,
    providers: ports.providers as D1ProviderRepository,
  };
}

/**
 * `ResolveProviderCredential` giải mã bằng cipher **thật**, theo version trên record.
 *
 * ⚠️ Đây là bản sao của `buildCredentialResolver` trong `main.ts`, và sự trùng lặp đó có
 * chủ đích: nếu test import hàm của composition root thì nó kéo theo `env` và toàn bộ
 * Hono app, và `main.ts` sẽ phải export nội bộ chỉ để test dùng. Ở đây phần bị sao chép là
 * **một lệnh giải mã theo version của record** — thứ mà test kiểm bằng cipher thật, nên một
 * sai khác về version routing vẫn bị bắt.
 */
export function credentialResolver(
  cipher: WebCryptoCredentialCipher,
  ports: PushNotificationPorts,
): ResolveProviderCredential {
  return async (app, providerId, vapidKeyId) => {
    const record = await ports.providerCredentials.findByVapidKeyId(app, providerId, vapidKeyId);
    if (record === null) {
      return null;
    }
    const privateKey = await cipher.decrypt(
      record.credentialCiphertext,
      record.credentialEncryptionVersion,
    );
    return { privateKey, publicKey: record.publicKey };
  };
}

/** Ghi một credential đã mã hoá cho `scope`, dùng version `K1` mặc định. */
export async function seedEncryptedCredential(
  testDb: TestDatabase,
  scope: SeededScope,
  cipher: WebCryptoCredentialCipher,
  plaintext: string,
  options: { readonly encryptionVersion?: string; readonly vapidKeyId?: string } = {},
): Promise<void> {
  const sealed = await cipher.encrypt(plaintext);
  await testDb.run(
    `UPDATE push_provider_credentials
       SET credential_ciphertext = ?, credential_encryption_version = ?
     WHERE credential_id = ?`,
    sealed.ciphertext,
    options.encryptionVersion ?? sealed.version,
    `cred${scope.app === APP ? '' : `-${scope.app}`}`,
  );
  if (options.vapidKeyId !== undefined) {
    await testDb.run(
      `UPDATE push_provider_credentials SET vapid_key_id = ? WHERE provider_id = ?`,
      options.vapidKeyId,
      scope.providerId,
    );
  }
}
