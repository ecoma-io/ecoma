import { describe, expect, it } from 'vitest';

import type { ArchProjectNode } from './arch-tags.js';
import {
  createNodeTestTargetFs,
  crossTierImportMarkers,
  detectRealDependencyMarkers,
  includeCoversPurposeDir,
  KNOWN_TEST_TARGET_VIOLATIONS,
  type TestTargetAllowlistEntry,
  type TestTargetFs,
  parseVitestConfig,
  REAL_DEPENDENCY_MARKERS,
  unitSourceDirs,
  validateTestTargets,
} from './test-target-check.js';

/**
 * Filesystem tổng hợp trong bộ nhớ: path tương đối so với repo root ảo của
 * fixture, nội dung là string khai sẵn. Không chạm đĩa thật — cùng mô hình
 * inject-fs mà lượt deployment map dùng, nhưng gọn hơn vì không cần tmpdir.
 */
function memFs(files: Record<string, string>): TestTargetFs {
  const paths = Object.keys(files);
  const dirNames = new Map<string, Set<string>>();
  const fileNames = new Map<string, Set<string>>();
  const ensureDir = (dir: string): void => {
    if (dir === '' || dirNames.has(dir)) return;
    ensureDir(dir.slice(0, dir.lastIndexOf('/')));
    dirNames.set(dir, new Set());
  };
  for (const path of paths) {
    const slash = path.lastIndexOf('/');
    const dir = slash < 0 ? '' : path.slice(0, slash);
    const name = slash < 0 ? path : path.slice(slash + 1);
    ensureDir(dir);
    fileNames.set(dir, (fileNames.get(dir) ?? new Set()).add(name));
    let parent = dir;
    while (parent !== '') {
      ensureDir(parent);
      const up = parent.slice(0, parent.lastIndexOf('/'));
      dirNames.get(up)?.add(parent.slice(up.length + 1 || up.length));
      parent = up;
    }
  }
  return {
    readFile(relativePath) {
      const content = files[relativePath];
      if (content === undefined) throw new Error(`ENOENT: ${relativePath}`);
      return content;
    },
    exists(relativePath) {
      return files[relativePath] !== undefined || dirNames.has(relativePath);
    },
    listDirs(relativePath) {
      // target es2022 không có toSorted: copy rồi sort tại chỗ.
      const dirs = [...(dirNames.get(relativePath) ?? new Set<string>())];
      dirs.sort();
      return dirs;
    },
    listFiles(relativePath) {
      const names = [...(fileNames.get(relativePath) ?? new Set<string>())];
      names.sort();
      return names;
    },
  };
}

/** Node app/lib tối thiểu cho lượt này: lượt chỉ dùng `name` và `root`. */
function node(name: string, root: string): ArchProjectNode {
  return { name, tags: [], dependencies: [], root };
}

/** Unit config theo mẫu thống nhất của repo (include brace group, defaultExclude). */
function unitConfig(include: string[], extra = ''): string {
  return `export default defineConfig(() => ({ test: {
    include: [${include.map((s) => `'${s}'`).join(', ')}],
    ${extra}
  } }));\n`;
}

/** Integration config theo mẫu thống nhất của repo. */
function integrationConfig(include: string[], passWithNoTests = false): string {
  return `export default defineConfig(() => ({ test: {
    include: [${include.map((s) => `'${s}'`).join(', ')}],
    passWithNoTests: ${passWithNoTests},
  } }));\n`;
}

/** Package.json với tập target nx khai trong `nx.targets`. */
function pkg(targets: string[]): string {
  return JSON.stringify({
    name: 'fixture',
    nx: { targets: Object.fromEntries(targets.map((t) => [t, {}])) },
  });
}

/** Gom vi phạm theo kind, để assert "đúng lỗi duy nhất" gọn hơn. */
function kinds(violations: { kind: string }[]): string[] {
  // target es2022 không có toSorted: copy rồi sort tại chỗ.
  const list = [...new Set(violations.map((v) => v.kind))];
  list.sort();
  return list;
}

/**
 * Workspace app "đẹp" mặc định: một thư mục mục đích có suite, target khai đủ,
 * config integration include đúng và fail-loud, unit config exclude đúng. Mỗi
 * test chỉ phá MỘT khía cạnh rồi assert lỗi của đúng khía cạnh đó.
 */
