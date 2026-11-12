/**
 * Bootstrap runner bước 9 — seed Consumer tenant canonical `ecoma` + owner
 * membership (`db-llm-tenant`, schema `llm_tenant`) và API key đầu tiên của
 * tenant đó (`db-llm-gateway`, schema `llm_gateway`).
 *
 * Source of truth: ADR-0020 (Quyết định 4, 5, 6, 9, 13), ADR-0025 (kernel
 * P1–P3, owner là fact trên tenant), ADR-0026 §1 (classification là fact
 * provisioning), domain-model `llm-consumer-tenant` §1, Issue #24. Chạy sau
 * `db:migrate` cho CẢ HAI database và sau bước 8b trên lane local; chạy lại
 * là no-op theo natural key; divergence dữ liệu là fail-closed (không có
 * trạng thái resurrect — tenant không có cột lifecycle để "sống lại", key đã
 * revoke không bao giờ được kích hoạt lại).
 *
 * Hai sub-bước, MỘT tiến trình (ADR-0020 Quyết định 4: một write surface một
 * database — tách thành hai sub-bước trong cùng runner, mỗi sub-bước một
 * connection, một transaction, một bảng audit trên database của nó; không
 * transaction nguyên tử xuyên database; `tenant_id` là HẰNG trong code như
 * `SELLER_TENANT_ID` của 8a/8b — không truyền giá trị xuyên database):
 * 1. Sub-bước 9a trên `db-llm-tenant`: tenant `ecoma` (`first_party`, owner =
 *    `sub` Superadmin bootstrap) + owner membership của `sub`; divergence
 *    pre-check chặn cả biến thể tên `ecoma-internal` (ADR-0020 Quyết định 9).
 * 2. Sub-bước 9b trên `db-llm-gateway`: API key đầu tiên của tenant.
 *    Lỗi ở sub-bước sau khi sub-bước trước đã commit là một **tiền tố hợp lệ**
 *    — chạy lại hội tụ (ADR-0020 Quyết định 6).
 *
 * Credential (show-once/hash-only, ADR-0027 §8 pattern):
 * - plaintext key do runner sinh bằng CSPRNG (`randomBytes(32)`, base64url)
 *   CHỈ ở run tạo key; DB chỉ lưu SHA-256 hex; `id` suy ra deterministic từ
 *   hash. Plaintext xuất hiện ĐÚNG MỘT LẦN trên stdout dưới dạng dòng máy đọc
 *   `ECOMA_CONSUMER_API_KEY=<plaintext>`, KHÔNG BAO GIỜ trên stderr, trong
 *   result JSON hay bất kỳ log nào.
 * - Chạy lại khi tenant đã có key active: KHÔNG tạo row mới, KHÔNG in
 *   plaintext — result line báo `apiKey:"existing"` (show-once: ai giữ key
 *   plaintext thì giữ, bootstrap không phát lại).
 * - Tenant có row key nhưng TẤT CẢ đã revoke: fail-closed — revoke là quyết
 *   định ngoài bề mặt provisioning, bootstrap không phát key mới vượt qua nó.
 *
 * stdout giữ máy đọc: `ECOMA_CONSUMER_API_KEY=<plaintext>` (chỉ run tạo key)
 * rồi `CONSUMER_TENANT_RESULT=<json>` — dòng cuối, tiêu thụ được bởi bước 10
 * cùng cách 8b tiêu thụ `SELLER_ELIGIBILITY_VERDICT`; mọi log người đọc đi
 * stderr.
 */

import { randomBytes } from 'node:crypto';
import { Client } from 'pg';

import {
  createTenant,
  isMembershipStatus,
  provisionMembership,
  type Membership,
} from '@ecoma-io/llm-consumer-tenant-domain';
import {
  BOOTSTRAP_ACTOR_ENV,
  CANONICAL_CONSUMER_TENANT_NAME,
  CONSUMER_GATEWAY_DATABASE_URL_ENV,
  CONSUMER_OWNER_MEMBERSHIP_ID,
  CONSUMER_TENANT_DATABASE_URL_ENV,
  CONSUMER_TENANT_ID,
  CONSUMER_TENANT_OWNER_SUB_ENV,
  assertBootstrapDatabase,
  fail,
  log,
  printResult,
  printResultJson,
  requireEnv,
  sha256Hex,
  type BootstrapRunResult,
} from './bootstrap-shared.mts';

