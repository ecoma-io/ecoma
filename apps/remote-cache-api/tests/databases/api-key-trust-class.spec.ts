/**
 * Database-level test cho guard tính bất biến của phân lớp credential
 * (domain model §2.4, migration 0008 — issue #202): `trusted_ci` được đặt khi
 * tạo key và KHÔNG BAO GIỜ đổi — bất kỳ UPDATE nào dịch key sang class khác
 * phải bị trigger `api_key_trust_class_guard` chặn bằng
 * `integrity_constraint_violation`, còn revoke (UPDATE `revoked_at`) phải vẫn
 * đi qua. Chạy trên PostgreSQL thật, assert qua catalog + hành vi thật.
 *
 * ⚠️ Docker là phụ thuộc cứng — vắng Docker là đỏ, không skip (06-testing.md §6).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type RemoteCacheDatabase, startRemoteCacheDatabase } from '../integrations/harness.ts';

let db: RemoteCacheDatabase;

beforeAll(async () => {
  db = await startRemoteCacheDatabase();
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

beforeEach(async () => {
  await db.truncateData();
});

/**
 * Bắt buộc `INSERT ... RETURNING` trả về hàng — fallback chuỗi rỗng sẽ chèn
 * UUID rỗng vào câu lệnh kế tiếp (FK violation hoặc 0 hàng updates) và che
 * mất lỗi seed gốc.
 */
function requireId(rows: { id: string }[], what: string): string {
  const id = rows[0]?.id;
  if (id === undefined || id === '') {
    throw new Error(`Failed to seed ${what}: INSERT returned no rows`);
  }
  return id;
}

/**
 * Seed tenant + project + một key với phân lớp tùy chọn. Cả ba test dùng cùng
 * một đường seed duy nhất — khác biệt giữa các test chỉ còn `trusted_ci`,
 * `scopes` và suffix phân biệt fixture (mỗi spec chạy testcontainer riêng,
 * `truncateData` giữa các test, nên suffix chỉ để đọc dễ).
 */
async function seedApiKey(
  client: import('pg').Client,
  options: { readonly trustedCi: boolean; readonly scopes: string; readonly suffix?: string },
): Promise<string> {
  const suffix = options.suffix ?? '';
  const { rows: tenantRows } = await client.query<{ id: string }>(
    `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
     VALUES ($1, 'customer', 'paid', $2) RETURNING id`,
    [`trust-class-tenant${suffix}`, `sub-owner-trust-class${suffix}`],
  );
  const tenantId = requireId(tenantRows, 'tenant');
  const { rows: projectRows } = await client.query<{ id: string }>(
    `INSERT INTO remote_cache.projects (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantId, `trust-class-project${suffix}`],
  );
  const projectId = requireId(projectRows, 'project');
  const { rows: keyRows } = await client.query<{ id: string }>(
    `INSERT INTO remote_cache.api_keys (project_id, token_hash, scopes, trusted_ci)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [projectId, `seed-hash-trust-class${suffix}`, options.scopes, options.trustedCi],
  );
  return requireId(keyRows, 'api_key');
}

describe('api_keys credential-class guard (database behavior)', () => {
  it('blocks promoting a developer key into trusted CI with integrity_constraint_violation', async () => {
    const client = await db.connect();
    try {
      const keyId = await seedApiKey(client, { trustedCi: false, scopes: 'read' });
      await expect(
        client.query('UPDATE remote_cache.api_keys SET trusted_ci = true WHERE id = $1', [keyId]),
      ).rejects.toMatchObject({ code: '23000' });
      // ERRCODE của RAISE là integrity_constraint_violation = SQLSTATE 23000.
      const { rows } = await client.query<{ trusted_ci: boolean }>(
        'SELECT trusted_ci FROM remote_cache.api_keys WHERE id = $1',
        [keyId],
      );
      expect(rows[0]?.trusted_ci).toBe(false);
    } finally {
      await client.end();
    }
  });

  it('blocks demoting a trusted key into the developer class the same way', async () => {
    const client = await db.connect();
    try {
      const keyId = await seedApiKey(client, {
        trustedCi: true,
        scopes: 'read write',
        suffix: '-b',
      });
      await expect(
        client.query('UPDATE remote_cache.api_keys SET trusted_ci = false WHERE id = $1', [keyId]),
      ).rejects.toMatchObject({ code: '23000' });
      // Guard phải bảo toàn trạng thái: class vẫn là trusted sau UPDATE bị chặn.
      const { rows } = await client.query<{ trusted_ci: boolean }>(
        'SELECT trusted_ci FROM remote_cache.api_keys WHERE id = $1',
        [keyId],
      );
      expect(rows[0]?.trusted_ci).toBe(true);
    } finally {
      await client.end();
    }
  });

  it('lets revocation update revoked_at without touching the class', async () => {
    const client = await db.connect();
    try {
      const keyId = await seedApiKey(client, { trustedCi: false, scopes: 'read', suffix: '-c' });
      const result = await client.query<{ revoked_at: string }>(
        'UPDATE remote_cache.api_keys SET revoked_at = now() WHERE id = $1 RETURNING revoked_at',
        [keyId],
      );
      expect(result.rowCount).toBe(1);
      expect(result.rows[0]?.revoked_at).toBeTruthy();
      const { rows } = await client.query<{ trusted_ci: boolean }>(
        'SELECT trusted_ci FROM remote_cache.api_keys WHERE id = $1',
        [keyId],
      );
      expect(rows[0]?.trusted_ci).toBe(false);
    } finally {
      await client.end();
    }
  });
});