function goodApp(): { files: Record<string, string>; project: ArchProjectNode } {
  return {
    files: {
      'apps/widget/package.json': pkg(['test', 'test-integration']),
      'apps/widget/vitest.config.mts': unitConfig(
        ['{src,tests}/**/*.{test,spec}.ts'],
        `exclude: [...defaultExclude, 'tests/integrations/**'],`,
      ),
      'apps/widget/vitest.integration.config.mts': integrationConfig([
        'tests/integrations/**/*.{test,spec}.ts',
      ]),
      'apps/widget/src/thing.ts': 'export const x = 1;\n',
      'apps/widget/src/thing.spec.ts': 'import { it } from "vitest"; it("works", () => {});\n',
      'apps/widget/tests/integrations/wire.spec.ts':
        'import { it } from "vitest"; it("works", () => {});\n',
    },
    project: node('@ecoma-io/widget', 'apps/widget'),
  };
}

/**
 * Chạy lượt trên workspace tổng hợp với allowlist RỖNG: các test layout không
 * muốn bị allowlist thật của repo (entry auth/mailer-job trên cây thật) làm
 * nhiễu kết quả fixture — entry đó không khớp workspace tổng hợp nào nên sẽ
 * bị báo stale, đè lên lỗi mà từng test đang assert. Cơ chế allowlist có test
 * riêng với allowlist inject.
 */
function run(
  files: Record<string, string>,
  projects: ArchProjectNode[],
  allowlist: readonly TestTargetAllowlistEntry[] = [],
): ReturnType<typeof validateTestTargets> {
  return validateTestTargets({
    projects: new Map(projects.map((p) => [p.name, p])),
    fs: memFs(files),
    allowlist,
  });
}

describe('validateTestTargets — valid workspace', () => {
  it('passes a synthetic app whose integration tier is wired end to end', () => {
    const { files, project } = goodApp();
    expect(run(files, [project])).toEqual([]);
  });

  it('passes an app without purpose directories that has only a unit tier', () => {
    const { files, project } = goodApp();
    delete files['apps/widget/tests/integrations/wire.spec.ts'];
    expect(run(files, [project])).toEqual([]);
  });

  it('passes a lib whose colocated specs are pure unit specs', () => {
    const files = {
      'libs/math/package.json': pkg(['test']),
      'libs/math/vitest.config.mts': unitConfig(['src/**/*.spec.ts']),
      'libs/math/src/add.ts': 'export const add = (a: number, b: number) => a + b;\n',
      'libs/math/src/add.spec.ts': 'import { it } from "vitest"; it("adds", () => {});\n',
    };
    expect(run(files, [node('@ecoma-io/math', 'libs/math')])).toEqual([]);
  });

  it('ignores projects outside apps/ and libs/', () => {
    // system-tests tự định nghĩa target của mình (06 §4); tools không có tier
    // test — lượt này ngoài hợp đồng của cả hai.
    const { files } = goodApp();
    expect(
      run(files, [node('system-tests/e2e/x', 'system-tests/e2e/x'), node('dx', 'tools/dx')]),
    ).toEqual([]);
  });

  it('skips projects without a root instead of guessing their disk location', () => {
    const { files } = goodApp();
    expect(run(files, [{ name: '@ecoma-io/widget', tags: [], dependencies: [] }])).toEqual([]);
  });
});

describe('validateTestTargets — orphan integration suites', () => {
  it('reports a purpose directory whose project declares no test-integration target', () => {
    const { files, project } = goodApp();
    files['apps/widget/package.json'] = pkg(['test']);
    const violations = run(files, [project]);
    expect(kinds(violations)).toEqual(['missing-integration-target']);
    expect(violations[0].project).toBe('@ecoma-io/widget');
    expect(violations[0].detail).toContain('tests/integrations');
  });

  it('reports a purpose directory whose project has no integration config file', () => {
    const { files, project } = goodApp();
    delete files['apps/widget/vitest.integration.config.mts'];
    const violations = run(files, [project]);
    expect(kinds(violations)).toEqual(['missing-integration-config']);
    expect(violations[0].detail).toContain('vitest.integration.config.mts');
  });

  it('reports an integration config that omits an existing purpose directory', () => {
    // databases/ tồn tại trên đĩa nhưng integration config chỉ include
    // integrations/ — target sẽ bỏ suite trong im lặng, đúng hình "suite mồ côi".
    // Unit config không exclude tests/databases/ nên suite còn chạy trùng ở
    // tier unit — hai lỗi độc lập, mỗi lượt báo đúng phần việc của mình.
    const { files, project } = goodApp();
    files['apps/widget/tests/databases/migrate.spec.ts'] =
      'import { it } from "vitest"; it("works", () => {});\n';
    const violations = run(files, [project]);
    expect(kinds(violations)).toEqual([
      'integration-config-missing-dir',
      'integration-dir-in-unit-config',
    ]);
    expect(violations.find((v) => v.kind === 'integration-config-missing-dir')?.detail).toContain(
      'tests/databases',
    );
  });

  it('reports an unreadable package.json as a missing integration target, not a skip', () => {
    // Fail-closed: JSON hỏng không được biến thành "project sạch". Không đọc
    // được targets tức không chứng minh được target tồn tại ⇒ báo thiếu.
    const { files, project } = goodApp();
    files['apps/widget/package.json'] = '{ broken json';
    const violations = run(files, [project]);
    expect(violations.some((v) => v.kind === 'missing-integration-target')).toBe(true);
  });
});

