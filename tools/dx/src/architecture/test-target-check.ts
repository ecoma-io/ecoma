/**
 * Lượt kiểm test-target layout — ràng buộc layout test trên đĩa theo hợp đồng
 * canonical `docs/architecture/06-testing.md` (§2 ownership/layout, §4 target).
 *
 * Khác các lượt kiểm tag trong `arch-tags.ts` (đọc project graph), lượt này
 * đọc ĐĨA trong project root của app/lib: vitest config, package.json, nội dung
 * spec file. Graph chỉ cho biết project nằm ở đâu (`root`) và tên gì; tier của
 * một spec không diễn đạt được bằng tag hay dependency edge — nó nằm ở chỗ file
 * đứng và config nào include nó.
 *
 * Năm nhóm ràng buộc (mỗi nhóm một nhóm kind):
 *
 * 1. **Suite app-owned phải thuộc `test-integration`.** Thư mục mục đích
 *    `tests/{integrations,databases,contracts,browser}/` tồn tại ⇒ project
 *    phải khai target `test-integration` trong `package.json` (`nx.targets`)
 *    và phải có `vitest.integration.config.mts` include đúng các thư mục đó
 *    (`missing-integration-target`, `missing-integration-config`,
 *    `integration-config-missing-dir`). Không có "suite mồ côi" chỉ chạy lặng
 *    lẽ dưới job unit.
 *
 * 2. **Suite app-owned không được chạy trùng ở tier unit.** Unit config include
 *    tới đâu thì tier unit chạy tới đó: thư mục mục đích bị include phủ mà
 *    không có exclude tương ứng là suite chạy HAI lần (cả `test` lẫn
 *    `test-integration`) (`integration-dir-in-unit-config`). Việc loại trừ
 *    nhận cả hai hình hợp lệ: exclude tường minh `tests/<purpose>/**`, hoặc
 *    include không phủ `tests/` (vd `src/**` của `apps/auth`).
 *
 * 3. **Tier unit không boot dependency thật.** Spec trong tier unit mà import
 *    driver `postgres` thật, testcontainers, `getPlatformProxy` của wrangler,
 *    CLI wrangler, hay kéo file từ thư mục mục đích vào — là spec integration
 *    đứng nhầm tầng (`unit-real-dependency-spec`, `lib-real-dependency-spec`).
 *    Lib không có tier integration riêng: nhà của nó là tier integration của
 *    app sở hữu (ruling #357; tiền lệ #298 PR-C cho auth-infrastructure).
 *
 * 4. **`passWithNoTests: false` trong mọi `vitest.integration.config.mts`.**
 *    Target integration tìm thấy 0 test phải đỏ lớn, không pass im lặng
 *    (`integration-pass-with-no-tests`). Unit config không bị lượt này đụng
 *    tới: giá trị hiện tại được giữ nguyên, danh sách exception nằm ở PR mô tả.
 *
 * 5. **Config không đọc được là lỗi, không phải skip.** Thiếu mảng include,
 *    JSON hỏng, file không đọc được ⇒ `unreadable-test-config` — fail-closed,
 *    không bỏ qua lặng lẽ project nào (cùng hợp đồng fail-closed với arch-check).
 *
 * Detection của nhóm (3) là **regex theo cú pháp import/call** trên nội dung
 * spec file, KHÔNG phải chạy hay typecheck: đơn giản, deterministic, offline,
 * và đủ vì mọi cách boot dependency thật trong repo này đều đi qua một import
 * nhận dạng được. Hạn chế được ghi rõ: marker không nhìn thấy cách boot mới
 * (vd spawn binary lạ) — khi xuất hiện, thêm marker ở `REAL_DEPENDENCY_MARKERS`
 * thay vì nới lỏng nhóm khác. Comment nhắc tên thư viện trong prose KHÔNG khớp
 * marker (marker neo vào `from '...'` / `import(...)` / call), nên spec unit
 * viết "testcontainers" trong chú thích vẫn xanh.
 *
 * Phạm vi: chỉ project root dưới `apps/` và `libs/`. `system-tests/` là các Nx
 * project độc lập tự định nghĩa target của mình (06 §4), `tools/` không có tier
 * test — cả hai ngoài hợp đồng này. Suite `tests/*.spec.ts` nằm PHẲNG (không
 * trong thư mục mục đích) không bị lượt này kết tội placement: xếp chúng vào
 * tier đúng là việc của các PR chuyển tier dưới #357, không phải của validator.
 *
 * Toàn bộ I/O đi qua `TestTargetFs` inject được: unit test dựng workspace tổng
 * hợp trong bộ nhớ, không spawn nx, không chạm repo thật. Production dùng
 * `createNodeTestTargetFs(ROOT_DIR)` — cùng hình dạng inject như lượt deployment
 * map đọc đĩa.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../utils.js';
import type { ArchProjectNode, ArchTagViolation } from './arch-tags.js';

/** Các thư mục mục đích app-owned dưới `apps/<app>/tests/` (06-testing.md §2). */
export const INTEGRATION_PURPOSE_DIRS = [
  'browser',
  'contracts',
  'databases',
  'integrations',
] as const;

