/**
 * Kiểm chứng receiver của internal HMAC contract.
 *
 * ⚠️ **Không có verifier viết riêng cho test ở đây.** Mọi assert về chữ ký đi qua
 * `signRequest`/`verifyRequest` của lib contract — một verifier riêng chỉ chứng minh
 * receiver thống nhất với chính nó, chứ không chứng minh nó nói đúng ngôn ngữ với bên ký.
 *
 * ⚠️ **Kho nonce giả PHẢI là kho chiếm-và-ghi**, không phải predicate chỉ-đọc. Đó là hợp
 * đồng của `verifyRequest` và của `InternalNonceStore.claimNonce`, và nó chính là thứ
 * một test tuần tự không bắt được — xem test `read-only claim does not block a replay` ở
 * dưới: với một kho chỉ-đọc, mọi test tuần tự vẫn xanh và replay guard đã chết.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  INTERNAL_NONCE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  NONCE_TTL_BUFFER_SECONDS,
  signRequest,
} from '@ecoma-io/internal-auth-contracts';
import type {
  ClaimMailNonceInput,
  InternalNonceStore,
} from '@ecoma-io/transactional-mail-application';

import {
  FINGERPRINT_KEYRING_ENV,
  type TransactionalMailConfig,
  type TransactionalMailEnv,
  loadTransactionalMailConfig,
} from './config';
import { authenticateInternalRequest, logInternalRejection } from './internal-auth';
import {
  PERMISSION_DELIVERY_OUTCOME,
  PERMISSION_DELIVERY_READ,
  PERMISSION_MESSAGE_CREATE,
} from './principal';

/** Đồng hồ cố định — `nowMs` là input, không đọc đồng hồ thật. */
const NOW_MS = 1_780_000_000_000;
const NOW_SECONDS = String(Math.floor(NOW_MS / 1000));

const SECRET_ACCOUNT = 'secret-svc-account-0001';
const SECRET_AUTH = 'secret-svc-auth-0002';
const SECRET_PAYMENT = 'secret-svc-payment-0003';
const SECRET_MAILER_JOB = 'secret-svc-mailer-job-0004';

const KEY_A = 'a'.repeat(64);

/** Nonce cố định cho test replay — UUID v4 để `isStrongNonce` chấp nhận thẳng. */
const NONCE_REPLAYED = '11111111-2222-4333-8444-555555555555';
/** Nonce dùng chung cho test cô lập chéo-principal. */
const NONCE_SHARED = '12345678-1234-4234-8234-123456789abc';
/** Nonce của lần probe sai secret — request thật sau đó dùng lại đúng nonce này. */
const NONCE_PROBE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
/** Nonce gửi hai lần dưới cùng một principal. */
const NONCE_SAME_PRINCIPAL = '99999999-8888-4777-8666-555555555555';

/** Khoá `(principal, nonce)` của một kho nonce bền, giữ đúng hợp đồng của port. */
interface ClaimRow {
  readonly principal: string;
  readonly nonce: string;
  readonly expiresAtEpochSeconds: number;
}

/**
 * Kho nonce giả **chiếm-và-ghi**: `true` khi khoá đã tồn tại (tức replay), `false` khi
 * claim mới thành công — cùng nghĩa với `INSERT … ON CONFLICT DO NOTHING` rồi đếm số
 * hàng trả về.
 */
class RecordingNonceStore implements InternalNonceStore {
  readonly rows = new Map<string, ClaimRow>();

  async claimNonce(input: ClaimMailNonceInput): Promise<boolean> {
    const key = `${input.principal}::${input.nonce}`;
    if (this.rows.has(key)) {
      return true;
    }
    this.rows.set(key, { ...input });
    return false;
  }

  async deleteExpiredNonces(): Promise<number> {
    return 0;
  }

  /** Số hàng đã ghi thật — assert này mới bắt được một `claim` chỉ-đọc. */
  get size(): number {
    return this.rows.size;
  }
}

/** Kho chỉ-đọc: **không** ghi gì, luôn trả `false` — hợp đồng bị vi phạm có chủ đích. */
class ReadOnlyNonceStore implements InternalNonceStore {
  readonly claims: ClaimMailNonceInput[] = [];

  async claimNonce(input: ClaimMailNonceInput): Promise<boolean> {
    this.claims.push(input);
    return false;
  }

