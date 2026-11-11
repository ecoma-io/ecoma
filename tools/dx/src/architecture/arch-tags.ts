/**
 * Validate Nx architecture tags cho toàn workspace.
 *
 * Hai lượt kiểm, tách bạch nguồn dữ liệu:
 *
 * 1. **Tag schema** — đọc trực tiếp `nx show projects --json`: mỗi project phải
 *    có đúng một `scope:*`, một `type:*`, một `runtime:*`, mọi value thuộc
 *    allowlist, và không còn value legacy (`type:web`, `layer:*`, …). Lượt này
 *    chạy trên **tất cả** project, bất kể affected — một tag sai ở project không
 *    đổi file nào cũng phải bị bắt, vì chính tag là dữ liệu đầu vào của mọi
 *    constraint khác. Danh sách `show` là truth: project nào có trong danh sách
 *    mà vắng trong project graph thì check fail-closed (xem
 *    `buildWorkspaceState`) — không skip lặng lẽ project nào.
 *
 * 2. **Runtime compatibility theo graph** — đọc project graph và kiểm mỗi edge
 *    theo ma trận `RUNTIME_COMPAT`: `runtime:edge` không được phụ thuộc
 *    `runtime:native`/`runtime:browser`, v.v. Lượt này dùng graph chứ không dùng
 *    directory glob: guard theo glob (`.oxlintrc.json` override) chỉ chặn chữ
 *    `node:*` trong mã của app, không biết project nào là `runtime:edge`
 *    thật — một tooling script import `node:fs` hợp lệ, một app edge thì không,
 *    và glob không phân biệt được hai trường hợp đó.
 *
 * 3. **Bất biến đồ thị deployment** — kiểm trên chính project graph những điều
 *    mà metadata Nx không diễn đạt được (xem `validateDeploymentGraph`).
 *
 * 4. **Deployment map** — đối chiếu `DEPLOYMENT_MAP` với đĩa và marker
 *    `ecoma.deployment.status` (xem `validateDeploymentMap`).
 *
 * 5. **Layout test-target** — ràng buộc layout test của
 *    `docs/architecture/06-testing.md` lên đĩa trong project root app/lib: thư mục
 *    mục đích ⇔ target `test-integration`, unit config không include suite
 *    app-owned, tier unit không boot dependency thật, `passWithNoTests: false`
 *    trong mọi config integration (xem `validateTestTargets`).
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { ROOT_DIR } from '../utils.js';
import { validateDeploymentMap } from './deployment-map-check.js';
import { validateLlmBoundaries, validateLlmEdgeAllowlist } from './llm-boundaries.js';
import { validateTestTargets } from './test-target-check.js';

/** Giá trị hợp lệ của mỗi dimension tag kiến trúc bắt buộc. */
export const ARCH_TAG_DIMENSIONS = {
  scope: null, // ownership boundary — value do repo quyết định, kiểm theo PREFIX
  // `deployment` là provisioning/orchestration (project Pulumi), KHÁC `infrastructure`:
  // `infrastructure` là adapter/implementation chạy được ở runtime của ứng dụng,
  // `deployment` là mã mô tả hạ tầng được provision ra. Trộn hai nghĩa này là
  // lý do trước đây 12 project `deploy/*` bị gắn `type:infrastructure` rồi không
  // có constraint nào bảo vệ — chúng là code chạy khi provision, không phải code
  // chạy trong app.
  type: [
    'domain',
    'application',
    'infrastructure',
    'contracts',
    'composition',
    'tooling',
    'deployment',
  ],
  runtime: ['edge', 'browser', 'native', 'universal'],
} as const;

export type ArchDimension = keyof typeof ARCH_TAG_DIMENSIONS;

/**
 * Value legacy của các dimension cũ — xuất hiện ở project nào cũng là lỗi.
 *
 * Danh sách này chặn value biết trước của dimension VẪN TỒN TẠI (`type:*`,
 * `runtime:*`): value đó giờ không thuộc allowlist nên lượt 1 đã báo
 * `invalid-value`, mục ở đây chỉ để gắn nhãn `legacy-value` — lỗi taxonomy cũ,
 * không phải gõ sai. Riêng dimension đã bị XOÁ (`layer`) bị chặn theo PREFIX
 * trong `validateTagSchema`: mọi `layer:*` là di tích bất kể value, không thể
 * lọt qua chỉ vì value chưa được liệt kê.
 */
export const LEGACY_TAG_VALUES: readonly string[] = [
  'type:web',
  'type:service',
  'type:lib',
  'type:tool',
  'type:infras',
  'layer:domain',
  'layer:application',
  'layer:infrastructure',
  'layer:contracts',
  'runtime:node',
];

