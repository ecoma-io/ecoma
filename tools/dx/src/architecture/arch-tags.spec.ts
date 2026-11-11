import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ARCH_TAG_DIMENSIONS,
  buildWorkspaceState,
  CONTRACT_EDGE_OWNERSHIP,
  DEPLOYMENT_DIR,
  DEPLOYMENT_TYPE,
  findDanglingDeploymentRefs,
  GraphInconsistencyError,
  KNOWN_SCOPES,
  LEGACY_TAG_VALUES,
  type ArchProjectNode,
  type ArchWorkspaceState,
  PLATFORM_DEPLOY_PROJECT,
  RUNTIME_COMPAT,
  validateArchitecture,
  validateContractEdgeOwnership,
  validateDeploymentGraph,
  validateRuntimeCompat,
  validateTagSchema,
} from './arch-tags.js';
import { ROOT_DIR } from '../utils.js';

/** Dựng node test tối thiểu; tags mặc định đủ schema để test tập trung vào một khía cạnh. */
function node(name: string, tags?: string[], deps: string[] = []): ArchProjectNode {
  return {
    name,
    tags: tags ?? ['scope:public', 'type:domain', 'runtime:universal'],
    dependencies: deps,
  };
}

/**
 * Tag triple của một project deployment: scope thuộc KNOWN_SCOPES sẵn có.
 *
 * `root` đặt trong `deploys/` vì bất biến vị trí ⇔ tag kiểm đúng điều đó; node
 * không có `root` sẽ bị báo `misplaced-deployment-project`.
 */
function deployNode(name: string, scope: string, deps: string[] = []): ArchProjectNode {
  return {
    ...node(name, [`scope:${scope}`, DEPLOYMENT_TYPE, 'runtime:native'], deps),
    root: `${DEPLOYMENT_DIR}/${name}`,
  };
}

/** Workspace state cho tầng deployment: 1 platform + n app deploy đều dựa vào nó. */
function deployState(apps: readonly string[]): ArchWorkspaceState {
  const nodes = [
    deployNode(PLATFORM_DEPLOY_PROJECT, 'platform'),
    ...apps.map((name) => deployNode(name, 'platform', [PLATFORM_DEPLOY_PROJECT])),
  ];
  return { projects: new Map(nodes.map((n) => [n.name, n])) };
}

/** Node messaging composition chuẩn — hình thật của transactional-mail. */
function messagingApp(deps: string[]): ArchProjectNode {
  return node('mail-app', ['scope:messaging', 'type:composition', 'runtime:edge'], deps);
}

/** Node contracts chuẩn cho lượt kiểm contract-edge. */
function contractsNode(name: string, scope: string): ArchProjectNode {
  return node(name, [`scope:${scope}`, 'type:contracts', 'runtime:universal']);
}

describe('validateTagSchema', () => {
  it('passes a project carrying exactly one tag per dimension', () => {
    expect(
      validateTagSchema(node('a', ['scope:public', 'type:domain', 'runtime:universal'])),
    ).toEqual([]);
  });

  it('leaves non-architecture tags such as npm:private alone', () => {
    expect(
      validateTagSchema(node('a', ['npm:private', 'scope:public', 'type:domain', 'runtime:edge'])),
    ).toEqual([]);
  });

  it('reports a missing dimension', () => {
    const violations = validateTagSchema(node('a', ['scope:public', 'runtime:edge']));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'missing-dimension', detail: 'type' });
  });

  it('reports a duplicate dimension tag', () => {
    const violations = validateTagSchema(
      node('a', ['scope:public', 'scope:shared', 'type:domain', 'runtime:edge']),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'duplicate-dimension' });
  });

  it('rejects a type value outside the allowlist', () => {
    const violations = validateTagSchema(
      node('a', ['scope:public', 'type:widget', 'runtime:edge']),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'invalid-value', detail: 'type:widget' });
  });

  it('accepts the deployment type with an existing scope', () => {
    // Tầng deployment dùng scope ĐANG CÓ (`platform` cho tầng nền, scope nghiệp
    // vụ cho app deploy) — không sinh dimension scope mới. Scope lạ thì vẫn phải
    // bị bắt, nên test này khẳng định cả hai vế: triple hợp lệ sạch, triple
    // cùng scope đó nhưng type sai bị chặn.
    expect(
      validateTagSchema(
        node(PLATFORM_DEPLOY_PROJECT, ['scope:platform', DEPLOYMENT_TYPE, 'runtime:native']),
      ),
    ).toEqual([]);
    expect(
      validateTagSchema(
        node('account-deploy', ['scope:account', DEPLOYMENT_TYPE, 'runtime:native']),
      ),
    ).toEqual([]);

    const typo = validateTagSchema(
      node('account-deploy', ['scope:account', 'type:deploy', 'runtime:native']),
    );
    expect(typo).toHaveLength(1);
    expect(typo[0]).toMatchObject({ kind: 'invalid-value', detail: 'type:deploy' });
  });

  it('rejects a runtime value outside the allowlist', () => {
    const violations = validateTagSchema(
      node('a', ['scope:public', 'type:domain', 'runtime:serverless']),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'invalid-value', detail: 'runtime:serverless' });
  });

  it('rejects a scope outside KNOWN_SCOPES', () => {
    const violations = validateTagSchema(
      node('a', ['scope:mystery', 'type:domain', 'runtime:edge']),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'unknown-scope', detail: 'scope:mystery' });
  });

  it.each(LEGACY_TAG_VALUES)('rejects legacy tag %s', (legacy) => {
    // Legacy tag thay thế đúng tag dimension mà nó lấn sân, để lỗi duy nhất
    // được báo là legacy-value chứ không phải duplicate-dimension.
    const replaces =
      legacy === 'type:infras'
        ? 'type:domain'
        : legacy.startsWith('type:')
          ? 'type:domain'
          : legacy === 'runtime:node'
            ? 'runtime:universal'
            : null; // layer:* lấn sân dimension không tồn tại — chỉ thêm vào
    const tags = replaces
      ? ['scope:public', replaces, 'runtime:universal'].map((t) => (t === replaces ? legacy : t))
      : ['scope:public', 'type:domain', 'runtime:universal', legacy];
    const violations = validateTagSchema(node('a', tags));
    expect(violations.filter((v) => v.kind === 'legacy-value').map((v) => v.detail)).toContain(
      legacy,
    );
  });

  it('rejects layer tags by PREFIX, not by an enumerated value', () => {
    // Dimension `layer` đã bị xoá khỏi taxonomy: giá trị nào mang prefix đó cũng
    // là di tích. `layer:widget` không nằm trong LEGACY_TAG_VALUES — nếu validator
    // chỉ chặn theo danh sách cứng thì nó đi qua guard dimension lặng lẽ.
    const violations = validateTagSchema(
      node('a', ['scope:public', 'type:domain', 'runtime:universal', 'layer:widget']),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'legacy-value', detail: 'layer:widget' });

    // Cùng cơ chế với value khác chưa từng tồn tại trong repo.
    const other = validateTagSchema(
      node('a', ['scope:public', 'type:domain', 'runtime:universal', 'layer:everything']),
    );
    expect(other.map((v) => v.detail)).toContain('layer:everything');
  });

  it('reports layer:widget from validateArchitecture on a full workspace state', () => {
    // Cùng đường vào như arch-check: validateArchitecture trên state đủ project.
    const bad = node('bad', ['scope:public', 'type:domain', 'runtime:universal', 'layer:widget']);
    const good = node('good', ['scope:public', 'type:domain', 'runtime:universal']);
    const violations = validateArchitecture({
      projects: new Map([
        [bad.name, bad],
        [good.name, good],
      ]),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ project: 'bad', kind: 'legacy-value' });
  });

  it.each(['toString', 'constructor', 'hasOwnProperty'])(
    'ignores prototype key %s like any non-architecture tag, never a TypeError',
    (prototypeKey) => {
      // `dim:value` với dim là tên property của `Object.prototype`: guard
      // dimension phải dùng own-property check. Với `in`, tag này đi QUA guard
      // (key có trên prototype chain), rồi lookup allowlist trả về hàm thừa kế
      // từ `Object.prototype` — `allowed.includes` nổ TypeError giữa chừng thay
      // vì bỏ qua có kiểm như `npm:private`. Sau fix, hành vi đúng thiết kế:
      // tag ngoài ba dimension bị bỏ qua lặng lẽ, arch-check không sập.
      const violations = validateTagSchema(
        node('a', ['scope:public', 'type:domain', 'runtime:universal', `${prototypeKey}:x`]),
      );
      expect(violations).toEqual([]);
    },
  );

  it('ignores prototype key toString through validateArchitecture end to end', () => {
    const bad = node('bad', ['scope:public', 'type:domain', 'runtime:universal', 'toString:x']);
    const good = node('good', ['scope:public', 'type:domain', 'runtime:universal']);
    const violations = validateArchitecture({
      projects: new Map([
        [bad.name, bad],
        [good.name, good],
      ]),
    });
    expect(violations).toEqual([]);
  });
});

