/**
 * Bootstrap runner 8b — seed marketplace offering của Seller tenant canonical
 * vào `db-llm-marketplace` (schema `llm_marketplace`): endpoint + pool +
 * provider credential (hash-only) + ModelOffer, rồi kích hoạt offer khi pool
 * healthy và verdict eligibility từ 8a còn dùng được.
 *
 * Source of truth: ADR-0020 (Quyết định 4, 5, 6, 12, 13), ADR-0027 §7–§8,
 * Issue #23. Chạy sau 8a (verdict đi qua `SELLER_ELIGIBILITY_VERDICT` do deploy
 * extract từ stdout của 8a) và sau `db:migrate marketplace`; chạy lại là no-op
 * theo natural key; divergence là fail-closed.
 *
 * Credential (ADR-0027 §8, show-once/hash-only):
 * - plaintext upstream key chỉ tồn tại trong env của run này; DB chỉ lưu
 *   SHA-256 hex; plaintext không bao giờ được log/echo/ghép vào câu lệnh.
 * - hai trục scope: `provider` + `seller_tenant_id`; lookup credential luôn
 *   trong tập của owning tenant — không có đường theo `provider` một mình.
 * - cùng key chạy lại là no-op; key mới (hash khác) là rotation: credential
 *   mới + revoke credential cũ (không xoá dữ liệu audit).
 *
 * Smoke probe: gọi trực tiếp upstream (GET `/v1/models` với Bearer key) để xác
 * nhận credential sống — config-gated bởi chính env của run. Endpoint chỉ được
 * ghi `healthy` khi probe thật sự thành công; thất bại ⇒ endpoint ở `degraded`,
 * offer ở `draft` (fail-closed ở mặt serving), run vẫn thành công để re-run
 * kích hoạt được ở lần sau.
 *
 * stdout giữ máy đọc: `SELLER_ELIGIBILITY_VERDICT` đến từ 8a; run này in
 * `MARKETPLACE_RESULT=<json>`; log người đọc đi stderr.
 */

import { Client } from 'pg';
import {
  assertEligibilityForTenant,
  activateModelOffer,
  createCapabilitySet,
  createEndpointPool,
  createModelOffer,
  createProviderCredential,
  createUpstreamEndpoint,
  isSellerOperationalEligibility,
  normalizeModelId,
  revokeProviderCredential,
  type EndpointPool,
  type ModelOffer,
  type ProviderCredential,
  type SellerOperationalEligibility,
  type UpstreamEndpoint,
} from '@ecoma-io/llm-marketplace-domain';
import {
  BOOTSTRAP_ACTOR_ENV,
  SELLER_TENANT_ID,
  assertBootstrapDatabase,
  fail,
  log,
  optionalEnv,
  printResultJson,
  requireEnv,
  sha256Hex,
  type BootstrapRunResult,
} from './bootstrap-shared.mts';

/** Cấu hình upstream + verdict từ env của run. */
interface MarketplaceSeedInput {
  readonly actor: string;
  readonly provider: string;
  readonly upstreamModel: string;
  readonly baseUrl: string;
  readonly protocol: string;
  readonly credentialPlaintext: string;
  readonly verdict: SellerOperationalEligibility | undefined;
}

/**
 * Smoke probe GET {base}/v1/models — trả true khi HTTP 2xx.
 *
 * Base URL chấp nhận cả hai quy ước của upstream OpenAI-compatible: gốc
 * (`https://host`) và có sẵn suffix `/v1` (`https://host/v1`) — suffix `/v1`
 * bị strip trước khi ghép `v1/models`, không nhân đôi thành `/v1/v1/models`.
 */
