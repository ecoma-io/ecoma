/**
 * Integration **cross-plane** — đường §12 "control-plane → D1/outbox → Queue → delivery worker
 * → mocked provider → outcome" chạy trên **cả hai worker thật**:
 *
 * - **Control plane thật**: `apps/push-notification/src/main.ts` (composition root, mọi route
 *   qua `worker.fetch`), D1 `push` thật (migrations thật), publisher outbox thật, use case
 *   claim/release/outcome/invalidate thật, cipher credential thật (AES-256-GCM chạy trong test).
 * - **Delivery plane thật**: `handleQueueBatch` của job (không seam nào bị thay), D1 `push-job`
 *   thật, sender Web Push **thật** (mã hoá aes128gcm + ký VAPID ES256 thật chạy trong test).
 *
 * ⚠️ **Vì sao spec này nằm ở app job chứ không phải một app thứ ba.** Nó cần composition root
 * của job và của control plane cùng lúc; import tương đối qua `tests/` (file này) là cách duy
 * nhất hai deploy unit gặp nhau mà không tạo cạnh `app → app` trong `package.json` — cạnh đó bị
 * bảng depConstraints chặn (`type:composition` chỉ compose bốn type lib). Lint/arch-check cho
 * phép đường này vì mọi file `tests/**` chạy trên Node runner của Vitest, không bundle vào
 * Worker edge; `nx sync` tự quản project reference phát sinh trên graph.
 *
 * ⚠️ **Cái gì fake.** Đúng ba chỗ, mỗi chỗ một lý do nằm ở platform, không ở code:
 * 1. **Queue transport** — không có queue local trong platform proxy; producer của control plane
 *    ghi envelope vào mảng, và việc chuyển giao được mô phỏng bằng cách **đưa envelope thật đã
 *    ghi** vào `handleQueueBatch` qua một message giả giữ đúng hợp đồng ack/retry per-message.
 * 2. **Service Binding** — bọc `worker.fetch` của control plane (đúng hợp đồng
 *    `{ fetch: (Request) → Promise<Response> }`); client runtime của job không biết khác biệt.
 * 3. **Provider Web Push** — `globalThis.fetch` bị stub; mọi request của sender thật bị ghi lại
 *    và trả HTTP status theo kịch bản. Không một byte nào rời máy.
 *
 * ⚠️ **Mốc thời gian**: đồng hồ **thật** cả hai phía — composition root của control plane dùng
 * `Date.now()` qua cache config, pipeline của job cũng vậy. Ghim một T0 đóng băng sẽ biến mọi
 * `expires_at` thành quá khứ và mọi test thành "đã hết hạn"; fixture seed ở hiện tại và
 * `expires_at` do use case sinh (`now + max_notification_ttl`) luôn ở tương lai trong thời gian
 * chạy test.
 *
 * ⚠️ **Không log secret**: mọi assertion về credential là **so sánh bằng** với hằng đã có sẵn
 * trong file này (material test) — không in giá trị secret nào qua thông điệp expect khác với
 * việc hai chuỗi bằng nhau, và material test không phải material thật.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Hai import tương đối dưới đây là đường có chủ đích: composition root của control plane
// phải gặp composition root của job trong cùng một process test, mà cạnh `app → app` trong
// package.json bị depConstraints chặn (`type:composition` chỉ compose bốn type lib). Exemption
// theo precedent của root-surface spec từng sống ở `libs/identity-auth-contracts` (đã xoá ở
// issue #324) — file spec chạy
// trên Node runner, không bundle vào Worker edge.
// oxlint-disable-next-line @nx/enforce-module-boundaries
import controlPlaneWorker from '../../../push-notification/src/main';
// oxlint-disable-next-line @nx/enforce-module-boundaries
import { resetConfigCacheForTest } from '../../../push-notification/src/config';

import { handleQueueBatch, type JobWorkerEnv } from '../../src/main';
import { createD1Harness, type D1Harness } from './d1-harness';
import {
  createCpTestDatabase,
  seedCpScope,
  CP_TEST_APP,
  CP_TEST_ENDPOINT,
  CP_TEST_P256DH,
  type CpSeededScope,
  type CpTestDatabase,
} from './cp-d1-harness';
import { WebCryptoCredentialCipher } from '@ecoma-io/push-notification-infrastructure';

/* -------------------------------------------------------------------------------------- */
/* Hằng của kịch bản                                                                          */
/* -------------------------------------------------------------------------------------- */

