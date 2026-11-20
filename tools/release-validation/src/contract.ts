import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Hợp đồng baseline Release Validation cho PostgreSQL — nguồn duy nhất là
 * `docs/architecture/02-delivery.md` §3a.6 (mục G của #373, thực thi #379) và
 * `03-operations.md` §3.1 (lớp restore per-database: `pg_dumpall` là
 * cluster-level — `04` PG1 — nên mọi database phải đi đường dump
 * per-database này). D1 (mục G+) KHÔNG thuộc cơ chế này — slice D1 là
 * follow-up của #379.
 *
 * Ràng buộc #379 được đóng gói ở các type dưới đây:
 * - baseline identity **versioned per database** (mỗi logical database một
 *   baseline cho một release candidate);
 * - "backup thành công" không phải bằng chứng — verify-restorable bắt buộc
 *   (restore + integrity check + candidate-migration apply), encode ở
 *   `BaselineIdentity.integrity` và stage machine của `runner.ts`;
 * - evidence gắn danh tính candidate exact (SHA + version);
 * - không down-migrate — cơ chế chỉ apply tiến, không có đường rollback.
 */

/** Một logical database PostgreSQL trong inventory §3a.1 — chỉ 11 database PG. */
export interface PgDatabaseContract {
  /**
   * Tên database hợp đồng — cũng là giá trị `current_database()` mà runner
   * migration authority guard, và là tên database mà cơ chế recreate trên
   * target dùng-đi (guard của runner phải pass trên đúng tên này).
   */
  readonly database: string;
  /** Migration authority `deploys/<slug>-db` (§3a.1 mục A) — slug suy từ tên database. */
  readonly migrationsProject: string;
}

/**
 * Inventory §3a.1 (PostgreSQL) — bảng này là ánh xạ hợp đồng, không suy từ
 * graph: một database không có trong bảng là refuse (fail closed), không tự
 * đoán project migration.
 */
export const PG_DATABASES: readonly PgDatabaseContract[] = [
  { database: 'db-account', migrationsProject: 'account-db' },
  { database: 'db-auth', migrationsProject: 'auth-db' },
  { database: 'db-backoffice', migrationsProject: 'backoffice-db' },
  { database: 'db-staff-access', migrationsProject: 'staff-access-db' },
  { database: 'db-llm-gateway', migrationsProject: 'llm-gateway-db' },
  { database: 'db-llm-tenant', migrationsProject: 'llm-tenant-db' },
  { database: 'db-llm-marketplace', migrationsProject: 'llm-marketplace-db' },
  { database: 'db-pact-broker', migrationsProject: 'pact-broker-db' },
  { database: 'db-pact-broker-app', migrationsProject: 'pact-broker-app-db' },
  { database: 'db-remote-cache', migrationsProject: 'remote-cache-db' },
  { database: 'db-remote-cache-app', migrationsProject: 'remote-cache-app-db' },
] as const;

/** Resolve database theo tên hợp đồng — tên lạ là refuse, không default. */
export function resolveDatabase(name: string): PgDatabaseContract {
  const contract = PG_DATABASES.find((entry) => entry.database === name);
  if (contract === undefined) {
    throw new Error(
      `unknown PostgreSQL database ${JSON.stringify(name)}: not in the 02-delivery.md 3a.1 inventory; refusing to guess its migration authority`,
    );
  }
  return contract;
}

/**
 * Repo root suy từ vị trí module (src/ → lên ba cấp) — deterministic, không
 * phụ thuộc cwd của process gọi (vitest, nx, CI đều phải ra cùng một root).
 */
export const WORKSPACE_ROOT = resolve(import.meta.dirname, '../../..');

/** Đường dẫn tuyệt đối của migration authority project trên cây repo. */
export function migrationsProjectPath(contract: PgDatabaseContract): string {
  return resolve(WORKSPACE_ROOT, 'deploys', contract.migrationsProject);
}

/**
 * Blocker fail-closed pre-flight: migration authority project của database
 * phải tồn tại thật trên cây (runner.mts + drizzle.config.ts) — thiếu là
 * refuse trước khi chạm bất kỳ database nào.
 */
export function unresolvedBlockers(contract: PgDatabaseContract): readonly string[] {
  const projectPath = migrationsProjectPath(contract);
  const blockers: string[] = [];
  if (!existsSync(resolve(projectPath, 'runner.mts'))) {
    blockers.push(
      `migration authority ${contract.migrationsProject} has no runner.mts on the tree (#374/#375-#378 cutover)`,
    );
  }
  if (!existsSync(resolve(projectPath, 'drizzle.config.ts'))) {
    blockers.push(`migration authority ${contract.migrationsProject} has no drizzle.config.ts`);
  }
  return blockers;
}

/**
 * Dấu vân tay state database — nội dung của integrity check §3a.6 ("verify
 * invariants + `__drizzle_migrations` khớp expected history"): inventory
 * bảng BASE TABLE (trừ catalog) + số hàng và mốc `when` của history table.
 * Giá trị được ghi lúc capture và so khớp lại sau restore — lệch bất kỳ
 * trường nào là corrupted restore, fail closed.
 */
export interface RestoredStateFingerprint {
  /** Số entry trong history table `__drizzle_migrations` (0 khi chưa migrate). */
  readonly historyCount: number;
  /** `max(created_at)` của history — checkpoint per-run của kit (§3a.3). */
  readonly historyMaxWhen: number | null;
  /** `schema.table` sorted — BASE TABLE duy nhất, deterministic theo SQL order. */
  readonly tables: readonly string[];
}

/**
 * Baseline identity — phiên bản hoá per database (ràng buộc #379). Dump là
 * artifact restorable; sha256 + fingerprint là identity; mốc thời gian/LSN
 * ghi vào release record theo `02-delivery.md` §12 (`sourceLsn` là thông tin
 * provenance, không phải điều kiện restorable — điều kiện là integrity check).
 */
export interface BaselineIdentity {
  readonly mechanism: 'pg-dump-per-database';
  readonly database: string;
  readonly dumpSha256: string;
  readonly dumpBytes: number;
  readonly capturedAt: string;
  /** Mốc WAL lúc capture; `null` khi source không expose `pg_current_wal_lsn()`. */
  readonly sourceLsn: string | null;
  readonly integrity: RestoredStateFingerprint;
}

/** Danh tính candidate exact — điều kiện #379/#346: evidence gắn SHA + version. */
export interface CandidateIdentity {
  readonly commitSha: string;
  readonly version: string;
}

/** Hình manifest release mà resolver chấp nhận (theo mẫu build-manifest §7.3 mục 7). */
export interface ReleaseManifestInput {
  readonly sha?: unknown;
  readonly commit?: unknown;
  readonly version?: unknown;
}

/**
 * Resolve danh tính candidate từ manifest (provenance store input #346) và/hoặc
 * explicit flags. Fail-closed: flag mâu thuẫn manifest là refuse (đầu vào tự
 * đâm nhau không được âm thầm chọn một bên); thiếu SHA hoặc version là refuse —
 * evidence không được phép gắn danh tính thiếu một nửa.
 */
export function resolveCandidateIdentity(input: {
  manifest?: unknown;
  commitSha?: string;
  version?: string;
}): CandidateIdentity {
  const manifest =
    typeof input.manifest === 'object' && input.manifest !== null
      ? (input.manifest as ReleaseManifestInput)
      : undefined;
  const manifestSha =
    typeof manifest?.sha === 'string'
      ? manifest.sha
      : typeof manifest?.commit === 'string'
        ? manifest.commit
        : undefined;
  const manifestVersion = typeof manifest?.version === 'string' ? manifest.version : undefined;

  if (
    input.commitSha !== undefined &&
    manifestSha !== undefined &&
    input.commitSha !== manifestSha
  ) {
    throw new Error(
      `candidate identity conflict: --commit-sha ${JSON.stringify(input.commitSha)} differs from manifest ${JSON.stringify(manifestSha)}`,
    );
  }
  if (
    input.version !== undefined &&
    manifestVersion !== undefined &&
    input.version !== manifestVersion
  ) {
    throw new Error(
      `candidate identity conflict: --candidate-version ${JSON.stringify(input.version)} differs from manifest ${JSON.stringify(manifestVersion)}`,
    );
  }

  const commitSha = input.commitSha ?? manifestSha;
  const version = input.version ?? manifestVersion;
  if (commitSha === undefined || version === undefined) {
    throw new Error(
      'candidate identity incomplete: both a commit SHA and a version are required (from --commit-sha/--candidate-version or --manifest)',
    );
  }
  if (commitSha === '' || version === '') {
    throw new Error('candidate identity incomplete: empty SHA or version is not an identity');
  }
  return { commitSha, version };
}
