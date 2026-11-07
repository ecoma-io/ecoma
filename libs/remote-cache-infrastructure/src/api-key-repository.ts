import {
  hasRemoteCacheWriteScope,
  type RemoteCacheApiKeyScope,
} from '@ecoma-io/remote-cache-domain';

import type { RemoteCacheQueryable } from './postgres';

/**
 * Repository cua bang `remote_cache.api_keys` — machine credential cua
 * bounded context `remote-cache` (ADR-0015).
 *
 * ⚠️ **Hash-only.** Bang chi giu SHA-256 hex cua token (`token_hash`);
 * token gon chua bao gio cham DB — show-once o response luc tao, sau do he
 * thong khong con cach nao tai hien. Xu ly "tim key theo token" di qua
 * `getTokenHashByToken` o module auth cua app (P4.2 hardening).
 *
 * ⚠️ **Khong `last_used_at`** — thoi diem dung cuoi cung la observability,
 * khong duoc doi hoi ghi serving path (pattern `pact.machine_tokens`).
 */

/** Mot hang api key nhu schema tra ve. */
export interface ApiKeyRow {
  readonly id: string;
  readonly project_id: string;
  /** SHA-256 hex cua token — UNIQUE o schema; khong bao gio tra ra wire. */
  readonly token_hash: string;
  /** Chuoi scope phan tach khoang trang — CHECK `api_key_scopes_check`. */
  readonly scopes: string;
  /** NULL = con hieu luc; revoke la SET `revoked_at`, khong DELETE. */
  readonly revoked_at: string | null;
  readonly created_at: string;
  /** true neu key la credential CI tin cahy (duoc phep ghi neu co scope write).
   * false = key khong tin cahy (fork/PR) — chi duoc doc, khong bao ghi. */
  readonly trusted_ci: boolean;
}

/** Lay api key theo id. */
export async function getApiKeyById(
  db: RemoteCacheQueryable,
  id: string,
): Promise<ApiKeyRow | null> {
  const rows = await db.unsafe<ApiKeyRow>(
    `SELECT id, project_id, token_hash, scopes, revoked_at, created_at
       FROM remote_cache.api_keys
      WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Lay api key theo hash token — duong xac thuc token cua serving path
 * (P4.2); hash do caller tinh truoc khi goi, repo khong biet token gon.
 */
export async function getApiKeyByTokenHash(
  db: RemoteCacheQueryable,
  tokenHash: string,
): Promise<ApiKeyRow | null> {
  const rows = await db.unsafe<ApiKeyRow>(
    `SELECT id, project_id, token_hash, scopes, revoked_at, created_at, trusted_ci
       FROM remote_cache.api_keys
      WHERE token_hash = $1`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

/** Cac scope cua mot hang key, da parse va da kiem tap o schema. */
export function parseApiKeyScopes(
  row: Pick<ApiKeyRow, 'scopes'>,
): readonly RemoteCacheApiKeyScope[] {
  return row.scopes.split(' ') as RemoteCacheApiKeyScope[];
}

/** Kiem mot hang key co quyen `write` khong — duong authorize write-side. */
export function apiKeyHasWriteScope(row: Pick<ApiKeyRow, 'scopes'>): boolean {
  return hasRemoteCacheWriteScope(parseApiKeyScopes(row));
}

/**
 * Tao api key trong mot project — caller da hash token va validate scopes;
 * schema CHECK la nguon that cuoi cung (`api_key_scopes_check`).
 *
 * Skeleton P4.1 goi ham nay trong transaction cung `insertProject` khi tao
 * project kem key mac dinh (issue #442: skeleton khong mo endpoint tao key
 * rieng — P4.2).
 */
export async function insertApiKey(
  db: RemoteCacheQueryable,
  entry: {
    readonly id: string;
    readonly projectId: string;
    /** SHA-256 hex — khong bao gio token gon. */
    readonly tokenHash: string;
    readonly scopes: readonly RemoteCacheApiKeyScope[];
    /** true neu key la credential CI tin cahy (duoc phep ghi neu co scope write).
     * false = key khong tin cahy (fork/PR) — chi duoc doc. Mac dinh false. */
    readonly trusted_ci?: boolean;
  },
): Promise<void> {
  await db.unsafe(
    `INSERT INTO remote_cache.api_keys (id, project_id, token_hash, scopes, trusted_ci)
     VALUES ($1, $2, $3, $4, $5)`,
    [entry.id, entry.projectId, entry.tokenHash, entry.scopes.join(' '), entry.trusted_ci ?? false],
  );
}

/**
 * Revoke api key — SET `revoked_at`, KHONG DELETE (invariant reconstructible:
 * lich su credential phai doc duoc tu DB state).
 *
 * Tra so hang da revoke de caller phan biet "key khong ton tai" (0) va
 * "key da con hieu luc va duoc revoke ngay" (1) ma khong phai two-phase.
 */
export async function revokeApiKey(
  db: RemoteCacheQueryable,
  id: string,
  revokedAt: string,
): Promise<number> {
  const result = await db.unsafe<{ revoked_count: string }>(
    `WITH revoked AS (
       UPDATE remote_cache.api_keys
          SET revoked_at = $2::timestamptz
        WHERE id = $1 AND revoked_at IS NULL
      RETURNING 1 AS one
     )
     SELECT count(*)::text AS revoked_count FROM revoked`,
    [id, revokedAt],
  );
  return Number(result[0]?.revoked_count ?? '0');
}
