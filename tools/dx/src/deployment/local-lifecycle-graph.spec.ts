/**
 * Graph-drift check cho lane local + đường system-test affected-aware.
 *
 * Vấn đề: hợp đồng của issue #423/#424 nằm ở HAI tầng khai báo khác nhau và
 * hiện không có test nào chặn chúng trôi dạt:
 *
 * 1. **Project graph (selection cho `nx affected -t system-test`)** — mỗi
 *    suite dưới `system-tests/e2e/*` khai `implicitDependencies` trỏ đúng các
 *    deploy project mà luồng test chạm thật. Thiếu/cá hệ thống một edge là
 *    `affected` chọn thiếu suite (thay đổi deploy unit không kéo suite tương
 *    ứng) — lỗi âm thầm, chỉ thấy khi regression lọt vào main.
 * 2. **Task graph (prerequisite)** — target `system-test` khai `dependsOn`
 *    tới `local-up` của ĐÚNG các deploy project đó, kèm `configurations.local`
 *    (cờ `-c local` phải lan xuống prerequisite, task id dạng
 *    `...:local-up:local`) và `cache: false` (stack local là external state —
 *    cache hit trả kết quả xanh cho một hệ thống không còn chạy như lúc cache
 *    được ghi). Hai tập (implicitDependencies vs dependsOn) lệch nhau nghĩa là
 *    selection nói một đường, readiness nói một đường khác.
 *
 * Nương theo ranh giới với các check hiện có: `local-entry-contract.spec.ts`
 * ghim danh sách lane project bằng allowlist cứng; check này bổ sung hình
 * tổng quát self-maintaining (đọc đĩa, không allowlist riêng) + tính nhất quán
 * của E2E; acyclicity trên tập deployment đã có ở `validateDeploymentGraph`
 * (arch-check) — check này mở rộng sang toàn project graph vì một chu trình
 * qua node e2e/tooling (không phải deployment) không rơi vào lượt đó.
 *
 * Toàn bộ đọc là read-only (package.json trên đĩa + `nx graph --print` qua
 * `collectWorkspaceState`) — không chạy task, không chạm Docker.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectWorkspaceState, DEPLOYMENT_TYPE } from '../architecture/arch-tags.js';
import { ROOT_DIR } from '../utils.js';

const DEPLOYS_DIR = join(ROOT_DIR, 'deploys');
const E2E_DIR = join(ROOT_DIR, 'system-tests', 'e2e');

/** Target local mà một lane project phải có (cùng hợp đồng entry contract). */
const LOCAL_LIFECYCLE_TARGETS = ['local-up', 'local-down'] as const;

interface ProjectNx {
  implicitDependencies?: string[];
  tags?: string[];
  targets?: Record<string, Record<string, unknown>>;
}

function readPackageJson(projectRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function nxSection(projectRoot: string): ProjectNx {
  const pkg = readPackageJson(projectRoot);
  return (pkg['nx'] as ProjectNx | undefined) ?? {};
}

/** Danh sách thư mục con của `dir` có chứa `package.json` (mỗi thư mục một Nx project). */
function projectDirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => existsSync(join(dir, e.name, 'package.json')))
    .map((e) => join(dir, e.name));
}

function deploymentProjectsOnDisk(): string[] {
  return projectDirs(DEPLOYS_DIR).filter((root) => {
    const tags = nxSection(root).tags ?? [];
    return tags.includes(DEPLOYMENT_TYPE);
  });
}

/** Hợp đồng khai báo của MỘT suite e2e, đã chuẩn hoá để các lượt kiểm đọc. */
interface SuiteContract {
  name: string;
  hasSystemTestTarget: boolean;
  /** Số entry `dependsOn` trỏ đúng target `local-up`. */
  localUpEntryCount: number;
  implicit: string[];
  dependsOnProjects: string[];
  dependsOnTargets: string[];
  hasLocalConfig: boolean;
  cache: unknown;
}

/**
 * Đọc hợp đồng của một suite từ package.json. KHÔNG expect bên trong: trả về
 * các giá trị thô để từng lượt kiểm khẳng định ở nơi duy nhất của nó — expect
 * trong helper dùng chung bị vitest(no-conditional-expect) cấm và làm mờ nguồn
 * lỗi thật.
 */
