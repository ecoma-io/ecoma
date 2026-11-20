/**
 * Job `plan` của coordinator staging (issue #362; hợp đồng `02-delivery.md`
 * §7.2 điều 1–5, §7.5 mục 1–2, 16–18) — NƠI DUY NHẤT sinh matrix deploy:
 *
 * 1. Audit workspace-level, đỏ TRƯỚC khi bất kỳ leg nào chạy (§7.5 mục 17:
 *    lỗi audit không bao giờ biến thành no-op xanh):
 *    - `deploy-eligibility.jsonc` parse nghiêm ngặt (slice A) — file hỏng là
 *      lỗi chặn;
 *    - MỌI project trên workspace (`nx show projects`) phải được phân loại —
 *      unclassified là lỗi chặn, không phải warning (§7.5 mục 2);
 *    - tập staging-`releaseable` PHẢI bằng `nx.json → release.projects`
 *      (`compareReleaseDeclarations`, §7.2 điều 5).
 * 2. Mapping affected → deploy units: `nx affected` (caller đưa kết quả vào)
 *    ∩ releaseable — không danh sách viết tay (§7.5 mục 1). Mỗi unit suy
 *    slug từ tên project (`stagingUnits`), config `apps/<slug>/wrangler.jsonc`,
 *    Environment `staging-<slug>`.
 * 3. Migration-aware (điều #362): batch unit nào khai phụ thuộc `*-db` (cạnh
 *    "app consumer → deploys/<name>-db" của §3a.1, đọc từ
 *    `nx.implicitDependencies` của project unit) mà project db đó nằm trong
 *    affected set thì có MỘT migration step trước deploy của batch. Không có
 *    cạnh nào trên graph → không có step nào: coordinator không tự bịa cặp
 *    unit↔db.
 *
 * Hàm thuần: caller (CLI `staging-plan`) đọc file, chạy `nx show projects`,
 * chạy `git rev-parse` cho base rồi đưa kết quả vào đây.
 */

import { fileURLToPath } from 'node:url';

import {
  evaluateEligibility,
  parseDeployEligibility,
  compareReleaseDeclarations,
} from './release-allowlist.ts';
import { stripJsoncComments } from './worker-secrets.ts';

/** Deps inject để spec chạy không cần file/nx thật. */
export interface StagingPlanDeps {
  readTextFile: (path: string) => string;
  /** Danh sách project Nx toàn workspace (`nx show projects`). */
  listProjects: () => string[];
  /** Tập project affected cho cặp base/head đã verify (caller chạy nx affected). */
  affectedProjects: (base: string, head: string) => string[];
}

/** Một deploy unit vào matrix — tham số suy ra, không viết tay (§7.5 mục 1). */
export interface StagingPlanUnit {
  project: string;
  slug: string;
  configPath: string;
  environment: string;
}

/** Một migration step phải chạy TRƯỚC deploy của batch (điều #362). */
export interface StagingPlanMigrationStep {
  /** Nx project `deploys/<name>-db` sở hữu migration. */
  dbProject: string;
  /** Target migration của project db (hợp đồng §3a: `db-migrate`). */
  target: string;
  /** Các batch unit tiêu thụ db này — unit đầu tiên trong danh sách là leg chờ step này. */
  units: string[];
}

/** Kết quả plan — JSON machine-readable mà workflow đọc thành matrix. */
export interface StagingPlan {
  deploySha: string;
  /** Affected set đầy đủ (gồm cả `-db`) — log cho operator đối chiếu. */
  affected: string[];
  units: StagingPlanUnit[];
  migrations: StagingPlanMigrationStep[];
}

/** Đường dẫn tuyệt đối của inventory eligibility (cùng nguồn với staging-deploy). */
export function planEligibilityPath(): string {
  return fileURLToPath(new URL('../config/deploy-eligibility.jsonc', import.meta.url));
}

/** Đường dẫn tuyệt đối của nx.json — nguồn `release.projects`. */
export function planNxJsonPath(): string {
  return fileURLToPath(new URL('../../../nx.json', import.meta.url));
}

