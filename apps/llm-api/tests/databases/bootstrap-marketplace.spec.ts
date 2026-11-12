/**
 * Bootstrap runner 8b (`db/bootstrap-marketplace.mts`) trên PostgreSQL thật +
 * một **stub upstream HTTP thật** (node:http, không mock library) — đúng mô hình
 * ADR-0020: runner chạy bằng `tsx` như trên lane local; smoke probe gọi network
 * thật tới stub (Issue #23: xác nhận credential sống bằng một request trực tiếp
 * tới provider, không qua quota).
 *
 * Phủ: seed endpoint + pool + credential (hash-only) + ModelOffer; smoke probe
 * thất bại ⇒ endpoint ở `degraded`, offer ở `draft` (fail-closed mặt serving);
 * probe thành công + verdict hợp lệ ⇒ activation; re-run là no-op; đổi key là
 * rotation (revoke cũ, không xoá); verdict lệch tenant bị từ chối; credential
 * bị từ chối trên serving path của tenant khác (`credential_tenant_mismatch`)
 * và không tồn tại đường lookup theo `provider` một mình (ADR-0027 §8).
 *
 * Plaintext upstream key chỉ tồn tại trong env của tiến trình con; DB chỉ chứa
 * SHA-256 hex — suite khẳng định không có cột plaintext nào.
 */

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  migratorUrl,
  runBootstrapCli,
  startLlmApiDatabase,
  type LlmApiDatabase,
} from '../integrations/harness.ts';
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
let stub: Server;
let stubPort: number;

beforeAll(async () => {
  db = await startLlmApiDatabase();
  stub = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ object: 'list', data: [] }));
  });
  await new Promise<void>((resolvePromise) => {
    stub.listen(0, '127.0.0.1', () => {
      const address = stub.address();
      if (address === null || typeof address === 'string') {
        throw new Error('stub upstream must listen on a TCP port');
      }
      stubPort = address.port;
      resolvePromise();
    });
  });
}, 180_000);

afterAll(async () => {
  const closeError = await new Promise<unknown>((resolvePromise) => {
    stub.close((error) => resolvePromise(error ?? undefined));
  });
  await db?.stop();
  if (closeError !== undefined) {
    throw closeError;
  }
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

/** Env đầy đủ cho một run 8b. */
function marketplaceEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ECOMA_GOVERNANCE_ACTOR: ACTOR,
    LLM_UPSTREAM_PROVIDER: PROVIDER,
    LLM_UPSTREAM_MODEL: RAW_MODEL,
    LLM_UPSTREAM_BASE_URL: `http://127.0.0.1:${stubPort}`,
    LLM_UPSTREAM_PROTOCOL: PROTOCOL,
    LLM_UPSTREAM_CREDENTIAL_PLAINTEXT: PLAINTEXT_ONE,
    SELLER_ELIGIBILITY_VERDICT: verdict(),
    ...overrides,
  };
}

function runMarketplace(env: Record<string, string>) {
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
  return line.slice(key.length + 1);
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

describe('bootstrap runner 8b (marketplace) on real PostgreSQL with a stub upstream', () => {
  it('seeds offer, pool and credential hash-only, stays draft and degraded when the upstream probe fails', async () => {
    const result = await runMarketplace(
      marketplaceEnv({ LLM_UPSTREAM_BASE_URL: 'http://127.0.0.1:1' }),
    );
    expect(stdoutLine(result.stdout, 'MARKETPLACE_RESULT')).toContain(
      '"outcome":"created-draft-unhealthy"',
    );

    const offer = await fetchOffer();
    expect(offer.status).toBe('draft');
    expect(offer.normalized_model_id).toBe('dronie-flash');
    expect(offer.activated_at).toBeNull();

    const client = await db.connectAsMigrator('marketplace');
    try {
      const endpoints = await client.query<{ health: string }>(
        'SELECT health FROM llm_marketplace.upstream_endpoints WHERE id = $1',
        [`${OFFER_ID}-pool-1-endpoint-1`],
      );
      expect(endpoints.rows[0]?.health).toBe('degraded');
    } finally {
      await client.end();
    }
    // Hash-only: đúng SHA-256 của plaintext, không cột plaintext nào chứa giá trị.
    const credentials = await fetchCredentials();
    expect(credentials).toHaveLength(1);
    expect(credentials[0].credential_hash).toBe(
      createHash('sha256').update(PLAINTEXT_ONE, 'utf8').digest('hex'),
    );

    // Endpoint target là bất biến qua bootstrap: URL chết của test này không
    // được thừa kế sang các test sau — dọn offering state để chúng seed fresh.
    const cleanup = await db.connectAsMigrator('marketplace');
    try {
      await cleanup.query(
        'TRUNCATE llm_marketplace.model_offers, llm_marketplace.endpoint_pools, llm_marketplace.upstream_endpoints, llm_marketplace.provider_credentials CASCADE',
      );
    } finally {
      await cleanup.end();
    }
  });

  it('activates the offer when the smoke probe succeeds with a valid verdict for the owning tenant', async () => {
    const result = await runMarketplace(marketplaceEnv());
    const summary = stdoutLine(result.stdout, 'MARKETPLACE_RESULT');
    expect(summary).toContain('"activation":"activated"');

    const offer = await fetchOffer();
    expect(offer.status).toBe('active');
    expect(offer.activated_at).not.toBeNull();

    const client = await db.connectAsMigrator('marketplace');
    try {
      const endpoints = await client.query<{ health: string; health_recorded_at: string | null }>(
        'SELECT health, health_recorded_at::text AS health_recorded_at FROM llm_marketplace.upstream_endpoints WHERE id = $1',
        [`${OFFER_ID}-pool-1-endpoint-1`],
      );
      expect(endpoints.rows[0]?.health).toBe('healthy');
      expect(endpoints.rows[0]?.health_recorded_at).not.toBeNull();
    } finally {
      await client.end();
    }
  });

  it('reruns as a no-op without a new credential row or a re-activation', async () => {
    const before = await fetchCredentials();
    const result = await runMarketplace(marketplaceEnv());
    expect(stdoutLine(result.stdout, 'MARKETPLACE_RESULT')).toContain('"outcome":"no-op"');
    expect(stdoutLine(result.stdout, 'MARKETPLACE_RESULT')).toContain(
      '"activation":"already-active"',
    );
    expect(await fetchCredentials()).toEqual(before);
  });

  it('rotates the credential when the upstream key changes: new row active, old row revoked, nothing deleted', async () => {
    const before = await fetchCredentials();
    expect(before).toHaveLength(1);

    const result = await runMarketplace(
      marketplaceEnv({ LLM_UPSTREAM_CREDENTIAL_PLAINTEXT: PLAINTEXT_TWO }),
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
  });

  it('rejects a verdict belonging to another seller tenant fail-closed before touching state', async () => {
    const credentialsBefore = await fetchCredentials();
    await expect(
      runMarketplace(
        marketplaceEnv({
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