describe('validateRuntimeCompat', () => {
  it('allows an edge project to depend on edge and universal projects', () => {
    const edge = node('app', ['scope:public', 'type:composition', 'runtime:edge'], ['u', 'e']);
    const projects = new Map(
      [
        edge,
        node('u', ['scope:public', 'type:domain', 'runtime:universal']),
        node('e', ['scope:public', 'type:domain', 'runtime:edge']),
      ].map((n) => [n.name, n]),
    );
    expect(validateRuntimeCompat(edge, projects)).toEqual([]);
  });

  it('blocks an edge project from depending on a native project', () => {
    const edge = node('app', ['scope:public', 'type:composition', 'runtime:edge'], ['cli']);
    const projects = new Map(
      [edge, node('cli', ['scope:local', 'type:tooling', 'runtime:native'])].map((n) => [
        n.name,
        n,
      ]),
    );
    const violations = validateRuntimeCompat(edge, projects);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'runtime-compat' });
    expect(violations[0].detail).toContain('runtime:edge depends on cli (runtime:native)');
  });

  it('allows a deployment project to depend on a composition app across runtimes (packaging edge, not an import)', () => {
    // deploy unit build/mount app edge vào container native của mình (Dockerfile
    // COPY, dist mount, WIC) — hai process không import nhau lúc runtime, nên
    // ma trận runtime không áp cho edge đóng gói này. Carve-out CHỈ cho
    // deployment: một composition khác vẫn bị chặn như thường.
    const deploy = node('x-deploy', ['scope:public', 'type:deployment', 'runtime:native'], ['app']);
    const projects = new Map(
      [
        deploy,
        node('app', ['scope:public', 'type:composition', 'runtime:edge']),
        node('lib', ['scope:public', 'type:domain', 'runtime:edge']),
      ].map((n) => [n.name, n]),
    );
    expect(validateRuntimeCompat(deploy, projects)).toEqual([]);
  });

  it('still blocks a non-deployment project from depending on a composition app across runtimes', () => {
    // Carve-out không phải lỗ: composition → composition lệch runtime vẫn là
    // import thật (SSR render, lib import) và vẫn bị ma trận chặn.
    const server = node('app', ['scope:public', 'type:composition', 'runtime:native'], ['spa']);
    const projects = new Map(
      [server, node('spa', ['scope:public', 'type:composition', 'runtime:edge'])].map((n) => [
        n.name,
        n,
      ]),
    );
    const violations = validateRuntimeCompat(server, projects);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'runtime-compat' });
  });

  it('blocks a universal project from depending on an edge project', () => {
    // universal là cam kết tương thích hai chiều: dependency edge-only của lib
    // universal sẽ khoá lib vào edge, phá chính cam kết đó.
    const uni = node('lib', ['scope:public', 'type:domain', 'runtime:universal'], ['edgeLib']);
    const projects = new Map(
      [uni, node('edgeLib', ['scope:public', 'type:domain', 'runtime:edge'])].map((n) => [
        n.name,
        n,
      ]),
    );
    const violations = validateRuntimeCompat(uni, projects);
    expect(violations).toHaveLength(1);
    expect(violations[0].detail).toContain('runtime:universal depends on edgeLib (runtime:edge)');
  });

  it('blocks a universal project from depending on a native project', () => {
    const uni = node('lib', ['scope:public', 'type:domain', 'runtime:universal'], ['cli']);
    const projects = new Map(
      [uni, node('cli', ['scope:local', 'type:tooling', 'runtime:native'])].map((n) => [n.name, n]),
    );
    expect(validateRuntimeCompat(uni, projects)).toHaveLength(1);
  });

  it('blocks a browser project from depending on a native project', () => {
    const browser = node('spa', ['scope:public', 'type:composition', 'runtime:browser'], ['cli']);
    const projects = new Map(
      [browser, node('cli', ['scope:local', 'type:tooling', 'runtime:native'])].map((n) => [
        n.name,
        n,
      ]),
    );
    expect(validateRuntimeCompat(browser, projects)).toHaveLength(1);
  });

  it('does not double-report when the project itself is missing a runtime tag', () => {
    const orphan = node('app', ['scope:public', 'type:composition'], ['u']);
    const projects = new Map(
      [orphan, node('u', ['scope:public', 'type:domain', 'runtime:universal'])].map((n) => [
        n.name,
        n,
      ]),
    );
    expect(validateRuntimeCompat(orphan, projects)).toEqual([]);
  });

  it.each(['constructor', 'toString'])(
    'skips runtime-compat for prototype key runtime:%s without throwing',
    (prototypeKey) => {
      // `runtime:<prototype-key>` không thuộc allowlist (lượt 1 báo
      // invalid-value); lượt 2 phải bỏ qua bằng own-property check — lookup
      // qua prototype chain trả về hàm thừa kế làm `allowed` rồi
      // `allowed.includes` nổ TypeError giữa vòng validate.
      const app = node(
        'app',
        ['scope:public', 'type:composition', `runtime:${prototypeKey}`],
        ['u'],
      );
      const projects = new Map(
        [app, node('u', ['scope:public', 'type:domain', 'runtime:universal'])].map((n) => [
          n.name,
          n,
        ]),
      );
      expect(validateRuntimeCompat(app, projects)).toEqual([]);
    },
  );

  it('matches the documented compatibility matrix shape', () => {
    // Runtime cụ thể phụ thuộc được chính nó + universal; universal chỉ được
    // phụ thuộc universal — đúng nghĩa cam kết tương thích hai chiều.
    // (Sắp trước để assertion không nằm trong nhánh if — no-conditional-expect.)
    const specific = Object.entries(RUNTIME_COMPAT).filter(([source]) => source !== 'universal');
    expect(specific.length).toBe(3);
    for (const [source, targets] of specific) {
      expect(new Set(targets)).toEqual(new Set([source, 'universal']));
    }
    expect(RUNTIME_COMPAT.universal).toEqual(['universal']);
  });
});

describe('validateArchitecture', () => {
  it('aggregates schema and runtime violations across projects', () => {
    const bad = node('bad', ['scope:public', 'type:composition'], ['good']);
    const good = node('good', ['scope:public', 'type:domain', 'runtime:universal']);
    const violations = validateArchitecture({
      projects: new Map([
        [bad.name, bad],
        [good.name, good],
      ]),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ project: 'bad', kind: 'missing-dimension' });
  });

  it('returns empty for a consistent workspace', () => {
    const a = node('a', ['scope:llm-consumer', 'type:composition', 'runtime:edge'], ['b']);
    const b = node('b', ['scope:llm-consumer', 'type:contracts', 'runtime:universal']);
    const violations = validateArchitecture({
      projects: new Map([
        [a.name, a],
        [b.name, b],
      ]),
    });
    expect(violations).toEqual([]);
  });
});