describe('validateTestTargets — integration suites leaked into the unit tier', () => {
  it('reports a unit config that includes a purpose directory without excluding it', () => {
    const { files, project } = goodApp();
    files['apps/widget/vitest.config.mts'] = unitConfig(['{src,tests}/**/*.{test,spec}.ts']);
    const violations = run(files, [project]);
    expect(kinds(violations)).toEqual(['integration-dir-in-unit-config']);
    expect(violations[0].detail).toContain('both test and test-integration');
  });

  it('accepts the explicit per-purpose exclude shape', () => {
    const { files, project } = goodApp();
    files['apps/widget/vitest.config.mts'] = unitConfig(
      ['{src,tests}/**/*.{test,spec}.ts'],
      `exclude: [...defaultExclude, 'tests/integrations/**'],`,
    );
    expect(run(files, [project])).toEqual([]);
  });

  it('accepts a unit include that never reaches into tests/', () => {
    // apps/auth shape: include chỉ src/** — tier unit không chạm tests/ thì
    // không cần exclude nào.
    const { files, project } = goodApp();
    files['apps/widget/vitest.config.mts'] = unitConfig(['src/**/*.{test,spec}.ts']);
    expect(run(files, [project])).toEqual([]);
  });
});

describe('validateTestTargets — passWithNoTests policy', () => {
  it('reports an integration config with passWithNoTests true', () => {
    const { files, project } = goodApp();
    files['apps/widget/vitest.integration.config.mts'] = integrationConfig(
      ['tests/integrations/**/*.{test,spec}.ts'],
      true,
    );
    const violations = run(files, [project]);
    expect(kinds(violations)).toEqual(['integration-pass-with-no-tests']);
    expect(violations[0].detail).toContain('passWithNoTests: true');
  });

  it('does not police passWithNoTests in unit configs', () => {
    // Chính sách PR này: giữ nguyên giá trị unit hiện có, không flip — lượt
    // kiểm không biến unit `passWithNoTests: true` thành lỗi.
    const { files, project } = goodApp();
    files['apps/widget/vitest.config.mts'] = unitConfig(
      ['{src,tests}/**/*.{test,spec}.ts'],
      `exclude: [...defaultExclude, 'tests/integrations/**'], passWithNoTests: true,`,
    );
    expect(run(files, [project])).toEqual([]);
  });
});