/** Đường dẫn `wrangler.jsonc` của app job — harness D1 `push-job` đọc binding từ file này. */
const JOB_CONFIG_PATH = new URL('../../wrangler.jsonc', import.meta.url).pathname;

/** Shared secret của private delivery runtime API — material test, không phải secret thật. */
const RUNTIME_SECRET = 'cross-plane-runtime-secret';

/** Principal mà control plane chấp nhận cho runtime API — phải có tiền tố `svc.` (§8.1). */
const RUNTIME_PRINCIPAL = 'svc.web-push-notification-job';

/** Base64 của 32 byte cố định — root key AES-256 `K1` của cipher credential (material test). */
const TEST_ROOT_KEY_K1_BASE64 = btoa(String.fromCodePoint(...new Uint8Array(32).fill(7)));

/**
 * Cặp khoá VAPID **thật** (P-256) — fixture đóng băng, không thuộc môi trường nào. Sender thật
 * ký JWT bằng private key này; nếu chuỗi không parse được DER PKCS#8 thì sender trả
 * `vapid_key_missing` — tức một fixture sai khiến test đỏ vì lý do đúng chứ không phải xanh giả.
 */
const VAPID_PRIVATE_KEY =
  'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsMSsYICHIatB_g0PHR93O4Eg_Q4J9rTI78qRXy_mcfihRANCAASBKbDWRgip1pwZkG_Pxb1MJecoOcd0MPtK_PTyPIuSn1IU8uAOnFU1keldjHXdrPl0SRomizSHj1qhByw84dTb';
const VAPID_PUBLIC_KEY =
  'BIEpsNZGCKnWnBmQb8_FvUwl5yg5x3Qw-0r89PI8i5KfUhTy4A6cVTWR6V2Mdd2s-XRJGiaLNIePWqEHLDzh1Ns';

/**
 * Cipher **cùng key** với env của control plane: `PUSH_CREDENTIAL_ROOT_KEY_K1` là base64 của
 * 32 byte `fill(7)`, nên keyring ở đây phải tạo lại **đúng** 32 byte đó. Seed credential bằng
 * một cipher khác key là cách claim trở thành `409 terminal` fail-closed — test đỏ sai lý do.
 */
function credentialCipherForSeed(): WebCryptoCredentialCipher {
  const rootKey = Uint8Array.from(atob(TEST_ROOT_KEY_K1_BASE64), (character) =>
    character.charCodeAt(0),
  );
  return new WebCryptoCredentialCipher({ currentVersion: 'K1', keysByVersion: { K1: rootKey } });
}

/* -------------------------------------------------------------------------------------- */
/* Env của control plane — mọi biến bắt buộc của `pushConfig` (fail closed khi thiếu)         */
/* -------------------------------------------------------------------------------------- */

/**
 * Giá trị SLA là **giá trị test** — thỏa `assertConfigCoherence`
 * (`idempotency_retention ≥ caller_retry_window`), không phải giá trị đã chốt của docs.
 */
function controlPlaneEnv(cpDb: CpTestDatabase): Record<string, unknown> {
  return {
    IDEMPOTENCY_RETENTION_MS: '7000007',
    CALLER_RETRY_WINDOW_MS: '3000003',
    MAX_NOTIFICATION_TTL_MS: '5000005',
    PAYLOAD_DIGEST_ALGORITHM: 'none',
    OUTBOX_RECOVERY_SLA_MS: '1111111',
    DELIVERY_RECONCILIATION_AGE_MS: '2222222',
    RUNTIME_API_EXPECTED_PRINCIPAL: RUNTIME_PRINCIPAL,
    RUNTIME_API_SHARED_SECRET: RUNTIME_SECRET,
    ADMIN_API_TOKEN: 'admin-token',
    ADMIN_API_PRINCIPAL: 'backoffice',
    APPLICATION_API_TOKEN: 'application-token',
    APPLICATION_API_PRINCIPAL: CP_TEST_APP,
    CREDENTIAL_KEY_VERSION: 'K1',
    CREDENTIAL_SERVING_VERSIONS: 'K1',
    PUSH_CREDENTIAL_ROOT_KEY_K1: TEST_ROOT_KEY_K1_BASE64,
    ENVIRONMENT: 'test',
    LOG_LEVEL: 'error',
    push: cpDb.db,
    /**
     * Producer thật không được test gọi trực tiếp: route `/internal/outbox/publish` là đường
     * duy nhất chạm QUEUE, và binding này **ghi lại** envelope thay vì gửi đi đâu cả —
     * `BindingQueuePublisher.send` chỉ cần `send` resolves thành công, còn envelope thật được
     * đọc lại từ mảng này cho bước chuyển giao sang job.
     */
    QUEUE: {
      send: async (message: unknown) => {
        sent.push(message);
        return { id: 'recorded' };
      },
    },
  };
}