/** Graph Nx tối thiểu đủ cho buildWorkspaceState: nodes + dependencies theo source. */
function fakeGraph(nodes: Record<string, { tags?: string[] }>, edges: [string, string][]) {
  const dependencies: Record<string, { target: string }[]> = {};
  for (const [source, target] of edges) {
    (dependencies[source] ??= []).push({ target });
  }
  return {
    nodes: Object.fromEntries(Object.entries(nodes).map(([name, data]) => [name, { name, data }])),
    dependencies,
  };
}

/** Bắt exception để assert trên nó ngoài nhánh catch (no-conditional-expect). */
function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined; // caller phải assert là GraphInconsistencyError — sẽ fail rõ
}

describe('buildWorkspaceState (graph consistency, fail-closed)', () => {
  it('accepts a consistent workspace/project graph', () => {
    const projects = buildWorkspaceState(
      ['a', 'b'],
      fakeGraph({ a: { tags: ['scope:shared'] }, b: {} }, [['a', 'b']]),
    );
    expect(projects.size).toBe(2);
    expect(projects.get('a')?.tags).toContain('scope:shared');
    expect(projects.get('a')?.dependencies).toEqual(['b']);
  });

  it('fails and names the project missing from the graph', () => {
    // truth = `nx show projects`; graph thiếu 'ghost' → phải fail, không skip.
    const error = capture(() => buildWorkspaceState(['a', 'ghost'], fakeGraph({ a: {} }, [])));
    expect(error).toBeInstanceOf(GraphInconsistencyError);
    const inconsistent = error as GraphInconsistencyError;
    expect(inconsistent.missingProjects).toEqual(['ghost']);
    expect(inconsistent.message).toContain('ghost');
  });

  it('diagnoses every missing project when several are absent', () => {
    const error = capture(() =>
      buildWorkspaceState(['a', 'ghost1', 'ghost2'], fakeGraph({ a: {} }, [])),
    );
    expect(error).toBeInstanceOf(GraphInconsistencyError);
    const inconsistent = error as GraphInconsistencyError;
    expect(new Set(inconsistent.missingProjects)).toEqual(new Set(['ghost1', 'ghost2']));
    expect(inconsistent.message).toContain('ghost1');
    expect(inconsistent.message).toContain('ghost2');
  });

  it('does not treat external/package dependency targets as missing projects', () => {
    // npm package chỉ xuất hiện trong `dependencies`, không trong `nodes` —
    // lọc edges là hành vi đúng, không phải lệch graph (ngược lại với project
    // thật bị thiếu node, test phía trên).
    const projects = buildWorkspaceState(
      ['a', 'b'],
      fakeGraph({ a: {}, b: {} }, [
        ['a', 'npm:lodash'],
        ['a', 'b'],
      ]),
    );
    expect(projects.get('a')?.dependencies).toEqual(['b']);
  });
});

/**
 * Đọc `.oxlintrc.json` là JSONC (oxlint/oxfmt chấp nhận comment) — parse bằng
 * jsonc-parser mà nx đã mang vào tree, truy qua createRequire từ context của
 * nx để không phải thêm dependency mới vào package.json.
 */
function readOxlintConfig(): {
  rules: Record<string, [number, Record<string, unknown>]>;
} {
  const req = createRequire(resolve(ROOT_DIR, 'node_modules/nx/package.json'));
  const jsoncParse: (text: string) => unknown = req('jsonc-parser').parse;
  const raw = readFileSync(resolve(ROOT_DIR, '.oxlintrc.json'), 'utf8');
  return jsoncParse(raw) as { rules: Record<string, [number, Record<string, unknown>]> };
}

/** Mảng depConstraints của @nx/enforce-module-boundaries, đã parse thật. */
function readDepConstraints(): readonly Record<string, unknown>[] {
  const config = readOxlintConfig();
  const rule = config.rules['@nx/enforce-module-boundaries'];
  if (!Array.isArray(rule) || rule.length < 2) {
    throw new Error('@nx/enforce-module-boundaries is not configured in .oxlintrc.json');
  }
  const options = rule[1] as { depConstraints?: Record<string, unknown>[] };
  if (!Array.isArray(options.depConstraints)) {
    throw new Error('depConstraints missing from @nx/enforce-module-boundaries options');
  }
  return options.depConstraints;
}

/** Các constraint match theo `sourceTag` đơn (không phải allSourceTags combo). */
function scopeSourceConstraints(): Map<string, readonly string[]> {
  const bySource = new Map<string, readonly string[]>();
  for (const constraint of readDepConstraints()) {
    if (typeof constraint.sourceTag !== 'string') continue;
    if (!constraint.sourceTag.startsWith('scope:')) continue;
    const targets = constraint.onlyDependOnLibsWithTags;
    if (!Array.isArray(targets)) continue;
    bySource.set(constraint.sourceTag, targets as readonly string[]);
  }
  return bySource;
}

/** Helper của @nx/eslint-plugin (đang cài) để test HÀNH VI constraint thật. */
async function pluginConstraintHelpers(): Promise<{
  findConstraintsFor: (
    constraints: readonly Record<string, unknown>[],
    source: { data: { tags: string[] } },
  ) => readonly Record<string, unknown>[];
  hasNoneOfTheseTags: (proj: { data: { tags: string[] } }, tags: readonly string[]) => boolean;
  findDependenciesWithTags: (
    target: { name: string; data: { tags: string[] } },
    tags: readonly string[],
    graph: unknown,
  ) => unknown[][];
}> {
  const req = createRequire(resolve(ROOT_DIR, 'node_modules/nx/package.json'));
  const pluginPkg = req.resolve('@nx/eslint-plugin/package.json');
  const utilsPath = createRequire(pluginPkg).resolve('./dist/src/utils/runtime-lint-utils.js');
  return (await import(utilsPath)) as never;
}

/** Allowlist scope constraint mà engine thật sẽ áp cho một source tags cụ thể. */
async function scopeAllowlistFor(sourceTags: string[]): Promise<readonly string[]> {
  const { findConstraintsFor } = await pluginConstraintHelpers();
  const matched = findConstraintsFor(readDepConstraints(), { data: { tags: sourceTags } });
  const scope = matched.find(
    (c) => typeof c.sourceTag === 'string' && c.sourceTag.startsWith('scope:'),
  );
  expect(scope, `no scope constraint matches source tags ${sourceTags.join(',')}`).toBeDefined();
  return (scope?.onlyDependOnLibsWithTags ?? []) as readonly string[];
}

/** hasNoneOfTheseTags qua engine thật: false = được phép, true = bị cấm. */
async function edgeAllowed(sourceTags: string[], targetTags: string[]): Promise<boolean> {
  const { hasNoneOfTheseTags } = await pluginConstraintHelpers();
  return !hasNoneOfTheseTags({ data: { tags: targetTags } }, await scopeAllowlistFor(sourceTags));
}

/**
 * Đánh giá cạnh direct A→B qua MỌI constraint khớp source, đúng ngữ nghĩa
 * conjunctive của rule (`findConstraintsFor` trả tất cả constraint khớp; một
 * cái fail là report). `notDependOn*` là transitive nên cần graph thật tối
 * thiểu: findDependenciesWithTags đếm cả self (pathExists(A,A)=true) — target
 * mang tag cấm là đủ báo violation mà không cần node trung gian.
 */
