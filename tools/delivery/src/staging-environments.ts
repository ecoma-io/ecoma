/**
 * Machinery GitHub Environments `staging-<slug>` cho lane Continuous Staging
 * (issue #351; hợp đồng `02-delivery.md` §6.12/§6.13/§7.4).
 *
 * §6.13: khai `environment:` trong workflow khiến GitHub TỰ TẠO Environment
 * không có protection nào — một approval/audit trống. Environment vì thế phải
 * TỒN TẠI SẴN với protection đặt đúng trước khi workflow nào tham chiếu nó.
 * Script này là đường tạo idempotent trong repo: chạy lại an toàn, mutation và
 * verification nằm trong CÙNG một lần chạy, và lần chạy kết thúc fail-closed
 * (exit khác 0 ở CLI) nếu state cuối vẫn thiếu protection.
 *
 * Protection của Environment STAGING (khác §6.13 production một cách có chủ
 * đích): deployment branch policy giới hạn đúng nhánh `main` — lane staging
 * là continuous, chỉ chạy từ `main` sau CI (§7.4), nên KHÔNG required
 * reviewers / wait timer; một gate thủ công trên staging là cấu hình sai
 * (báo violation, không tự xoá — xoá cấu hình repo là mutation ngoài phạm vi
 * setup, operator tự sửa qua Settings). Credential KHÔNG thuộc Environment:
 * `ECOMA_CLOUDFLARE_API_TOKEN` là org secret dùng chung (§6.12).
 *
 * Danh sách unit là inventory fail-closed: suy từ
 * `config/deploy-eligibility.jsonc` (nguồn phân loại canonical, #360) — chỉ
 * nhận entry `staging: "releaseable"`, đúng tập mà audit khớp với
 * `nx.json → release.projects`. Không suy từ "có wrangler.jsonc hay không".
 *
 * Mọi lời gọi GitHub đi qua `gh api` (subprocess, gh xử lý auth từ
 * `GH_TOKEN`/keyring) — không thêm dependency SDK nào. Env của subprocess gh
 * là danh sách tối thiểu: không passthrough toàn bộ process.env.
 */

import { exec, type ExecResult } from '@ecoma-io/deployment';

/** Prefix org của Nx project trong workspace. */
const ORG_PREFIX = '@ecoma-io/';

/** Một deploy unit staging cần Environment `staging-<slug>`. */
export interface StagingUnit {
  project: string;
  slug: string;
  environment: string;
}

/** Shape tối thiểu của `config/deploy-eligibility.jsonc` mà module này đọc. */
export interface StagingEligibilityConfig {
  projects?: Record<string, { staging?: string }>;
}

/**
 * Inventory fail-closed: chỉ entry `staging: "releaseable"` của
 * deploy-eligibility.jsonc, slug suy từ tên project (§7.2 — slug không suy
 * được an toàn là lỗi chặn, không đoán). Rỗng cũng là lỗi chặn: một inventory
 * trống nghĩa là phân loại eligibility hỏng, không phải "không cần tạo gì".
 */
export function stagingUnits(config: StagingEligibilityConfig): StagingUnit[] {
  const errors: string[] = [];
  const units: StagingUnit[] = [];
  const projects = Object.entries(config.projects ?? {})
    .filter(([, entry]) => entry.staging === 'releaseable')
    .map(([project]) => project)
    .toSorted();
  for (const project of projects) {
    const slug = project.startsWith(ORG_PREFIX) ? project.slice(ORG_PREFIX.length) : '';
    if (!/^[a-z0-9-]+$/u.test(slug)) {
      errors.push(`project ${project}: cannot derive a safe slug from "${slug}"`);
      continue;
    }
    units.push({ project, slug, environment: `staging-${slug}` });
  }
  if (errors.length > 0) {
    throw new Error(`staging environment inventory is unsafe: ${errors.join('; ')}`);
  }
  if (units.length === 0) {
    throw new Error(
      'staging environment inventory is empty — deploy-eligibility.jsonc declares no ' +
        'staging-releaseable project; refusing to guess the environment list',
    );
  }
  return units;
}