describe('validateTestTargets — real-dependency specs in the unit tier', () => {
  it('reports an app spec under src/ that imports the postgres driver', () => {
    const { files, project } = goodApp();
    files['apps/widget/src/db-cas.spec.ts'] = [
      "import postgres from 'postgres';",
      'import { it } from "vitest"; it("works", () => {});',
    ].join('\n');
    const violations = run(files, [project]);
    expect(kinds(violations)).toEqual(['unit-real-dependency-spec']);
    expect(violations[0].detail).toContain('apps/widget/src/db-cas.spec.ts');
    expect(violations[0].detail).toContain('postgres');
  });

  it('reports a lib spec in the unit tier with the lib-specific kind', () => {
    // Lib không có tier integration riêng — nhà của spec này là tier
    // integration của app sở hữu (ruling #357), nên kind nói rõ lần khác.
    const files = {
      'libs/pgbox/package.json': pkg(['test']),
      'libs/pgbox/vitest.config.mts': unitConfig(['src/**/*.spec.ts']),
      'libs/pgbox/src/cas.spec.ts': "import postgres from 'postgres';\n",
    };
    const violations = run(files, [node('@ecoma-io/pgbox', 'libs/pgbox')]);
    expect(kinds(violations)).toEqual(['lib-real-dependency-spec']);
    expect(violations[0].detail).toContain("owning app's integration tier");
  });

  it('does not report a spec that only mocks the driver', () => {
    // `vi.mock('postgres')` thay driver bằng giả — đúng tier unit; marker neo
    // vào cú pháp import thật nên mock không khớp.
    const { files, project } = goodApp();
    files['apps/widget/src/store.spec.ts'] = [
      "import { vi } from 'vitest';",
      "vi.mock('postgres', () => ({ default: {} }));",
      'import { it } from "vitest"; it("works", () => {});',
    ].join('\n');
    expect(run(files, [project])).toEqual([]);
  });

  it('does not report a spec that only mentions testcontainers in prose comments', () => {
    const { files, project } = goodApp();
    files['apps/widget/src/doc.spec.ts'] = [
      '// Database PostgreSQL đến từ testcontainers — xem harness.',
      'import { it } from "vitest"; it("works", () => {});',
    ].join('\n');
    expect(run(files, [project])).toEqual([]);
  });

  it('reports a unit spec that pulls the integration harness across the tier boundary', () => {
    // Import harness từ tests/integrations/ là lép ranh giới tier dù spec không
    // import driver nào trực tiếp — đây chính là cách harness PostgreSQL được
    // kéo vào spec colocated trong hình vi phạm thật của repo (internal-auth.spec).
    const { files, project } = goodApp();
    files['apps/widget/src/flow.spec.ts'] =
      "import { startDb } from '../tests/integrations/harness.ts';\n";
    files['apps/widget/tests/integrations/harness.ts'] =
      "import { PostgreSqlContainer } from '@testcontainers/postgresql';\n";
    const violations = run(files, [project]);
    expect(kinds(violations)).toEqual(['unit-real-dependency-spec']);
    expect(violations[0].detail).toContain('integration tier directory');
  });

  it('accepts a unit spec importing pure fixture data from a purpose directory', () => {
    // Hình thật của push-notification sau #367: spec unit import fixture-ports
    // (dữ liệu test, không boot gì) nằm trong tests/integrations/ — import
    // chéo tier chỉ là vi phạm khi file được import cũng boot dependency thật.
    const { files, project } = goodApp();
    files['apps/widget/src/auth.spec.ts'] =
      "import { testConfig } from '../tests/integrations/fixture-ports';\nimport { it } from 'vitest';\n";
    files['apps/widget/tests/integrations/fixture-ports.ts'] =
      'export const testConfig = { port: 1234 };\n';
    expect(run(files, [project])).toEqual([]);
  });

  it('reports a cross-tier import whose target cannot be resolved on disk', () => {
    // Fail-closed: import vào thư mục mục đích mà không resolve được file nào
    // tự thân đã là lỗi layout — báo thay vì nuốt.
    const { files, project } = goodApp();
    files['apps/widget/src/ghost.spec.ts'] = "import { x } from '../tests/integrations/ghost';\n";
    const violations = run(files, [project]);
    expect(kinds(violations)).toEqual(['unit-real-dependency-spec']);
  });

  it('reports getPlatformProxy and wrangler CLI usage in unit-tier specs', () => {
    const { files, project } = goodApp();
    files['apps/widget/src/d1.spec.ts'] = [
      "const { getPlatformProxy } = requireFromSpec('wrangler') as typeof import('wrangler');",
      "const wranglerCli = requireFromSpec.resolve('wrangler');",
    ].join('\n');
    const violations = run(files, [project]);
    expect(kinds(violations)).toEqual(['unit-real-dependency-spec']);
    expect(violations[0].detail).toContain('getPlatformProxy');
  });

  it('skips spec files inside purpose directories when scanning the unit tier', () => {
    // Suite real-dependency trong tests/integrations/ là NHÀ HỢP LỆ của nó:
    // dò tier unit không được kết tội file ở đúng nhà.
    const { files, project } = goodApp();
    files['apps/widget/tests/integrations/wire.spec.ts'] =
      "import postgres from 'postgres';\nimport { startDb } from './harness.ts';\n";
    expect(run(files, [project])).toEqual([]);
  });

  it('ignores real-dependency imports in non-spec source files', () => {
    // Production code importing postgres là chuyện bình thường của adapter;
    // chỉ SPEC trong tier unit mới bị kiểm marker.
    const { files, project } = goodApp();
    files['apps/widget/src/real-adapter.ts'] = "import postgres from 'postgres';\n";
    expect(run(files, [project])).toEqual([]);
  });

  it('scans every source directory the unit include covers', () => {
    // apps/backoffice shape: spec real-dependency nằm dưới server/, một thư
    // mục nguồn khác src/ — dò phải phủ theo include, không hard-code src/.
    const { files, project } = goodApp();
    files['apps/widget/vitest.config.mts'] = unitConfig(
      ['{src,server,tests}/**/*.{test,spec}.ts'],
      `exclude: [...defaultExclude, 'tests/integrations/**'],`,
    );
    files['apps/widget/server/otp.spec.ts'] = "import postgres from 'postgres';\n";
    const violations = run(files, [project]);
    expect(violations).toHaveLength(1);
    expect(violations[0].detail).toContain('apps/widget/server/otp.spec.ts');
  });
});

