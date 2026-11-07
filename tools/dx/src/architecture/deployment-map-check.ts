/**
 * Lượt kiểm deployment map — đối chiếu `DEPLOYMENT_MAP` với workspace thật.
 *
 * Khác các lượt kiểm tag trong `arch-tags.ts` (đọc project graph), lượt này
 * còn đọc HAI nguồn trên đĩa:
 *
 * 1. Thư mục `apps/` — danh sách app authoritative, không hard-code trong
 *    checker: app mới xuất hiện trên đĩa mà thiếu entry map là lỗi ngay.
 * 2. `package.json` của từng `deploys/*` — marker machine-readable
 *    `ecoma.deployment.status` phải khớp status của entry mà deploy project
 *    đó sở hữu.
 *
 * Ba nguồn (map, đĩa, graph) lệch nhau ở bất kỳ đâu đều fail-closed: bản đồ
 * canonical chỉ có giá trị khi mọi lệch được bắt, không skip lặng lẽ project
 * nào. Xem `DEPLOYMENT_MAP` để biết ngữ nghĩa từng status.
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';

import { DEPLOYMENT_MAP, knownInvalidTargets, type AppDeploymentStatus } from './deployment-map.js';
import {
  DEPLOYMENT_DIR,
  DEPLOYMENT_TYPE,
  PLATFORM_DEPLOY_PROJECT,
  type ArchProjectNode,
  type ArchTagViolation,
} from './arch-tags.js';
import { ROOT_DIR } from '../utils.js';

/**
 * Vi phạm của lượt kiểm map — dùng lại `ArchTagViolation` với kinds riêng đã
 * được thêm vào union của nó, để mọi lượt gom về một danh sách in ra.
 * `project` là app/deploy project vi phạm (rỗng khi lỗi thuộc về chính bản đồ,
 * ví dụ entry lạ không ứng app nào trên đĩa).
 */
export type DeploymentMapViolation = ArchTagViolation;

/** Loại vi phạm riêng của lượt kiểm deployment map (subset của kind union). */
export type DeploymentMapViolationKind = Extract<
  ArchTagViolation['kind'],
  | 'missing-map-entry'
  | 'stale-map-entry'
  | 'invalid-map-owner'
  | 'platform-cannot-own'
  | 'missing-reason'
  | 'stale-allowlist-entry'
  | 'invalid-target-ref'
  | 'deployment-status-marker-mismatch'
>;

/** Đọc danh sách app authoritative từ đĩa (`apps/`), không qua Nx. */
export function readAppsFromDisk(dir: string = join(ROOT_DIR, 'apps')): string[] {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  // Mảng mới từ readdirSync — sort tại chỗ như worker-discovery: target es2022
  // chưa có toSorted, và mutation ở đây chỉ chạm mảng mình sở hữu.
  names.sort();
  return names;
}

/** Đọc danh sách deploy project từ đĩa (`deploys/`), cùng quy ước apps/. */
function readDeploysFromDisk(): string[] {
  const names = readdirSync(join(ROOT_DIR, DEPLOYMENT_DIR), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  names.sort(); // mảng mới từ readdirSync — sort tại chỗ (target es2022)
  return names;
}

/**
 * Đọc marker `ecoma.deployment.status` từ `package.json` của một deploy
 * project. Trả `undefined` khi thiếu marker (checker báo lỗi riêng).
 */
export function readDeploymentStatusMarker(
  packageJsonPath: string,
): AppDeploymentStatus | undefined {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    ecoma?: { deployment?: { status?: string } };
  };
  const status = pkg.ecoma?.deployment?.status;
  return status === 'implemented' || status === 'scaffold' ? status : undefined;
}

/**
 * Lượt kiểm mapping + reverse ownership + invalid target reference.
 *
 * `projects` là project graph đã lọc (cùng nguồn với các lượt khác);
 * `appsOnDisk`/`deploysOnDisk`/`targetCommands` inject được để unit test không
 * phải dựng workspace thật — production path đi qua `collectTargetCommands`
 * và mặc định đọc từ `ROOT_DIR`.
 */