async function directEdgeViolations(sourceTags: string[], targetTags: string[]): Promise<string[]> {
  const { findConstraintsFor, hasNoneOfTheseTags, findDependenciesWithTags } =
    await pluginConstraintHelpers();
  const source = { name: 'a', data: { tags: sourceTags } };
  const target = { name: 'b', data: { tags: targetTags } };
  const graph = {
    nodes: { a: source, b: target },
    dependencies: { a: [{ source: 'a', target: 'b' }] },
  };
  const violations: string[] = [];
  for (const constraint of findConstraintsFor(readDepConstraints(), source)) {
    const only = constraint.onlyDependOnLibsWithTags;
    if (Array.isArray(only) && only.length > 0 && hasNoneOfTheseTags(target, only as string[])) {
      violations.push(`onlyDependOn [${(only as string[]).join(',')}]`);
    }
    const not = constraint.notDependOnLibsWithTags;
    if (Array.isArray(not) && not.length > 0) {
      const paths = findDependenciesWithTags(target, not as string[], graph);
      if (paths.length > 0) {
        violations.push(`notDependOn [${(not as string[]).join(',')}]`);
      }
    }
  }
  return violations;
}

describe('validateContractEdgeOwnership', () => {
  it('blocks a messaging dependency on another business context contracts', () => {
    // Hình regression thật: transactional-mail từng import identity-auth-contracts
    // (lib đã xoá ở issue #324) để dùng protocol HMAC nội bộ — chéo BC
    // qua wildcard
    // `type:contracts` của allowlist lint (OR-match theo tag, không nhìn scope
    // của target). Edge này phải bị bắt ở mức graph. Tên project trong fixture chỉ là
    // định danh tổng hợp — không cần khớp một project thật trên đĩa; scope
    // `account` đại diện cho scope BC nghiệp vụ khác của messaging.
    const state: ArchWorkspaceState = {
      projects: new Map([
        [messagingApp(['account-contracts']).name, messagingApp(['account-contracts'])],
        ['account-contracts', contractsNode('account-contracts', 'account')],
      ]),
    };
    const violations = validateContractEdgeOwnership(state.projects);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      project: 'mail-app',
      kind: 'cross-context-contract-edge',
    });
    expect(violations[0].detail).toContain('scope:account');
  });

  it('allows messaging dependencies on its own contracts and platform contracts', () => {
    const own = messagingApp(['mail-contracts', 'platform-auth-contracts']);
    const state: ArchWorkspaceState = {
      projects: new Map([
        [own.name, own],
        ['mail-contracts', contractsNode('mail-contracts', 'messaging')],
        ['platform-auth-contracts', contractsNode('platform-auth-contracts', 'platform')],
      ]),
    };
    expect(validateContractEdgeOwnership(state.projects)).toEqual([]);
  });

  it('ignores non-contracts dependencies and scopes without an ownership entry', () => {
    // Scope chưa có chính sách riêng không bị lượt này kiểm, và non-contracts
    // deps của messaging vẫn thuộc các lượt khác — lượt này chỉ nói contract-edge.
    const app = node(
      'some-app',
      ['scope:account', 'type:composition', 'runtime:edge'],
      ['any-contracts', 'some-shared-lib'],
    );
    const msgWithImplDep = messagingApp(['platform-shared-lib']);
    const state: ArchWorkspaceState = {
      projects: new Map([
        [app.name, app],
        [msgWithImplDep.name, msgWithImplDep],
        ['any-contracts', contractsNode('any-contracts', 'messaging')],
        [
          'platform-shared-lib',
          node('platform-shared-lib', [
            'scope:platform',
            'type:infrastructure',
            'runtime:universal',
          ]),
        ],
      ]),
    };
    expect(validateContractEdgeOwnership(state.projects)).toEqual([]);
  });

  it('keeps .oxlintrc.json unable to reopen the cross-context edge for messaging', async () => {
    // Hai lớp phải khớp nhau: constraint lint của scope:messaging KHÔNG được chứa
    // `type:contracts` (OR-match sẽ cho mọi contract chéo scope đi qua), còn
    // validator graph ở trên chặn theo scope thật của target. Nếu ai thêm lại
    // wildcard vào allowlist lint thì test này đỏ — chính là chỗ từng lọt.
    const allowlist = (await scopeAllowlistFor(['scope:messaging', 'type:composition'])).filter(
      (t) => t !== 'scope:messaging',
    );
    expect(allowlist).not.toContain('type:contracts');
    expect(allowlist).toEqual(expect.arrayContaining(['scope:shared', 'scope:platform']));
  });
});