describe('validateTestTargets — fail-closed config reading', () => {
  it('reports a unit config whose include array cannot be parsed', () => {
    const { files, project } = goodApp();
    files['apps/widget/vitest.config.mts'] = 'export default defineConfig(() => ({ test: {} }));\n';
    const violations = run(files, [project]);
    expect(kinds(violations)).toEqual(['unreadable-test-config']);
    expect(violations[0].detail).toContain('include');
  });

  it('reports an unreadable spec file instead of treating it as clean', () => {
    const { files, project } = goodApp();
    // readFile của fixture ném cho mọi path chưa khai; khai config trỏ tới
    // thư mục nguồn nhưng spec file "không tồn tại" là mâu thuẫn fixture —
    // dùng fs wrapper ném đúng một file.
    const failing: TestTargetFs = {
      ...memFs(files),
      readFile(path) {
        if (path === 'apps/widget/src/thing.spec.ts') throw new Error('EACCES');
        return files[path] ?? '';
      },
    };
    const violations = validateTestTargets({
      projects: new Map([[project.name, project]]),
      fs: failing,
      allowlist: [],
    });
    expect(kinds(violations)).toEqual(['unreadable-test-config']);
    expect(violations[0].detail).toContain('thing.spec.ts');
  });

  it('treats an include entry pointing at a missing directory as vacuous, not broken', () => {
    // include khai `tests/` nhưng project chưa có suite nào dưới đó — config
    // không sai layout, chỉ rỗng; việc rỗng có đáng báo hay không là policy
    // passWithNoTests, không phải của lượt layout này.
    const { files, project } = goodApp();
    files['apps/widget/vitest.config.mts'] = unitConfig(
      ['{src,tests}/**/*.{test,spec}.ts'],
      `exclude: [...defaultExclude, 'tests/integrations/**'],`,
    );
    delete files['apps/widget/tests/integrations/wire.spec.ts'];
    expect(run(files, [project])).toEqual([]);
  });
});