/** Tên biến thể bị cấm của tenant canonical — xuất hiện trong DB là divergence fail-closed. */
const FORBIDDEN_TENANT_NAME = 'ecoma-internal';

/** Classification provisioning của Consumer tenant canonical (ADR-0026 §1). */
const CANONICAL_CONSUMER_CLASSIFICATION = 'first_party';

/** Input cấu hình của run bước 9 — env là kênh cấu hình duy nhất. */
interface ConsumerTenantSeedInput {
  readonly ownerSub: string;
  readonly actor: string;
}

/** Row shape của `llm_tenant.tenants` (bigint đọc về string qua pg). */
interface ConsumerTenantRow {
  id: string;
  name: string;
  classification: string;
  owner_sub: string;
  created_at: string | number;
}

/** Row shape của `llm_tenant.memberships`. */
interface ConsumerMembershipRow {
  tenant_id: string;
  id: string;
  actor: string;
  status: string;
  created_at: string | number;
  revoked_at: string | number | null;
}

/** Row shape của `llm_gateway.api_keys`. */
interface ApiKeyRow {
  id: string;
  tenant_id: string;
  key_hash: string;
  created_by: string;
  created_at: string | number;
  revoked_at: string | number | null;
  revoked_by: string | null;
}

/** Ghi một dòng `bootstrap_audit` trên database đang chạy (ADR-0020: audit trail của mọi lần chạy). */
async function writeBootstrapAudit(
  client: Client,
  surface: 'llm_tenant' | 'llm_gateway',
  outcome: 'created' | 'no-op',
  detail: Record<string, string>,
  actor: string,
): Promise<void> {
  await client.query(
    `INSERT INTO ${surface}.bootstrap_audit (runner, outcome, detail, actor, occurred_at)
     VALUES ('consumer-tenant', $1, $2::jsonb, $3, $4)`,
    [outcome, JSON.stringify(detail), actor, Date.now()],
  );
}

/**
 * Sub-bước 9a — seed tenant canonical `ecoma` (`db-llm-tenant`).
 *
 * Idempotency theo natural key `(schema, name)`; divergence fail-closed:
 * - row hiện có với id/classification/owner khác → fail (danh tính immutable);
 * - tên `ecoma-internal` tồn tại → fail (ADR-0020 Quyết định 9: biến thể đó
 *   không bao giờ được tồn tại);
 * - tenant đã bị xoá trong khi membership còn → fail (tên vẫn reserved, không
 *   resurrect — ADR-0020 Quyết định 6);
 * - chèn bằng domain op `createTenant` rồi ghi bền vững, không SQL tự dựng field.
 */