  async deleteExpiredNonces(): Promise<number> {
    return 0;
  }
}

/** Kho ném lỗi — mô phỏng D1 không tới được. */
class FailingNonceStore implements InternalNonceStore {
  async claimNonce(): Promise<boolean> {
    throw new Error('D1 unavailable: mail_internal_nonces unreachable');
  }

  async deleteExpiredNonces(): Promise<number> {
    throw new Error('D1 unavailable: mail_internal_nonces unreachable');
  }
}

/**
 * Kho **không** đảo ngược `true`/`false`: lần đầu trả `false` (chưa từng thấy), mọi lần
 * sau trả `true`. Dùng để chứng minh vòng duyệt **dừng ở lần khớp đầu**: nếu cứ trả
 * `false`, một receiver duyệt hết registry sẽ xanh y như request được chấp nhận nhiều
 * lần.
 */
class AlwaysFreshNonceStore implements InternalNonceStore {
  #calls = 0;

  async claimNonce(): Promise<boolean> {
    this.#calls += 1;
    return this.#calls > 1;
  }

  async deleteExpiredNonces(): Promise<number> {
    return 0;
  }

  get calls(): number {
    return this.#calls;
  }
}

function makeEnv(overrides: Partial<TransactionalMailEnv> = {}): TransactionalMailEnv {
  return {
    [FINGERPRINT_KEYRING_ENV]: JSON.stringify({ current: 'p1.k1', keys: { 'p1.k1': KEY_A } }),
    MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT: SECRET_ACCOUNT,
    MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH: SECRET_AUTH,
    MAIL_INTERNAL_AUTH_SECRET_SVC_PAYMENT: SECRET_PAYMENT,
    MAIL_INTERNAL_AUTH_SECRET_SVC_TRANSACTIONAL_MAILER_JOB: SECRET_MAILER_JOB,
    MAIL_RATE_LIMIT_PRINCIPAL_LIMIT: '60',
    MAIL_RATE_LIMIT_PRINCIPAL_WINDOW_MS: '60000',
    MAIL_RATE_LIMIT_SYSTEM_LIMIT: '10000',
    MAIL_RATE_LIMIT_SYSTEM_WINDOW_MS: '60000',
    MAIL_RATE_LIMIT_KEY_LIMIT: '20',
    MAIL_RATE_LIMIT_KEY_WINDOW_MS: '60000',
    MAIL_RENDER_MAX_BYTES: '64000',
    MAIL_PUBLISH_LEASE_MS: '30000',
    MAIL_PUBLISH_BATCH_LIMIT: '10',
    MAIL_PUBLISH_MAX_ATTEMPTS: '5',
    MAIL_PUBLISH_BACKOFF_BASE_MS: '1000',
    MAIL_RECONCILER_MAX_AGE_MS: '600000',
    MAIL_RECONCILER_BATCH_LIMIT: '50',
    MAIL_RECOVERY_MAX_CYCLES: '5',
    MAIL_NONCE_PRUNE_BATCH_LIMIT: '500',
    MAIL_RETENTION_CONTENT_MS: '2592000000',
    MAIL_RETENTION_STALE_ALERT_MS: '86400000',
    ...overrides,
  };
}

async function makeConfig(
  overrides: Partial<TransactionalMailEnv> = {},
): Promise<TransactionalMailConfig> {
  return await loadTransactionalMailConfig(makeEnv(overrides), { cache: false });
}

interface EnvelopeOptions {
  readonly method?: string;
  readonly path?: string;
  readonly body?: Uint8Array | null;
  readonly secret?: string;
  readonly timestamp?: string;
  readonly nonce?: string;
}

/**
 * Dựng một request có envelope HMAC **thật** — ký bằng `signRequest` của contract.
 *
 * ⚠️ `path` mặc định là `pathname` **không kèm query**: receiver dựng canonical từ
 * `pathname` (không route nào của service này định nghĩa query string). Test query bên
 * dưới kiểm riêng rằng query ⇒ `invalid_field`.
 */
async function signedRequest(options: EnvelopeOptions = {}): Promise<{
  request: Request;
  body: Uint8Array | null;
}> {
  const method = options.method ?? 'POST';
  const path = options.path ?? '/internal/deliveries/dlv_123/outcome';
  const body = options.body === undefined ? null : options.body;
  const headers = await signRequest({
    method,
    path,
    body,
    secret: options.secret ?? SECRET_MAILER_JOB,
    timestamp: options.timestamp ?? NOW_SECONDS,
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
  });
  const request = new Request(`https://mail.internal${path}`, {
    method,
    headers: new Headers(headers),
  });
  return { request, body };
}