/**
 * Prefix chấp nhận được cho `scope:*`.
 *
 * `scope` là ownership boundary nên value của nó do bounded context/product
 * quyết định và tăng dần theo repo; validator chỉ neo hai điều:
 * - value không được rỗng (`scope:` trống không mang ý nghĩa ownership);
 * - value phải thuộc danh sách scope mà repo đang khai báo trong constraints
 *   của `.oxlintrc.json` — scope ngoài danh sách đó không có constraint nên
 *   dependency của project này sẽ không được ai kiểm.
 *
 * Danh sách giữ nguyên trong validator và `.oxlintrc.json` phải đồng bộ; spec
 * của validator test hai nguồn bằng chung một fixture.
 */
export const KNOWN_SCOPES: readonly string[] = [
  'public',
  'shared',
  'platform',
  'account',
  'auth',
  'backoffice',
  'staff-access',
  'remote-cache',
  // Ba scope ownership của LLM product (ADR-0019). `scope:llm` đã bị xoá:
  // một scope chung cho mọi LLM domain library không phân biệt Consumer với
  // Seller, nên không constraint nào ngăn được Consumer import Seller.
  'llm-consumer',
  'llm-seller',
  'llm-shared',
  'llm-api',
  'pact',
  'payment',
  'messaging',
  'notifications',
  'local',
];

/**
 * Ma trận compatibility runtime: key được phép phụ thuộc tập value ở value.
 *
 * Runtime cụ thể loại trừ lẫn nhau và loại `native` (OS process) — một project
 * edge không import được code native, v.v. `universal` là lời cam kết tương
 * thích hai chiều nên nó chỉ được phụ thuộc project `universal`: một lib
 * universal mà kéo theo dependency edge-only/native/browser-only thì lời cam
 * kết đó lộp bộp — dependency quyết định nơi lib chạy được, không phải tag.
 */
export const RUNTIME_COMPAT: Record<string, readonly string[]> = {
  universal: ['universal'],
  edge: ['universal', 'edge'],
  browser: ['universal', 'browser'],
  native: ['universal', 'native'],
};

/**
 * Project nền tảng của tầng deployment: mọi project `type:deployment` khác phải
 * phụ thuộc nó. Đây là tên project canonical, không phải tag scope — nếu đổi
 * tên thì đổi hằng số này, đừng viết literal rải rác trong validator.
 */
export const PLATFORM_DEPLOY_PROJECT = 'platform-deploy';

export interface ArchTagViolation {
  project: string;
  kind:
    | 'missing-dimension'
    | 'duplicate-dimension'
    | 'invalid-value'
    | 'legacy-value'
    | 'unknown-scope'
    | 'runtime-compat'
    | 'missing-platform-dependency'
    | 'invalid-deploy-dependency'
    | 'deploy-graph-cycle'
    | 'misplaced-deployment-project'
    | 'cross-unit-deploy-dependency'
    | 'cross-context-contract-edge'
    // Lượt ranh giới giữa các bounded context LLM trong cùng scope (ADR-0018,
    // ADR-0019): tag không phân biệt context bên trong một scope, nên cặp
    // context phải được liệt kê tường minh (xem `validateLlmBoundaries`).
    | 'cross-context-domain-edge'
    | 'stale-llm-edge-allowlist-entry'
    | 'graph-inconsistent'
    // Kinds của lượt deployment map (validateDeploymentMap): cùng hình dạng
    // { project, kind, detail } nên mọi lượt gom về một danh sách in ra.
    | 'missing-map-entry'
    | 'stale-map-entry'
    | 'invalid-map-owner'
    | 'platform-cannot-own'
    | 'missing-reason'
    | 'stale-allowlist-entry'
    | 'invalid-target-ref'
    | 'deployment-status-marker-mismatch'
    // Kinds của lượt test-target (validateTestTargets): cùng hình dạng
    // { project, kind, detail } nên mọi lượt gom về một danh sách in ra.
    | 'missing-integration-target'
    | 'missing-integration-config'
    | 'integration-config-missing-dir'
    | 'integration-dir-in-unit-config'
    | 'integration-pass-with-no-tests'
    | 'unit-real-dependency-spec'
    | 'lib-real-dependency-spec'
    | 'unreadable-test-config'
    | 'stale-test-target-allowlist-entry';
  detail: string;
}

/** Một node của project graph đủ dùng cho kiểm runtime: name, tags, dependencies. */
export interface ArchProjectNode {
  name: string;
  tags: readonly string[];
  dependencies: readonly string[];
  /**
   * Đường dẫn project gốc, tương đối so với repo root.
   *
   * Cần cho bất biến `deploys/` ⇔ `type:deployment` (`DEPLOYMENT_DIR`): chỉ
   * có tag thì validator không biết project đặt ở đâu, và một project đặt
   * trong `deploys/` mà gắn tag khác sẽ trốn khỏi mọi lượt kiểm deployment.
   * Optional để các bài test tổng hợp không phải dựng `root` khi không cần.
   */
  root?: string;
}

