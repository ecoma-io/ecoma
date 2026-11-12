/**
 * Bootstrap runner 8b (`db/bootstrap-marketplace.mts`) trên PostgreSQL thật +
 * **upstream mock dùng chung** `tools/llm-upstream-mock` spawn thành tiến trình
 * con (ADR-0020: runner chạy bằng `tsx` như trên lane local; smoke probe gọi
 * network thật — Issue #23: xác nhận credential sống bằng request trực tiếp
 * tới provider, không qua quota).
 *
 * Vì sao spawn chứ không import: mock là `type:tooling`/`runtime:native`, app
 * là `type:composition`/`runtime:edge` — module boundary cấm cạnh import trên
 * cả ba trục; tiến trình con không tạo cạnh Nx graph (chi tiết ở helper
 * `tests/integrations/upstream-mock.ts`).
 *
 * Phủ: seed endpoint + pool + credential (hash-only) + ModelOffer; probe thất
 * bại (URL chết, 401 sai credential, timeout) ⇒ endpoint `degraded`, offer
 * `draft` (fail-closed mặt serving); probe thành công + verdict hợp lệ ⇒
 * activation; re-run là no-op; đổi key là rotation (revoke cũ, không xoá; quay
 * lại key đã revoke bị chặn); base URL có suffix `/v1` không nhân đôi path;
 * verdict lệch tenant bị từ chối; credential bị từ chối trên serving path của
 * tenant khác (`credential_tenant_mismatch`) và không tồn tại đường lookup
 * theo `provider` một mình (ADR-0027 §8).
 *
 * Chứng minh Bearer: mock bật `MOCK_UPSTREAM_EXPECTED_AUTHORIZATION` — credential
 * chỉ đi qua env của tiến trình con, mock trả 401 khi header lệch. Group activate
 * chứng minh probe gửi đúng `Authorization: Bearer <plaintext-từ-env>` (log
 * `auth=ok` của mock) và group sai credential chứng minh fail-closed tương ứng.
 *
 * Plaintext upstream key chỉ tồn tại trong env của tiến trình con; DB chỉ chứa
 * SHA-256 hex — suite khẳng định không cột plaintext nào và không plaintext nào
 * trong stdout/stderr của runner lẫn mock.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  migratorUrl,
  runBootstrapCli,
  startLlmApiDatabase,
  type ApplyCliResult,
  type LlmApiDatabase,
} from '../integrations/harness.ts';
import {
  startUpstreamMock,
  stopAllUpstreamMocks,
  type UpstreamMockProcess,
} from '../integrations/upstream-mock.ts';
import { resetMarketplace } from './bootstrap-database-reset.ts';
import { SELLER_TENANT_ID } from '../../db/bootstrap-shared.mts';
import {
  assertCredentialProvider,
  createSellerTenantId,
  type ProviderCredential,
} from '@ecoma-io/llm-marketplace-domain';

const ACTOR = 'ecoma-bootstrap';
const PROVIDER = 'dronie-upstream';
const RAW_MODEL = 'Dronie-Flash';
const PROTOCOL = 'openai_chat';
const PLAINTEXT_ONE = 'sk-test-upstream-show-once-1';
const PLAINTEXT_TWO = 'sk-test-upstream-show-once-2';
const OFFER_ID = `model-offer-${SELLER_TENANT_ID}-dronie-flash`;

let db: LlmApiDatabase;

beforeAll(async () => {
  db = await startLlmApiDatabase();
}, 180_000);

afterAll(async () => {
  // Stop mock trước khi hạ container: SIGTERM (SIGKILL nếu cần) — kể cả khi có
  // socket đang treo cố ý của scenario `timeout`, không để lại tiến trình sót.
  await stopAllUpstreamMocks();
  await db?.stop();
});

/** Verdict eligibility của 8a dạng wire — marketplace chỉ tiêu thụ. */
function verdict(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tenantId: SELLER_TENANT_ID,
    eligible: true,
    blockers: [],
    assessedAt: Date.now(),
    ...overrides,
  });
}