describe('authenticateInternalRequest — golden vector', () => {
  it('authenticates an envelope signed by the matching principal credential', async () => {
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    const { request, body } = await signedRequest();
    const outcome = await authenticateInternalRequest(
      { config, nonces, nowMs: NOW_MS },
      request,
      body,
    );
    expect(outcome).toEqual({
      kind: 'authenticated',
      principal: {
        principal: 'svc.transactional-mailer-job',
        permissions: [PERMISSION_DELIVERY_READ, PERMISSION_DELIVERY_OUTCOME],
      },
    });
    // Đúng MỘT claim cho một request được chấp nhận.
    expect(nonces.size).toBe(1);
  });

  it('derives TTL from the envelope timestamp, not from the verifier clock', async () => {
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    // Timestamp lệch về quá khứ trong cửa sổ skew: TTL phải neo theo ENVELOPE.
    const envelopeTimestamp = Number(NOW_SECONDS) - 120;
    const { request, body } = await signedRequest({ timestamp: String(envelopeTimestamp) });
    await authenticateInternalRequest({ config, nonces, nowMs: NOW_MS }, request, body);
    const [row] = [...nonces.rows.values()];
    expect(row?.expiresAtEpochSeconds).toBe(
      envelopeTimestamp + config.skewSeconds + NONCE_TTL_BUFFER_SECONDS,
    );
  });

  it.each([
    ['svc.account', SECRET_ACCOUNT, [PERMISSION_MESSAGE_CREATE]],
    ['svc.auth', SECRET_AUTH, [PERMISSION_MESSAGE_CREATE]],
    ['svc.payment', SECRET_PAYMENT, [PERMISSION_MESSAGE_CREATE]],
    [
      'svc.transactional-mailer-job',
      SECRET_MAILER_JOB,
      [PERMISSION_DELIVERY_READ, PERMISSION_DELIVERY_OUTCOME],
    ],
  ])(
    'authenticates %s with its own credential and no other permissions',
    async (principal, secret, permissions) => {
      const config = await makeConfig();
      const nonces = new RecordingNonceStore();
      const { request, body } = await signedRequest({ secret });
      const outcome = await authenticateInternalRequest(
        { config, nonces, nowMs: NOW_MS },
        request,
        body,
      );
      expect(outcome).toEqual({ kind: 'authenticated', principal: { principal, permissions } });
    },
  );

  it('authenticates a previous credential of the same principal during rotation overlap', async () => {
    const config = await makeConfig({
      MAIL_INTERNAL_AUTH_SECRET_SVC_TRANSACTIONAL_MAILER_JOB_PREVIOUS: 'secret-mailer-prev',
    });
    const nonces = new RecordingNonceStore();
    const { request, body } = await signedRequest({ secret: 'secret-mailer-prev' });
    const outcome = await authenticateInternalRequest(
      { config, nonces, nowMs: NOW_MS },
      request,
      body,
    );
    expect(outcome).toEqual({
      kind: 'authenticated',
      principal: {
        principal: 'svc.transactional-mailer-job',
        permissions: [PERMISSION_DELIVERY_READ, PERMISSION_DELIVERY_OUTCOME],
      },
    });
  });

  it('verifies the exact bytes on the wire, not a decoded string', async () => {
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    // Byte không hợp lệ UTF-8: `TextDecoder` non-fatal sẽ thay bằng U+FFFD, hai payload
    // khác byte sẽ băm thành một. Receiver phải verify được byte thật.
    const body = new Uint8Array([0xff, 0xfe, 0x00, 0x7b]);
    const { request } = await signedRequest({ body });
    const outcome = await authenticateInternalRequest(
      { config, nonces, nowMs: NOW_MS },
      request,
      body,
    );
    expect(outcome.kind).toBe('authenticated');
  });
});