/** Deps inject để spec chạy không cần `gh` thật. */
export interface GhApiDeps {
  /** Chạy `gh api <args...>` (input ghi vào stdin khi có). */
  ghApi: (args: string[], input?: string) => ExecResult;
}

/** Env tối thiểu cho subprocess `gh` — không passthrough toàn bộ process.env. */
export function ghProcessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: source.PATH, HOME: source.HOME };
  for (const key of ['GH_TOKEN', 'GH_HOST', 'GH_REPO'] as const) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

/** Chạy `gh <args>` bất kỳ (không chỉ `api`) với env tối thiểu. */
function runGh(args: string[], source: NodeJS.ProcessEnv, input?: string): ExecResult {
  return exec(
    'gh',
    args,
    process.cwd(),
    ghProcessEnv(source),
    input === undefined ? {} : { input },
  );
}

/** Deps mặc định: `gh api` thật, env tối thiểu của process hiện tại. */
export function defaultGhApiDeps(): GhApiDeps {
  return { ghApi: (args, input) => runGh(['api', ...args], process.env, input) };
}

/** `gh api` trả 404 — "chưa tồn tại", phân biệt với mọi lỗi API khác. */
export function isNotFound(result: ExecResult): boolean {
  return result.status !== 0 && /HTTP 404/u.test(result.stderr);
}

/** Lỗi API khác 404 phải nổi lên — nuốt thành "chưa tồn tại" là fail-open (§7.2). */
function assertOk(result: ExecResult, label: string): void {
  if (result.status === 0) return;
  const reason =
    result.error?.message ??
    (result.signal !== undefined && result.signal !== null
      ? `killed by signal ${result.signal}`
      : result.stderr.trim() === ''
        ? 'no output'
        : result.stderr.trim());
  throw new Error(`gh ${label} failed: ${reason}`);
}

function parseJson<T>(stdout: string, label: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`gh ${label} returned a non-JSON payload`);
  }
}

/** Shape `deployment_branch_policy` trong payload Environment (§6.13). */
export interface DeploymentBranchPolicyShape {
  protected_branches?: boolean;
  custom_branch_policies?: boolean;
}

/** Shape payload `GET /environments/{name}` mà preflight đọc (§6.13). */
export interface EnvironmentPayload {
  deployment_branch_policy?: DeploymentBranchPolicyShape | null;
  protection_rules?: Array<{ type?: string }>;
}

/** Shape payload danh sách branch policy của Environment. */
export interface BranchPolicyListPayload {
  branch_policies?: Array<{ name?: string }>;
}

/** Chính sách branch của Environment staging: custom, chỉ nhận pattern khai tường minh. */
const CUSTOM_BRANCH_POLICY = { protected_branches: false, custom_branch_policies: true };

/** Kết quả ensure/verify cho MỘT Environment. */
export interface EnvironmentReport {
  environment: string;
  /** Environment tồn tại ở cuối lần chạy (tìm thấy hoặc vừa tạo). */
  exists: boolean;
  /** Environment được tạo bởi lần chạy này. */
  created: boolean;
  /**
   * `deployment_branch_policy` được đặt/sửa bởi lần chạy này VÀ re-read sau
   * mutation đã xác nhận — cờ là kết quả đã xác nhận, không phải ý định.
   */
  policyFixed: boolean;
  /** Pattern `main` được thêm bởi lần chạy này VÀ re-read đã thấy nó. */
  branchPolicyAdded: boolean;
  /**
   * Protection còn thiếu/sai SAU khi ensure — rỗng nghĩa là Environment đạt.
   * Mọi violation được báo cùng lúc kèm tên Environment (§6.13).
   */
  violations: string[];
}

/** Đọc payload Environment; trả `null` cho 404, throw cho lỗi khác. */
function getEnvironment(envPath: string, deps: GhApiDeps): EnvironmentPayload | null {
  const result = deps.ghApi([envPath]);
  if (isNotFound(result)) return null;
  assertOk(result, `api GET ${envPath}`);
  return parseJson<EnvironmentPayload>(result.stdout, `api GET ${envPath}`);
}