describe('temporary allowlist mechanics', () => {
  /** Allowlist fixture: đúng hình shape entry thật, tên project của fixture. */
  const fixtureAllowlist = [
    {
      project: '@ecoma-io/widget',
      kind: 'unit-real-dependency-spec' as const,
      reason: 'test fixture: seeded for the allowlist mechanics tests',
    },
  ];

  it('requires a non-empty reason on every shipped allowlist entry', () => {
    for (const entry of KNOWN_TEST_TARGET_VIOLATIONS) {
      expect(entry.reason.length, `${entry.project} needs a reason`).toBeGreaterThan(0);
    }
  });

  it('masks a matching violation and keeps the entry alive', () => {
    // Entry chết phải bị dọn cùng fix của nó, không ở lại che vi phạm tương lai.
    // Fixture: dựng đúng HÌNH vi phạm mà entry khai (cùng project, cùng kind) —
    // entry phải che được nó, tức vi phạm không hiện và entry không stale.
    const { files, project } = goodApp();
    files['apps/widget/src/pg.spec.ts'] = "import postgres from 'postgres';\n";
    const violations = validateTestTargets({
      projects: new Map([[project.name, project]]),
      fs: memFs(files),
      allowlist: fixtureAllowlist,
    });
    expect(violations).toEqual([]);
  });

  it('reports the underlying violation when no allowlist entry matches its kind', () => {
    const { files, project } = goodApp();
    files['apps/widget/src/pg.spec.ts'] = "import postgres from 'postgres';\n";
    const violations = validateTestTargets({
      projects: new Map([[project.name, project]]),
      fs: memFs(files),
      allowlist: [{ ...fixtureAllowlist[0], kind: 'lib-real-dependency-spec' }],
    });
    // Entry khai nhầm kind: không che được vi phạm (báo nguyên vi phạm) và
    // chính nó chết (stale) — hai báo, mỗi báo một nửa sai của entry.
    expect(kinds(violations)).toEqual([
      'stale-test-target-allowlist-entry',
      'unit-real-dependency-spec',
    ]);
  });

  it('reports a stale entry that masks no violation on the current tree', () => {
    const { files, project } = goodApp();
    const violations = validateTestTargets({
      projects: new Map([[project.name, project]]),
      fs: memFs(files),
      allowlist: fixtureAllowlist,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      project: '@ecoma-io/widget',
      kind: 'stale-test-target-allowlist-entry',
    });
    expect(violations[0].detail).toContain('remove the entry');
  });

  it('does not let an entry mask a different project with the same kind', () => {
    // Mask theo {project, kind}: vi phạm của project khác cùng kind phải vẫn
    // hiện; entry fixture khớp đúng vi phạm của widget nên không stale.
    const { files, project } = goodApp();
    files['apps/widget/src/pg.spec.ts'] = "import postgres from 'postgres';\n";
    const other = node('@ecoma-io/other', 'apps/other');
    const violations = validateTestTargets({
      projects: new Map([
        [project.name, project],
        [other.name, other],
      ]),
      fs: memFs({
        ...files,
        'apps/other/package.json': pkg(['test']),
        'apps/other/vitest.config.mts': unitConfig(['src/**/*.spec.ts']),
        'apps/other/src/pg.spec.ts': "import postgres from 'postgres';\n",
      }),
      allowlist: fixtureAllowlist,
    });
    expect(kinds(violations)).toEqual(['unit-real-dependency-spec']);
    expect(violations[0].project).toBe('@ecoma-io/other');
  });
});

describe('parseVitestConfig', () => {
  it('extracts include, exclude and passWithNoTests from a repo-shaped config', () => {
    const parsed = parseVitestConfig(
      unitConfig(
        ['{src,tests}/**/*.spec.ts'],
        `exclude: [...defaultExclude, 'tests/integrations/**'], passWithNoTests: true,`,
      ),
    );
    expect(parsed?.include).toEqual(['{src,tests}/**/*.spec.ts']);
    expect(parsed?.exclude).toEqual(['tests/integrations/**']);
    expect(parsed?.passWithNoTestsExplicitTrue).toBe(true);
  });

  it('returns undefined when the config has no include array', () => {
    expect(parseVitestConfig('export default { test: {} };')).toBeUndefined();
  });
});

describe('unitSourceDirs', () => {
  it('expands brace groups and keeps literal roots', () => {
    expect(unitSourceDirs(['{src,tests}/**/*.spec.ts', 'server/**/*.spec.ts'])).toEqual([
      'server',
      'src',
      'tests',
    ]);
  });

  it('skips entries without a determinable root directory', () => {
    expect(unitSourceDirs(['**/*.spec.ts'])).toEqual([]);
  });
});

describe('includeCoversPurposeDir', () => {
  it('matches brace-group roots and explicit purpose segments', () => {
    expect(includeCoversPurposeDir('{src,tests}/**/*.spec.ts', 'integrations')).toBe(true);
    expect(includeCoversPurposeDir('tests/integrations/**/*.spec.ts', 'integrations')).toBe(true);
    expect(includeCoversPurposeDir('tests/integrations/**/*.spec.ts', 'databases')).toBe(false);
    expect(includeCoversPurposeDir('src/**/*.spec.ts', 'integrations')).toBe(false);
    expect(includeCoversPurposeDir('tests/{integrations,databases}/**', 'databases')).toBe(true);
    expect(includeCoversPurposeDir('tests/{integrations,databases}/**', 'browser')).toBe(false);
  });
});