/** Đọc `nx.json → release.projects` bằng bộ đọc JSONC của repo — sai shape là lỗi chặn. */
export function readNxReleaseProjects(
  path: string,
  deps: Pick<StagingPlanDeps, 'readTextFile'>,
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsoncComments(deps.readTextFile(path))) as unknown;
  } catch (error) {
    throw new Error(
      `nx.json is not valid JSON(C) at ${path}: ` +
        `${error instanceof Error ? error.message : String(error)} — no deploy may be planned (fail closed)`,
      { cause: error },
    );
  }
  const release = (parsed as { release?: unknown }).release;
  const projects = (release as { projects?: unknown } | undefined)?.projects;
  if (
    !Array.isArray(projects) ||
    projects.some((project) => typeof project !== 'string' || project.trim().length === 0)
  ) {
    throw new Error(
      `nx.json at ${path} does not declare release.projects as a non-empty string list — ` +
        'no deploy may be planned (fail closed)',
    );
  }
  return projects as string[];
}

/** Đọc `nx.implicitDependencies` của một unit — cạnh "app consumer → deploys/<name>-db" của §3a.1. */
function readImplicitDependencies(
  packageJsonPath: string,
  deps: Pick<StagingPlanDeps, 'readTextFile'>,
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsoncComments(deps.readTextFile(packageJsonPath))) as unknown;
  } catch (error) {
    throw new Error(
      `cannot read the unit package.json at ${packageJsonPath}: ` +
        `${error instanceof Error ? error.message : String(error)} — the migration mapping ` +
        'refuses to guess unit-to-database edges (fail closed)',
      { cause: error },
    );
  }
  const implicit = (parsed as { nx?: { implicitDependencies?: unknown } }).nx?.implicitDependencies;
  if (implicit === undefined) return [];
  if (!Array.isArray(implicit) || implicit.some((entry) => typeof entry !== 'string')) {
    throw new Error(
      `nx.implicitDependencies at ${packageJsonPath} is not a string list — the migration ` +
        'mapping refuses to guess unit-to-database edges (fail closed)',
    );
  }
  return implicit as string[];
}

/**
 * Chạy trọn audit + mapping cho SHA deploy đã qua guard. Throw ở BẤT KỪ lỗi
 * audit workspace-level (CLI map thành exit khác 0 — lane đỏ trước cổng
 * Environment, chưa dùng credential nào).
 */
export function planStagingBatch(
  params: { deploySha: string; baseSha: string },
  deps: StagingPlanDeps,
): StagingPlan {
  const eligibility = parseDeployEligibility(deps.readTextFile(planEligibilityPath()));
  const nxRelease = readNxReleaseProjects(planNxJsonPath(), deps);

  // MỌI project trên workspace phải được phân loại — evaluate all-or-nothing
  // (slice A) ném lỗi chặn liệt kê đầy đủ project unclassified.
  const workspaceProjects = deps.listProjects();
  const decisions = evaluateEligibility(eligibility, workspaceProjects);
  const releaseable = decisions
    .filter((decision) => decision.status === 'releaseable')
    .map((decision) => decision.project);
  compareReleaseDeclarations(releaseable, nxRelease);

  const affected = deps.affectedProjects(params.baseSha, params.deploySha);
  const affectedSet = new Set(affected);
  const batch = releaseable.filter((project) => affectedSet.has(project));

  const units: StagingPlanUnit[] = [];
  // Migration steps gom theo db project: một db consumed bởi nhiều unit
  // migrate ĐÚNG MỘT lần (journal checkpoint của §3a.3 làm no-op thêm vô nghĩa).
  const migrationsByDb = new Map<string, StagingPlanMigrationStep>();
  for (const project of batch) {
    const slug = project.startsWith('@ecoma-io/') ? project.slice('@ecoma-io/'.length) : '';
    if (!/^[a-z0-9-]+$/u.test(slug)) {
      throw new Error(
        `cannot derive a safe slug from project "${project}" — slug names the GitHub ` +
          'Environment and the commit-status context; refusing to guess (§7.2)',
      );
    }
    units.push({
      project,
      slug,
      configPath: `apps/${slug}/wrangler.jsonc`,
      environment: `staging-${slug}`,
    });
    const packageJsonPath = `apps/${slug}/package.json`;
    for (const dependency of readImplicitDependencies(packageJsonPath, deps)) {
      if (!dependency.endsWith('-db') || !affectedSet.has(dependency)) continue;
      const existing = migrationsByDb.get(dependency);
      if (existing !== undefined) {
        existing.units.push(project);
        continue;
      }
      migrationsByDb.set(dependency, {
        dbProject: dependency,
        target: 'db-migrate',
        units: [project],
      });
    }
  }

  return {
    deploySha: params.deploySha,
    affected,
    units,
    migrations: [...migrationsByDb.values()],
  };
}