/** Đặt `deployment_branch_policy` custom (PUT Environment). */
function putEnvironment(envPath: string, deps: GhApiDeps): void {
  const body = JSON.stringify({ deployment_branch_policy: CUSTOM_BRANCH_POLICY });
  assertOk(deps.ghApi(['-X', 'PUT', envPath, '--input', '-'], body), `api PUT ${envPath}`);
}

/** Đọc danh sách pattern branch policy; `null` khi shape không đọc được. */
function getBranchPolicyNames(envPath: string, deps: GhApiDeps): { names: string[] } | null {
  const policiesPath = `${envPath}/deployment-branch-policies`;
  const result = deps.ghApi([policiesPath]);
  assertOk(result, `api GET ${policiesPath}`);
  const payload = parseJson<BranchPolicyListPayload>(result.stdout, `api GET ${policiesPath}`);
  const policies = payload.branch_policies;
  if (!Array.isArray(policies)) return null;
  const names: string[] = [];
  for (const policy of policies) {
    if (typeof policy.name !== 'string') return null;
    names.push(policy.name);
  }
  return { names };
}

/** Thêm pattern `main` vào branch policy của Environment. */
function addBranchPolicy(envPath: string, deps: GhApiDeps): void {
  const policiesPath = `${envPath}/deployment-branch-policies`;
  assertOk(
    deps.ghApi(['-X', 'POST', policiesPath, '--input', '-'], JSON.stringify({ name: 'main' })),
    `api POST ${policiesPath}`,
  );
}

/** Quy tắc protection thủ công mà lane continuous KHÔNG được có (§7.4). */
const MANUAL_GATE_RULE_TYPES = ['required_reviewers', 'wait_timer'] as const;

/**
 * Ensure + verify MỘT Environment. `mode: 'check'` không mutation — chỉ đọc
 * và báo violations (đường guard CI chống auto-create-không-bảo-vệ, §6.13).
 */
function ensureOne(
  unit: StagingUnit,
  repo: string,
  deps: GhApiDeps,
  mode: 'ensure' | 'check',
): EnvironmentReport {
  const envPath = `repos/${repo}/environments/${unit.environment}`;
  const report: EnvironmentReport = {
    environment: unit.environment,
    exists: false,
    created: false,
    policyFixed: false,
    branchPolicyAdded: false,
    violations: [],
  };
  let payload = getEnvironment(envPath, deps);
  if (payload !== null) report.exists = true;
  let policyCustom = false;
  let policyMutated = false;
  if (payload === null) {
    if (mode === 'check') {
      report.violations.push(
        'environment does not exist — a workflow referencing it would make GitHub ' +
          'auto-create it with no protection at all (§6.13)',
      );
      return report;
    }
    // Tạo và đặt protection trong CÙNG một lời gọi PUT — không có cửa sổ
    // Environment tồn tại mà trống protection.
    putEnvironment(envPath, deps);
    report.created = true;
    report.exists = true;
    policyMutated = true;
    // Đọc LẠI sau mutation — không tin response của PUT tự chứng minh state.
    payload = getEnvironment(envPath, deps);
  } else {
    const policy = payload.deployment_branch_policy;
    policyCustom =
      typeof policy === 'object' &&
      policy !== null &&
      !Array.isArray(policy) &&
      policy.custom_branch_policies === true;
    if (!policyCustom) {
      if (mode === 'check') {
        // §6.13 fail-closed: check mode PHẢI báo policy sai, không chỉ ensure —
        // guard CI im lặng ở đúng state nguy hiểm nhất là fail-open.
        report.violations.push(
          'deployment_branch_policy is not { custom_branch_policies: true } — the staging ' +
            'branch restriction cannot be verified (§6.13); run without --check to repair',
        );
      } else {
        putEnvironment(envPath, deps);
        policyMutated = true;
        payload = getEnvironment(envPath, deps);
      }
    }
  }
  if (policyMutated) {
    // Sau mutation, đọc lại policy từ payload mới: PUT mà vẫn không custom là
    // API không nhận mutation — báo thay vì giả định thành công. `policyFixed`
    // chỉ đặt TRUE khi re-read XÁC NHẬN state, không phải ngay sau khi PUT.
    // `payload` về mặt type vẫn nullable (getEnvironment) — optional chain cho
    // state đọc không được là fail-closed về violation, không phải crash.
    const repaired = payload?.deployment_branch_policy;
    policyCustom =
      typeof repaired === 'object' &&
      repaired !== null &&
      !Array.isArray(repaired) &&
      repaired.custom_branch_policies === true;
    if (!policyCustom) {
      report.violations.push(
        'deployment_branch_policy is still not custom after repair — the GitHub API did ' +
          'not accept the mutation (§6.13)',
      );
    } else {
      report.policyFixed = true;
    }
  }

  if (policyCustom) {
    const policies = getBranchPolicyNames(envPath, deps);
    if (policies === null) {
      report.violations.push('branch policy list has an unreadable shape (§6.13)');
    } else {
      let addedMain = false;
      if (!policies.names.includes('main') && mode === 'ensure') {
        addBranchPolicy(envPath, deps);
        addedMain = true;
      }
      // Đọc lại danh sách SAU mutations để violations phản ánh state cuối.
      const current = getBranchPolicyNames(envPath, deps);
      if (current === null) {
        report.violations.push('branch policy list has an unreadable shape (§6.13)');
      } else {
        if (!current.names.includes('main')) {
          report.violations.push(
            'deployment branch policy does not allow "main" — the staging lane deploys ' +
              'only from main after CI (§7.4)',
          );
        } else if (addedMain) {
          // Đặt TRUE chỉ khi POST đã chạy VÀ re-read thấy "main" — cờ báo kết
          // quả đã xác nhận, không phải ý định mutation.
          report.branchPolicyAdded = true;
        }
        const extras = current.names.filter((name) => name !== 'main');
        if (extras.length > 0) {
          report.violations.push(
            `unexpected deployment branch policies: ${extras.join(', ')} — staging deploys ` +
              'run only from main; remove them in Settings → Environments',
          );
        }
      }
    }
  }

  // Gate thủ công trên staging chặn lane continuous — báo, không tự xoá.
  // `payload` chỉ null ở nhánh check-mode-missing đã return sớm ở trên.
  for (const rule of payload?.protection_rules ?? []) {
    if (
      rule.type !== undefined &&
      (MANUAL_GATE_RULE_TYPES as readonly string[]).includes(rule.type)
    ) {
      report.violations.push(
        `protection rule "${rule.type}" blocks the continuous staging lane with a manual ` +
          'gate — manual approval is production-only (§7.4); remove it in Settings → Environments',
      );
    }
  }
  return report;
}