async function upsertCanonicalTenant(
  client: Client,
  now: number,
  input: ConsumerTenantSeedInput,
): Promise<'created' | 'existing'> {
  const forbidden = await client.query<{ name: string }>(
    'SELECT name FROM llm_tenant.tenants WHERE name = $1',
    [FORBIDDEN_TENANT_NAME],
  );
  if (forbidden.rows.length > 0) {
    fail(
      `tenant name "${FORBIDDEN_TENANT_NAME}" must never exist in llm-consumer-tenant: the canonical internal tenant is named "${CANONICAL_CONSUMER_TENANT_NAME}" (ADR-0020 decision 9); divergent provisioning state`,
    );
  }
  const existing = await client.query<ConsumerTenantRow>(
    'SELECT id, name, classification, owner_sub, created_at FROM llm_tenant.tenants WHERE name = $1',
    [CANONICAL_CONSUMER_TENANT_NAME],
  );
  const tenant = existing.rows[0];
  if (tenant !== undefined) {
    // Trùng natural key: khẳng định các fact bất biến của định danh.
    if (tenant.id !== CONSUMER_TENANT_ID) {
      fail(
        `tenant name "${CANONICAL_CONSUMER_TENANT_NAME}" is taken by id "${tenant.id}" but the canonical id is "${CONSUMER_TENANT_ID}"; divergent provisioning state`,
      );
    }
    if (tenant.classification !== CANONICAL_CONSUMER_CLASSIFICATION) {
      fail(
        `canonical tenant classification is "${tenant.classification}" but bootstrap seeds "${CANONICAL_CONSUMER_CLASSIFICATION}"; classification is a provisioning fact and immutable (ADR-0026 section 1)`,
      );
    }
    if (tenant.owner_sub !== input.ownerSub) {
      fail(
        'canonical tenant owner differs from the configured bootstrap superadmin sub; ownership is immutable and never resurrected through bootstrap',
      );
    }
    return 'existing';
  }
  // Tenant vắng mặt: membership còn tồn tại nghĩa là tenant từng được seed rồi
  // bị xoá ngoài bề mặt provisioning — tên vẫn reserved, seed lại bị chặn
  // fail-closed (ADR-0020 Quyết định 6). Không có trạng thái resurrect.
  const membershipLingers = await client.query<{ c: string }>(
    'SELECT count(*)::text AS c FROM llm_tenant.memberships WHERE tenant_id = $1',
    [CONSUMER_TENANT_ID],
  );
  if ((membershipLingers.rows[0]?.c ?? '0') !== '0') {
    fail(
      `canonical tenant "${CANONICAL_CONSUMER_TENANT_NAME}" was removed while its membership state still exists; the removed tenant name stays reserved and bootstrap never reseeds it — restore through the tenant surface`,
    );
  }
  const inserted = await client.query<ConsumerTenantRow>(
    `INSERT INTO llm_tenant.tenants (id, name, classification, owner_sub, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (name) DO NOTHING
     RETURNING id, name, classification, owner_sub, created_at`,
    ((): [string, string, string, string, number] => {
      // Domain op là đường code duy nhất: aggregate được dựng qua `createTenant`
      // rồi mới ghi bền vững — classification là fact provisioning ghi kèm
      // (ADR-0026 §1), không phải field của aggregate domain hiện hành.
      const created = createTenant({
        id: CONSUMER_TENANT_ID,
        name: CANONICAL_CONSUMER_TENANT_NAME,
        owner: input.ownerSub,
        createdAt: now,
      });
      if (!created.ok) {
        fail(`canonical tenant creation rejected by domain: ${created.error}`);
      }
      if (
        created.value.id !== CONSUMER_TENANT_ID ||
        created.value.name !== CANONICAL_CONSUMER_TENANT_NAME ||
        created.value.owner !== input.ownerSub
      ) {
        fail('canonical tenant identity diverged from the constants held in code; fail-closed');
      }
      return [
        created.value.id,
        created.value.name,
        CANONICAL_CONSUMER_CLASSIFICATION,
        created.value.owner,
        created.value.createdAt,
      ];
    })(),
  );
  if (inserted.rows.length === 1) {
    return 'created';
  }
  // Concurrent bootstrap đã chèn row giữa hai bước — đọc lại ở run kế tiếp.
  fail('canonical tenant row appeared during concurrent bootstrap; rerun the step');
}