/** Kind riêng của lượt test-target cho phép allowlist tạm thời che. */
export type TestTargetAllowlistKind = Extract<
  ArchTagViolation['kind'],
  'lib-real-dependency-spec' | 'unit-real-dependency-spec'
>;

export interface TestTargetAllowlistEntry {
  project: string;
  kind: TestTargetAllowlistKind;
  reason: string;
}

/**
 * Allowlist TẠM THỜI cho lượt test-target: che đúng vi phạm real-dependency
 * mà các PR chuyển tier dưới #357 chưa kịp sửa, để main giữ xanh cho mọi PR
 * khác trong lúc wave đang chạy.
 *
 * ⚠️ Cho phép tạm thời — xóa entry khi PR tương ứng merge, không gia hạn:
 * entry che 0 vi phạm trên cây bị báo `stale-test-target-allowlist-entry` ngay
 * (cùng cơ chế `stale-allowlist-entry` của lượt deployment map), nên việc PR
 * merge mà quên dọn entry là arch-check đỏ, không phải nợ vô hình.
 *
 * ⚠️ Độ tinh của entry là MỘT PR, không phải một file: mask theo
 * `{project, kind}` vì kế hoạch dọn dẹp là cả project cùng lượt chuyển tier;
 * mask theo file sẽ sinh stale lẻ tẻ giữa chừng và ép dọn nhiều lần vô nghĩa.
 * Hệ quả được chấp nhận có chủ đích: một real-dependency spec MỚI thêm vào
 * project đang nằm trong allowlist sẽ bị che luôn đến khi entry được xóa —
 * cửa sổ đó ngắn (đến khi PR tier merge) và PR tier chính là người đóng lại.
 *
 * Đã rỗng kể từ #385: entry cuối cùng (`transactional-mail` real-D1 suite
 * còn colocated ở `src/`) đã được chuyển tier sang `tests/integrations/`.
 * Mảng vẫn được giữ để cơ chế stale-detection sẵn sàng cho vi phạm kế tiếp.
 */
export const KNOWN_TEST_TARGET_VIOLATIONS: readonly TestTargetAllowlistEntry[] = [];

/**
 * Filesystem thuần cho lượt này: mọi path là TƯƠNG ĐỐI so với repo root mà fs
 * phục vụ. Injectable để unit test dựng workspace tổng hợp trong bộ nhớ mà
 * không chạm đĩa thật; production cài bằng `createNodeTestTargetFs(ROOT_DIR)`.
 */
export interface TestTargetFs {
  readFile(relativePath: string): string;
  exists(relativePath: string): boolean;
  /** Tên các thư mục con, đã sort; thư mục không tồn tại trả về mảng rỗng. */
  listDirs(relativePath: string): readonly string[];
  /** Tên các file, đã sort; thư mục không tồn tại trả về mảng rỗng. */
  listFiles(relativePath: string): readonly string[];
}