function readSuiteContract(root: string): SuiteContract {
  const name = root.split('/').at(-1) as string;
  const nx = nxSection(root);
  const target = nx.targets?.['system-test'] as Record<string, unknown> | undefined;
  // Nx cho phép `dependsOn` ở dạng chuỗi (`'^build'`, `'project:target'`) hoặc
  // object — chuẩn hoá CẢ HAI, không bỏ lặng dạng nào: entry chuỗi cũng là
  // prerequisite thật, để nó "thoát" các kiểm tra dưới đây là lỗ hổng fail-open
  // (suite tự thoát contract bằng cách đổi sang chuỗi). `'project:target'` tách
  // theo dấu hai chấm cuối (project scope có thể chứa ':'); `'target'` không có
  // ':' là self/implicit — không trỏ được vào project nào, coi như thiếu project.
  const dependsOn = ((target?.['dependsOn'] ?? []) as unknown[]).flatMap((d) => {
    if (typeof d === 'object' && d !== null) {
      return [d as { projects?: string[]; target?: string }];
    }
    if (typeof d === 'string') {
      const separator = d.lastIndexOf(':');
      if (separator > 0) {
        return [{ projects: [d.slice(0, separator)], target: d.slice(separator + 1) }];
      }
      return [{ target: d }];
    }
    return [];
  });
  const configurations = target?.['configurations'] as Record<string, unknown> | undefined;
  return {
    name,
    hasSystemTestTarget: target !== undefined,
    localUpEntryCount: dependsOn.filter((d) => d.target === 'local-up').length,
    implicit: nx.implicitDependencies ?? [],
    dependsOnProjects: dependsOn
      .filter((d) => d.target === 'local-up')
      .flatMap((d) => d.projects ?? []),
    dependsOnTargets: dependsOn.map((d) => d.target ?? ''),
    hasLocalConfig: configurations !== undefined && 'local' in configurations,
    cache: target?.['cache'],
  };
}

describe('deploys/* local lifecycle inventory (self-maintaining)', () => {
  it('every deployment project is either a lane project (local.ts + local targets) or scaffold-only (neither)', () => {
    // Hình tổng quát của allowlist trong local-entry-contract.spec.ts: phân loại
    // đọc từ ĐĨA, không liệt kê tay — một project mới rơi tự nhiên vào một trong
    // hai hình, và hình nửa vời (target local mà thiếu local.ts, hoặc ngược lại)
    // là lỗi ngay không cần sửa allowlist. Vi phạm được gom theo hình để khẳng
    // định ngoài vòng lặp (vitest(no-conditional-expect)).
    const laneViolations: string[] = [];
    const scaffoldViolations: string[] = [];
    for (const root of deploymentProjectsOnDisk()) {
      const name = root.split('/').at(-1) as string;
      const targets = nxSection(root).targets ?? {};
      const hasLocalTs = existsSync(join(root, 'local.ts'));
      const localTargets = LOCAL_LIFECYCLE_TARGETS.filter((t) => targets[t] !== undefined);
      if (hasLocalTs) {
        if (localTargets.length !== LOCAL_LIFECYCLE_TARGETS.length) {
          laneViolations.push(name);
        }
      } else if (localTargets.length > 0) {
        scaffoldViolations.push(`${name} (declares ${localTargets.join(', ')} without local.ts)`);
      }
    }
    expect(
      laneViolations,
      `projects with local.ts must declare ${LOCAL_LIFECYCLE_TARGETS.join(' and ')} targets`,
    ).toEqual([]);
    expect(
      scaffoldViolations,
      'projects without local.ts must not declare local lifecycle targets (scaffold-only)',
    ).toEqual([]);
  });

  it('every scaffold-only deployment project carries the status marker', () => {
    // Bằng chứng "chủ ý scaffold" phải machine-readable: marker
    // `ecoma.deployment.status` (arch-check đối chiếu với DEPLOYMENT_MAP) —
    // không phải một dự án quên khai lifecycle.
    for (const root of deploymentProjectsOnDisk()) {
      const name = root.split('/').at(-1) as string;
      const hasLocalTs = existsSync(join(root, 'local.ts'));
      if (hasLocalTs) continue;
      const pkg = readPackageJson(root);
      const status = (pkg['ecoma'] as { deployment?: { status?: string } } | undefined)?.deployment
        ?.status;
      expect(status, `${name} must declare ecoma.deployment.status`).toBe('scaffold');
    }
  });
});