describe('detectRealDependencyMarkers', () => {
  it('anchors markers to import and call syntax, not bare names', () => {
    const clean = [
      '// PostgreSQL đến từ testcontainers; boot qua getPlatformProxy.',
      'import { describe } from "vitest";',
    ].join('\n');
    expect(detectRealDependencyMarkers(clean)).toEqual([]);
  });

  it('covers every direct marker shipped in REAL_DEPENDENCY_MARKERS with a distinct fixture', () => {
    // Mỗi marker phải có ít nhất một fixture khớp — thêm marker mà quên fixture
    // là marker chết, phát hiện rỗng tay và không ai biết. Marker chéo tier
    // (cuối danh sách) không khớp thuần regex — nó được test riêng bên dưới
    // qua bước giải import MỘT BẬC.
    const fixtures = [
      "import postgres from 'postgres';",
      "import { PostgreSqlContainer } from '@testcontainers/postgresql';",
      "import { testcontainers } from 'testcontainers';",
      "const { getPlatformProxy } = requireFromSpec('wrangler');",
      'await getPlatformProxy<MjBindings>({});',
      "const wranglerCli = req.resolve('wrangler');",
    ];
    for (const fixture of fixtures) {
      // expect 1 đối số (vitest valid-expect): fixture nằm trong message của
      // vòng lặp qua biến, không truyền làm message phụ.
      expect(detectRealDependencyMarkers(fixture).length).toBeGreaterThanOrEqual(1);
    }
    expect(REAL_DEPENDENCY_MARKERS.length).toBeGreaterThanOrEqual(3);
    // Marker chéo tier NẰM NGOÀI danh sách direct (xuất `CROSS_TIER_LABEL`)
    // — neo hành vi đó: detect thuần trên text không bao giờ khớp nó.
    expect(
      detectRealDependencyMarkers("import { startDb } from '../tests/integrations/harness.ts';"),
    ).toEqual([]);
  });

  it('flags the cross-tier marker only through one-hop resolution', () => {
    const fs = memFs({
      'apps/w/src/flow.spec.ts': "import { startDb } from '../tests/integrations/harness.ts';\n",
      'apps/w/tests/integrations/harness.ts':
        "import { PostgreSqlContainer } from '@testcontainers/postgresql';\n",
    });
    expect(
      crossTierImportMarkers(
        "import { startDb } from '../tests/integrations/harness.ts';",
        'apps/w/src',
        fs,
      ),
    ).toEqual(['import from an app-owned integration tier directory']);
  });

  it('does not flag a cross-tier import whose target is marker-free', () => {
    const fs = memFs({
      'apps/w/src/auth.spec.ts':
        "import { testConfig } from '../tests/integrations/fixture-ports';\n",
      'apps/w/tests/integrations/fixture-ports.ts': 'export const testConfig = {};\n',
    });
    expect(
      crossTierImportMarkers(
        "import { testConfig } from '../tests/integrations/fixture-ports';",
        'apps/w/src',
        fs,
      ),
    ).toEqual([]);
  });

  it('resolves a two-level-up cross-tier import', () => {
    // Spec sâu hai cấp dưới src/ (hình thật của apps/auth/src/oidc/*.spec.ts
    // import `../../tests/integrations/harness`) — hai cấp `../` phải resolve
    // đúng ra project root.
    const fs = memFs({
      'apps/w/src/oidc/flow.spec.ts':
        "import { startDb } from '../../tests/integrations/harness.ts';\n",
      'apps/w/tests/integrations/harness.ts': "import postgres from 'postgres';\n",
    });
    expect(
      crossTierImportMarkers(
        "import { startDb } from '../../tests/integrations/harness.ts';",
        'apps/w/src/oidc',
        fs,
      ),
    ).toEqual(['import from an app-owned integration tier directory']);
  });

  it('matches dynamic import of wrangler', () => {
    expect(detectRealDependencyMarkers("await import('wrangler')").length).toBe(1);
  });
});

describe('createNodeTestTargetFs', () => {
  it('reads a real file from the repository relative to the root', () => {
    // Smoke trên đĩa thật với chính validator này: ROOT_DIR của repo chứa file
    // đặc tả ở đó. Fixture tổng hợp đã phủ mọi nhánh logic còn lại.
    const fs = createNodeTestTargetFs();
    expect(fs.exists('tools/dx/src/architecture/test-target-check.ts')).toBe(true);
    expect(fs.exists('tools/dx/does-not-exist.ts')).toBe(false);
    expect(fs.listDirs('tools/dx/src')).toContain('architecture');
    expect(fs.listFiles('tools/dx/src/architecture').some((f) => f.endsWith('.spec.ts'))).toBe(
      true,
    );
  });
});