/** Env đầy đủ cho một run 8b trỏ tới `baseUrl`. */
function marketplaceEnv(
  baseUrl: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    ECOMA_GOVERNANCE_ACTOR: ACTOR,
    LLM_UPSTREAM_PROVIDER: PROVIDER,
    LLM_UPSTREAM_MODEL: RAW_MODEL,
    LLM_UPSTREAM_BASE_URL: baseUrl,
    LLM_UPSTREAM_PROTOCOL: PROTOCOL,
    LLM_UPSTREAM_CREDENTIAL_PLAINTEXT: PLAINTEXT_ONE,
    SELLER_ELIGIBILITY_VERDICT: verdict(),
    ...overrides,
  };
}

function runMarketplace(env: Record<string, string>): Promise<ApplyCliResult> {
  return runBootstrapCli({
    script: 'db/bootstrap-marketplace.mts',
    databaseUrl: migratorUrl('marketplace', db.host, db.port),
    env,
  });
}

/** Trích dòng máy đọc `KEY=value` cuối cùng từ stdout. */
function stdoutLine(stdout: string, key: string): string {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith(`${key}=`));
  if (line === undefined) {
    throw new Error(`stdout must carry a ${key}= line; got: ${stdout}`);
  }
  return line.slice(key.length);
}

/**
 * Fence không lộ credential: plaintext không xuất hiện trong bất kỳ output nào
 * của run (stdout/stderr runner + stdout/stderr mock).
 */
function expectNoPlaintextLeak(
  runs: readonly ApplyCliResult[],
  mocks: readonly UpstreamMockProcess[],
): void {
  const outputs = [
    ...runs.flatMap((run) => [run.stdout, run.stderr]),
    ...mocks.flatMap((mock) => [mock.stdout(), mock.stderr()]),
  ];
  for (const output of outputs) {
    expect(output).not.toContain(PLAINTEXT_ONE);
    expect(output).not.toContain(PLAINTEXT_TWO);
  }
}

interface OfferRow {
  status: string;
  normalized_model_id: string;
  activated_at: string | null;
}

interface CredentialRow {
  id: string;
  credential_hash: string;
  revoked_at: string | null;
}

async function fetchOffer(): Promise<OfferRow> {
  const client = await db.connectAsMigrator('marketplace');
  try {
    const result = await client.query<OfferRow>(
      'SELECT status, normalized_model_id, activated_at::text AS activated_at FROM llm_marketplace.model_offers WHERE id = $1',
      [OFFER_ID],
    );
    expect(result.rows[0], 'offer row must exist').toBeDefined();
    return result.rows[0];
  } finally {
    await client.end();
  }
}