/** Mảng envelope mà producer của control plane đã ghi — reset mỗi test. */
let sent: unknown[];

/** Kiểu context của `fetch` control plane — suy ra từ handler, không tham chiếu global nào. */
type ControlPlaneContext = NonNullable<Parameters<typeof controlPlaneWorker.fetch>[2]>;

/** Gọi một route của control plane qua `worker.fetch` thật. */
async function callControlPlane(
  env: Record<string, unknown>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return controlPlaneWorker.fetch(
    new Request(`https://push-notification.test${path}`, init),
    env as never,
    {} as ControlPlaneContext,
  );
}

/** Header của runtime API — secret nguyên văn trong `Authorization`, không scheme `Bearer`. */
function runtimeHeaders(): Record<string, string> {
  return { authorization: RUNTIME_SECRET, 'x-ecoma-principal': RUNTIME_PRINCIPAL };
}

/* -------------------------------------------------------------------------------------- */
/* Credential thật: cipher K1 mã hoá thật — claim phải giải mã ra đúng private key VAPID      */
/* -------------------------------------------------------------------------------------- */

/**
 * Điểm **quan trọng nhất** của file này: control plane **giải mã** credential bằng cipher trước
 * khi trả material trong claim (`buildCredentialResolver` → `cipher.decrypt(ciphertext,
 * record.version)`); `publicKey` đi thẳng từ cột không mã hoá. Vậy nên credential seed phải là
 * ciphertext thật của plaintext VAPID private key, mã hoá bằng cipher K1 thật với **cùng key**
 * với env.
 *
 * ⚠️ **INSERT chứ không UPDATE**: `seedCpScope` cố ý không seed hàng credential nào (xem
 * harness), nên một `UPDATE` khớp không row nào là **no-op âm thầm** — lookup miss khiến claim
 * trả `409 terminal` fail-closed và cả file đỏ vì lý do sai. Chèn hàng thật sự ở đây.
 */
async function seedEncryptedCredential(cpDb: CpTestDatabase, scope: CpSeededScope): Promise<void> {
  const cipher = credentialCipherForSeed();
  const encrypted = await cipher.encrypt(VAPID_PRIVATE_KEY);
  const now = Date.now();
  await cpDb.run(
    `INSERT INTO push_provider_credentials
       (credential_id, provider_id, app, vapid_key_id, public_key, credential_ciphertext,
        credential_encryption_version, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?8)`,
    `cred-${scope.app}`,
    scope.providerId,
    scope.app,
    scope.vapidKeyId,
    VAPID_PUBLIC_KEY,
    encrypted.ciphertext,
    encrypted.version,
    now,
  );
}

/* -------------------------------------------------------------------------------------- */
/* Message giả giữ đúng hợp đồng ack/retry per-message của Queue                              */
/* -------------------------------------------------------------------------------------- */

interface TrackedMessage {
  readonly body: unknown;
  readonly attempts: number;
  readonly actions: string[];
}

function messageOf(
  body: unknown,
  attempts = 1,
): TrackedMessage & { ack(): void; retry(options?: { delaySeconds?: number }): void } {
  const tracked: TrackedMessage = { body, attempts, actions: [] };
  return {
    get body(): unknown {
      return tracked.body;
    },
    get attempts(): number {
      return tracked.attempts;
    },
    get actions(): readonly string[] {
      return tracked.actions;
    },
    ack(): void {
      tracked.actions.push('ack');
    },
    retry(options?: { delaySeconds?: number }): void {
      tracked.actions.push(
        options?.delaySeconds === undefined ? 'retry' : `retry:${options.delaySeconds}`,
      );
    },
  } as never;
}

/* -------------------------------------------------------------------------------------- */
/* Harness chung — một cặp D1 thật dùng chung, reset giữa các test                            */
/* -------------------------------------------------------------------------------------- */

let cpDb: CpTestDatabase;
let jobDb: D1Harness;