describe('validateDeploymentGraph', () => {
  it('requires every deployment consumer to depend on platform-deploy', () => {
    // Không phụ thuộc tầng nền = project provision không kế thừa được gì từ
    // platform. Không có dep nào cả vẫn hợp lệ với mọi depConstraint, nên đây là
    // lý do cần một validator riêng chứ không dựa vào `.oxlintrc.json`.
    const orphan = deployNode('account-deploy', 'account');
    const platform = deployNode(PLATFORM_DEPLOY_PROJECT, 'platform');
    const violations = validateDeploymentGraph({
      projects: new Map([
        [platform.name, platform],
        [orphan.name, orphan],
      ]),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      project: 'account-deploy',
      kind: 'missing-platform-dependency',
    });
    expect(violations[0].detail).toContain(PLATFORM_DEPLOY_PROJECT);
  });

  it('exempts platform-deploy itself from the prerequisite rule', () => {
    // platform-deploy là tầng nền: nó không thể phụ thuộc chính nó, nên nếu
    // không miễn trừ thì mọi workspace có tầng deployment đều báo lỗi ngay từ
    // project gốc của tầng.
    const platform = deployNode(PLATFORM_DEPLOY_PROJECT, 'platform');
    const state = { projects: new Map([[platform.name, platform]]) };
    expect(validateDeploymentGraph(state)).toEqual([]);
    // Miễn trừ đúng phạm vi: app deploy VẪN phải dựa vào platform.
    const app = deployNode('home-deploy', 'public');
    expect(
      validateDeploymentGraph({
        projects: new Map([
          [platform.name, platform],
          [app.name, app],
        ]),
      }).map((v) => v.kind),
    ).toEqual(['missing-platform-dependency']);
  });

  it('does not require the prerequisite of a non-deployment project', () => {
    // Rule chỉ áp cho `type:deployment`: một `type:infrastructure` adapter không
    // có lý do gì phải phụ thuộc tầng provisioning.
    const lib = node('platform-cache', ['scope:platform', 'type:infrastructure', 'runtime:edge']);
    const platform = deployNode(PLATFORM_DEPLOY_PROJECT, 'platform');
    expect(
      validateDeploymentGraph({
        projects: new Map([
          [lib.name, lib],
          [platform.name, platform],
        ]),
      }),
    ).toEqual([]);
  });

  it('flags a dependency target that is not a project in the workspace', () => {
    // Dangling ref đã bị `buildWorkspaceState` lọc mất khỏi
    // `ArchProjectNode.dependencies` — nên lượt này đọc `rawDependencies`.
    const app = deployNode('account-deploy', 'account', [PLATFORM_DEPLOY_PROJECT]);
    const platform = deployNode(PLATFORM_DEPLOY_PROJECT, 'platform');
    const violations = validateDeploymentGraph({
      projects: new Map([
        [platform.name, platform],
        [app.name, app],
      ]),
      rawDependencies: new Map([[app.name, [PLATFORM_DEPLOY_PROJECT, 'account-deploy-v2']]]),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      project: 'account-deploy',
      kind: 'invalid-deploy-dependency',
    });
    expect(violations[0].detail).toContain('account-deploy-v2');
  });

  it('treats an npm target outside the workspace as a valid dependency', () => {
    // Pulumi program phụ thuộc `@pulumi/*` là chuyện bình thường; target `npm:*`
    // vốn không phải project nên không được báo dangling.
    const app = deployNode('account-deploy', 'account', [PLATFORM_DEPLOY_PROJECT]);
    const platform = deployNode(PLATFORM_DEPLOY_PROJECT, 'platform');
    const violations = validateDeploymentGraph({
      projects: new Map([
        [platform.name, platform],
        [app.name, app],
      ]),
      rawDependencies: new Map([
        [app.name, [PLATFORM_DEPLOY_PROJECT, 'npm:@pulumi/aws']],
        [platform.name, ['npm:@pulumi/pulumi']],
      ]),
    });
    expect(violations).toEqual([]);
  });

  it('detects a three-node deployment cycle and names the cycle path', () => {
    // A→B→C→A: một kiểm tra chỉ so "A↔B" (đối xứng) sẽ XANH vì không có cặp
    // nào trong ba node này phụ thuộc lẫn nhau trực tiếp. Vòng dài hơn đúng là
    // lý do cần DFS ba màu chứ không phải so sánh cặp.
    const a = deployNode('a-deploy', 'platform', [PLATFORM_DEPLOY_PROJECT, 'b-deploy']);
    const b = deployNode('b-deploy', 'platform', [PLATFORM_DEPLOY_PROJECT, 'c-deploy']);
    const c = deployNode('c-deploy', 'platform', [PLATFORM_DEPLOY_PROJECT, 'a-deploy']);
    const platform = deployNode(PLATFORM_DEPLOY_PROJECT, 'platform');
    const violations = validateDeploymentGraph({
      projects: new Map([
        [platform.name, platform],
        [a.name, a],
        [b.name, b],
        [c.name, c],
      ] as const),
    });
    const cycles = violations.filter((v) => v.kind === 'deploy-graph-cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0].detail).toContain('a-deploy -> b-deploy -> c-deploy -> a-deploy');
    // Chu trình này đồng thời vi phạm bất biến (4): cả ba edge a→b, b→c, c→a đều
    // là edge giữa hai deployment unit khác nhau. Chu trình đã bắt trước, nhưng
    // các edge vẫn phải được báo — nếu im lặng thì chu trình bị gỡ bằng cách
    // thêm edge hợp lệ khác thì lỗi tương lai không ai thấy.
    expect(violations.filter((v) => v.kind === 'cross-unit-deploy-dependency')).toHaveLength(3);
    expect(violations.some((v) => v.kind === 'missing-platform-dependency')).toBe(false);
  });

  it('does not confuse a fan-out to the platform with a cycle', () => {
    // Nhiều app deploy cùng trỏ vào một nền tảng là hình sao (DAG), không phải
    // chu trình — DFS phải đánh dấu node đã xong, không quay lại node đang trong
    // stack.
    expect(validateDeploymentGraph(deployState(['a-deploy', 'b-deploy', 'c-deploy']))).toEqual([]);
  });

  it('does not report a cycle for edges that leave the deployment subgraph', () => {
    // Edge deployment → contracts không tạo được chu trình với node deployment
    // khác; lọc hai đầu không được xoá lỗi thật cũng không được sinh báo giả.
    // `account-contracts` là tên của một project thật, còn node này chỉ là fixture
    // tổng hợp không có dependency nào — không cần khớp graph thật.
    const contracts = node('account-contracts', [
      'scope:account',
      'type:contracts',
      'runtime:universal',
    ]);
    const platform = deployNode(PLATFORM_DEPLOY_PROJECT, 'platform', ['account-contracts']);
    const app = deployNode('account-deploy', 'account', [PLATFORM_DEPLOY_PROJECT]);
    expect(
      validateDeploymentGraph({
        projects: new Map([
          [platform.name, platform],
          [app.name, app],
          [contracts.name, contracts],
        ]),
      }),
    ).toEqual([]);
  });

  it('flags a deployment project that is tagged correctly but placed outside deploys/', () => {
    // Bất biến vị trí ⇔ tag là HAI CHIỀU. Chỉ kiểm chiều "trong `deploys/` phải
    // mang tag" thì một project `type:deployment` đặt ngoài `deploys/` vẫn lọt,
    // và tầng deployment lan sang project không thuộc nhóm.
    const misplaced = deployNode('account-deploy', 'account', [PLATFORM_DEPLOY_PROJECT]);
    const platform = deployNode(PLATFORM_DEPLOY_PROJECT, 'platform');
    const violations = validateDeploymentGraph({
      projects: new Map([
        [platform.name, platform],
        [misplaced.name, { ...misplaced, root: 'libs/account-deploy' }],
      ]),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      project: 'account-deploy',
      kind: 'misplaced-deployment-project',
    });
    expect(violations[0].detail).toContain(DEPLOYMENT_DIR);
  });

  it('flags a project inside deploys/ that is not tagged as a deployment', () => {
    // Đây là lỗ hổng mà chỉ kiểm tag không thấy: project đặt trong `deploys/` mà
    // mang `type:infrastructure` đi vòng qua MỌI lượt kiểm deployment.
    const platform = deployNode(PLATFORM_DEPLOY_PROJECT, 'platform');
    const untagged = {
      ...node('rogue-deploy', ['scope:platform', 'type:infrastructure', 'runtime:native']),
      root: `${DEPLOYMENT_DIR}/rogue-deploy`,
    };
    const violations = validateDeploymentGraph({
      projects: new Map([
        [platform.name, platform],
        [untagged.name, untagged],
      ]),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      project: 'rogue-deploy',
      kind: 'misplaced-deployment-project',
    });
    expect(violations[0].detail).toContain(DEPLOYMENT_TYPE);
  });

  it('accepts a deployment project that sits in deploys/ with the right tag', () => {
    expect(validateDeploymentGraph(deployState(['account-deploy']))).toEqual([]);
  });

  it('rejects a dependency between two deployment units', () => {
    // `type:deployment` nằm trong `onlyDependOnLibsWithTags` của `.oxlintrc.json`
    // nên constraint đó CHO PHÉP `a-deploy → b-deploy`, trong khi tài liệu nói
    // `platform-deploy` là hướng được phép duy nhất. Validator này là nơi
    // phía tài liệu được thực thi.
    const a = deployNode('a-deploy', 'platform', [PLATFORM_DEPLOY_PROJECT, 'b-deploy']);
    const b = deployNode('b-deploy', 'platform', [PLATFORM_DEPLOY_PROJECT]);
    const platform = deployNode(PLATFORM_DEPLOY_PROJECT, 'platform');
    const violations = validateDeploymentGraph({
      projects: new Map([
        [platform.name, platform],
        [a.name, a],
        [b.name, b],
      ]),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      project: 'a-deploy',
      kind: 'cross-unit-deploy-dependency',
    });
  });

  it('still allows the platform edge, which is the one permitted direction', () => {
    // Đối chiếu với test trên: edge TỚI `platform-deploy` là hợp lệ, và đây là
    // hướng duy nhất được phép. Nếu lượt này vô tình chặn luôn platform thì
    // workspace sẽ đỏ, nên phải có test chứng minh chiều đúng vẫn xanh.
    expect(validateDeploymentGraph(deployState(['a-deploy', 'b-deploy']))).toEqual([]);
  });

  it('runs the deployment invariants as part of validateArchitecture', () => {
    // arch-check gọi `validateArchitecture`, không gọi `validateDeploymentGraph`
    // riêng — nếu wiring đứt thì test này xanh trong khi CLI vẫn bỏ sót.
    const orphan = deployNode('account-deploy', 'account');
    const platform = deployNode(PLATFORM_DEPLOY_PROJECT, 'platform');
    const violations = validateArchitecture({
      projects: new Map([
        [platform.name, platform],
        [orphan.name, orphan],
      ]),
    });
    expect(violations.map((v) => v.kind)).toEqual(['missing-platform-dependency']);
  });

  it('exposes the dangling-ref check as its own pure function', () => {
    // Tách riêng vì nó là lượt DUY NHẤT cần edge chưa lọc: unit test gọi trực
    // tiếp hàm này với một tập target tự khai, không cần dựng cả workspace.
    const app = deployNode('account-deploy', 'account');
    const projects = new Map([[app.name, app]]);
    expect(
      findDanglingDeploymentRefs(
        new Map([[app.name, ['typo-deploy', 'npm:@pulumi/aws']]]),
        projects,
      ).map((v) => v.detail),
    ).toEqual(['typo-deploy is not a project in the workspace']);
  });
});

describe('allowlists sync with .oxlintrc.json', () => {
  it('keeps type and runtime allowlists non-empty and disjoint from legacy values', () => {
    for (const dim of ['type', 'runtime'] as const) {
      const allowed = ARCH_TAG_DIMENSIONS[dim] as readonly string[];
      expect(allowed.length).toBeGreaterThan(0);
      for (const value of allowed) {
        expect(LEGACY_TAG_VALUES).not.toContain(`${dim}:${value}`);
      }
    }
  });

  it('gives every KNOWN_SCOPES entry its own source-scope constraint', () => {
    // Hai chiều: scope trong KNOWN_SCOPES mà thiếu constraint là scope không ai
    // kiểm dependency (lỗ hổng `scope:shared` cũ); constraint chứa scope lạ là
    // scope đã xoá mà còn sống trong config.
    const bySource = scopeSourceConstraints();
    for (const scope of KNOWN_SCOPES) {
      const targets = bySource.get(`scope:${scope}`);
      expect(targets, `scope:${scope} must have its own sourceTag constraint`).toBeDefined();
    }
    for (const source of bySource.keys()) {
      const scope = source.slice('scope:'.length);
      expect(
        KNOWN_SCOPES,
        `constraint sourceTag ${source} must be declared in KNOWN_SCOPES`,
      ).toContain(scope);
    }
  });

  it('keeps contract-edge ownership keys and values within KNOWN_SCOPES', () => {
    // Dữ liệu của lượt kiểm contract-edge cũng phải neo vào taxonomy: key scope
    // đã xoá là chính sách trên project không bao giờ tồn tại (chết code), value
    // scope lạ là cho phép contract của scope không bao giờ được tag như vậy.
    for (const [source, allowed] of Object.entries(CONTRACT_EDGE_OWNERSHIP)) {
      expect(
        KNOWN_SCOPES,
        `contract-edge ownership key scope:${source} must be declared in KNOWN_SCOPES`,
      ).toContain(source);
      for (const scope of allowed) {
        expect(
          KNOWN_SCOPES,
          `contract-edge ownership value scope:${scope} (of scope:${source}) must be declared in KNOWN_SCOPES`,
        ).toContain(scope);
      }
    }
  });

  /**
   * Policy chéo scope qua HÀNH VI constraint thật (engine @nx/eslint-plugin đang
   * cài, không substring config). Ma trận:
   * - foundation (shared/platform) được phép cho bounded context — vai trò tầng nền;
   * - `type:contracts` chéo scope nghiệp vụ được phép với scope CHÍNH SÁCH MẶC ĐỊNH;
   * - implementation scope nghiệp vụ khác bị chặn;
   * - đáy: shared không chạm platform; platform không chạm scope nghiệp vụ.
   *
   * `messaging` KHÔNG còn thuộc nhóm mặc định: nó có chính sách contract-edge
   * riêng (chỉ self + platform — xem `validateContractEdgeOwnership` và constraint
   * `scope:messaging` đã bỏ wildcard `type:contracts`), sau khi transactional-mail
   * từng import `identity-auth-contracts` (lib đã xoá ở issue #324) chéo BC qua
   * chính wildcard đó.
   *
   * `account`/`auth` vẫn thuộc nhóm mặc định: constraint lint cho phép chéo scope
   * qua `type:contracts` đúng như thiết kế — chiều ngược lại (một chiều bị chặn
   * riêng cho cặp này) là việc của `CONTRACT_EDGE_OWNERSHIP`, không của allowlist.
   */
  /**
   * Scope nghiệp vụ theo CHÍNH SÁCH MẶC ĐỊNH: tự do chéo scope qua
   * `type:contracts`, chỉ chặn implementation của scope khác.
   *
   * Ba scope LLM bị loại khỏi nhóm này vì ADR-0019 chốt chúng chặt hơn: Consumer
   * và Seller không được phụ thuộc nhau kể cả qua contract, và hiện không có
   * contract library nào của LLM product để ngoại lệ đó phục vụ. Chúng có test
   * riêng ngay bên dưới.
   */
  const defaultPolicyContexts = KNOWN_SCOPES.filter(
    (s) =>
      ![
        'shared',
        'platform',
        'local',
        'public',
        'messaging',
        'llm-consumer',
        'llm-seller',
        'llm-shared',
        'llm-api',
      ].includes(s),
  );

  it('allows bounded contexts to depend on shared foundation implementations', async () => {
    for (const scope of defaultPolicyContexts) {
      expect(
        await edgeAllowed([`scope:${scope}`], ['scope:shared', 'type:infrastructure']),
        `scope:${scope} -> shared implementation must be allowed`,
      ).toBe(true);
    }
  });

  it('allows bounded contexts to depend on platform foundation implementations', async () => {
    for (const scope of defaultPolicyContexts) {
      expect(
        await edgeAllowed([`scope:${scope}`], ['scope:platform', 'type:infrastructure']),
        `scope:${scope} -> platform implementation must be allowed`,
      ).toBe(true);
    }
  });

  it('allows cross-scope dependencies only through type:contracts', async () => {
    for (const source of defaultPolicyContexts) {
      for (const target of defaultPolicyContexts.filter((t) => t !== source)) {
        expect(
          await edgeAllowed([`scope:${source}`], [`scope:${target}`, 'type:contracts']),
          `${source} -> ${target} contracts must be allowed`,
        ).toBe(true);
        expect(
          await edgeAllowed([`scope:${source}`], [`scope:${target}`, 'type:infrastructure']),
          `${source} -> ${target} implementation must be blocked`,
        ).toBe(false);
        expect(
          await edgeAllowed([`scope:${source}`], [`scope:${target}`, 'type:domain']),
          `${source} -> ${target} domain must be blocked`,
        ).toBe(false);
        expect(
          await edgeAllowed([`scope:${source}`], [`scope:${target}`, 'type:application']),
          `${source} -> ${target} application must be blocked`,
        ).toBe(false);
      }
    }
  });

  it('keeps the three LLM scopes mutually exclusive at the tag level', async () => {
    // ADR-0019: Consumer và Seller là hai phía ownership không được phụ thuộc
    // nhau; Shared phục vụ cả hai nên không được phụ thuộc phía nào. Mức tag chặn
    // cả implementation LẪN contract — chặt hơn chính sách mặc định vì hiện không
    // có contract library nào của LLM product.
    const llmScopes = ['llm-consumer', 'llm-seller', 'llm-shared'];
    for (const source of llmScopes) {
      for (const target of llmScopes.filter((s) => s !== source)) {
        for (const type of ['domain', 'contracts', 'application', 'infrastructure']) {
          expect(
            await edgeAllowed([`scope:${source}`], [`scope:${target}`, `type:${type}`]),
            `${source} -> ${target} ${type} must be blocked`,
          ).toBe(false);
        }
      }
      // Nền tảng dùng chung vẫn đi qua.
      expect(await edgeAllowed([`scope:${source}`], ['scope:shared', 'type:domain'])).toBe(true);
      expect(await edgeAllowed([`scope:${source}`], ['scope:platform', 'type:domain'])).toBe(true);
    }
  });

  it('lets the llm-api composition root consume all three LLM scopes and the shared foundation only', async () => {
    // `llm-api` là composition root của deploy unit LLM (Issue #22): nó soạn cả
    // ba phía LLM, nên constraint của nó là tổng của ba scope nghiệp vụ + nền
    // tảng dùng chung — KHÔNG phải chính sách mặc định (không `type:contracts`
    // chéo scope, không scope nghiệp vụ ngoài LLM). Bất biến ADR-0019 1–3 vẫn
    // giữ: composition root nằm NGOÀI ba scope đó, không làm chúng nhìn thấy nhau.
    const allowedTargets: Array<[string, string]> = [
      ['scope:llm-consumer', 'type:domain'],
      ['scope:llm-seller', 'type:domain'],
      ['scope:llm-shared', 'type:domain'],
      ['scope:shared', 'type:infrastructure'],
      ['scope:platform', 'type:infrastructure'],
    ];
    for (const [targetScope, targetType] of allowedTargets) {
      expect(
        await edgeAllowed(['scope:llm-api', 'type:composition'], [targetScope, targetType]),
        `llm-api -> ${targetScope} ${targetType} must be allowed`,
      ).toBe(true);
    }
    const blockedTargets: Array<[string, string]> = [
      ['scope:account', 'type:infrastructure'],
      ['scope:remote-cache', 'type:infrastructure'],
      ['scope:public', 'type:domain'],
      ['scope:llm-consumer', 'type:contracts'],
      ['scope:llm-seller', 'type:contracts'],
    ];
    for (const [targetScope, targetType] of blockedTargets) {
      expect(
        await edgeAllowed(['scope:llm-api', 'type:composition'], [targetScope, targetType]),
        `llm-api -> ${targetScope} ${targetType} must be blocked`,
      ).toBe(false);
    }
  });

  it('keeps messaging out of the default cross-scope contracts policy', async () => {
    // messaging có chính sách riêng: contract chỉ từ self + platform (mục tiêu
    // issue #203). Engine thật phải chặn messaging → contracts của BC khác, kể cả
    // khi target còn mang `type:contracts` — đúng hình dependency từng lọt.
    expect(
      await edgeAllowed(
        ['scope:messaging', 'type:composition'],
        ['scope:account', 'type:contracts'],
      ),
      'messaging -> account contracts must be blocked',
    ).toBe(false);
    expect(
      await edgeAllowed(
        ['scope:messaging', 'type:composition'],
        ['scope:messaging', 'type:contracts'],
      ),
      'messaging -> own contracts must be allowed',
    ).toBe(true);
    expect(
      await edgeAllowed(
        ['scope:messaging', 'type:composition'],
        ['scope:platform', 'type:contracts'],
      ),
      'messaging -> platform contracts must be allowed',
    ).toBe(true);
  });

  it('blocks composition-to-composition edges (app never imports app)', async () => {
    // Ranh giới taxonomy cũ (`type:web`/`type:service` → onlyDependOn ["type:lib"]):
    // app không bao giờ import app khác — một deploy unit không được trờ thành
    // implementation của deploy unit khác. Regression: constraint cũ
    // `type:composition` notDependOn ["type:tooling"] để tuột app→app qua CẢ
    // constraint scope (identity→cache: allowlist có scope:platform) lẫn combo
    // runtime (allowlist có type:composition).
    const source = ['scope:account', 'type:composition', 'runtime:edge'];
    expect(
      await directEdgeViolations(source, ['scope:platform', 'type:composition', 'runtime:edge']),
      'account app -> cache app must be blocked',
    ).not.toEqual([]);
    expect(
      await directEdgeViolations(
        ['scope:llm-consumer', 'type:composition', 'runtime:edge'],
        ['scope:llm-seller', 'type:composition', 'runtime:edge'],
      ),
      'llm-console -> llm-seller must be blocked too',
    ).not.toEqual([]);
    expect(
      await directEdgeViolations(source, ['scope:local', 'type:tooling', 'runtime:native']),
      'app -> tooling must be blocked',
    ).not.toEqual([]);
    // Nghịch đảo: compose lib thật vẫn đi qua — mọi constraint đều chấp thuận.
    expect(
      await directEdgeViolations(source, ['scope:platform', 'type:infrastructure', 'runtime:edge']),
      'app -> platform lib must stay allowed',
    ).toEqual([]);
  });

  it('keeps shared as the bottom of the ownership axis', async () => {
    // Đáy: shared không chạm platform hay scope nghiệp vụ nào — impl lẫn contract.
    // `onlyDependOnLibsWithTags` khớp BẤT KỂ tag nào trong allowlist nên để
    // `type:contracts` vào allowlist shared là mở `shared → contracts của scope
    // bất kỳ` (target chỉ cần một tag khớp), tạo chu trình shared ↔ contracts của
    // scope đó — đảo chiều dependency của tầng đáy. Ngoại lệ contracts là cho
    // CONSUMER, tầng nền không consume scope nghiệp vụ.
    expect(await edgeAllowed(['scope:shared'], ['scope:platform', 'type:infrastructure'])).toBe(
      false,
    );
    expect(await edgeAllowed(['scope:shared'], ['scope:llm-consumer', 'type:infrastructure'])).toBe(
      false,
    );
    expect(await edgeAllowed(['scope:shared'], ['scope:llm-seller', 'type:contracts'])).toBe(false);
    expect(await edgeAllowed(['scope:shared'], ['scope:shared', 'type:domain'])).toBe(true);
  });

  it('keeps platform above shared and independent of business scopes', async () => {
    expect(await edgeAllowed(['scope:platform'], ['scope:shared', 'type:infrastructure'])).toBe(
      true,
    );
    for (const scope of defaultPolicyContexts) {
      expect(
        await edgeAllowed(['scope:platform'], [`scope:${scope}`, 'type:infrastructure']),
        `platform -> ${scope} implementation must be blocked`,
      ).toBe(false);
      expect(
        await edgeAllowed(['scope:platform'], [`scope:${scope}`, 'type:contracts']),
        `platform -> ${scope} contracts must be allowed`,
      ).toBe(true);
    }
  });

  it('does not contradict type rules: shared constraint stays scope-only and type-free', () => {
    // Constraint scope:shared onlyDependOn* là lượt direct — allowlist của nó
    // KHÔNG được chứa `type:contracts` (OR-match: target chỉ cần một tag khớp là
    // mở `shared → contracts của scope bất kỳ`, đảo chiều tầng đáy) và cũng không
    // nuốt trục type (`type:domain` v.v.): type direction là việc của constraint
    // `type:*`, để vào đây là mỗi lần taxonomy type đổi lại phải sửa hai chỗ.
    const bySource = scopeSourceConstraints();
    const targets = bySource.get('scope:shared') ?? [];
    expect(targets).toContain('scope:shared'); // test phía trên bắt buộc constraint tồn tại
    const typeEntries = targets.filter((t) => t.startsWith('type:'));
    expect(typeEntries).toEqual([]);
  });

  it('every scope targeted by scope constraints is a known scope', () => {
    // Target scope của constraint scope nào cũng phải thuộc KNOWN_SCOPES —
    // scope target hỏng (typo, scope đã xoá) là constraint cho phép dep vào
    // project không bao giờ được tag như vậy, hoặc tệ hơn: cho phép scope đã
    // bị xoá sống sót qua config. (Thu tập trước, assert sau — tránh
    // expect trong nhánh if, vi phạm no-conditional-expect.)
    const targetedScopes: string[] = [];
    for (const targets of scopeSourceConstraints().values()) {
      for (const target of targets) {
        if (target.startsWith('scope:')) {
          targetedScopes.push(target.slice('scope:'.length));
        }
      }
    }
    expect(targetedScopes.length).toBeGreaterThan(0); // tập target không rỗng
    for (const scope of new Set(targetedScopes)) {
      expect(KNOWN_SCOPES).toContain(scope);
    }
  });

  it('keeps legacy scopes out of the constraint config entirely', () => {
    // Assertion đọc CONFIG ĐÃ PARSE (không substring trên raw text): scope cũ
    // không được là sourceTag lẫn target của bất kỳ constraint nào.
    const constraints = readDepConstraints();
    const legacyScopes = ['console', 'seller', 'docs'];
    const serialized = JSON.stringify(constraints);
    for (const scope of legacyScopes) {
      expect(serialized).not.toContain(`scope:${scope}`);
    }
  });

  it('gives every type allowlist entry its own source-type constraint', () => {
    // Hai chiều, cùng lý do với scope: type trong `ARCH_TAG_DIMENSIONS` mà
    // không có constraint là dependency direction của nó không ai kiểm; và
    // `type:*` xuất hiện trong config mà không nằm trong allowlist là taxonomy
    // cũ sống sót hoặc typo — `validateTagSchema` sẽ báo `invalid-value` cho mọi
    // project mang tag đó, tức constraint đang bảo vệ một tag không tồn tại.
    const bySource = new Map<string, Record<string, unknown> | undefined>();
    for (const constraint of readDepConstraints()) {
      if (typeof constraint.sourceTag !== 'string') continue;
      if (!constraint.sourceTag.startsWith('type:')) continue;
      bySource.set(constraint.sourceTag, constraint);
    }
    for (const value of ARCH_TAG_DIMENSIONS.type) {
      expect(
        bySource.get(`type:${value}`),
        `type:${value} must have its own sourceTag constraint`,
      ).toBeDefined();
    }
    for (const source of bySource.keys()) {
      expect(
        ARCH_TAG_DIMENSIONS.type as readonly string[],
        `constraint sourceTag ${source} must be declared in ARCH_TAG_DIMENSIONS.type`,
      ).toContain(source.slice('type:'.length));
    }
  });

  it('keeps the deployment constraint transitive-blocked types out of its allowlist', () => {
    // `notDependOn*` chặn transitive, `onlyDependOn*` là allowlist lượt direct và
    // là OR-match trên target. Để type đã bị chặn transitive mào allowlist sẽ
    // mâu thuẫn với chính nó: allowlist nói "cạnh trực tiếp tới type này hợp
    // lệ" trong khi lượt dưới cấm chính cạnh đó — và nếu `onlyDependOn` được
    // kiểm trước thì cảm giác an toàn là giả.
    const constraint = readDepConstraints().find((c) => c.sourceTag === DEPLOYMENT_TYPE) as Record<
      string,
      unknown
    >;
    expect(constraint).toBeDefined();
    const blocked = constraint.notDependOnLibsWithTags as readonly string[];
    const allowed = constraint.onlyDependOnLibsWithTags as readonly string[];
    expect(blocked.length).toBeGreaterThan(0);
    expect(allowed.length).toBeGreaterThan(0);
    for (const tag of blocked) {
      expect(allowed, `${DEPLOYMENT_TYPE} onlyDependOn must not reopen ${tag}`).not.toContain(tag);
    }
    // `type:deployment` phải có mặt: prerequisite tầng nền là một edge trực tiếp.
    expect(allowed).toContain(DEPLOYMENT_TYPE);
    expect(allowed).toContain('type:contracts');
  });

  it('blocks a deployment project from reaching an app or business implementation', async () => {
    // Hành vi qua ENGINE THẬT của @nx/eslint-plugin, không đọc chuỗi config:
    // assert "trong .oxlintrc.json có mảt chữ type:composition" sẽ xanh ngay cả
    // khi constraint không hề áp dụng.
    const source = ['scope:account', DEPLOYMENT_TYPE, 'runtime:native'];
    expect(
      await directEdgeViolations(source, ['scope:account', 'type:composition', 'runtime:edge']),
      'deploy -> app must be blocked',
    ).not.toEqual([]);
    expect(
      await directEdgeViolations(source, ['scope:account', 'type:domain', 'runtime:universal']),
      'deploy -> domain must be blocked',
    ).not.toEqual([]);
    expect(
      await directEdgeViolations(source, ['scope:account', 'type:application', 'runtime:edge']),
      'deploy -> application must be blocked',
    ).not.toEqual([]);
  });

  it('allows a deployment project to depend on the platform and contracts', async () => {
    // Đảo chiều: nếu một trong các cạnh hợp lệ bị chặn thì constraint trên chỉ
    // "chặn cho có" và không giữ được giá trị thực tế. Target tooling chọn
    // `scope:platform` vì trục scope vẫn áp đồng thời (xem test kế bên).
    const source = ['scope:account', DEPLOYMENT_TYPE, 'runtime:native'];
    for (const target of [
      ['scope:platform', DEPLOYMENT_TYPE, 'runtime:native'],
      ['scope:account', 'type:contracts', 'runtime:universal'],
      ['scope:platform', 'type:infrastructure', 'runtime:edge'],
      ['scope:platform', 'type:tooling', 'runtime:native'],
    ]) {
      expect(
        await directEdgeViolations(source, target),
        `deploy -> ${target.join(',')} must stay allowed`,
      ).toEqual([]);
    }
  });

  it('keeps the scope axis applying to deployment projects', async () => {
    // `findConstraintsFor` trả MỌI constraint khớp source và rule conjunctive:
    // một deploy project mang scope nghiệp vụ vẫn bị constraint `scope:*` của
    // scope đó chi phối. `type:tooling` trong allowlist của `type:deployment`
    // KHÔNG mở được lối tới tooling ở scope khác — đó là chính sách scope có sẵn
    // (`scope:local` không nằm trong allowlist của `scope:account`), và
    // constraint deployment không được làm nới nó.
    const source = ['scope:account', DEPLOYMENT_TYPE, 'runtime:native'];
    expect(
      await directEdgeViolations(source, ['scope:local', 'type:tooling', 'runtime:native']),
      'business deploy -> local tooling stays blocked by the scope axis',
    ).not.toEqual([]);
    expect(
      await directEdgeViolations(
        ['scope:local', DEPLOYMENT_TYPE, 'runtime:native'],
        ['scope:local', 'type:tooling', 'runtime:native'],
      ),
      'local deploy -> local tooling must be allowed',
    ).toEqual([]);
  });

  it('derives runtime composition constraints from RUNTIME_COMPAT without drift', () => {
    // Lượt runtime của .oxlintrc.json (allSourceTags type:composition + runtime:X,
    // onlyDependOn* runtime) phải là ảnh của RUNTIME_COMPAT: X được phụ thuộc
    // đúng {X, universal}. drift giữa hai nguồn = một bên cấm điều bên kia cho.
    const constraints = readDepConstraints();
    const runtimeConstraints = constraints.filter(
      (c) =>
        Array.isArray(c.allSourceTags) &&
        (c.allSourceTags as string[]).some((t) => t.startsWith('runtime:')),
    );

    const derived: Record<string, Set<string>> = {};
    const runtimeValues = runtimeConstraints.map((c) =>
      (c.allSourceTags as string[]).find((t) => t.startsWith('runtime:')),
    );
    expect(runtimeValues.every((t) => t !== undefined)).toBe(true); // bộ lọc bảo đảm
    for (const constraint of runtimeConstraints) {
      const runtimeTag = (constraint.allSourceTags as string[]).find((t) =>
        t.startsWith('runtime:'),
      ) as string;
      const value = runtimeTag.slice('runtime:'.length);
      expect(RUNTIME_COMPAT, `runtime:${value} must exist in RUNTIME_COMPAT`).toHaveProperty(value);
      const targets = constraint.onlyDependOnLibsWithTags as readonly string[];
      const runtimeTargets = targets
        .filter((t) => t.startsWith('runtime:'))
        .map((t) => t.slice('runtime:'.length));
      derived[value] ??= new Set();
      // Nhiều constraint có thể nhắm cùng runtime (composition vs type khác) —
      // runtime target của chúng phải nhất quán với nhau.
      expect(new Set(runtimeTargets)).toEqual(new Set(RUNTIME_COMPAT[value]));
      for (const t of runtimeTargets) derived[value].add(t);
    }
    // Mọi runtime CỤ THỂ trong RUNTIME_COMPAT phải có ít nhất một constraint
    // direct-edge đại diện trong config. `universal` cố ý không có: phía source
    // universal được chặn TRANSITIVE bởi arch-check trên graph (constraint
    // direct-edge không diễn đạt được "universal chỉ chạm universal qua mọi
    // chuỗi"), thêm constraint direct cho universal chỉ tạo ảo giác hai nguồn.
    const specificRuntimes = Object.keys(RUNTIME_COMPAT).filter((r) => r !== 'universal');
    for (const runtime of specificRuntimes) {
      expect(derived[runtime], `runtime:${runtime} must have a constraint`).toBeDefined();
    }
    expect(derived.universal).toBeUndefined();
  });
});