describe('authenticateInternalRequest — replay guard', () => {
  it('rejects the second send of the same envelope and records the nonce row', async () => {
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    const { request, body } = await signedRequest({ nonce: NONCE_REPLAYED });

    const first = await authenticateInternalRequest(
      { config, nonces, nowMs: NOW_MS },
      request,
      body,
    );
    expect(first.kind).toBe('authenticated');

    // Mutation-check có ý nghĩa: nếu `claimNonce` chỉ ĐỌC, hàng này không tồn tại và test
    // đỏ ở assertion dưới chứ không phải ở assertion kết quả.
    expect(nonces.size).toBe(1);
    expect([...nonces.rows.keys()]).toEqual([`svc.transactional-mailer-job::${NONCE_REPLAYED}`]);

    const second = await authenticateInternalRequest(
      { config, nonces, nowMs: NOW_MS },
      request,
      body,
    );
    expect(second).toEqual({ kind: 'rejected', status: 401, reason: 'replayed_nonce' });
  });

  it('a read-only claim does not block a replay', async () => {
    // ⚠️ Test mutation của hợp đồng `claimNonce`. Ở đây kho **vi phạm** hợp đồng (chỉ đọc,
    // luôn `false`) và receiver vẫn trả `authenticated` cho cả hai lần gửi — tức replay
    // guard đã chết trong khi mọi assert khác vẫn xanh. Đổi kho giả trong các test khác
    // thành loại này là suite vẫn xanh: đó là lý do test này tồn tại.
    const config = await makeConfig();
    const nonces = new ReadOnlyNonceStore();
    const { request, body } = await signedRequest();

    const first = await authenticateInternalRequest(
      { config, nonces, nowMs: NOW_MS },
      request,
      body,
    );
    const second = await authenticateInternalRequest(
      { config, nonces, nowMs: NOW_MS },
      request,
      body,
    );
    expect(first.kind).toBe('authenticated');
    expect(second.kind).toBe('authenticated');
    // Không có hàng nào được ghi — hợp đồng chiếm-và-ghi đã bị vi phạm, đúng như cố ý.
    expect(nonces.claims).toHaveLength(2);
  });

  it('does not let a failed signature probe burn the nonce of a real request', async () => {
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    const nonce = NONCE_PROBE;

    const probe = await signedRequest({ secret: 'attacker-secret', nonce });
    const probeOutcome = await authenticateInternalRequest(
      { config, nonces, nowMs: NOW_MS },
      probe.request,
      probe.body,
    );
    expect(probeOutcome).toEqual({ kind: 'rejected', status: 401, reason: 'bad_signature' });
    expect(nonces.size).toBe(0);

    const real = await signedRequest({ nonce });
    const realOutcome = await authenticateInternalRequest(
      { config, nonces, nowMs: NOW_MS },
      real.request,
      real.body,
    );
    expect(realOutcome.kind).toBe('authenticated');
  });

  it('scopes the nonce key by principal so one consumer cannot block another', async () => {
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    // Cùng nonce, hai principal khác nhau — cả hai đều phải được nhận.
    const nonce = NONCE_SHARED;

    const asAccount = await signedRequest({ secret: SECRET_ACCOUNT, nonce });
    const asAuth = await signedRequest({ secret: SECRET_AUTH, nonce });

    const accountOutcome = await authenticateInternalRequest(
      { config, nonces, nowMs: NOW_MS },
      asAccount.request,
      asAccount.body,
    );
    const authOutcome = await authenticateInternalRequest(
      { config, nonces, nowMs: NOW_MS },
      asAuth.request,
      asAuth.body,
    );

    expect(accountOutcome).toEqual({
      kind: 'authenticated',
      principal: { principal: 'svc.account', permissions: [PERMISSION_MESSAGE_CREATE] },
    });
    expect(authOutcome).toEqual({
      kind: 'authenticated',
      principal: { principal: 'svc.auth', permissions: [PERMISSION_MESSAGE_CREATE] },
    });
    // ⚠️ Không dùng `toSorted` lẫn `sort()` ở đây: `lib` của project là `es2022` nên
    // không có `toSorted` (nâng `lib` là thay đổi tsconfig ngoài phạm vi của PR này), còn
    // repo cấm `Array#sort`. Assert từng khoá một là đúng hơn và không cần sắp xếp: nó
    // **không phụ thuộc thứ tự chèn** và còn đòi đúng hai hàng, nên một khoá ghi trùng
    // thành một hàng cũng đỏ.
    expect(nonces.size).toBe(2);
    expect(nonces.rows.has(`svc.account::${NONCE_SHARED}`)).toBe(true);
    expect(nonces.rows.has(`svc.auth::${NONCE_SHARED}`)).toBe(true);
  });

  it('rejects the same nonce twice under the same principal', async () => {
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    const nonce = NONCE_SAME_PRINCIPAL;
    const first = await signedRequest({ secret: SECRET_AUTH, nonce });
    expect(
      (
        await authenticateInternalRequest(
          { config, nonces, nowMs: NOW_MS },
          first.request,
          first.body,
        )
      ).kind,
    ).toBe('authenticated');
    const second = await signedRequest({ secret: SECRET_AUTH, nonce });
    expect(
      await authenticateInternalRequest(
        { config, nonces, nowMs: NOW_MS },
        second.request,
        second.body,
      ),
    ).toEqual({ kind: 'rejected', status: 401, reason: 'replayed_nonce' });
  });

  it('stops at the first matching credential so one request claims exactly once', async () => {
    const base = await makeConfig();
    // ⚠️ Registry **cố ý mơ hồ** ở test này: hai entry khác principal mang CÙNG một
    // secret. Loader chặn cấu hình này lúc boot (test ở `config.spec.ts`), nhưng nhánh
    // "dừng ở lần khớp đầu" của receiver vẫn phải **đúng kể cả khi nó xảy ra** — vì đó là
    // điều kiện để mỗi request tạo đúng một claim. Với registry gồm các secret KHÁC NHAU,
    // không candidate sau nào có thể khớp, nên early-stop không quan sát được; phải dựng
    // registry mơ hồ mới đo được.
    const shared = 'secret-shared-by-two-principals';
    const ambiguous: TransactionalMailConfig = {
      ...base,
      credentialRegistry: [
        { principal: 'svc.account', secret: shared, kind: 'current' },
        { principal: 'svc.auth', secret: shared, kind: 'current' },
      ],
      permissionsByPrincipal: base.permissionsByPrincipal,
    };
    const nonces = new AlwaysFreshNonceStore();
    const { request, body } = await signedRequest({ secret: shared });
    const outcome = await authenticateInternalRequest(
      { config: ambiguous, nonces, nowMs: NOW_MS },
      request,
      body,
    );
    // Dừng ở candidate ĐẦU ⇒ principal của candidate đầu, và đúng MỘT claim. Nếu
    // receiver đi tiếp, candidate thứ hai cũng khớp, claim thứ hai trả `true` ⇒ kết quả
    // là `replayed_nonce` trên chính một request hợp lệ.
    expect(outcome).toEqual({
      kind: 'authenticated',
      principal: { principal: 'svc.account', permissions: [PERMISSION_MESSAGE_CREATE] },
    });
    expect(nonces.calls).toBe(1);
  });
});