/**
 * Ensure + verify toàn bộ inventory. Trả MỘT report mỗi unit; violations rỗng
 * nghĩa là Environment đạt chuẩn §6.12/§6.13 cho lane staging.
 */
export function ensureStagingEnvironments(
  units: StagingUnit[],
  repo: string,
  deps: GhApiDeps = defaultGhApiDeps(),
  mode: 'ensure' | 'check' = 'ensure',
): EnvironmentReport[] {
  return units.map((unit) => ensureOne(unit, repo, deps, mode));
}

/**
 * `owner/name` hợp lệ: ĐÚNG HAI segment, mỗi segment chỉ chữ/số/_/./- — anchor
 * cả hai đầu nên path `a/b/c`, ký tự trắng hay trailing slash đều bị từ chối.
 * Lookahead loại segment đúng bằng `.`/`..`: identifier này được ghép vào path
 * API `repos/<repo>/...` nên `../evil` là path traversal chứ không phải tên.
 * (`\w` của JS luôn là ASCII nên hai segment này đủ chặn mọi ký tự ngoài.)
 */
export function isValidRepoIdentifier(repo: string): boolean {
  return /^(?!\.\.?(?:\/|$))[\w.-]+\/(?!\.\.?(?:\/|$))[\w.-]+$/u.test(repo);
}

/**
 * Suy `owner/name` từ `gh repo view` — fallback khi không có `--repo` và
 * `GITHUB_REPOSITORY`.
 */
export function repoFromGh(source: NodeJS.ProcessEnv = process.env): string {
  const result = runGh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], source);
  assertOk(result, 'repo view');
  const repo = result.stdout.trim();
  if (!isValidRepoIdentifier(repo)) {
    throw new Error(`gh repo view returned an unexpected repository identifier: "${repo}"`);
  }
  return repo;
}