beforeAll(async () => {
  cpDb = await createCpTestDatabase();
  jobDb = await createD1Harness(JOB_CONFIG_PATH);
  await jobDb.applyMigrations();
});

afterAll(async () => {
  await cpDb.dispose();
  await jobDb.dispose();
});

beforeEach(async () => {
  // Cache config là module state của control plane — phải nạp lại từ env của test này, nếu
  // không env test này nhiễm giá trị env của test trước (hoặc của file spec khác chạy chung
  // worker process).
  resetConfigCacheForTest();
  sent = [];
  providerRequests = [];
  // Provider bị chặn ở fetch: sender thật gọi `doFetch(endpoint.href, …)` → stub ghi lại và
  // trả 201. Đúng precedent của `composition-root.spec.ts` — chặn ở fetch là chỗ duy nhất
  // một test có thể chặn mọi request provider mà không chạm code sender.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url =
        typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
      providerRequests.push({ url, status: 201 });
      return new Response('{}', { status: 201 });
    }),
  );
  // Hai D1 thật dùng chung cả file: sạch dữ liệu thay vì dựng proxy mới mỗi test (workerd
  // spawn đắt). Không FK nào trong hai schema, nên thứ tự DELETE tự do; bảng rate-limit và
  // idempotency cũng phải sạch để các test không chia sẻ cửa sổ quota lẫn key replay.
  await cpDb.run('DELETE FROM push_deliveries');
  await cpDb.run('DELETE FROM push_outbox');
  await cpDb.run('DELETE FROM notification_idempotency');
  await cpDb.run('DELETE FROM push_rate_limits');
  await cpDb.run('DELETE FROM push_notifications');
  await cpDb.run('DELETE FROM push_provider_credentials');
  await cpDb.run('DELETE FROM push_app_provider_mappings');
  await cpDb.run('DELETE FROM push_routing_policy');
  await cpDb.run('DELETE FROM push_providers');
  await cpDb.run('DELETE FROM push_subscriptions');
  await cpDb.run('DELETE FROM devices');
  await cpDb.run('DELETE FROM audit_records');
  await jobDb.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface ProviderRequest {
  readonly url: string;
  readonly status: number;
}

let providerRequests: ProviderRequest[] = [];

/**
 * Env của job worker — Service Binding bọc control plane thật, secret khớp env control plane
 * (`RuntimeControlPlaneClient` resolve secret **mỗi request**, nên một env thiếu secret là
 * một `runtime_resolution_errors` thấy được thay vì lỗi compose-time).
 */
function jobEnv(cpEnv: Record<string, unknown>): JobWorkerEnv {
  return {
    'push-job': jobDb.db,
    QUEUE: {
      send: async () => ({ id: 'unused' }),
    },
    PUSH_NOTIFICATION_SERVICE: {
      fetch: (input: Request): Promise<Response> =>
        controlPlaneWorker.fetch(input, cpEnv as never, {} as ControlPlaneContext),
    },
    RUNTIME_API_SHARED_SECRET: RUNTIME_SECRET,
    RUNTIME_API_EXPECTED_PRINCIPAL: RUNTIME_PRINCIPAL,
    LOG_LEVEL: 'error',
    ENVIRONMENT: 'test',
  } as unknown as JobWorkerEnv;
}

/** Envelope cuối cùng mà publisher đã ghi — bài test đọc producer thật thay vì tự chế envelope. */
function lastEnvelope(): Record<string, unknown> {
  expect(sent.length).toBeGreaterThan(0);
  return sent[sent.length - 1] as Record<string, unknown>;
}

/**
 * Golden path rút gọn tới khi envelope đã nằm trên "Queue": seed scope + credential, tạo
 * notification (Application API) → publish outbox (Admin API). Mọi test đường dài dùng chung
 * đoạn này — một chỗ duy nhất để một route đổi tên làm cả file đỏ với đúng assertion thay vì
 * một test lẻ loi pass.
 */