describe('authenticateInternalRequest — candidate order and cross-principal isolation', () => {
  it('tries the next candidate when the first one does not match', async () => {
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    // Ký bằng secret của `svc.payment` — candidate thứ 3 trong registry.
    const { request, body } = await signedRequest({ secret: SECRET_PAYMENT });
    const outcome = await authenticateInternalRequest(
      { config, nonces, nowMs: NOW_MS },
      request,
      body,
    );
    expect(outcome).toEqual({
      kind: 'authenticated',
      principal: { principal: 'svc.payment', permissions: [PERMISSION_MESSAGE_CREATE] },
    });
    // Claim phải gắn với principal của candidate **đã khớp**, không phải candidate đầu.
    expect([...nonces.rows.keys()]).toEqual([`svc.payment::${nonceOf(request)}`]);
  });

  it('rejects when no credential matches', async () => {
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    const { request, body } = await signedRequest({ secret: 'secret-of-nobody' });
    expect(
      await authenticateInternalRequest({ config, nonces, nowMs: NOW_MS }, request, body),
    ).toEqual({
      kind: 'rejected',
      status: 401,
      reason: 'bad_signature',
    });
    expect(nonces.size).toBe(0);
  });

  it('never authenticates a credential of one principal as another', async () => {
    // ⚠️ SR-002: credential của `svc.account` dùng để authenticate với tư cách
    // `svc.auth` là `401`, vì receiver suy principal TỪ credential khớp chứ không tin claim.
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    const { request, body } = await signedRequest({ secret: SECRET_ACCOUNT });
    const outcome = await authenticateInternalRequest(
      { config, nonces, nowMs: NOW_MS },
      request,
      body,
    );
    expect(outcome).toEqual({
      kind: 'authenticated',
      principal: { principal: 'svc.account', permissions: [PERMISSION_MESSAGE_CREATE] },
    });
    expect(outcome.kind === 'authenticated' && outcome.principal.principal).not.toBe('svc.auth');
  });

  it('ignores a caller-supplied principal header', async () => {
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    const { request } = await signedRequest({ secret: SECRET_ACCOUNT });
    // Header identity do caller kiểm soát là **claim**, không phải authentication
    // (`01-architecture.md` §7.4). Không route nào trong service được đọc nó.
    request.headers.set('x-ecoma-principal', 'svc.transactional-mailer-job');
    request.headers.set('x-ecoma-app', 'transactional-mailer-job');
    const outcome = await authenticateInternalRequest(
      { config, nonces, nowMs: NOW_MS },
      request,
      null,
    );
    expect(outcome).toEqual({
      kind: 'authenticated',
      principal: { principal: 'svc.account', permissions: [PERMISSION_MESSAGE_CREATE] },
    });
  });
});