describe('system-tests/e2e/* prerequisite contract', () => {
  const suiteRoots = projectDirs(E2E_DIR);
  const deployNames = new Set(deploymentProjectsOnDisk().map((r) => r.split('/').at(-1) as string));

  it('every suite directory under system-tests/e2e exists (baseline for the checks below)', () => {
    expect(suiteRoots.length).toBeGreaterThan(0);
  });

  it('every suite declares a system-test target with exactly one local-up dependsOn entry', () => {
    // 06-testing.md mục 4: mỗi suite là một Nx project với target system-test,
    // prerequisite dựng stack qua đúng một dependsOn -> local-up. Thiếu target
    // hoặc thiếu/kéo nhiều entry là lỗi cấu trúc của chính suite.
    const violations: string[] = [];
    for (const root of suiteRoots) {
      const contract = readSuiteContract(root);
      if (!contract.hasSystemTestTarget) violations.push(`${contract.name}: no system-test target`);
      if (contract.localUpEntryCount !== 1) {
        violations.push(
          `${contract.name}: ${contract.localUpEntryCount} dependsOn entries for local-up (expected exactly 1)`,
        );
      }
    }
    expect(violations, 'suite target structure').toEqual([]);
  });

  it('implicitDependencies and system-test local-up dependsOn declare the same deployment set', () => {
    // Selection (project graph) và prerequisite (task graph) phải là MỘT tập:
    // lệch nhau nghĩa là `nx affected` chọn suite theo một đường nhưng stack
    // được dựng theo một đường khác.
    for (const root of suiteRoots) {
      const contract = readSuiteContract(root);
      expect(
        new Set(contract.implicit),
        `${contract.name}: implicitDependencies must equal the local-up dependsOn projects`,
      ).toEqual(new Set(contract.dependsOnProjects));
    }
  });

  it('suite dependencies point only at existing deployment projects that implement local-up', () => {
    const violations: string[] = [];
    for (const root of suiteRoots) {
      const contract = readSuiteContract(root);
      for (const dep of [...contract.implicit, ...contract.dependsOnProjects]) {
        if (!deployNames.has(dep)) {
          violations.push(`${contract.name}: dependency ${dep} is not a deploys/* project`);
          continue;
        }
        const depTargets = nxSection(join(DEPLOYS_DIR, dep)).targets ?? {};
        if (depTargets['local-up'] === undefined) {
          violations.push(
            `${contract.name}: prerequisite ${dep} does not implement local-up (scaffold-only projects cannot be prerequisites)`,
          );
        }
      }
    }
    expect(violations, 'suite prerequisite edges must resolve to lane projects').toEqual([]);
  });

  it('system-test target carries configurations.local and cache=false (lane contract)', () => {
    // `-c local` của invocation chỉ tới prerequisite khi target khai cùng tên
    // configuration; `cache: false` là CONTRACT (external stack state), không
    // phải tối ưu — đặt lại cacheable là hồi quy.
    const violations: string[] = [];
    for (const root of suiteRoots) {
      const contract = readSuiteContract(root);
      if (!contract.hasLocalConfig) {
        violations.push(`${contract.name}: system-test must declare configurations.local`);
      }
      if (contract.cache !== false) {
        violations.push(`${contract.name}: system-test must not be cacheable`);
      }
    }
    expect(violations, 'system-test lane contract').toEqual([]);
  });

  it('system-test dependsOn pulls neither local-smoke nor local-down', () => {
    // local-smoke dependsOn `home-deploy` (smoke kiểm chuỗi redirect của home);
    // local-down là teardown — cả hai trong prerequisite của suite đều sai.
    const violations: string[] = [];
    for (const root of suiteRoots) {
      const contract = readSuiteContract(root);
      for (const forbidden of ['local-smoke', 'local-down'] as const) {
        if (contract.dependsOnTargets.includes(forbidden)) {
          violations.push(`${contract.name}: ${forbidden} must not be a prerequisite`);
        }
      }
    }
    expect(violations, 'forbidden prerequisite targets').toEqual([]);
  });
});

describe('whole project graph acyclicity', () => {
  it('no dependency cycle exists anywhere in the project graph', () => {
    // `validateDeploymentGraph` chỉ duyệt chu trình trên tập con deployment;
    // một chu trình qua node e2e/tooling (implicitDependencies hai chiều với
    // một deploy project, chẳng hạn) không rơi vào lượt đó nhưng vẫn làm
    // `nx affected` không tính được tập affected. DFS ba màu trên toàn đồ thị.
    const { projects } = collectWorkspaceState();
    const edges = new Map<string, readonly string[]>();
    for (const project of projects.values()) edges.set(project.name, project.dependencies);

    const WHITE = 0;
    const GREY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    const stack: string[] = [];
    const cycles: string[][] = [];
    const visit = (node: string): void => {
      color.set(node, GREY);
      stack.push(node);
      for (const dep of edges.get(node) ?? []) {
        const state = color.get(dep) ?? WHITE;
        if (state === GREY) {
          const start = stack.indexOf(dep);
          cycles.push(stack.slice(start).concat(dep));
        } else if (state === WHITE) {
          visit(dep);
        }
      }
      stack.pop();
      color.set(node, BLACK);
    };
    for (const name of edges.keys()) {
      if ((color.get(name) ?? WHITE) === WHITE) visit(name);
    }
    expect(
      cycles,
      `project graph must be acyclic; cycles found: ${cycles.map((c) => c.join(' -> ')).join('; ')}`,
    ).toEqual([]);
  });
});