async function driveToQueued(
  cpEnv: Record<string, unknown>,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const scope = await seedCpScope(cpDb);
  await seedEncryptedCredential(cpDb, scope);
  const created = await callControlPlane(cpEnv, '/v1/notifications', {
    method: 'POST',
    headers: {
      authorization: 'Bearer application-token',
      'idempotency-key': idempotencyKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      app: scope.app,
      recipients: [scope.userId],
      notification: { title: 'T', body: 'B' },
    }),
  });
  expect(created.status).toBe(201);
  const createdBody = (await created.json()) as { deliveries_created: number };
  expect(createdBody.deliveries_created).toBe(1);

  const publish = await callControlPlane(cpEnv, '/internal/outbox/publish', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-token' },
  });
  expect(publish.status).toBe(200);
  const publishBody = (await publish.json()) as {
    claimed: number;
    published: number;
    send_calls: number;
  };
  expect(publishBody).toMatchObject({ claimed: 1, published: 1, send_calls: 1 });
  expect(sent).toHaveLength(1);
  return lastEnvelope();
}

/* -------------------------------------------------------------------------------------- */
/* Đường vàng end-to-end                                                                      */
/* -------------------------------------------------------------------------------------- */

describe('cross-plane golden path', () => {
  it('delivers from POST /v1/notifications through outbox, queue handoff, real Web Push sender to a delivered outcome', async () => {
    const cpEnv = controlPlaneEnv(cpDb);
    const envelope = (await driveToQueued(cpEnv, 'e2e-key-1')) as {
      delivery_id: string;
      notification_id: string;
      subscription_id: string;
      provider_id: string;
    };

    // Envelope trên Queue đúng bảy field canonical (§5) — đọc từ producer thật.
    expect(Object.keys(envelope).toSorted()).toEqual([
      'delivery_id',
      'notification_id',
      'payload',
      'provider_id',
      'subscription_id',
      'transport',
      'version',
    ]);
    expect(envelope.version).toBe(1);
    expect(envelope.transport).toBe('web');

    // Consumer của job nhận envelope thật: job state persist → claim runtime (qua Service
    // Binding tới control plane thật, cipher giải mã thật) → sender thật mã hoá + ký → provider.
    const msg = messageOf(envelope);
    await handleQueueBatch(jobEnv(cpEnv), { messages: [msg] });
    expect(msg.actions).toEqual(['ack']);

    // Provider nhận đúng endpoint; body thật của RFC 8291 được kiểm bằng kết cục (payload rõ
    // không bao giờ đi qua `fetch` — sender mã hoá trước khi gọi).
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]?.url).toBe(CP_TEST_ENDPOINT);

    // Logical delivery của control plane ghi `delivered` qua runtime API thật — fenced write
    // theo dispatch_generation, chứng minh trên D1 `push`, không phải trên response.
    const delivery = (
      await cpDb.rows<{ status: string; dispatch_generation: number }>(
        'SELECT status, dispatch_generation FROM push_deliveries WHERE delivery_id = ?1',
        envelope.delivery_id,
      )
    )[0];
    expect(delivery).toMatchObject({ status: 'delivered', dispatch_generation: 1 });

    // Job state của D1 `push-job`: marker processed + kết cục, đúng parity constraint.
    const job = await jobDb.db
      .prepare('SELECT processed, terminal_outcome FROM push_jobs WHERE delivery_id = ?1')
      .bind(envelope.delivery_id)
      .first<{ processed: number; terminal_outcome: string }>();
    expect(job).toMatchObject({ processed: 1, terminal_outcome: 'delivered' });

    // Attempt row: kết cục attempt 1 của lần consume duy nhất — `terminal_sent` (request đã
    // tới provider) và `http_status = 200` là giá trị pipeline **tổng hợp** cho mọi 2xx, kể cả
    // khi provider trả 201 (xem `readHttpStatus`).
    const attempt = await jobDb.db
      .prepare(
        'SELECT outcome, phase, http_status, state FROM push_job_attempts WHERE delivery_id = ?1 AND attempt = ?2',
      )
      .bind(envelope.delivery_id, 1)
      .first<{ outcome: string; phase: string; http_status: number; state: string }>();
    expect(attempt).toMatchObject({
      outcome: 'delivered',
      phase: 'terminal_sent',
      http_status: 200,
      state: 'completed',
    });
  });

  it('returns the runtime material only to the right secret, with the decrypted VAPID private key', async () => {
    const cpEnv = controlPlaneEnv(cpDb);
    const scope = await seedCpScope(cpDb);
    await seedEncryptedCredential(cpDb, scope);
    // Golden path rút gọn tới khi delivery ở `queued` (điều kiện duy nhất của predicate claim).
    const created = await callControlPlane(cpEnv, '/v1/notifications', {
      method: 'POST',
      headers: {
        authorization: 'Bearer application-token',
        'idempotency-key': 'e2e-key-2',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        app: scope.app,
        recipients: [scope.userId],
        notification: { title: 'T', body: 'B' },
      }),
    });
    expect(created.status).toBe(201);
    await callControlPlane(cpEnv, '/internal/outbox/publish', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token' },
    });
    const envelope = lastEnvelope() as { delivery_id: string };

    // Sai secret → `401`; sai principal cũng `401` — cùng một hình thái từ chối, không oracle.
    const badSecret = await callControlPlane(
      cpEnv,
      `/internal/deliveries/${envelope.delivery_id}/claim`,
      {
        method: 'POST',
        headers: { authorization: 'wrong-secret', 'x-ecoma-principal': RUNTIME_PRINCIPAL },
      },
    );
    expect(badSecret.status).toBe(401);
    const badPrincipal = await callControlPlane(
      cpEnv,
      `/internal/deliveries/${envelope.delivery_id}/claim`,
      {
        method: 'POST',
        headers: { authorization: RUNTIME_SECRET, 'x-ecoma-principal': 'svc.impersonator' },
      },
    );
    expect(badPrincipal.status).toBe(401);

    // Đúng secret → `200` + DeliveryClaim. Đây là chỗ chứng minh **decryption thật**: credential
    // trong claim phải là plaintext VAPID private key, không phải bytes ciphertext đã seed.
    const good = await callControlPlane(
      cpEnv,
      `/internal/deliveries/${envelope.delivery_id}/claim`,
      { method: 'POST', headers: runtimeHeaders() },
    );
    expect(good.status).toBe(200);
    const claim = (await good.json()) as {
      status: string;
      dispatch_generation: number;
      subscription: { endpoint: string; p256dh: string; auth: string; vapid_key_id: string };
      provider: { type: string; credential: Record<string, unknown> };
    };
    expect(claim.status).toBe('processing');
    expect(claim.dispatch_generation).toBe(1);
    expect(claim.subscription.endpoint).toBe(CP_TEST_ENDPOINT);
    expect(claim.subscription.p256dh).toBe(CP_TEST_P256DH);
    expect(claim.subscription.vapid_key_id).toBe(scope.vapidKeyId);
    expect(claim.provider.type).toBe('web-push');
    expect(claim.provider.credential['privateKey']).toBe(VAPID_PRIVATE_KEY);
    expect(claim.provider.credential['publicKey']).toBe(VAPID_PUBLIC_KEY);
  });

  it('acks a terminal redelivery without touching the provider, leaving both D1 states untouched', async () => {
    const cpEnv = controlPlaneEnv(cpDb);
    const envelope = (await driveToQueued(cpEnv, 'e2e-key-3')) as { delivery_id: string };

    // Toàn golden path một lần — message đầu tiên đã ACK sau khi delivered.
    await handleQueueBatch(jobEnv(cpEnv), { messages: [messageOf(envelope)] });
    expect(providerRequests).toHaveLength(1);

    // Redelivery sau crash-giữa-persist-và-ACK (W4): marker đã có → ACK ngay, không claim,
    // không provider, không đổi gì trên hai D1.
    providerRequests = [];
    const redelivery = messageOf(envelope, 2);
    await handleQueueBatch(jobEnv(cpEnv), { messages: [redelivery] });
    expect(redelivery.actions).toEqual(['ack']);
    expect(providerRequests).toEqual([]);

    // Control plane không thấy một write nào mới: `delivered` nguyên trạng.
    const delivery = (
      await cpDb.rows<{ status: string }>(
        'SELECT status FROM push_deliveries WHERE delivery_id = ?1',
        envelope.delivery_id,
      )
    )[0];
    expect(delivery?.status).toBe('delivered');
    // Job state: redelivery early-return **trước** `beginAttempt`, nên `consume_count` giữ
    // nguyên ở 1 — "consume_count" đếm lượt qua `beginAttempt`, không phải số message nhận.
    const job = await jobDb.db
      .prepare('SELECT consume_count, processed FROM push_jobs WHERE delivery_id = ?1')
      .bind(envelope.delivery_id)
      .first<{ consume_count: number; processed: number }>();
    expect(job).toMatchObject({ consume_count: 1, processed: 1 });
  });
});