/** Kéo tags + dependency edges từ Nx cho toàn workspace (read-only). */
export function collectWorkspaceState(): ArchWorkspaceState {
  const raw = execFileSync(
    process.execPath,
    [join(ROOT_DIR, 'node_modules/nx/dist/bin/nx.js'), 'show', 'projects', '--json'],
    { cwd: ROOT_DIR, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const names = JSON.parse(raw) as string[];

  const rawGraph = execFileSync(
    process.execPath,
    [join(ROOT_DIR, 'node_modules/nx/dist/bin/nx.js'), 'graph', '--print'],
    { cwd: ROOT_DIR, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const graph = JSON.parse(rawGraph) as NxGraphJson;

  const projects = buildWorkspaceState(names, graph.graph);
  // Edge CHƯA lọc: `buildWorkspaceState` đã bỏ target không phải project, nên
  // dangling ref chỉ còn nhìn thấy ở bản này — xem `findDanglingDeploymentRefs`.
  const rawDependencies = new Map<string, readonly string[]>();
  for (const [source, targets] of Object.entries(graph.graph.dependencies)) {
    rawDependencies.set(
      source,
      targets.map((d) => d.target),
    );
  }
  return { projects, rawDependencies };
}

/** Đúng hình dạng `nx graph --print` trả về mà phần này dùng. */
interface NxGraphJson {
  graph: {
    nodes: Record<string, { name: string; data: { tags?: string[] } }>;
    dependencies: Record<string, { target: string }[]>;
  };
}

/**
 * Hợp nhất danh sách project authoritative (`nx show projects`) với project
 * graph. Danh sách `show` là **truth về những project nào tồn tại** — project
 * có trong danh sách mà vắng trong graph là lỗi dữ liệu graph (fail-closed,
 * không skip lặng lẽ: một project bị bỏ qua là một project không ai kiểm tag).
 *
 * Node external/npm (package dependency, không phải project) nằm trong
 * `dependencies` chứ không trong `nodes` của graph — chúng bị lọc khỏi danh
 * sách edges project↔project, đúng vai trò, không phải lỗi.
 *
 * Tách thành helper thuần để unit test được mà không cần corrupt workspace thật.
 */
export function buildWorkspaceState(
  names: readonly string[],
  graph: {
    nodes: Record<string, { name: string; data: { tags?: string[]; root?: string } }>;
    dependencies: Record<string, { target: string }[]>;
  },
): Map<string, ArchProjectNode> {
  const missing = names.filter((name) => !graph.nodes[name]);
  if (missing.length > 0) {
    throw new GraphInconsistencyError(
      `workspace projects missing from the Nx project graph — ` +
        `arch-check refuses to validate a partial graph: ${missing.join(', ')}`,
      missing,
    );
  }

  const projects = new Map<string, ArchProjectNode>();
  for (const name of names) {
    const node = graph.nodes[name];
    const deps = (graph.dependencies[name] ?? [])
      .map((d) => d.target)
      .filter((t) => graph.nodes[t] !== undefined); // chỉ quan tâm project↔project
    projects.set(name, {
      name,
      tags: node.data.tags ?? [],
      dependencies: deps,
      root: node.data.root,
    });
  }
  return projects;
}

/** Graph và danh sách project lệch nhau — workspace chưa sẵn sàng để validate. */
export class GraphInconsistencyError extends Error {
  readonly missingProjects: readonly string[];

  constructor(message: string, missingProjects: readonly string[] = []) {
    super(message);
    this.name = 'GraphInconsistencyError';
    this.missingProjects = missingProjects;
  }
}

/** Lượt 1: schema của ba dimension tag trên một project. */
export function validateTagSchema(project: ArchProjectNode): ArchTagViolation[] {
  const violations: ArchTagViolation[] = [];
  const seen = new Map<ArchDimension, string[]>();

  for (const tag of project.tags) {
    const colon = tag.indexOf(':');
    if (colon <= 0) continue; // không phải dạng `dim:value` (vd `npm:private` vẫn đúng dạng) — bỏ qua tag ngoài ba dimension
    const dim = tag.slice(0, colon) as ArchDimension;
    const value = tag.slice(colon + 1);

    // Legacy check đứng TRƯỚC guard dimension: `layer:*` thuộc dimension đã bị
    // xoá nên nếu để sau `dim in ARCH_TAG_DIMENSIONS` thì nó đi thẳng qua mà
    // không bị báo — đúng kiểu "legacy còn sống lặng lẽ" mà check này hunting.
    // `layer` bị chặn theo PREFIX (mọi value), không theo danh sách value định
    // trước: dimension đã bị xoá khỏi taxonomy nên giá trị nào mang prefix đó
    // cũng là di tích — danh sách cứng chỉ bắt được value biết trước.
    if (LEGACY_TAG_VALUES.includes(tag) || tag.startsWith('layer:')) {
      violations.push({ project: project.name, kind: 'legacy-value', detail: tag });
      continue;
    }
    // `Object.hasOwn` chứ KHÔNG phải `in`: `in` đi qua prototype chain, nên
    // tag dạng `toString:x` / `constructor:x` đi qua guard, rồi lookup
    // `ARCH_TAG_DIMENSIONS[dim]` bên dưới trả về hàm thừa kế từ
    // `Object.prototype` — `allowed.includes` nổ TypeError giữa chừng thay vì
    // báo `unknown-dimension` có kiểm. Dimension của record literal chỉ được
    // nhận từ own property.
    if (!Object.hasOwn(ARCH_TAG_DIMENSIONS, dim)) continue;

    const list = seen.get(dim) ?? [];
    list.push(value);
    seen.set(dim, list);

    if (dim === 'scope') {
      if (!KNOWN_SCOPES.includes(value)) {
        violations.push({ project: project.name, kind: 'unknown-scope', detail: tag });
      }
      continue;
    }
    const allowed = ARCH_TAG_DIMENSIONS[dim] as readonly string[];
    if (!allowed.includes(value)) {
      violations.push({ project: project.name, kind: 'invalid-value', detail: tag });
    }
  }

  for (const dim of Object.keys(ARCH_TAG_DIMENSIONS) as ArchDimension[]) {
    const list = seen.get(dim);
    if (!list || list.length === 0) {
      violations.push({
        project: project.name,
        kind: 'missing-dimension',
        detail: dim,
      });
    } else if (list.length > 1) {
      violations.push({
        project: project.name,
        kind: 'duplicate-dimension',
        detail: `${dim}: ${list.join(', ')}`,
      });
    }
  }

  return violations;
}

/** Lượt 2: mỗi dependency edge của một project phải qua ma trận runtime. */
export function validateRuntimeCompat(
  project: ArchProjectNode,
  projects: Map<string, ArchProjectNode>,
): ArchTagViolation[] {
  const violations: ArchTagViolation[] = [];
  const runtimeTag = project.tags.find((t) => t.startsWith('runtime:'));
  if (!runtimeTag) return violations; // lượt 1 đã báo missing — không nhân đôi lỗi
  // `Object.hasOwn` để key như `constructor` (từ tag `runtime:constructor`)
  // không resolve ra `Object.prototype.constructor` — lookup qua prototype
  // chain biến hàm thừa kế thành `allowed` và `allowed.includes` nổ TypeError.
  // Guard chặt này cũng vô hiệu hoá cạnh lỗ hổng dạng prototype pollution.
  if (!Object.hasOwn(RUNTIME_COMPAT, runtimeTag.slice('runtime:'.length))) {
    return violations; // lượt 1 đã báo invalid-value
  }
  const allowed = RUNTIME_COMPAT[runtimeTag.slice('runtime:'.length)];

  for (const dep of project.dependencies) {
    const depNode = projects.get(dep);
    if (!depNode) continue;
    const depRuntime = depNode.tags.find((t) => t.startsWith('runtime:'));
    if (!depRuntime) continue; // dep lỗi schema — lượt 1 báo, khỏi nhân đôi
    // Edge deployment → app (`type:composition`) là quan hệ ĐÓNG GÓI, không
    // phải import runtime: deploy unit build/mount app đó vào container của
    // mình (Dockerfile COPY, dist mount, WIC), hai process không cùng runtime
    // trong một luồng gọi. Ma trận runtime chỉ có ý nghĩa cho cạnh import —
    // áp nó lên edge đóng gói là chặn sai kiến trúc đã chốt (app edge chạy
    // trong container native qua WIC/node-server). Chỉ deployment được phép
    // carve-out này, và edge vẫn qua mọi lượt deployment graph khác.
    // Carve-out CHỈ dành cho app `runtime:edge` được đóng gói vào container
    // native của deploy unit — yêu cầu NGHIÊM: deploy unit phải `runtime:native`
    // (một deployment gắn runtime khác đã sai schema sở hữu riêng; không ghim
    // là lỗ bypass ma trận cho mọi `type:deployment`), và composition app với
    // runtime khác (browser...) không nằm trong nghĩa đó, nên vẫn qua ma trận
    // runtime.
    if (
      project.tags.includes(DEPLOYMENT_TYPE) &&
      runtimeTag === 'runtime:native' &&
      depNode.tags.includes('type:composition') &&
      depRuntime === 'runtime:edge'
    ) {
      continue;
    }
    if (!allowed.includes(depRuntime.slice('runtime:'.length))) {
      violations.push({
        project: project.name,
        kind: 'runtime-compat',
        detail: `${runtimeTag} depends on ${dep} (${depRuntime})`,
      });
    }
  }
  return violations;
}

/**
 * Trạng thái workspace mà các lượt kim đọc.
 *
 * `rawDependencies` là dependency target **chưa lọc** (mọi tên xuất hiện trong
 * `dependencies` của Nx graph, kể cả package npm ngoài workspace). Nó tồn tại vì
 * `buildWorkspaceState` cố tình lọc bỏ những target không phải project — và
 * chính thao tác lọc đó xoá mất thông tin cần cho kiểm dangling ref. Xem
 * `findDanglingDeploymentRefs`.
 *
 * Trường này optional để state dựng tay trong unit test không phải khai báo:
 * khi vắng mặt, lượt dangling chạy trên `projects[*].dependencies` (đã lọc),
 * tức trên tập edge mà test tự khai — đúng cái test đang cố kiểm. Không có
 * nhánh nào "bỏ qua im lặng": thiếu `rawDependencies` không tắt check.
 */
export interface ArchWorkspaceState {
  projects: Map<string, ArchProjectNode>;
  rawDependencies?: ReadonlyMap<string, readonly string[]>;
}

/** Nhóm lượt kiểm đồ thị deployment — export để test import từ một chỗ. */
export const DEPLOYMENT_TYPE = 'type:deployment';

/**
 * Thư mục chứa deployment project. Ràng buộc này nối *vị trí* với *tag*.
 *
 * Nếu chỉ kiểm `type:deployment` thì `deploys/` chỉ là quy ước đặt tên: một
 * project đặt trong `deploys/` mà gắn tag khác sẽ đi vòng qua mọi lượt kiểm
 * bên dưới, và `arch-check` vẫn xanh. Vì `deploys/` được tài liệu mô tả là lớp
 * chuẩn (canonical), nơi chứa và tag phải là một: hai chiều, cùng một bất biến.
 */
export const DEPLOYMENT_DIR = 'deploys';

/**
 * Bất biến contract-edge theo scope nguồn: scope nguồn chỉ được phụ thuộc
 * `type:contracts` của các scope được liệt kê ở value.
 *
 * ⚠️ Đây là lượt bổ sung cho constraint `onlyDependOnLibsWithTags` của
 * `.oxlintrc.json`, KHÔNG thay thế: constraint lint là OR-match trên tag của
 * target (target chỉ cần MỘT tag khớp là qua), nên `scope:messaging` có
 * `type:contracts` trong allowlist thì target `scope:account` + `type:contracts`
 * cũng đi qua — chéo BC đúng điều cấm mà task yêu cầu chặn. Lượt này đọc CẢ HAI
 * tag trên mỗi node của graph thật nên nói được "contract của scope NÀO".
 *
 * Ghi chú lịch sử: trước đây messaging (transactional-mail) import
 * `identity-auth-contracts` của scope identity (lib đã xoá ở issue #324) để dùng
 * protocol HMAC nội bộ —
 * protocol đó là tài sản nền tảng, đã được tách về `internal-auth-contracts`
 * (`scope:platform`), và messaging được siết về `{ self, platform }`.
 *
 * `auth` được liệt kê tường minh (mặc dù trục `type:contracts` của constraint
 * lint đã cho phép chéo scope): cặp `account` ↔ `auth` có contract chéo HAI
 * CHIỀU thật — `apps/auth` + `libs/auth-{application,domain}` import
 * `account-contracts` (contract `GET /internal/account/status`), và `apps/account`
 * import `auth-contracts` (contract `session-verified`/consent). Khai entry ở đây
 * ghim chính sách đó ở mức graph: một contract lib mới của `auth` rơi vào
 * consumer nào khác của `account` sẽ bị bắt ở đây thay vì lọt qua wildcard.
 *
 * `messaging` nằm trong tập được phép của `account`: account là consumer chính
 * thức của contract công khai `POST /v1/messages` của transactional-mail (gửi mail
 * OTP qua `apps/account/server/lib/mail.ts`, ghim dependency direction ở issue
 * #203) — consumer contracts của messaging là đúng vai trò, khác chiều ngược lại
 * (messaging chỉ được contract của self + platform).
 */
export const CONTRACT_EDGE_OWNERSHIP: Readonly<Record<string, readonly string[]>> = {
  messaging: ['messaging', 'platform'],
  account: ['account', 'auth', 'platform', 'messaging'],
  auth: ['auth', 'account', 'platform'],
};

/**
 * Lượt kiểm contract-edge theo scope nguồn: một edge `source → target` với
 * target mang `type:contracts` phải có scope của target nằm trong danh sách
 * được phép của scope nguồn ({@link CONTRACT_EDGE_OWNERSHIP}).
 *
 * Scope nguồn không có entry trong bản đồ không bị lượt này kiểm (chưa có
 * chính sách riêng — policy của từng scope bổ sung dần, không bắt mọi scope
 * phải khai); scope nguồn entry với value rỗng nghĩa là không được phụ thuộc
 * contract của scope nào kể cả chính nó.
 */
export function validateContractEdgeOwnership(
  projects: Map<string, ArchProjectNode>,
): ArchTagViolation[] {
  const violations: ArchTagViolation[] = [];
  for (const project of projects.values()) {
    const sourceScope = project.tags.find((t) => t.startsWith('scope:'))?.slice('scope:'.length);
    if (sourceScope === undefined) continue; // lượt 1 đã báo missing-dimension
    const allowedScopes = CONTRACT_EDGE_OWNERSHIP[sourceScope];
    if (allowedScopes === undefined) continue;
    for (const dep of project.dependencies) {
      const target = projects.get(dep);
      if (!target?.tags.includes('type:contracts')) continue;
      const targetScope = target.tags.find((t) => t.startsWith('scope:'))?.slice('scope:'.length);
      if (!allowedScopes.includes(targetScope ?? '')) {
        violations.push({
          project: project.name,
          kind: 'cross-context-contract-edge',
          detail: `scope:${sourceScope} depends on contracts of scope:${targetScope ?? 'unknown'} (${dep}); allowed: ${allowedScopes.map((s) => `scope:${s}`).join(', ')}`,
        });
      }
    }
  }
  return violations;
}

/** Project `type:deployment` = consumer của tầng deployment trừ chính nó. */
function deploymentConsumerNodes(projects: Map<string, ArchProjectNode>): ArchProjectNode[] {
  return [...projects.values()].filter(
    (p) => p.tags.includes(DEPLOYMENT_TYPE) && p.name !== PLATFORM_DEPLOY_PROJECT,
  );
}

/**
 * Target không phải project nào trong workspace.
 *
 * `buildWorkspaceState` lọc sạch target không có node trong graph nên dangling
 * ref đã biến mất khỏi `ArchProjectNode.dependencies` trước khi validator kịp
 * nhìn thấy. Vì vậy lượt này đọc `rawDependencies` (chưa lọc) — nếu đọc bản đã
 * lọc thì check luôn xanh và đó là một lỗ hổng, không phải một check.
 *
 * Chỉ áp cho project `type:deployment`: một npm package bên ngoài là chuyện
 * bình thường (Pulumi SDK, `@pulumi/*`), còn một tên gần giống project mà không
 * có node thì là typo đang âm thầm biến thành dependency vô hình. Target
 * `npm:*` được miễn vì đó là cách Nx biểu diễn package ngoài workspace.
 */
export function findDanglingDeploymentRefs(
  rawDependencies: ReadonlyMap<string, readonly string[]>,
  projects: Map<string, ArchProjectNode>,
): ArchTagViolation[] {
  const violations: ArchTagViolation[] = [];
  for (const project of projects.values()) {
    if (!project.tags.includes(DEPLOYMENT_TYPE)) continue;
    const targets = rawDependencies.get(project.name) ?? project.dependencies;
    for (const target of targets) {
      if (target.startsWith('npm:')) continue; // package ngoài workspace
      if (projects.has(target)) continue;
      violations.push({
        project: project.name,
        kind: 'invalid-deploy-dependency',
        detail: `${target} is not a project in the workspace`,
      });
    }
  }
  return violations;
}

/**
 * Bất biến đồ thị deployment — lớp kiểm nhỏ nhất nằm trên metadata Nx.
 *
 * Ba điều ở đây không diễn đạt được bằng `depConstraints` của
 * `.oxlintrc.json` hay bằng tag:
 *
 * 1. **Prerequisite nền tảng.** `type:deployment` nào (trừ chính
 *    `platform-deploy`) đều phải phụ thuộc `platform-deploy`. Một
 *    `onlyDependOnLibsWithTags` không nói được "luôn có MỘT edge này": allowlist
 *    là OR-match trên target, nên một deploy project không có dependency nào
 *    vẫn hợp lệ với mọi constraint. Việc "phải dựa vào tầng nền" là quan hệ
 *    BẮT BUỘC (existential), không phải quan hệ "được phép" (universal) —
 *    hai ngữ nghĩa khác nhau, nên cần một validator riêng.
 * 2. **Acyclicity.** Chu trình trong đồ thị dep là lỗi của chính cấu trúc
 *    graph; không có tag nào biểu đạt "đồ thị này không được có chu trình".
 * 3. **Dangling ref.** Xem `findDanglingDeploymentRefs`.
 *
 * Nhận `state` (cùng hình dạng với `validateArchitecture`) thay vì chỉ
 * `projects` vì lượt (3) cần `rawDependencies`; giữ một hình dạng state cho cả
 * ba lượt giữ `collectWorkspaceState` → `validateArchitecture` →
 * `validateDeploymentGraph` không đổi chữ ký giữa chừng.
 */
export function validateDeploymentGraph(state: ArchWorkspaceState): ArchTagViolation[] {
  const { projects, rawDependencies } = state;
  const violations: ArchTagViolation[] = [];

  // (0) Vị trí ⇔ tag. Phải chạy trước (1): một project trong `deploys/` mà
  // không mang `type:deployment` bị bỏ qua bởi mọi lượt bên dưới, và chỉ lượt
  // này nhìn thấy được nó.
  violations.push(...validateDeploymentPlacement(projects));

  // (1) Prerequisite nền tảng.
  for (const project of deploymentConsumerNodes(projects)) {
    if (project.dependencies.includes(PLATFORM_DEPLOY_PROJECT)) continue;
    violations.push({
      project: project.name,
      kind: 'missing-platform-dependency',
      detail: `${DEPLOYMENT_TYPE} must depend on ${PLATFORM_DEPLOY_PROJECT}`,
    });
  }

  // (3) Target không tồn tại — đọc edge chưa lọc.
  violations.push(...findDanglingDeploymentRefs(rawDependencies ?? new Map(), projects));

  // (2) Acyclicity trên TẬP CON deployment: cả hai đầu edge đều `type:deployment`.
  // Edge deployment → contracts không tạo được chu trình với node deployment
  // khác, nên việc lọc cả hai đầu không bỏ sót chu trình nào mà lại giữ đồ thị
  // kiểm tra thuần về tầng deployment.
  const deployNames = [...projects.values()]
    .filter((p) => p.tags.includes(DEPLOYMENT_TYPE))
    .map((p) => p.name);
  const deploySet = new Set(deployNames);
  const edges = new Map<string, readonly string[]>();
  for (const name of deployNames) {
    edges.set(
      name,
      (projects.get(name)?.dependencies ?? []).filter((dep) => deploySet.has(dep)),
    );
  }

  for (const cycle of findCycles(edges)) {
    violations.push({
      project: cycle[0],
      kind: 'deploy-graph-cycle',
      detail: cycle.join(' -> '),
    });
  }

  // (4) Không edge giữa hai deployment unit khác nhau. `type:deployment` nằm
  // trong `onlyDependOnLibsWithTags` của `.oxlintrc.json` nên constraint đó
  // CHẤP NHẬN `a-deploy → b-deploy`, trong khi `05-code-architecture.md` nói
  // `platform-deploy` là hướng phụ thuộc được phép duy nhất giữa các deployment
  // project. Lượt này chọn phía tài liệu: một deployment unit phụ thuộc unit
  // khác là cách duy nhất để hai stack Pulumi trở thành một chu trình lifecycle.
  violations.push(...findCrossUnitDeploymentEdges(projects));

  return violations;
}

/**
 * (4) Cấm edge giữa hai deployment unit khác nhau.
 *
 * Một vi phạm cho mỗi edge `a → b` với cả hai node `type:deployment` và
 * `b !== platform-deploy`: `platform-deploy` là prerequisite nên được phép,
 * mọi target deployment còn lại thì không.
 */
function findCrossUnitDeploymentEdges(projects: Map<string, ArchProjectNode>): ArchTagViolation[] {
  const violations: ArchTagViolation[] = [];
  for (const project of projects.values()) {
    if (!project.tags.includes(DEPLOYMENT_TYPE)) continue;
    for (const dep of project.dependencies) {
      const target = projects.get(dep);
      if (!target?.tags.includes(DEPLOYMENT_TYPE)) continue;
      if (dep === PLATFORM_DEPLOY_PROJECT) continue;
      violations.push({
        project: project.name,
        kind: 'cross-unit-deploy-dependency',
        detail: `${project.name} -> ${dep}: only ${PLATFORM_DEPLOY_PROJECT} may be the target of an edge deployment`,
      });
    }
  }
  return violations;
}

/**
 * (0) Bất biến vị trí ⇔ tag, hai chiều.
 *
 * - Project đặt trong `deploys/` mà thiếu `type:deployment` sẽ đi vòng qua mọi
 *   lượt kiểm deployment, nên `deploys/` chỉ còn là quy ước đặt tên chứ không
 *   phải lớp chuẩn có ràng buộc.
 * - Project mang `type:deployment` mà đặt ngoài `deploys/` thì tầng deployment
 *   lan sang project khác, phá đúng ranh giới mà task này dựng ra.
 *
 * Một chiều không đủ: chiều nào thiếu thì vi phạm tương ứng lọt qua.
 */
function validateDeploymentPlacement(projects: Map<string, ArchProjectNode>): ArchTagViolation[] {
  const violations: ArchTagViolation[] = [];
  for (const project of projects.values()) {
    const inDeploys = project.root?.startsWith(`${DEPLOYMENT_DIR}/`) ?? false;
    const tagged = project.tags.includes(DEPLOYMENT_TYPE);
    if (inDeploys && !tagged) {
      violations.push({
        project: project.name,
        kind: 'misplaced-deployment-project',
        detail: `a project inside ${DEPLOYMENT_DIR}/ must carry ${DEPLOYMENT_TYPE}`,
      });
    } else if (tagged && !inDeploys) {
      violations.push({
        project: project.name,
        kind: 'misplaced-deployment-project',
        detail: `${DEPLOYMENT_TYPE} must be placed inside ${DEPLOYMENT_DIR}/`,
      });
    }
  }
  return violations;
}

/**
 * Chu trình trong đồ thị có hướng, mỗi chu trình chỉ báo một lần.
 *
 * DFS ba màu (white chưa thăm / grey đang trong stack / black xong): gặp cạnh
 * về node grey nghĩa là đã đi trên cạnh đó rồi quay lại — đường từ node grey
 * trong stack tới đích là một chu trình thật, đủ điều kiện báo với đường dẫn
 * cụ thể thay vì chỉ "có chu trình".
 *
 * Không dùng bộ đếm in/out (Kahn): Kahn chỉ cho biết CÓ chu trình chứ không
 * cho biết chu trình nào, mà báo cáo arch-check cần đường dẫn để người đọc
 * biết sửa chỗ nào. Node đen được bỏ qua nên mỗi back-edge sinh đúng một báo
 * cáo, không nhân bản theo số đường vào cùng một chu trình.
 */
function findCycles(edges: ReadonlyMap<string, readonly string[]>): string[][] {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (node: string): void => {
    color.set(node, GREY);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const state = color.get(next) ?? WHITE;
      if (state === GREY) {
        cycles.push([...stack.slice(stack.indexOf(next)), next]);
      } else if (state === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };

  for (const node of edges.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) visit(node);
  }
  return cycles;
}

/**
 * Chạy đủ các lượt trên toàn workspace, trả mọi vi phạm (rỗng = sạch).
 *
 * Chỉ gồm các lượt thuần trên project graph — lượt deployment map đọc thêm
 * ĐĨA (apps/, marker trong deploys, command của nx target) nên nó được nối
 * vào ở `main()`: một state tổng hợp trong unit test không mang dữ liệu đĩa,
 * và chạy lượt đĩa trên state đó sẽ báo lỗi ảo cho dữ liệu thật của repo.
 */
export function validateArchitecture(state: ArchWorkspaceState): ArchTagViolation[] {
  const violations: ArchTagViolation[] = [];
  for (const project of state.projects.values()) {
    violations.push(...validateTagSchema(project));
    violations.push(...validateRuntimeCompat(project, state.projects));
  }
  violations.push(...validateDeploymentGraph(state));
  violations.push(...validateContractEdgeOwnership(state.projects));
  violations.push(...validateLlmBoundaries(state.projects));
  return violations;
}

/** Điểm vào CLI: exit 1 kèm danh sách vi phạm nếu workspace lệch schema. */
export function main(): number {
  let state: ReturnType<typeof collectWorkspaceState>;
  try {
    state = collectWorkspaceState();
  } catch (error) {
    if (error instanceof GraphInconsistencyError) {
      console.error(`[graph-inconsistent] ${error.message}`);
      console.error('architecture tag validation failed: Nx project graph is inconsistent');
      return 1;
    }
    throw error; // lỗi môi trường (nx crash, JSON hỏng) — để stacktrace gốc lộ ra
  }
  const violations = validateArchitecture(state);
  // Lượt deployment map đọc thêm ĐĨA (apps/, marker deploys/*/package.json,
  // command của nx target) — nối ở CLI chứ không trong `validateArchitecture`:
  // state tổng hợp của unit test không mang dữ liệu đĩa, chạy lượt đĩa trên
  // state đó sẽ báo lỗi ảo. Lỗi I/O đĩa để nổ ra thay vì nuốt thành "workspace
  // sạch": fail-closed theo đúng hợp đồng arch-check.
  violations.push(...validateDeploymentMap({ projects: state.projects }));
  // Lượt test-target đọc thêm ĐĨA trong project root app/lib (vitest config,
  // package.json, nội dung spec file) — cùng lý do lượt deployment map: state
  // tổng hợp của unit test không mang dữ liệu đĩa. Lỗi I/O đĩa nổ ra thay vì
  // nuốt thành "workspace sạch" — fail-closed theo đúng hợp đồng arch-check.
  violations.push(...validateTestTargets({ projects: state.projects }));
  // Allowlist của lượt LLM chỉ có nghĩa trên workspace thật — state tổng hợp
  // trong unit test không chứa đủ project nên sẽ báo entry chết giả.
  violations.push(...validateLlmEdgeAllowlist(state.projects));
  if (violations.length === 0) {
    console.log(
      `architecture checks OK (${state.projects.size} projects, ` +
        `deployment map + markers + target refs + test targets validated)`,
    );
    return 0;
  }
  for (const v of violations) {
    console.error(`[${v.kind}] ${v.project}: ${v.detail}`);
  }
  console.error(`architecture tag validation failed: ${violations.length} violation(s)`);
  return 1;
}