/** Cài production của `TestTargetFs` trên node:fs, gốc tại `rootDir`. */
export function createNodeTestTargetFs(rootDir: string = ROOT_DIR): TestTargetFs {
  const resolve = (relativePath: string): string => join(rootDir, relativePath);
  return {
    readFile(relativePath) {
      return readFileSync(resolve(relativePath), 'utf8');
    },
    exists(relativePath) {
      return existsSync(resolve(relativePath));
    },
    listDirs(relativePath) {
      try {
        // target es2022 không có toSorted: copy rồi sort tại chỗ (mảng mới
        // từ readdirSync, mutation chỉ chạm mảng mình sở hữu).
        const names = readdirSync(resolve(relativePath), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
        names.sort();
        return names;
      } catch {
        return [];
      }
    },
    listFiles(relativePath) {
      try {
        // target es2022 không có toSorted: copy rồi sort tại chỗ (mảng mới
        // từ readdirSync, mutation chỉ chạm mảng mình sở hữu).
        const names = readdirSync(resolve(relativePath), { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name);
        names.sort();
        return names;
      } catch {
        return [];
      }
    },
  };
}

/**
 * Marker real-dependency: mỗi marker một lý do "spec này không phải unit".
 * Neo vào cú pháp import/call thay vì tên trần để comment prose không khớp;
 * bổ sung marker mới ở đây thay vì thêm lượt kiểm riêng.
 */
export interface RealDependencyMarker {
  label: string;
  pattern: RegExp;
}

export const REAL_DEPENDENCY_MARKERS: readonly RealDependencyMarker[] = [
  // Driver PostgreSQL thật (postgres.js). `vi.mock('postgres')` KHÔNG khớp —
  // mock thay driver bằng giả là đúng tier unit; chỉ import thật mới khớp.
  {
    label: 'real PostgreSQL driver (postgres.js)',
    pattern: /(?:\bfrom\b|\bimport\b|\brequire\b)\s*\(?\s*['"]postgres['"]/u,
  },
  // testcontainers, cả bare package lẫn `@testcontainers/*`.
  {
    label: 'testcontainers',
    pattern: /(?:\bfrom\b|\bimport\b|\brequire\b)\s*\(?\s*['"]@?testcontainers/u,
  },
  // wrangler: `getPlatformProxy(` khởi động workerd in-process (generic hay không),
  // `from 'wrangler'` import module, và mọi hình gọi với literal `'wrangler'`
  // (`import('wrangler')`, `require('wrangler')`, `requireFromSpec('wrangler')`,
  // `.resolve('wrangler')` spawn CLI).
  {
    label: 'wrangler getPlatformProxy or wrangler CLI subprocess',
    pattern: /getPlatformProxy\s*[<(]|\bfrom\b\s*['"]wrangler['"]|\(\s*['"]wrangler['"]/u,
  },
];

/**
 * Nhãn + pattern của marker import chéo tier — KHÔNG nằm trong
 * `REAL_DEPENDENCY_MARKERS`: nó không khớp được thuần trên text của spec, mà
 * phải qua `crossTierImportMarkers` giải import MỘT BẬC rồi kiểm file được
 * import có cũng boot dependency thật không. Import fixture thuần (dữ liệu
 * test không boot gì) từ thư mục mục đích là hợp lệ — các spec unit của
 * push-notification import `fixture-ports.ts` trong `tests/integrations/`
 * và vẫn thuộc tier unit.
 *
 * Hạn chế đã biết: pattern neo vào literal `tests/<purpose>/` trong đường dẫn
 * import — spec nằm NGAY TRONG `tests/` mà import cùng cấp
 * (`./integrations/x`) không khớp. Hình đó hiện không tồn tại trong repo
 * (suite trong `tests/` là support/fixture, không import harness nào); nếu
 * xuất hiện, nó thuộc các PR chuyển tier của #357 trước khi đáng kiểm.
 */
export const CROSS_TIER_LABEL = 'import from an app-owned integration tier directory';

const CROSS_TIER_IMPORT_PATTERN =
  /(?:\bfrom\b|\bimport\b|\brequire\b)\s*\(?\s*['"]([^'"]*tests\/(?:integrations|databases|contracts|browser)\/[^'"]*)['"]/gu;

/** Trả về nhãn của mọi marker khớp trong nội dung một spec file. */
export function detectRealDependencyMarkers(specText: string): readonly string[] {
  return REAL_DEPENDENCY_MARKERS.filter((m) => m.pattern.test(specText)).map((m) => m.label);
}

/**
 * Marker của lượt import chéo tier, sau khi giải MỘT BẬC relative import.
 *
 * Import vào thư mục mục đích chỉ là vi phạm khi file được import cũng chứa
 * marker real-dependency (harness boot container/proxy) — import fixture dữ
 * liệu thuần từ thư mục đó hợp lệ. Path giải relative so với thư mục của spec
 * file, thử lần lượt đuôi `.ts`/`.mts`/`.js`/`.mjs` rồi `/index.*` như cách
 * TS resolve extensionless import.
 *
 * Import không resolve được ra file nào trên fs ⇒ BÁO vi phạm (fail-closed):
 * không chứng minh được import đó sạch, và import hỏng vào thư mục mục đích
 * tự thân đã là lỗi layout cần người nhìn thấy, không phải thứ để nuốt lặng lẽ.
 */
export function crossTierImportMarkers(
  specText: string,
  specDir: string,
  fs: TestTargetFs,
): readonly string[] {
  const markers: string[] = [];
  for (const match of specText.matchAll(CROSS_TIER_IMPORT_PATTERN)) {
    if (crossTierTargetHasMarker(match[1], specDir, fs)) {
      markers.push(CROSS_TIER_LABEL);
      break; // một import bẩn là đủ — không nhân bản nhãn theo số import
    }
  }
  return markers;
}

/** Path được import chạm thư mục mục đích và file đó có marker (hoặc không resolve được)? */
function crossTierTargetHasMarker(importPath: string, specDir: string, fs: TestTargetFs): boolean {
  const dir = resolveSpecDir(specDir, importPath);
  if (dir === undefined) return true; // path lạ (alias, package) — không giải được ⇒ fail-closed
  const candidates = [
    dir,
    `${dir}.ts`,
    `${dir}.mts`,
    `${dir}.js`,
    `${dir}.mjs`,
    `${dir}/index.ts`,
    `${dir}/index.mts`,
    `${dir}/index.js`,
  ];
  for (const candidate of candidates) {
    if (!fs.exists(candidate) || fs.listDirs(candidate).length > 0) continue;
    try {
      return detectRealDependencyMarkers(fs.readFile(candidate)).length > 0;
    } catch {
      return true; // tồn tại mà không đọc được — fail-closed
    }
  }
  return true; // không resolve ra file nào — fail-closed
}

/**
 * Path tuyệt đối (tương đối repo root) của module được import, giải relative so
 * với thư mục chứa spec file. Trả undefined khi path không phải relative import
 * (alias, bare specifier) — caller fail-closed.
 */
function resolveSpecDir(specDir: string, importPath: string): string | undefined {
  if (!importPath.startsWith('.')) return undefined;
  let up = 0;
  let rest = importPath;
  while (rest.startsWith('../')) {
    up += 1;
    rest = rest.slice(3);
  }
  rest = rest.replace(/^\.\//u, '');
  const parts = specDir.split('/');
  if (up > parts.length) return undefined;
  return parts
    .slice(0, parts.length - up)
    .concat(rest === '' ? [] : [rest])
    .join('/');
}

/** Bản tóm tắt phần `test` của một vitest config mà lượt này cần. */
export interface VitestConfigSummary {
  include: readonly string[];
  exclude: readonly string[];
  /** `passWithNoTests: true` xuất hiện tường minh trong config hay không. */
  passWithNoTestsExplicitTrue: boolean;
}

/**
 * Tóm tắt vitest config bằng regex trên TEXT config, không import config:
 * import chạy evaluate toàn bộ config (plugin vue, alias dò `.pnpm`…) — nặng,
 * phụ thuộc node_modules và có side effect. Các config trong repo viết include/
 * exclude theo một mẫu thống nhất (mảng string literal), đủ để regex đọc tin cậy;
 * đọc hỏng thì caller báo `unreadable-test-config` — fail-closed, không đoán tiếp.
 */
export function parseVitestConfig(text: string): VitestConfigSummary | undefined {
  const include = extractStringArray(text, 'include');
  if (include === undefined) return undefined;
  return {
    include,
    exclude: extractStringArray(text, 'exclude') ?? [],
    passWithNoTestsExplicitTrue: /passWithNoTests\s*:\s*true/u.test(text),
  };
}

/** Đọc mảng string literal của một field dạng `field: [...]`; thiếu field trả undefined. */
function extractStringArray(text: string, field: string): readonly string[] | undefined {
  const match = new RegExp(`${field}\\s*:\\s*\\[([^\\]]*)\\]`, 'u').exec(text);
  if (match === null) return undefined;
  const strings: string[] = [];
  for (const m of match[1].matchAll(/['"]([^'"]*)['"]/gu)) strings.push(m[1]);
  return strings;
}

/**
 * Thư mục nguồn của tier unit, suy từ mảng include của unit config: segment đầu
 * của mỗi entry, expansion brace group `{a,b}` thành a và b. Đây là tập thư mục
 * mà `nx test` của project quét spec — chính xác cho mọi config trong repo (mẫu
 * `{src,tests,…}/**` hoặc `src/**`); entry không suy được segment đầu (glob mở
 * đầu bằng dấu sao đôi) bị bỏ qua vì không xác định được thư mục gốc để dò.
 */
export function unitSourceDirs(include: readonly string[]): readonly string[] {
  const dirs = new Set<string>();
  for (const entry of include) {
    const brace = /^\{([^}]*)\}\//u.exec(entry);
    if (brace !== null) {
      for (const dir of brace[1].split(',')) {
        const trimmed = dir.trim();
        if (trimmed !== '') dirs.add(trimmed);
      }
      continue;
    }
    const literal = /^([A-Za-z0-9._$-]+)\//u.exec(entry);
    if (literal !== null) dirs.add(literal[1]);
  }
  // target es2022 không có toSorted: copy rồi sort tại chỗ.
  const sorted = [...dirs];
  sorted.sort();
  return sorted;
}

/**
 * Entry include có phủ `tests/<purpose>/` hay không, ở mức segment: `tests/**`
 * phủ mọi mục đích; `tests/<purpose>/**` chỉ phủ đúng mục đích đó; `src/**`
 * không phủ gì. Kiểm segment thay vì glob đầy đủ là đủ cho mẫu include thống
 * nhất của repo, và sai sót Parse theo hướng ồn (báo thừa vi phạm) chứ không
 * theo hướng im (nuốt vi phạm).
 */
export function includeCoversPurposeDir(entry: string, purpose: string): boolean {
  let firsts: readonly string[];
  let rest: string;
  const brace = /^\{([^}]*)\}\//u.exec(entry);
  if (brace !== null) {
    firsts = brace[1].split(',').map((s) => s.trim());
    rest = entry.slice(brace[0].length);
  } else {
    const slash = entry.indexOf('/');
    if (slash < 0) return false;
    firsts = [entry.slice(0, slash)];
    rest = entry.slice(slash + 1);
  }
  if (!firsts.includes('tests')) return false;
  if (rest.startsWith('**')) return true; // `tests/**/...` phủ mọi thư mục mục đích
  const secondBrace = /^\{([^}]*)\}\//u.exec(rest);
  if (secondBrace !== null) {
    return secondBrace[1]
      .split(',')
      .map((s) => s.trim())
      .includes(purpose);
  }
  const slash2 = rest.indexOf('/');
  const second = slash2 < 0 ? rest : rest.slice(0, slash2);
  return second === purpose;
}

/** Exclude entry của unit config có gỡ `tests/<purpose>/` khỏi tier unit không. */
function excludeCoversPurposeDir(exclude: readonly string[], purpose: string): boolean {
  return exclude.some(
    (e) => e === `tests/${purpose}/**` || e === `tests/${purpose}` || e === 'tests/**',
  );
}

const SPEC_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/u;

/**
 * Dò đệ quy các spec file dưới một thư mục, bỏ `node_modules` và các thư mục
 * nằm trong `skipDirPaths` (đường dẫn tương đối repo root). Bộ sưu tập `out`
 * được push vào theo thứ tự dò; caller sort lại trước khi báo cáo.
 */
function collectSpecFiles(
  fs: TestTargetFs,
  dirRel: string,
  skipDirPaths: ReadonlySet<string>,
  out: string[],
): void {
  for (const name of fs.listFiles(dirRel)) {
    if (SPEC_FILE.test(name)) out.push(`${dirRel}/${name}`);
  }
  for (const name of fs.listDirs(dirRel)) {
    if (name === 'node_modules') continue;
    const child = `${dirRel}/${name}`;
    if (skipDirPaths.has(child)) continue;
    collectSpecFiles(fs, child, skipDirPaths, out);
  }
}

/**
 * Lượt kiểm test-target trên toàn workspace app/lib.
 *
 * `projects` là project graph đã hợp nhất (cùng nguồn với các lượt khác —
 * `buildWorkspaceState`); chỉ field `name` và `root` được dùng. `fs` inject
 * được để unit test không chạm repo thật; `allowlist` inject được để test cơ
 * chế allowlist (stale/masked) trên fixture riêng mà không đụng allowlist thật
 * của repo — production dùng `KNOWN_TEST_TARGET_VIOLATIONS`.
 */
export function validateTestTargets(input: {
  projects: ReadonlyMap<string, ArchProjectNode>;
  fs?: TestTargetFs;
  allowlist?: readonly TestTargetAllowlistEntry[];
}): ArchTagViolation[] {
  const fs = input.fs ?? createNodeTestTargetFs(ROOT_DIR);
  const allowlist = input.allowlist ?? KNOWN_TEST_TARGET_VIOLATIONS;
  // Số vi phạm mỗi entry allowlist che — entry che 0 vi phạm là entry chết,
  // bị báo stale cuối lượt (cùng cơ chế với `findInvalidTargetRefs`).
  const masked = new Map<string, number>(
    allowlist.map((e) => [allowlistKey(e.project, e.kind), 0]),
  );
  const violations: ArchTagViolation[] = [];
  const report = (violation: ArchTagViolation): void => {
    const key = allowlistKey(violation.project, violation.kind);
    if (masked.has(key)) {
      masked.set(key, (masked.get(key) ?? 0) + 1);
      return;
    }
    violations.push(violation);
  };

  for (const project of input.projects.values()) {
    const root = project.root;
    // Node không có `root` (state dựng tay trong test): không biết project nằm
    // ở đâu trên đĩa thì không đoán — các lượt đọc graph đã báo dữ liệu thiếu.
    if (root === undefined) continue;
    const isApp = root.startsWith('apps/');
    if (!isApp && !root.startsWith('libs/')) continue;

    const purposeDirs = isApp
      ? INTEGRATION_PURPOSE_DIRS.filter((p) => fs.exists(`${root}/tests/${p}`))
      : [];

    // (1)+(2)+(4) Tier integration của app: target, config, không chạy trùng.
    if (purposeDirs.length > 0) {
      const dirList = purposeDirs.map((p) => `${root}/tests/${p}/`).join(', ');
      const targets = readNxTargets(fs, `${root}/package.json`);
      if (targets === undefined || !Object.hasOwn(targets, 'test-integration')) {
        report({
          project: project.name,
          kind: 'missing-integration-target',
          detail:
            `${dirList} exist on disk but package.json declares no ` +
            `test-integration target under nx.targets (docs/architecture/06-testing.md §4)`,
        });
      }

      const integrationConfigPath = `${root}/vitest.integration.config.mts`;
      if (!fs.exists(integrationConfigPath)) {
        report({
          project: project.name,
          kind: 'missing-integration-config',
          detail:
            `${integrationConfigPath} is missing but ${dirList} exist; ` +
            `the suites have no integration config of their own (docs/architecture/06-testing.md §4)`,
        });
      } else {
        const text = readOrReportUnreadable(fs, integrationConfigPath, project.name, report);
        const parsed = text === undefined ? undefined : parseVitestConfig(text);
        if (text !== undefined && parsed === undefined) {
          reportUnreadable(project.name, integrationConfigPath, report);
        } else if (parsed !== undefined) {
          for (const purpose of purposeDirs) {
            if (!parsed.include.some((e) => includeCoversPurposeDir(e, purpose))) {
              report({
                project: project.name,
                kind: 'integration-config-missing-dir',
                detail:
                  `${integrationConfigPath} does not include tests/${purpose}/**; the target would ` +
                  `silently skip the suite living there (docs/architecture/06-testing.md §4)`,
              });
            }
          }
          if (parsed.passWithNoTestsExplicitTrue) {
            report({
              project: project.name,
              kind: 'integration-pass-with-no-tests',
              detail:
                `${integrationConfigPath} sets passWithNoTests: true; an integration target finding ` +
                `nothing must fail loud (docs/architecture/06-testing.md §4)`,
            });
          }
        }
      }
    }

    // (2) Thư mục mục đích bị unit config include mà không bị exclude — suite
    // chạy HAI lần. Chỉ áp cho app: lib không có thư mục mục đích.
    const unitConfigPath = `${root}/vitest.config.mts`;
    if (!fs.exists(unitConfigPath)) continue; // không có test target suy ra — không có tier unit để kiểm
    const unitText = readOrReportUnreadable(fs, unitConfigPath, project.name, report);
    if (unitText === undefined) continue;
    const unit = parseVitestConfig(unitText);
    if (unit === undefined) {
      reportUnreadable(project.name, unitConfigPath, report);
      continue;
    }
    if (isApp) {
      for (const purpose of purposeDirs) {
        const covered = unit.include.some((e) => includeCoversPurposeDir(e, purpose));
        if (covered && !excludeCoversPurposeDir(unit.exclude, purpose)) {
          report({
            project: project.name,
            kind: 'integration-dir-in-unit-config',
            detail:
              `${unitConfigPath} includes tests/${purpose}/ without excluding it; the suite would run ` +
              `in both test and test-integration (docs/architecture/06-testing.md §4)`,
          });
        }
      }
    }

    // (3) Spec real-dependency trong tier unit: dò spec file dưới mọi thư mục
    // nguồn mà unit include phủ, trừ thư mục mục đích (nhà hợp lệ của suite
    // real-dependency). Project không có unit config đã `continue` ở trên.
    const skipDirPaths = new Set<string>(INTEGRATION_PURPOSE_DIRS.map((p) => `${root}/tests/${p}`));
    const specFiles: string[] = [];
    for (const dir of unitSourceDirs(unit.include)) {
      const dirRel = `${root}/${dir}`;
      // Include khai thư mục chưa tồn tại trên đĩa (vd `tests/` rỗng hoặc dự
      // phòng) — không phải lỗi layout, chỉ không có gì để dò.
      if (!fs.exists(dirRel)) continue;
      collectSpecFiles(fs, dirRel, skipDirPaths, specFiles);
    }
    for (const file of specFiles) {
      let text: string;
      try {
        text = fs.readFile(file);
      } catch {
        report({
          project: project.name,
          kind: 'unreadable-test-config',
          detail: `${file} could not be read; arch-check fails closed on unreadable spec files`,
        });
        continue;
      }
      const markers = [
        ...detectRealDependencyMarkers(text),
        // Marker chéo tier không khớp thuần regex — cần fs để giải import MỘT
        // BẬC và kiểm file được import cũng boot dependency thật (import
        // fixture dữ liệu thuần từ thư mục mục đích là hợp lệ).
        ...crossTierImportMarkers(text, file.slice(0, file.lastIndexOf('/')), fs),
      ];
      if (markers.length === 0) continue;
      report({
        project: project.name,
        kind: isApp ? 'unit-real-dependency-spec' : 'lib-real-dependency-spec',
        detail:
          `${file}: real-dependency spec in the unit tier (${markers.join('; ')}); ` +
          (isApp
            ? 'its home is tests/integrations/ of the owning app'
            : "its home is the owning app's integration tier") +
          ' (docs/architecture/06-testing.md §4, §9)',
      });
    }
  }

  // Allowlist chết: entry không còn che vi phạm nào trên cây hiện tại. Báo để
  // entry bị xóa CÙNG lúc fix của nó vào main, không thành đường miễn trừ vĩnh viễn.
  for (const entry of allowlist) {
    if ((masked.get(allowlistKey(entry.project, entry.kind)) ?? 0) === 0) {
      violations.push({
        project: entry.project,
        kind: 'stale-test-target-allowlist-entry',
        detail:
          `allowlist entry masks no violation on the current tree (${entry.reason}); ` +
          `remove the entry together with the fix it was seeded for`,
      });
    }
  }

  return sortViolations(violations);
}

/** Đọc file; hỏng thì báo `unreadable-test-config` và trả undefined (fail-closed). */
function readOrReportUnreadable(
  fs: TestTargetFs,
  path: string,
  project: string,
  report: (violation: ArchTagViolation) => void,
): string | undefined {
  try {
    return fs.readFile(path);
  } catch {
    report({
      project,
      kind: 'unreadable-test-config',
      detail: `${path} exists but could not be read; arch-check fails closed on unreadable test configs`,
    });
    return undefined;
  }
}

/** Config thiếu mảng include — regex không đọc được cấu trúc đã thống nhất của repo. */
function reportUnreadable(
  project: string,
  path: string,
  report: (violation: ArchTagViolation) => void,
): void {
  report({
    project,
    kind: 'unreadable-test-config',
    detail:
      `${path} has no include array arch-check can parse; test configs follow a fixed shape ` +
      `and failing to read one is a fail-closed error, not a skip`,
  });
}

/** Đọc `nx.targets` của package.json; undefined khi file hỏng — caller báo thiếu target. */
function readNxTargets(fs: TestTargetFs, path: string): Record<string, unknown> | undefined {
  try {
    const pkg = JSON.parse(fs.readFile(path)) as {
      nx?: { targets?: Record<string, unknown> };
    };
    return pkg.nx?.targets;
  } catch {
    return undefined;
  }
}

function allowlistKey(project: string, kind: string): string {
  return `${project}\u0000${kind}`;
}

/**
 * Sắp thứ tự báo cáo ổn định: lượt đọc Map theo insertion order của graph nên
 * thứ tự project không bảo đảm — output của arch-check phải deterministic.
 */
function sortViolations(violations: readonly ArchTagViolation[]): ArchTagViolation[] {
  // target es2022 không có toSorted: copy rồi sort tại chỗ.
  const sorted = [...violations];
  sorted.sort((a, b) =>
    a.project === b.project
      ? a.kind === b.kind
        ? a.detail.localeCompare(b.detail)
        : a.kind.localeCompare(b.kind)
      : a.project.localeCompare(b.project),
  );
  return sorted;
}