/* -------------------------------------------------------------------------------------- */
/* Đường retry và invalidate qua hai máy bay                                                  */
/* -------------------------------------------------------------------------------------- */

describe('cross-plane transient path', () => {
  it('releases the lease then retries when the provider answers 503, and the retry wins the claim again', async () => {
    const cpEnv = controlPlaneEnv(cpDb);
    const envelope = (await driveToQueued(cpEnv, 'e2e-key-4')) as { delivery_id: string };

    // Lần 1: provider 503 → transient after_send → release lease TRƯỚC rồi retry.
    // ⚠️ One-shot stub phải **tự ghi lại** request: `mockImplementationOnce` thay toàn bộ
    // implementation, nên nếu chỉ trả 503 thì lần gọi này không bao giờ xuất hiện trong
    // `providerRequests` — và assertion đếm request mất khả năng phân biệt "provider trả 503"
    // với "sender ném lỗi trước khi gọi" (hai đường cùng cho `retry` nhưng khác nghĩa).
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (input: unknown) => {
        const url =
          typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
        providerRequests.push({ url, status: 503 });
        return new Response('overloaded', { status: 503 });
      },
    );
    const first = messageOf(envelope);
    await handleQueueBatch(jobEnv(cpEnv), { messages: [first] });
    expect(first.actions).toEqual(['retry']);

    // Release đã thật sự xảy ra trên control plane: delivery quay về `queued` — điều kiện
    // duy nhất cho phép claim kế tiếp thắng (predicate §8.1). Generation **không** đổi ở
    // release (chỉ claim cấp generation mới).
    const released = (
      await cpDb.rows<{ status: string; dispatch_generation: number }>(
        'SELECT status, dispatch_generation FROM push_deliveries WHERE delivery_id = ?1',
        envelope.delivery_id,
      )
    )[0];
    expect(released).toMatchObject({ status: 'queued', dispatch_generation: 1 });

    // Lần 2 (redelivery của Queue): claim thắng lại (generation tăng), provider 201 →
    // delivered, ACK.
    const second = messageOf(envelope, 2);
    await handleQueueBatch(jobEnv(cpEnv), { messages: [second] });
    expect(second.actions).toEqual(['ack']);
    expect(providerRequests).toHaveLength(2);

    const delivery = (
      await cpDb.rows<{ status: string; dispatch_generation: number }>(
        'SELECT status, dispatch_generation FROM push_deliveries WHERE delivery_id = ?1',
        envelope.delivery_id,
      )
    )[0];
    // Generation tăng đúng một lần trên mỗi claim thắng (fencing token).
    expect(delivery).toMatchObject({ status: 'delivered', dispatch_generation: 2 });
  });

  it('invalidates the subscription on the control plane when the provider proves the endpoint is dead (404)', async () => {
    const cpEnv = controlPlaneEnv(cpDb);
    const envelope = (await driveToQueued(cpEnv, 'e2e-key-5')) as {
      delivery_id: string;
      subscription_id: string;
    };

    // Provider trả 404 — bằng chứng duy nhất mà matrix chấp nhận là endpoint chết.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => new Response('gone', { status: 404 }),
    );
    const msg = messageOf(envelope);
    await handleQueueBatch(jobEnv(cpEnv), { messages: [msg] });
    expect(msg.actions).toEqual(['ack']);

    // Subscription bị disable **trên control plane** qua runtime invalidate thật — nguyên nhân
    // `provider_invalidation` là lựa chọn của control plane (`SUBSCRIPTION_DISABLE_CAUSE`),
    // không phải worker tự ghi D1.
    const subscription = (
      await cpDb.rows<{ status: string; disabled_reason: string | null }>(
        'SELECT status, disabled_reason FROM push_subscriptions WHERE subscription_id = ?1',
        envelope.subscription_id,
      )
    )[0];
    expect(subscription).toMatchObject({
      status: 'disabled',
      disabled_reason: 'provider_invalidation',
    });

    // Delivery ghi `failed` (endpoint_invalid là permanent), job có marker cùng kết cục.
    const delivery = (
      await cpDb.rows<{ status: string }>(
        'SELECT status FROM push_deliveries WHERE delivery_id = ?1',
        envelope.delivery_id,
      )
    )[0];
    expect(delivery?.status).toBe('failed');
    const job = await jobDb.db
      .prepare('SELECT processed, terminal_outcome FROM push_jobs WHERE delivery_id = ?1')
      .bind(envelope.delivery_id)
      .first<{ processed: number; terminal_outcome: string }>();
    expect(job).toMatchObject({ processed: 1, terminal_outcome: 'failed' });
  });
});