async function probeUpstream(baseUrl: string, credentialPlaintext: string): Promise<boolean> {
  const withoutV1Suffix = baseUrl.replace(/\/v1\/?$/u, '/');
  const root = withoutV1Suffix.endsWith('/') ? withoutV1Suffix : `${withoutV1Suffix}/`;
  const modelsUrl = new URL('v1/models', root);
  try {
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${credentialPlaintext}` },
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Parse + validate verdict từ 8a; sai shape là lỗi wiring → fail-closed. */
/** Marketplace domain error là `{code, message}` — format ổn định cho stderr. */
function formatDomainError(error: { code: string; message: string } | string): string {
  return typeof error === 'string' ? error : `${error.code}: ${error.message}`;
}

function parseVerdict(raw: string | undefined): SellerOperationalEligibility | undefined {
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(
      'SELLER_ELIGIBILITY_VERDICT is not valid JSON; the deploy wiring between runner 8a and 8b is broken',
    );
  }
  if (!isSellerOperationalEligibility(parsed)) {
    fail(
      'SELLER_ELIGIBILITY_VERDICT failed the marketplace verdict shape guard; refusing to consume an unusable verdict',
    );
  }
  const tenantCheck = assertEligibilityForTenant(parsed, SELLER_TENANT_ID);
  if (!tenantCheck.ok) {
    fail(
      `SELLER_ELIGIBILITY_VERDICT does not belong to the canonical seller tenant: ${tenantCheck.error}`,
    );
  }
  return parsed;
}

interface OfferRow {
  id: string;
  seller_tenant_id: string;
  normalized_model_id: string;
  status: string;
  public_alias: string | null;
  capabilities: string[];
  created_at: string | number;
  updated_at: string | number;
  activated_at: string | number | null;
  deactivated_at: string | number | null;
  retired_at: string | number | null;
}

/** Ghép row thành ModelOffer cho domain guards. */
function rehydrateOffer(row: OfferRow): ModelOffer {
  const capabilities = createCapabilitySet(row.capabilities);
  if (!capabilities.ok) {
    fail(
      `stored capabilities of offer "${row.id}" failed the capability set guard; divergent provisioning state`,
    );
  }
  return {
    id: row.id,
    sellerTenantId: row.seller_tenant_id,
    normalizedModelId: row.normalized_model_id,
    status: row.status as ModelOffer['status'],
    publicAlias: row.public_alias,
    capabilities: capabilities.value,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    activatedAt: row.activated_at === null ? null : Number(row.activated_at),
    deactivatedAt: row.deactivated_at === null ? null : Number(row.deactivated_at),
    retiredAt: row.retired_at === null ? null : Number(row.retired_at),
  };
}

/** Seed offer nếu chưa có; fact bất biến của offer hiện có là fail-closed. */
async function upsertOffer(
  client: Client,
  input: MarketplaceSeedInput,
): Promise<{ offer: ModelOffer; outcome: 'created' | 'existing' }> {
  const normalized = normalizeModelId(input.upstreamModel);
  if (!normalized.ok) {
    fail(`upstream model identity rejected by domain: ${formatDomainError(normalized.error)}`);
  }
  const offerId = `model-offer-${SELLER_TENANT_ID}-${normalized.value}`;
  const existingResult = await client.query<OfferRow>(
    'SELECT id, seller_tenant_id, normalized_model_id, status, public_alias, capabilities, created_at, updated_at, activated_at, deactivated_at, retired_at FROM llm_marketplace.model_offers WHERE id = $1',
    [offerId],
  );
  const existingRow = existingResult.rows[0];
  if (existingRow !== undefined) {
    if (existingRow.seller_tenant_id !== SELLER_TENANT_ID) {
      fail(`offer "${offerId}" is owned by another seller tenant; divergent provisioning state`);
    }
    if (existingRow.normalized_model_id !== normalized.value) {
      fail(
        `offer "${offerId}" carries model "${existingRow.normalized_model_id}" but configuration seeds "${normalized.value}"; the model identity of an offer is immutable`,
      );
    }
    return { offer: rehydrateOffer(existingRow), outcome: 'existing' };
  }
  // createdAt = assessedAt của verdict: offer tồn tại là hệ quả của lần đánh
  // giá này, nên verdict không bao giờ "stale" so với chính offer nó sinh ra.
  const createdAt = input.verdict?.assessedAt ?? Date.now();
  const created = createModelOffer({
    id: offerId,
    sellerTenantId: SELLER_TENANT_ID,
    normalizedModelId: normalized.value,
    capabilities: ['chat'],
    createdAt,
  });
  if (!created.ok) {
    fail(`model offer creation rejected by domain: ${formatDomainError(created.error)}`);
  }
  await client.query(
    `INSERT INTO llm_marketplace.model_offers
       (id, seller_tenant_id, normalized_model_id, status, public_alias, capabilities, created_at, updated_at, activated_at, deactivated_at, retired_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO NOTHING`,
    [
      created.value.id,
      created.value.sellerTenantId,
      created.value.normalizedModelId,
      created.value.status,
      created.value.publicAlias,
      JSON.stringify(created.value.capabilities.capabilities),
      created.value.createdAt,
      created.value.updatedAt,
      created.value.activatedAt,
      created.value.deactivatedAt,
      created.value.retiredAt,
    ],
  );
  return { offer: created.value, outcome: 'created' };
}

/** Seed pool rỗng của offer. */
async function upsertPool(
  client: Client,
  now: number,
  offer: ModelOffer,
): Promise<{ poolId: string; outcome: 'created' | 'existing' }> {
  const poolId = `${offer.id}-pool-1`;
  const existing = await client.query<{ id: string; offer_id: string }>(
    'SELECT id, offer_id FROM llm_marketplace.endpoint_pools WHERE id = $1',
    [poolId],
  );
  if (existing.rows[0] !== undefined) {
    if (existing.rows[0].offer_id !== offer.id) {
      fail(`endpoint pool "${poolId}" belongs to another offer; divergent provisioning state`);
    }
    return { poolId, outcome: 'existing' };
  }
  const created = createEndpointPool({ id: poolId, offerId: offer.id, createdAt: now });
  if (!created.ok) {
    fail(`endpoint pool creation rejected by domain: ${formatDomainError(created.error)}`);
  }
  await client.query(
    `INSERT INTO llm_marketplace.endpoint_pools (id, offer_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [created.value.id, created.value.offerId, created.value.createdAt, created.value.updatedAt],
  );
  return { poolId, outcome: 'created' };
}

interface EndpointRow {
  id: string;
  pool_id: string;
  url: string;
  protocol: string;
  health: string;
  weight: string | number;
  created_at: string | number;
  health_recorded_at: string | number | null;
  updated_at: string | number;
}

/** Ghép row thành UpstreamEndpoint cho domain guards. */
function rehydrateEndpoint(row: EndpointRow): UpstreamEndpoint {
  return {
    id: row.id,
    endpointPoolId: row.pool_id,
    url: row.url,
    protocol: row.protocol,
    health: row.health as UpstreamEndpoint['health'],
    weight: Number(row.weight),
    createdAt: Number(row.created_at),
    healthRecordedAt: row.health_recorded_at === null ? null : Number(row.health_recorded_at),
  };
}

/** Seed endpoint mặc định `degraded` (chưa probe thì không healthy). */
async function upsertEndpoint(
  client: Client,
  now: number,
  poolId: string,
  input: MarketplaceSeedInput,
): Promise<{ endpointId: string; outcome: 'created' | 'existing' }> {
  const endpointId = `${poolId}-endpoint-1`;
  const existing = await client.query<EndpointRow>(
    'SELECT id, pool_id, url, protocol, health, weight, created_at, health_recorded_at, updated_at FROM llm_marketplace.upstream_endpoints WHERE id = $1',
    [endpointId],
  );
  const row = existing.rows[0];
  if (row !== undefined) {
    if (row.pool_id !== poolId || row.url !== input.baseUrl || row.protocol !== input.protocol) {
      fail(
        `upstream endpoint "${endpointId}" diverges from the configured upstream target; the endpoint target is immutable through bootstrap`,
      );
    }
    return { endpointId, outcome: 'existing' };
  }
  const created = createUpstreamEndpoint({
    id: endpointId,
    endpointPoolId: poolId,
    url: input.baseUrl,
    protocol: input.protocol,
    createdAt: now,
  });
  if (!created.ok) {
    fail(`upstream endpoint creation rejected by domain: ${formatDomainError(created.error)}`);
  }
  await client.query(
    `INSERT INTO llm_marketplace.upstream_endpoints (id, pool_id, url, protocol, health, weight, created_at, health_recorded_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO NOTHING`,
    [
      created.value.id,
      created.value.endpointPoolId,
      created.value.url,
      created.value.protocol,
      created.value.health,
      created.value.weight,
      created.value.createdAt,
      created.value.healthRecordedAt,
      created.value.createdAt,
    ],
  );
  return { endpointId, outcome: 'created' };
}

interface CredentialRow {
  id: string;
  provider: string;
  seller_tenant_id: string;
  credential_hash: string;
  created_by: string;
  created_at: string | number;
  revoked_at: string | number | null;
  revoked_by: string | null;
}

/** Ghép row thành ProviderCredential cho domain guards. */
function rehydrateCredential(row: CredentialRow): ProviderCredential {
  return {
    id: row.id,
    provider: row.provider,
    sellerTenantId: row.seller_tenant_id,
    credentialHash: row.credential_hash,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    revokedBy: row.revoked_by,
  };
}

/**
 * Seed/rotate credential trong tập của owning tenant. Lookup luôn theo
 * `(seller_tenant_id, provider)` — không có đường theo `provider` một mình.
 */
async function upsertCredential(
  client: Client,
  now: number,
  input: MarketplaceSeedInput,
): Promise<{ created: boolean; rotatedFrom: string | null }> {
  const hash = sha256Hex(input.credentialPlaintext);
  const credentialId = `provider-credential-${hash.slice(0, 24)}`;
  const tenantCredentials = await client.query<CredentialRow>(
    'SELECT id, provider, seller_tenant_id, credential_hash, created_by, created_at, revoked_at, revoked_by FROM llm_marketplace.provider_credentials WHERE seller_tenant_id = $1 AND provider = $2',
    [SELLER_TENANT_ID, input.provider],
  );
  const sameHash = tenantCredentials.rows.find((row) => row.credential_hash === hash);
  if (sameHash !== undefined) {
    if (sameHash.id !== credentialId) {
      fail(
        `credential hash already stored under another id ("${sameHash.id}"); credential identity is derived from the hash and must stay deterministic`,
      );
    }
    // Hash trùng một credential đã revoke: rotation là một chiều (revoke cũ +
    // tạo mới, không resurrect). Converge về cấu hình bằng cách "quay lại" key
    // đã thu hồi sẽ âm thầm làm DB lệch config — fail-closed và yêu cầu key mới.
    if (sameHash.revoked_at !== null) {
      fail(
        'the configured credential matches a credential that was already revoked; rotation is one-way and a revoked credential is never reactivated — configure a new credential plaintext',
      );
    }
    return { created: false, rotatedFrom: null };
  }
  const created = createProviderCredential({
    id: credentialId,
    provider: input.provider,
    sellerTenantId: SELLER_TENANT_ID,
    credentialHash: hash,
    plaintext: input.credentialPlaintext,
    createdBy: input.actor,
    createdAt: now,
  });
  if (!created.ok) {
    fail(`provider credential creation rejected by domain: ${formatDomainError(created.error)}`);
  }
  // Rotation: credential active khác hash cùng (tenant, provider) bị revoke —
  // không xoá; dữ liệu audit giữ nguyên.
  const activeOld = tenantCredentials.rows
    .map(rehydrateCredential)
    .find((credential) => credential.revokedAt === null);
  if (activeOld !== undefined) {
    const revoked = revokeProviderCredential({
      credential: activeOld,
      revokedBy: input.actor,
      revokedAt: now,
    });
    if (!revoked.ok) {
      fail(
        `previous credential revocation rejected by domain: ${formatDomainError(revoked.error)}`,
      );
    }
    await client.query(
      'UPDATE llm_marketplace.provider_credentials SET revoked_at = $2, revoked_by = $3 WHERE id = $1',
      [revoked.value.id, revoked.value.revokedAt, revoked.value.revokedBy],
    );
  }
  await client.query(
    `INSERT INTO llm_marketplace.provider_credentials (id, provider, seller_tenant_id, credential_hash, created_by, created_at, revoked_at, revoked_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (seller_tenant_id, credential_hash) DO NOTHING`,
    [
      created.value.credential.id,
      created.value.credential.provider,
      created.value.credential.sellerTenantId,
      created.value.credential.credentialHash,
      created.value.credential.createdBy,
      created.value.credential.createdAt,
      created.value.credential.revokedAt,
      created.value.credential.revokedBy,
    ],
  );
  return { created: true, rotatedFrom: activeOld?.id ?? null };
}

/** CLI entry — env là kênh cấu hình duy nhất; plaintext không bao giờ được log. */
async function main(): Promise<void> {
  const input: MarketplaceSeedInput = {
    actor: requireEnv(BOOTSTRAP_ACTOR_ENV),
    provider: requireEnv('LLM_UPSTREAM_PROVIDER'),
    upstreamModel: requireEnv('LLM_UPSTREAM_MODEL'),
    baseUrl: requireEnv('LLM_UPSTREAM_BASE_URL'),
    protocol: requireEnv('LLM_UPSTREAM_PROTOCOL'),
    credentialPlaintext: requireEnv('LLM_UPSTREAM_CREDENTIAL_PLAINTEXT'),
    verdict: parseVerdict(optionalEnv('SELLER_ELIGIBILITY_VERDICT')),
  };
  const databaseUrl = requireEnv('DATABASE_URL');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await assertBootstrapDatabase(client, 'db-llm-marketplace');
    await client.query('BEGIN');
    // Txn 1: seed các row marketplace (all-or-nothing).
    const seeded = await (async (): Promise<{
      offer: ModelOffer;
      offerOutcome: 'created' | 'existing';
      poolId: string;
      poolOutcome: 'created' | 'existing';
      endpointId: string;
      endpointOutcome: 'created' | 'existing';
      credentialOutcome: { created: boolean; rotatedFrom: string | null };
    }> => {
      const { offer, outcome: offerOutcome } = await upsertOffer(client, input);
      const now = Date.now();
      const { poolId, outcome: poolOutcome } = await upsertPool(client, now, offer);
      const { endpointId, outcome: endpointOutcome } = await upsertEndpoint(
        client,
        now,
        poolId,
        input,
      );
      const credentialOutcome = await upsertCredential(client, now, input);
      return {
        offer,
        offerOutcome,
        poolId,
        poolOutcome,
        endpointId,
        endpointOutcome,
        credentialOutcome,
      };
    })();
    await client.query('COMMIT');

    // Smoke probe ngoài transaction — không giữ kết nối DB trong lúc gọi mạng.
    const smokeHealthy = await probeUpstream(input.baseUrl, input.credentialPlaintext);
    if (!smokeHealthy) {
      log(
        'upstream smoke probe failed; endpoint stays degraded and the offer stays draft (fail-closed serving); rerun this step once the upstream is reachable',
      );
    }

    // Txn 2: ghi health + activation + audit từ kết quả probe.
    await client.query('BEGIN');
    let activationOutcome:
      | 'activated'
      | 'already-active'
      | 'not-activated'
      | 'stays-draft-no-verdict' = 'not-activated';
    if (smokeHealthy) {
      await client.query(
        `UPDATE llm_marketplace.upstream_endpoints
         SET health = 'healthy', health_recorded_at = $2, updated_at = $2
         WHERE id = $1 AND health <> 'healthy'`,
        [seeded.endpointId, Date.now()],
      );
      const endpointRow = await client.query<EndpointRow>(
        'SELECT id, pool_id, url, protocol, health, weight, created_at, health_recorded_at, updated_at FROM llm_marketplace.upstream_endpoints WHERE id = $1',
        [seeded.endpointId],
      );
      const endpoint = rehydrateEndpoint(endpointRow.rows[0]);
      const pool: EndpointPool = {
        id: seeded.poolId,
        offerId: seeded.offer.id,
        endpoints: [endpoint],
        createdAt: seeded.offer.createdAt,
        updatedAt: Date.now(),
      };
      const currentOfferRow = await client.query<OfferRow>(
        'SELECT id, seller_tenant_id, normalized_model_id, status, public_alias, capabilities, created_at, updated_at, activated_at, deactivated_at, retired_at FROM llm_marketplace.model_offers WHERE id = $1',
        [seeded.offer.id],
      );
      const currentOffer = rehydrateOffer(currentOfferRow.rows[0]);
      if (currentOffer.status === 'draft' && input.verdict !== undefined) {
        const activated = activateModelOffer({
          offer: currentOffer,
          eligibility: input.verdict,
          pools: [pool],
          activatedAt: Date.now(),
        });
        if (!activated.ok) {
          fail(`model offer activation rejected by domain: ${formatDomainError(activated.error)}`);
        }
        await client.query(
          `UPDATE llm_marketplace.model_offers
           SET status = $2, activated_at = $3, updated_at = $3
           WHERE id = $1`,
          [activated.value.id, activated.value.status, activated.value.activatedAt],
        );
        activationOutcome = 'activated';
      } else if (currentOffer.status === 'active') {
        activationOutcome = 'already-active';
      } else {
        activationOutcome = 'stays-draft-no-verdict';
        log(
          'offer stays draft: no eligibility verdict was provided by the deploy wiring; rerun after runner 8a succeeds',
        );
      }
    }
    const outcome: BootstrapRunResult['outcome'] =
      seeded.offerOutcome === 'created' ||
      seeded.poolOutcome === 'created' ||
      seeded.endpointOutcome === 'created' ||
      seeded.credentialOutcome.created
        ? smokeHealthy
          ? 'created'
          : 'created-draft-unhealthy'
        : smokeHealthy
          ? 'no-op'
          : 'created-draft-unhealthy';
    await client.query(
      `INSERT INTO llm_marketplace.bootstrap_audit (runner, outcome, detail, actor, occurred_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [
        'marketplace',
        outcome,
        JSON.stringify({
          offer: seeded.offer.id,
          model: seeded.offer.normalizedModelId,
          provider: input.provider,
          smoke: smokeHealthy,
          activation: activationOutcome,
          credentialRotationFrom: seeded.credentialOutcome.rotatedFrom,
        }),
        input.actor,
        Date.now(),
      ],
    );
    await client.query('COMMIT');
    // `credentialRotationFrom` chỉ xuất hiện khi có rotation thật — null là
    // "không có gì để nói", chi tiết máy đọc không mang field rỗng.
    const runDetail: BootstrapRunResult['detail'] = {
      offer: seeded.offer.id,
      model: seeded.offer.normalizedModelId,
      provider: input.provider,
      smoke: smokeHealthy,
      activation: activationOutcome,
      ...(seeded.credentialOutcome.rotatedFrom !== null
        ? { credentialRotationFrom: seeded.credentialOutcome.rotatedFrom }
        : {}),
    };
    printResultJson('MARKETPLACE_RESULT', { outcome, detail: runDetail });
    log(`marketplace bootstrap done: ${outcome}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