describe('authenticateInternalRequest — reasons independent of the secret', () => {
  it('stops immediately on a missing header without trying another credential', async () => {
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    const { request } = await signedRequest();
    request.headers.delete(INTERNAL_SIGNATURE_HEADER);
    expect(
      await authenticateInternalRequest({ config, nonces, nowMs: NOW_MS }, request, null),
    ).toEqual({
      kind: 'rejected',
      status: 401,
      reason: 'missing_header',
    });
    // Header thiếu không phụ thuộc secret, nên vòng duyệt phải dừng ngay — và vì thế kho nonce
    // không được chạm (dù sao chưa có credential nào được thử).
    expect(nonces.size).toBe(0);
  });

  it('stops immediately on a malformed timestamp without trying another credential', async () => {
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    const { request } = await signedRequest();
    request.headers.set(INTERNAL_TIMESTAMP_HEADER, 'not-a-number');
    expect(
      await authenticateInternalRequest({ config, nonces, nowMs: NOW_MS }, request, null),
    ).toEqual({
      kind: 'rejected',
      status: 401,
      reason: 'bad_timestamp',
    });
    expect(nonces.size).toBe(0);
  });

  it('stops immediately on a timestamp outside the skew window', async () => {
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    const stale = String(Number(NOW_SECONDS) - config.skewSeconds - 1);
    const { request, body } = await signedRequest({ timestamp: stale });
    expect(
      await authenticateInternalRequest({ config, nonces, nowMs: NOW_MS }, request, body),
    ).toEqual({
      kind: 'rejected',
      status: 401,
      reason: 'bad_timestamp',
    });
    expect(nonces.size).toBe(0);
  });

  it('rejects a weak nonce without trying another credential', async () => {
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    const { request, body } = await signedRequest({ nonce: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(
      await authenticateInternalRequest({ config, nonces, nowMs: NOW_MS }, request, body),
    ).toEqual({
      kind: 'rejected',
      status: 401,
      reason: 'weak_nonce',
    });
    expect(nonces.size).toBe(0);
  });

  it('rejects a tampered body byte with bad_signature', async () => {
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    const body = new TextEncoder().encode(JSON.stringify({ outcome: 'failed' }));
    const { request } = await signedRequest({ body });
    // Đổi đúng MỘT byte trên dây sau khi ký.
    const tampered = new Uint8Array(body);
    tampered[0] = tampered[0] === 0x7b ? 0x5b : 0x7b;
    expect(
      await authenticateInternalRequest({ config, nonces, nowMs: NOW_MS }, request, tampered),
    ).toEqual({ kind: 'rejected', status: 401, reason: 'bad_signature' });
    expect(nonces.size).toBe(0);
  });

  it.each([
    ['a bare hex signature with no version prefix', 'abcdef'],
    ['a wrong version prefix', 'v2=abcdef'],
    ['an empty version', 'v1='],
    ['uppercase hex', `v1=${'A'.repeat(64)}`],
  ])('rejects %s with bad_signature', async (_label, signature) => {
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    const { request, body } = await signedRequest();
    request.headers.set(INTERNAL_SIGNATURE_HEADER, signature);
    expect(
      await authenticateInternalRequest({ config, nonces, nowMs: NOW_MS }, request, body),
    ).toEqual({
      kind: 'rejected',
      status: 401,
      reason: 'bad_signature',
    });
  });

  it('rejects a request carrying a query string with invalid_field before any HMAC work', async () => {
    // Receiver dựng canonical từ `pathname`; không route nào của service định nghĩa
    // query string, nên canonical hợp lệ không bao giờ chứa một cái. Lý do phải là
    // `invalid_field` (canonical không dựng được) chứ không phải `bad_signature` — và
    // việc từ chối phải xảy ra TRƯỚC vòng duyệt, tức kho nonce không được chạm.
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    const headers = await signRequest({
      method: 'GET',
      path: '/internal/deliveries/dlv_123?detail=full',
      secret: SECRET_MAILER_JOB,
      timestamp: NOW_SECONDS,
    });
    const request = new Request('https://mail.internal/internal/deliveries/dlv_123?detail=full', {
      method: 'GET',
      headers: new Headers(headers),
    });
    expect(
      await authenticateInternalRequest({ config, nonces, nowMs: NOW_MS }, request, null),
    ).toEqual({
      kind: 'rejected',
      status: 401,
      reason: 'invalid_field',
    });
    expect(nonces.size).toBe(0);
  });

  it('accepts a bare trailing question mark, which carries no query parameter', async () => {
    // ⚠️ **Biên đã đo, không phải suy ra.** `new URL('…/y?').search` là `""` trong khi
    // `request.url` vẫn giữ dấu `?` — nên một `?` trần không mang tham số nào và request đó
    // giống hệt một request không có query. Chặn nó sẽ buộc phải soi **chuỗi thô** của URL
    // (`url.includes('?')`) để ra quyết định về một thứ mà `URL` đã phân giải xong — đúng
    // kiểu so chuỗi bị qua mặt mà repo cấm. Ở đây bất biến được quyết định bằng **URL
    // parse**: không có query ⇒ không có `?` trong canonical.
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    const headers = await signRequest({
      method: 'GET',
      path: '/internal/deliveries/dlv_123',
      secret: SECRET_MAILER_JOB,
      timestamp: NOW_SECONDS,
    });
    const request = new Request('https://mail.internal/internal/deliveries/dlv_123?', {
      method: 'GET',
      headers: new Headers(headers),
    });
    const outcome = await authenticateInternalRequest(
      { config, nonces, nowMs: NOW_MS },
      request,
      null,
    );
    expect(outcome.kind).toBe('authenticated');
  });

  it('rejects a body over the protocol limit with 413', async () => {
    const config = await makeConfig();
    const nonces = new RecordingNonceStore();
    const body = new Uint8Array(64 * 1024 + 1);
    const { request } = await signedRequest({ body });
    // Caller phải tự chặn lúc đọc; ở đây là chốt phòng thủ kép, và nó phải chạy TRƯỚC
    // candidate đầu tiên — nên kho nonce không được chạm.
    expect(
      await authenticateInternalRequest({ config, nonces, nowMs: NOW_MS }, request, body),
    ).toEqual({
      kind: 'rejected',
      status: 413,
      reason: 'invalid_field',
    });
    expect(nonces.size).toBe(0);
  });
});

describe('authenticateInternalRequest — infrastructure failure', () => {
  it('maps a nonce store exception to 503 and not to 401', async () => {
    const config = await makeConfig();
    const { request, body } = await signedRequest();
    const outcome = await authenticateInternalRequest(
      { config, nonces: new FailingNonceStore(), nowMs: NOW_MS },
      request,
      body,
    );
    // 401 ở đây sẽ khẳng định sai rằng nonce chưa từng thấy — tức mở cửa sổ replay.
    expect(outcome).toEqual({
      kind: 'rejected',
      status: 503,
      reason: 'nonce_store_unavailable',
    });
  });
});

describe('logInternalRejection', () => {
  it('writes one parseable JSON line carrying only event and reason', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      logInternalRejection('replayed_nonce');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toHaveLength(1);
      expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toEqual({
        event: 'internal_auth_rejected',
        reason: 'replayed_nonce',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('never throws, even when the sink itself fails', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('log sink unavailable');
    });
    try {
      expect(() => logInternalRejection('nonce_store_unavailable')).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

/** Đọc nonce thật của một request đã ký, dùng để assert khoá claim theo tên. */
function nonceOf(request: Request): string {
  return request.headers.get(INTERNAL_NONCE_HEADER) ?? '';
}