/** Đọc row membership thành aggregate; hình dạng sai là divergence fail-closed. */
function rehydrateMembership(row: ConsumerMembershipRow): Membership {
  const candidate = {
    id: row.id,
    tenantId: row.tenant_id,
    actor: row.actor,
    status: row.status,
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
  if (
    typeof candidate.id !== 'string' ||
    candidate.id === '' ||
    typeof candidate.tenantId !== 'string' ||
    candidate.tenantId === '' ||
    typeof candidate.actor !== 'string' ||
    candidate.actor === '' ||
    !isMembershipStatus(candidate.status) ||
    !Number.isSafeInteger(candidate.createdAt) ||
    (candidate.revokedAt !== null && !Number.isSafeInteger(candidate.revokedAt))
  ) {
    fail('stored consumer membership failed the domain shape guard; divergent provisioning state');
  }
  return candidate as Membership;
}

/**
 * Seed owner membership của tenant canonical (ADR-0020 Quyết định 13; kiểm
 * tra bước 9 của 02-delivery §3.2: "owner membership đọc lại được").
 *
 * Idempotency + divergence theo đúng triết lý của runner 8a:
 * - Row id canonical tồn tại với đúng actor → `existing` (kể cả đã revoke —
 *   membership bị revoke là state hợp lệ, bootstrap không resurrect).
 * - Row id canonical tồn tại với actor khác → fail-closed (id là của owner).
 * - Owner đã có membership active khác id → `existing` (bề mặt membership đã
 *   tiến hoá; bootstrap không provision bản sao thứ hai).
 * - Tenant đã seed nhưng owner không còn membership nào → converge (bảng rỗng
 *   là DB được seed bởi runner cũ hơn hợp đồng membership) hoặc fail-closed
 *   (có row lạ của actor khác — state bị thay đổi ngoài bề mặt provisioning).
 */
async function upsertOwnerMembership(
  client: Client,
  now: number,
  input: ConsumerTenantSeedInput,
  tenantOutcome: 'created' | 'existing',
): Promise<'created' | 'existing'> {
  const rows = await client.query<ConsumerMembershipRow>(
    'SELECT tenant_id, id, actor, status, created_at, revoked_at FROM llm_tenant.memberships WHERE tenant_id = $1',
    [CONSUMER_TENANT_ID],
  );
  const memberships: Membership[] = rows.rows.map(rehydrateMembership);
  const canonicalRow = memberships.find((m) => m.id === CONSUMER_OWNER_MEMBERSHIP_ID);
  if (canonicalRow !== undefined) {
    if (canonicalRow.actor !== input.ownerSub) {
      fail(
        `canonical owner membership id is held by actor "${canonicalRow.actor}" but bootstrap seeds owner "${input.ownerSub}"; divergent provisioning state`,
      );
    }
    return 'existing';
  }
  const ownerHasActive = memberships.some(
    (m) => m.actor === input.ownerSub && m.status === 'active',
  );
  if (ownerHasActive) {
    return 'existing';
  }
  if (tenantOutcome === 'existing' && memberships.length > 0) {
    // Có membership rows nhưng không row canonical nào và owner không còn
    // active: state bị thay đổi ngoài bề mặt provisioning — fail-closed.
    fail(
      'the tenant holds membership rows but none is the canonical owner membership and the owner has no active membership; membership state was changed outside the provisioning surface — restore the canonical row manually, bootstrap never mutates existing membership rows',
    );
  }
  // Còn lại (tenant vừa tạo, HOẶC tenant đã seed nhưng bảng membership rỗng —
  // DB được seed bởi runner cũ hơn hợp đồng membership): converge về hợp đồng
  // bằng cách provision lần đầu. Domain op là đường code duy nhất, kèm đọc lại
  // (read-back) theo tiêu chí kiểm của bước 9.
  const provisioned = provisionMembership(
    {
      id: CONSUMER_OWNER_MEMBERSHIP_ID,
      tenantId: CONSUMER_TENANT_ID,
      actor: input.ownerSub,
      createdAt: now,
    },
    memberships,
  );
  if (!provisioned.ok) {
    fail(`owner membership provisioning rejected by domain: ${provisioned.error}`);
  }
  const inserted = await client.query<{ id: string; actor: string; status: string }>(
    `INSERT INTO llm_tenant.memberships (tenant_id, id, actor, status, created_at, revoked_at)
     VALUES ($1, $2, $3, 'active', $4, NULL)
     ON CONFLICT (tenant_id, id) DO NOTHING
     RETURNING id, actor, status`,
    [
      provisioned.value.tenantId,
      provisioned.value.id,
      provisioned.value.actor,
      provisioned.value.createdAt,
    ],
  );
  const readBack = inserted.rows[0];
  if (readBack === undefined) {
    // ON CONFLICT DO NOTHING nuốt insert: row canonical xuất hiện giữa SELECT
    // và INSERT — một bootstrap chạy đồng thời đã ghi trước. Rerun sẽ thấy row
    // đó qua đường read làm 'existing' — không phải trạng thái divergent.
    fail('canonical owner membership row appeared during a concurrent bootstrap; rerun the step');
  }
  if (
    readBack.id !== provisioned.value.id ||
    readBack.actor !== provisioned.value.actor ||
    readBack.status !== provisioned.value.status
  ) {
    fail('owner membership read-back diverged from the domain value; fail-closed');
  }
  return 'created';
}

/**
 * Sub-bước 9b — seed API key đầu tiên của tenant canonical
 * (`db-llm-gateway`, schema `llm_gateway`).
 *
 * Natural key = `sha256(plaintext)` (ADR-0020 Quyết định 5); `id` suy ra
 * deterministic từ hash (pattern `bootstrap-marketplace.mts`). Trả plaintext
 * về cho caller ĐỂ in đúng một lần trên stdout khi key được tạo; run no-op
 * không sinh plaintext nào (không random waste cũng không lộ giá trị cũ).
 */
async function upsertApiKey(
  client: Client,
  now: number,
  input: ConsumerTenantSeedInput,
  tenantOutcome: 'created' | 'existing',
): Promise<{ outcome: 'created' | 'existing'; plaintext?: string }> {
  const tenantKeys = await client.query<ApiKeyRow>(
    'SELECT id, tenant_id, key_hash, created_by, created_at, revoked_at, revoked_by FROM llm_gateway.api_keys WHERE tenant_id = $1',
    [CONSUMER_TENANT_ID],
  );
  const activeKey = tenantKeys.rows.find((row) => row.revoked_at === null);
  if (activeKey !== undefined) {
    // Rerun với key active hiện có: KHÔNG row mới, KHÔNG plaintext (show-once).
    return { outcome: 'existing' };
  }
  if (tenantKeys.rows.length > 0) {
    // Có row nhưng tất cả đã revoke: revoke là quyết định ngoài bề mặt
    // provisioning — bootstrap không phát key mới vượt qua nó (rotation
    // một chiều, pattern 8b; không resurrect).
    fail(
      'the canonical tenant holds API key rows but none is active; every key was revoked outside the provisioning surface and bootstrap never issues a replacement past that decision — issue a new key through the control plane',
    );
  }
  if (tenantOutcome === 'existing') {
    // Tenant đã seed và bảng key rỗng: DB được seed bởi runner bước 9 cũ hơn
    // hợp đồng API key — converge bằng cách phát hành lần đầu (cùng triết lý
    // converge bảng membership rỗng của 8a).
    log('canonical tenant predates the API key contract; issuing the first key on this rerun');
  }
  const plaintext = randomBytes(32).toString('base64url');
  const hash = sha256Hex(plaintext);
  const apiKeyId = `consumer-api-key-${hash.slice(0, 24)}`;
  const inserted = await client.query<ApiKeyRow>(
    `INSERT INTO llm_gateway.api_keys (id, tenant_id, key_hash, created_by, created_at, revoked_at, revoked_by)
     VALUES ($1, $2, $3, $4, $5, NULL, NULL)
     ON CONFLICT (key_hash) DO NOTHING
     RETURNING id, tenant_id, key_hash`,
    [apiKeyId, CONSUMER_TENANT_ID, hash, input.actor, now],
  );
  const readBack = inserted.rows[0];
  if (readBack === undefined) {
    // ON CONFLICT DO NOTHING nuốt insert: hash trùng xuất hiện giữa SELECT và
    // INSERT — một bootstrap chạy đồng thời đã ghi trước. Rerun sẽ thấy key
    // active qua đường read làm 'existing'.
    fail('API key row appeared during a concurrent bootstrap; rerun the step');
  }
  if (
    readBack.id !== apiKeyId ||
    readBack.tenant_id !== CONSUMER_TENANT_ID ||
    readBack.key_hash !== hash
  ) {
    fail('API key read-back diverged from the derived identity; fail-closed');
  }
  return { outcome: 'created', plaintext };
}

/** CLI entry — env là kênh cấu hình duy nhất; plaintext không bao giờ được log. */
async function main(): Promise<void> {
  const input: ConsumerTenantSeedInput = {
    ownerSub: requireEnv(CONSUMER_TENANT_OWNER_SUB_ENV),
    actor: requireEnv(BOOTSTRAP_ACTOR_ENV),
  };
  const tenantUrl = requireEnv(CONSUMER_TENANT_DATABASE_URL_ENV);
  const gatewayUrl = requireEnv(CONSUMER_GATEWAY_DATABASE_URL_ENV);

  // Sub-bước 9a — tenant + owner membership trên db-llm-tenant.
  const tenantClient = new Client({ connectionString: tenantUrl });
  await tenantClient.connect();
  let tenantOutcome: 'created' | 'existing';
  let membershipOutcome: 'created' | 'existing';
  try {
    await assertBootstrapDatabase(tenantClient, 'db-llm-tenant');
    await tenantClient.query('BEGIN');
    tenantOutcome = await upsertCanonicalTenant(tenantClient, Date.now(), input);
    membershipOutcome = await upsertOwnerMembership(tenantClient, Date.now(), input, tenantOutcome);
    await writeBootstrapAudit(
      tenantClient,
      'llm_tenant',
      tenantOutcome === 'created' || membershipOutcome === 'created' ? 'created' : 'no-op',
      { tenant: tenantOutcome, membership: membershipOutcome },
      input.actor,
    );
    await tenantClient.query('COMMIT');
  } catch (error) {
    await tenantClient.query('ROLLBACK').catch(() => undefined);
    await tenantClient.end().catch(() => undefined);
    fail(error instanceof Error ? error.message : String(error));
  }
  await tenantClient.end();

  // Sub-bước 9b — API key đầu tiên trên db-llm-gateway. Lỗi ở đây sau khi 9a
  // đã commit là một tiền tố hợp lệ: chạy lại hội tụ (ADR-0020 Quyết định 6).
  const gatewayClient = new Client({ connectionString: gatewayUrl });
  await gatewayClient.connect();
  let keyOutcome: { outcome: 'created' | 'existing'; plaintext?: string };
  try {
    await assertBootstrapDatabase(gatewayClient, 'db-llm-gateway');
    await gatewayClient.query('BEGIN');
    keyOutcome = await upsertApiKey(gatewayClient, Date.now(), input, tenantOutcome);
    await writeBootstrapAudit(
      gatewayClient,
      'llm_gateway',
      keyOutcome.outcome === 'created' ? 'created' : 'no-op',
      { apiKey: keyOutcome.outcome, tenantId: CONSUMER_TENANT_ID },
      input.actor,
    );
    await gatewayClient.query('COMMIT');
  } catch (error) {
    await gatewayClient.query('ROLLBACK').catch(() => undefined);
    await gatewayClient.end().catch(() => undefined);
    fail(error instanceof Error ? error.message : String(error));
  }
  await gatewayClient.end();

  // Plaintext chỉ in ở run tạo key, ĐÚNG MỘT dòng trên stdout; result line là
  // dòng cuối cùng của stdout (hợp đồng máy đọc — bước 10 tiêu thụ như 8b).
  if (keyOutcome.outcome === 'created' && keyOutcome.plaintext !== undefined) {
    printResult('ECOMA_CONSUMER_API_KEY', keyOutcome.plaintext);
  }
  const outcome: BootstrapRunResult['outcome'] =
    tenantOutcome === 'created' ||
    membershipOutcome === 'created' ||
    keyOutcome.outcome === 'created'
      ? 'created'
      : 'no-op';
  printResultJson('CONSUMER_TENANT_RESULT', {
    outcome,
    detail: {
      tenantId: CONSUMER_TENANT_ID,
      tenant: tenantOutcome,
      membership: membershipOutcome,
      apiKey: keyOutcome.outcome,
    },
  });
  log(`consumer tenant bootstrap done: ${outcome}`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