export function validateDeploymentMap(input: {
  projects: Map<string, ArchProjectNode>;
  appsOnDisk?: readonly string[];
  deploysOnDisk?: readonly string[];
  targetCommands?: ReadonlyMap<string, readonly string[]>;
}): DeploymentMapViolation[] {
  const appsOnDisk = input.appsOnDisk ?? readAppsFromDisk();
  const deploysOnDisk = input.deploysOnDisk ?? readDeploysFromDisk();
  const targetCommands = input.targetCommands ?? collectTargetCommands();

  const violations: DeploymentMapViolation[] = [];

  // (1) Mỗi app trên đĩa có đúng một entry map — thiếu entry là lỗi, entry
  // không ứng app nào là lỗi thứ hai (stale). App trùng entry không thể xảy
  // ra với Record (key duy nhất), nên "đúng một" ở đây là: không thiếu,
  // không thừa.
  const appSet = new Set(appsOnDisk);
  for (const app of appsOnDisk) {
    if (DEPLOYMENT_MAP[app] === undefined) {
      violations.push({
        project: app,
        kind: 'missing-map-entry',
        detail: `app in apps/ has no entry in DEPLOYMENT_MAP (tools/dx/src/architecture/deployment-map.ts)`,
      });
    }
  }
  for (const key of Object.keys(DEPLOYMENT_MAP)) {
    const entry = DEPLOYMENT_MAP[key];
    if (entry.kind === 'platform') continue; // platform không thuộc apps/
    if (!appSet.has(key)) {
      violations.push({
        project: key,
        kind: 'stale-map-entry',
        detail: `DEPLOYMENT_MAP entry points at apps/${key}, which does not exist on disk`,
      });
    }
  }

  // (2) Owner phải là deployment project thật; platform-deploy không được là
  // owner. Entry absorbed/none bắt buộc có reason. Invariant owner-null theo
  // status chạy ĐẦU TIÊN và `continue` ngay khi báo: một entry absorbed/none
  // mang owner khác null không có unit thật để kiểm tiếp (lượt owner bên dưới
  // sẽ nhân đôi lỗi cùng một nguyên nhân), còn implemented/scaffold thiếu owner
  // thì mọi lượt owner khác đều vô nghĩa khi không có gì để kiểm. Entry bị
  // invariant báo được đưa vào `invalidEntries` để các lượt (3) và (4) bỏ nó —
  // một nguyên nhân dữ liệu chỉ báo một lần, không lan thành lỗi dây chuyền.
  const invalidEntries = new Set<string>();
  const deployProjects = new Set(
    [...input.projects.values()].filter((p) => p.tags.includes(DEPLOYMENT_TYPE)).map((p) => p.name),
  );
  for (const [key, entry] of Object.entries(DEPLOYMENT_MAP)) {
    if (entry.kind === 'platform') {
      continue;
    }
    if (entry.owner !== null && (entry.status === 'absorbed' || entry.status === 'none')) {
      violations.push({
        project: key,
        kind: 'invalid-map-owner',
        detail:
          `status '${entry.status}' must have owner null ` +
          `(got '${entry.owner}'); absorbed/none entries have no deployment unit of their own`,
      });
      invalidEntries.add(key);
      continue;
    }
    if (entry.owner === null && (entry.status === 'implemented' || entry.status === 'scaffold')) {
      violations.push({
        project: key,
        kind: 'invalid-map-owner',
        detail:
          `status '${entry.status}' requires a non-null owner deploy project; ` +
          `no deploy project provisions this app's runtime`,
      });
      invalidEntries.add(key);
      continue;
    }
    if (entry.owner !== null) {
      if (entry.owner === PLATFORM_DEPLOY_PROJECT) {
        violations.push({
          project: key,
          kind: 'platform-cannot-own',
          detail: `${PLATFORM_DEPLOY_PROJECT} is shared prerequisite infrastructure and cannot own an app`,
        });
        continue;
      }
      if (!deployProjects.has(entry.owner)) {
        violations.push({
          project: key,
          kind: 'invalid-map-owner',
          detail: `owner ${entry.owner} is not a ${DEPLOYMENT_TYPE} project in deploys/`,
        });
        continue;
      }
      // Owner thật ⇒ thư mục deploys/<owner> phải tồn tại trên đĩa: tag có
      // thể đúng trên graph trong khi thư mục đã bị đổi tên/xóa.
      if (!deploysOnDisk.includes(entry.owner)) {
        violations.push({
          project: key,
          kind: 'invalid-map-owner',
          detail: `owner ${entry.owner} has no directory in ${DEPLOYMENT_DIR}/`,
        });
      }
    }
    if ((entry.status === 'absorbed' || entry.status === 'none') && !entry.reason) {
      violations.push({
        project: key,
        kind: 'missing-reason',
        detail: `status '${entry.status}' requires a non-empty reason`,
      });
    }
  }

  // (3) Marker machine-readable trong deploys/*/package.json khớp status map.
  // Entry absorbed/none không có owner nên không cần marker — chỉ kiểm marker
  // trên deploy project NÀO ĐÓ sở hữu entry implemented/scaffold. Entry đã bị
  // invariant (2) báo bị loại khỏi nguồn expected: owner/status của nó không
  // còn đáng tin để đối chiếu marker, và lỗi marker phát sinh từ đó là lỗi dây
  // chuyền của cùng một nguyên nhân đã báo rồi.
  const ownedByStatus = new Map<string, AppDeploymentStatus>();
  for (const [key, entry] of Object.entries(DEPLOYMENT_MAP)) {
    if (entry.kind === 'app' && entry.owner !== null && !invalidEntries.has(key)) {
      ownedByStatus.set(entry.owner, entry.status);
    }
  }
  for (const deploy of deploysOnDisk) {
    const expected = ownedByStatus.get(deploy);
    if (expected === undefined) continue; // deploy project không owner app nào — reverse check phía dưới báo
    const packageJsonPath = join(ROOT_DIR, DEPLOYMENT_DIR, deploy, 'package.json');
    let actual: AppDeploymentStatus | undefined;
    try {
      actual = readDeploymentStatusMarker(packageJsonPath);
    } catch {
      violations.push({
        project: deploy,
        kind: 'deployment-status-marker-mismatch',
        detail: `cannot read ecoma.deployment.status from ${DEPLOYMENT_DIR}/${deploy}/package.json`,
      });
      continue;
    }
    if (actual !== expected) {
      violations.push({
        project: deploy,
        kind: 'deployment-status-marker-mismatch',
        detail: `ecoma.deployment.status is ${actual ?? 'missing'} but DEPLOYMENT_MAP says '${expected}'`,
      });
    }
  }

  // (4) Reverse ownership: mọi deploy project trừ platform phải sở hữu ≥1 app.
  // Đọc từ GRAPH (type:deployment) chứ không từ đĩa: một deploy project mới
  // xuất hiện trong graph mà chưa sở hữu app nào là lỗi dữ liệu bản đồ. Entry
  // đã bị invariant (2) báo không đóng góp owner vào tập này — owner ảo của
  // nó không biến deploy project thật thành "đã có chủ" (hoặc ngược lại).
  const owners = new Set(
    Object.entries(DEPLOYMENT_MAP)
      .filter(([key, entry]) => entry.kind === 'app' && !invalidEntries.has(key))
      .map(([, entry]) => (entry.kind === 'app' ? entry.owner : null))
      .filter((o): o is string => o !== null),
  );
  for (const name of deployProjects) {
    if (name === PLATFORM_DEPLOY_PROJECT) continue;
    if (!owners.has(name)) {
      violations.push({
        project: name,
        kind: 'invalid-map-owner',
        detail: `${DEPLOYMENT_TYPE} project owns no app in DEPLOYMENT_MAP; every deploy project except ${PLATFORM_DEPLOY_PROJECT} must own at least one entry`,
      });
    }
  }

  // (5) Invalid target reference: mọi path-repo ref trong `command` của nx
  // target phải tồn tại trên đĩa, trừ ref trong allowlist có reason.
  violations.push(...findInvalidTargetRefs(targetCommands));

  return violations;
}