async function fetchCredentials(): Promise<CredentialRow[]> {
  const client = await db.connectAsMigrator('marketplace');
  try {
    const result = await client.query<CredentialRow>(
      `SELECT id, credential_hash, revoked_at::text AS revoked_at
         FROM llm_marketplace.provider_credentials
        WHERE seller_tenant_id = $1 AND provider = $2
        ORDER BY created_at, id`,
      [SELLER_TENANT_ID, PROVIDER],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function fetchEndpointHealth(): Promise<string> {
  const client = await db.connectAsMigrator('marketplace');
  try {
    const endpoints = await client.query<{ health: string }>(
      'SELECT health FROM llm_marketplace.upstream_endpoints WHERE id = $1',
      [`${OFFER_ID}-pool-1-endpoint-1`],
    );
    expect(endpoints.rows[0], 'endpoint row must exist').toBeDefined();
    return endpoints.rows[0].health;
  } finally {
    await client.end();
  }
}

describe('bootstrap runner 8b (marketplace) on real PostgreSQL with the shared upstream mock', () => {
  // Mỗi group tự reset `llm_marketplace` và tự sở hữu mock instance riêng:
  // endpoint target là bất biến qua bootstrap (URL đổi ⇒ fail-closed), nên
  // hai group không thể chia một mock; reset ở hook đảm bảo group trước hỏng
  // giữa chừng thì group sau vẫn seed fresh và báo kết quả của chính nó.
  describe('dead upstream (connection refused)', () => {
    it('seeds offer, pool and credential hash-only, stays draft and degraded when the probe cannot connect', async () => {
      const result = await runMarketplace(marketplaceEnv('http://127.0.0.1:1'));
      expect(stdoutLine(result.stdout, 'MARKETPLACE_RESULT')).toContain(
        '"outcome":"created-draft-unhealthy"',
      );
      const offer = await fetchOffer();
      expect(offer.status).toBe('draft');
      expect(offer.normalized_model_id).toBe('dronie-flash');
      expect(offer.activated_at).toBeNull();
      expect(await fetchEndpointHealth()).toBe('degraded');
      // Hash-only: đúng SHA-256 của plaintext, không cột plaintext nào chứa giá trị.
      const credentials = await fetchCredentials();
      expect(credentials).toHaveLength(1);
      expect(credentials[0].credential_hash).toBe(
        createHash('sha256').update(PLAINTEXT_ONE, 'utf8').digest('hex'),
      );
      expect(result.stderr).not.toContain(PLAINTEXT_ONE);
    });
  });

  describe('activation chain on a credential-checking mock', () => {
    let mock: UpstreamMockProcess;
    let activationRun: ApplyCliResult;

    beforeAll(async () => {
      await resetMarketplace(db);
      // Một instance duy nhất cho cả chuỗi vì endpoint URL bất biến; expected
      // authorization chấp nhận cả hai key để các run sau rotation vẫn probe được.
      mock = await startUpstreamMock({
        MOCK_UPSTREAM_EXPECTED_AUTHORIZATION: JSON.stringify([
          `Bearer ${PLAINTEXT_ONE}`,
          `Bearer ${PLAINTEXT_TWO}`,
        ]),
      });
      activationRun = await runMarketplace(marketplaceEnv(mock.url));
    }, 60_000);

    afterAll(async () => {
      await mock?.stop();
    });

    it('activates the offer and proves the probe sent the Bearer credential from the environment', async () => {
      const summary = stdoutLine(activationRun.stdout, 'MARKETPLACE_RESULT');
      expect(summary).toContain('"activation":"activated"');
      const offer = await fetchOffer();
      expect(offer.status).toBe('active');
      expect(offer.activated_at).not.toBeNull();
      expect(await fetchEndpointHealth()).toBe('healthy');
      // Bearer proof: mock chỉ chấp nhận đúng giá trị `Bearer <PLAINTEXT_ONE>`;
      // một request thiếu/sai header đã bị 401 từ chối. Log chỉ mang verdict
      // một-bit `auth=ok` — không bao giờ chứa giá trị header.
      expect(mock.stdout()).toContain('auth=ok');
      expect(mock.stdout()).not.toContain('auth=rejected');
      expectNoPlaintextLeak([activationRun], [mock]);
    });

    it('reruns as a no-op without a new credential row or a re-activation', async () => {
      const before = await fetchCredentials();
      const result = await runMarketplace(marketplaceEnv(mock.url));
      expect(stdoutLine(result.stdout, 'MARKETPLACE_RESULT')).toContain('"outcome":"no-op"');
      expect(stdoutLine(result.stdout, 'MARKETPLACE_RESULT')).toContain(
        '"activation":"already-active"',
      );
      expect(await fetchCredentials()).toEqual(before);
      expectNoPlaintextLeak([result], [mock]);
    });

    it('rotates the credential when the upstream key changes: new row active, old row revoked, nothing deleted', async () => {
      const before = await fetchCredentials();
      expect(before).toHaveLength(1);
      const result = await runMarketplace(
        marketplaceEnv(mock.url, { LLM_UPSTREAM_CREDENTIAL_PLAINTEXT: PLAINTEXT_TWO }),
      );
      expect(stdoutLine(result.stdout, 'MARKETPLACE_RESULT')).toContain(
        '"credentialRotationFrom":"' + before[0].id + '"',
      );
      const after = await fetchCredentials();
      expect(after).toHaveLength(2);
      const active = after.find((row) => row.revoked_at === null);
      const revoked = after.find((row) => row.revoked_at !== null);
      expect(active?.id).not.toBe(before[0].id);
      expect(active?.credential_hash).toBe(
        createHash('sha256').update(PLAINTEXT_TWO, 'utf8').digest('hex'),
      );
      expect(revoked?.id).toBe(before[0].id);
      expect((await fetchOffer()).status).toBe('active');
      // Run này vẫn healthy vì mock chấp nhận cả hai key (endpoint URL bất biến
      // buộc một instance); bằng chứng probe gửi đúng giá trị env nằm ở group
      // activation và group /v1 — mỗi group đó khóa expected về đúng một giá trị.
      expectNoPlaintextLeak([result], [mock]);
    });

    it('refuses to reactivate a revoked credential when configuration reverts to an old key', async () => {
      const before = await fetchCredentials();
      // Quay về PLAINTEXT_ONE — key đã bị revoke ở bước rotation. Rotation là
      // một chiều: converge về cấu hình bằng cách resurrect key đã thu hồi là
      // bị cấm; runner phải fail-closed và để nguyên durable state.
      await expect(runMarketplace(marketplaceEnv(mock.url))).rejects.toThrow(
        /already revoked|one-way/u,
      );
      expect(await fetchCredentials()).toEqual(before);
      expect((await fetchOffer()).status).toBe('active');
    });

    it('rejects a verdict belonging to another seller tenant fail-closed before touching state', async () => {
      const credentialsBefore = await fetchCredentials();
      await expect(
        runMarketplace(
          marketplaceEnv(mock.url, {
            SELLER_ELIGIBILITY_VERDICT: verdict({ tenantId: 'seller-tenant-someone-else' }),
          }),
        ),
      ).rejects.toThrow(/does not belong to the canonical seller tenant/u);
      expect(await fetchCredentials()).toEqual(credentialsBefore);
    });

    it('keeps credentials tenant-scoped on the access path: other tenant is rejected, no provider-only lookup exists', async () => {
      const credentials = await fetchCredentials();
      const active = credentials.find((row) => row.revoked_at === null);
      if (active === undefined) {
        throw new Error('an active credential row must exist after rotation');
      }
      const rehydrated: ProviderCredential = {
        id: active.id,
        provider: PROVIDER,
        sellerTenantId: createSellerTenantId(SELLER_TENANT_ID),
        credentialHash: active.credential_hash,
        createdBy: ACTOR,
        createdAt: 0,
        revokedAt: null,
        revokedBy: null,
      };
      const tenantCheck = assertCredentialProvider(
        rehydrated,
        PROVIDER,
        createSellerTenantId(SELLER_TENANT_ID),
      );
      expect(tenantCheck.ok).toBe(true);
      const mismatch = assertCredentialProvider(
        rehydrated,
        PROVIDER,
        createSellerTenantId('seller-tenant-someone-else'),
      );
      expect(mismatch.ok).toBe(false);
      expect(mismatch).toMatchObject({ error: { code: 'credential_tenant_mismatch' } });
      // Không tồn tại đường lookup theo `provider` một mình: mỗi SELECT credential
      // trong runner đều scope theo owning tenant (ADR-0027 §8).
      const runnerSource = readFileSync(
        resolve(import.meta.dirname, '..', '..', 'db', 'bootstrap-marketplace.mts'),
        'utf8',
      );
      expect(runnerSource).not.toMatch(/WHERE\s+provider\s*=/u);
    });
  });

  describe('wrong Bearer credential is rejected by the upstream and fails closed', () => {
    let mock: UpstreamMockProcess;
    let rejectedRun: ApplyCliResult;

    beforeAll(async () => {
      await resetMarketplace(db);
      // Mock chỉ chấp nhận một giá trị KHÁC với credential trong env của runner:
      // 401 của upstream là điều kiện fail-closed mặt serving.
      mock = await startUpstreamMock({
        MOCK_UPSTREAM_EXPECTED_AUTHORIZATION: 'Bearer sk-test-definitely-not-the-seeded-key',
      });
      rejectedRun = await runMarketplace(marketplaceEnv(mock.url));
    }, 60_000);

    afterAll(async () => {
      await mock?.stop();
    });

    it('stays draft and degraded when the upstream answers 401 to the configured credential', async () => {
      expect(stdoutLine(rejectedRun.stdout, 'MARKETPLACE_RESULT')).toContain(
        '"outcome":"created-draft-unhealthy"',
      );
      expect((await fetchOffer()).status).toBe('draft');
      expect(await fetchEndpointHealth()).toBe('degraded');
      // Bằng chứng probe THẬT SỰ gửi header: mock ghi verdict `auth=rejected`
      // cho request của probe (chỉ khi header lệch giá trị expected).
      expect(mock.stdout()).toContain('auth=rejected');
      expectNoPlaintextLeak([rejectedRun], [mock]);
    });
  });

  describe('base URL with a /v1 suffix', () => {
    let mock: UpstreamMockProcess;
    let activationResult: ApplyCliResult;

    beforeAll(async () => {
      await resetMarketplace(db);
      mock = await startUpstreamMock({
        MOCK_UPSTREAM_EXPECTED_AUTHORIZATION: `Bearer ${PLAINTEXT_ONE}`,
      });
      // Base URL theo quy ước OpenAI (có sẵn `/v1`): probe phải strip suffix rồi
      // ghép `v1/models` — nhân đôi `/v1/v1/models` sẽ 404 và offer đứng ở draft.
      activationResult = await runMarketplace(marketplaceEnv(`${mock.url}/v1`));
    }, 60_000);

    afterAll(async () => {
      await mock?.stop();
    });

    it('activates through a conventional /v1-suffixed base URL without doubling the path', async () => {
      expect(stdoutLine(activationResult.stdout, 'MARKETPLACE_RESULT')).toContain(
        '"activation":"activated"',
      );
      expect((await fetchOffer()).status).toBe('active');
      expect(mock.stdout()).toContain('GET /v1/models scenario=ok status=200');
      expect(mock.stdout()).toContain('auth=ok');
      expectNoPlaintextLeak([activationResult], [mock]);
    });
  });

  describe('upstream timeout (no response at all)', () => {
    let mock: UpstreamMockProcess;
    let timeoutRun: ApplyCliResult;

    beforeAll(async () => {
      await resetMarketplace(db);
      // Scenario `timeout`: mock giữ socket treo — probe phải tự hết hạn qua
      // AbortSignal 10s của runner (không đợi mock), rồi fail-closed. Mock
      // timeoutMs 15s > 10s để chứng minh abort đến từ phía runner.
      mock = await startUpstreamMock({
        MOCK_UPSTREAM_SCENARIO: 'timeout',
        MOCK_UPSTREAM_TIMEOUT_MS: '15000',
      });
      timeoutRun = await runMarketplace(marketplaceEnv(mock.url));
    }, 60_000);

    afterAll(async () => {
      // Socket đang treo cố ý phải được dọn bởi SIGTERM handler của mock
      // (destroyPendingSockets) — afterAll này chứng minh shutdown sạch.
      await mock?.stop();
    });

    it('stays draft and degraded when the upstream never answers and the probe aborts', async () => {
      expect(stdoutLine(timeoutRun.stdout, 'MARKETPLACE_RESULT')).toContain(
        '"outcome":"created-draft-unhealthy"',
      );
      expect((await fetchOffer()).status).toBe('draft');
      expect(await fetchEndpointHealth()).toBe('degraded');
      expectNoPlaintextLeak([timeoutRun], [mock]);
    }, 30_000);
  });
});