/**
 * Quét mọi ref `tools/...`-style trong `command` của nx target.
 *
 * Ref được nhận theo token: mỗi từ trong `command` trông như một đường dẫn
 * repo (chứa `/`, không phải flag `--x=y`, không phải URL) được kiểm tồn tại
 * trên đĩa. Cho phép test inject `targetCommands`: map project → danh sách
 * chuỗi command.
 *
 * Allowlist là trạng thái tạm thời có chủ đích, không phải bãi rác: mỗi entry
 * được đếm số ref hỏng nó che; entry che 0 ref là dư thừa và bị báo
 * `stale-allowlist-entry` để dọn cùng lúc với target nó từng che, tránh
 * allowlist biến thành đường miễn trừ vĩnh viễn cho ref hỏng tương lai.
 */
export function findInvalidTargetRefs(
  targetCommands: ReadonlyMap<string, readonly string[]>,
): DeploymentMapViolation[] {
  const violations: DeploymentMapViolation[] = [];
  // Map ref → số lần ref đó bị phát hiện hỏng và được allowlist che. Chỉ entry
  // khớp >= 1 ref hỏng thật mới được ở lại allowlist.
  const allowlistedHits = new Map<string, number>(knownInvalidTargets.map((e) => [e.ref, 0]));

  for (const [project, commands] of targetCommands) {
    for (const command of commands) {
      for (const token of command.split(/\s+/u)) {
        if (!token.includes('/')) continue; // lệnh trần (npx tsx, wrangler dev...)
        if (token.startsWith('-')) continue; // flag, kể cả --key=value
        if (/^[a-z]+:\/\//u.test(token)) continue; // URL scheme
        // Token dạng a=b (gán biến môi trường) — chỉ kiểm vế phải nếu nó
        // trông như đường dẫn repo.
        const candidate = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
        if (!candidate.includes('/')) continue;
        if (candidate.startsWith('@')) continue; // package name scope (@ecoma-io/home)
        if (existsOnDisk(candidate, resolveCommandBase(project))) continue;
        if (allowlistedHits.has(candidate)) {
          allowlistedHits.set(candidate, (allowlistedHits.get(candidate) ?? 0) + 1);
          continue;
        }
        violations.push({
          project,
          kind: 'invalid-target-ref',
          detail:
            `nx target command references "${candidate}" which does not exist in the repository; ` +
            `add it to knownInvalidTargets with a reason if the reference is intentionally stale`,
        });
      }
    }
  }

  for (const [ref, hits] of allowlistedHits) {
    if (hits === 0) {
      violations.push({
        project: '',
        kind: 'stale-allowlist-entry',
        detail:
          `allowlist entry "${ref}" matches no dangling target reference in the workspace; ` +
          `remove the entry (it masks nothing now) or fix the ref it was seeded for`,
      });
    }
  }
  return violations;
}

/**
 * Thư mục mà ref tương đối trong `command` của project được giải hệ.
 *
 * `nx:run-commands` chạy `command` trong `cwd` của target khi có, còn lại
 * trong project root — KHÔNG phải repo root. Vì vậy ref tương đối được kiểm
 * theo hai vế: repo root (ref kiểu `tools/...` là phổ biến nhất) và project
 * root (`tests/databases` của chính project). Ref tuyệt đối (`/...`) thì
 * `join(base, ref)` đã tự trả về ref, đúng ngữ nghĩa path tuyệt đối.
 *
 * Tên project (vd `@ecoma-io/account`) không trùng tên thư mục
 * (`apps/account`): suy ra thư mục bằng cách so `package.json` name trong
 * từng top-level dir — cùng nguồn dữ liệu với `collectTargetCommands`.
 */
function resolveCommandBase(project: string): string | undefined {
  const dir = findProjectDir(project);
  return dir ? dir : undefined;
}

/** Path tồn tại trên đĩa, thử theo repo root rồi theo command base. */
function existsOnDisk(ref: string, base?: string): boolean {
  const roots = base ? [ROOT_DIR, base] : [ROOT_DIR];
  for (const root of roots) {
    try {
      statSync(resolve(root, ref));
      return true;
    } catch {
      // thử root kế tiếp
    }
  }
  return false;
}

/**
 * Tìm thư mục project theo `package.json` name, quét các top-level dir chuẩn
 * của workspace. Trả `undefined` khi project không có package.json (project
 * JSON-only) — lúc đó ref chỉ được giải hệ theo repo root.
 */
function findProjectDir(project: string): string | undefined {
  for (const top of ['apps', 'libs', 'deploys', 'tools']) {
    for (const [name, dir] of listPackageJsonProjects(top)) {
      if (name === project) return dir;
    }
  }
  return undefined;
}

/**
 * Thu thập mọi chuỗi `command` trong `nx.targets.*.options.command` (kể cả
 * `configurations.*.command`) của mọi package.json project trong workspace.
 *
 * Đọc đĩa trực tiếp thay vì qua `nx graph`: graph không expose target command,
 * còn đĩa là nơi file thật nằm — đúng nguồn mà check muốn đối chiếu.
 */
export function collectTargetCommands(): Map<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  const projectDirs: [string, string][] = [
    ...listPackageJsonProjects('apps'),
    ...listPackageJsonProjects('libs'),
    ...listPackageJsonProjects('deploys'),
    ...listPackageJsonProjects('tools'),
  ];
  for (const [name, dir] of projectDirs) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      nx?: { targets?: Record<string, NxTargetJson> };
    };
    const commands: string[] = [];
    for (const target of Object.values(pkg.nx?.targets ?? {})) {
      if (target.options?.command) commands.push(target.options.command);
      for (const configuration of Object.values(target.configurations ?? {})) {
        if (configuration?.command) commands.push(configuration.command);
      }
    }
    if (commands.length > 0) result.set(name, commands);
  }
  return result;
}

interface NxTargetJson {
  options?: { command?: string };
  configurations?: Record<string, { command?: string } | undefined>;
}

/** Liệt kê [tên project, đường dẫn tuyệt đối] từ package.json trong một thư mục gốc. */
function listPackageJsonProjects(root: string): [string, string][] {
  const base = join(ROOT_DIR, root);
  let entries: Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return []; // thư mục chưa tồn tại (vd tests/) — không phải lỗi dữ liệu
  }
  const result: [string, string][] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(base, e.name);
    if (!existsSync(join(dir, 'package.json'))) continue;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name?: string;
    };
    result.push([pkg.name ?? e.name, dir]);
  }
  return result;
}
