import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROOT_DIR } from './utils.js';

/**
 * Đọc pattern từ root `.dockerignore` thật để mọi case bên dưới đều chạy trên
 * nội dung file đang hiệu lực — sửa file là spec tự chạy lại trên pattern mới.
 */
const PATTERNS = readFileSync(join(ROOT_DIR, '.dockerignore'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'));

/**
 * Matcher thu nhỏ đúng ngữ nghĩa của Docker cho file `.dockerignore`.
 *
 * Docker build context đi cây file theo chiều từ root: khi một thư mục bị
 * loại, cả subtree của nó bị cắt khỏi walk, trừ khi một pattern `!` khớp sâu
 * hơn đưa nó (hoặc một ancestor sâu hơn của nó) trở lại. Matcher dưới đây lặp
 * lại đúng hành vi prune đó trên đường dẫn string thay vì đi cây thật:
 *
 * 1. Với mỗi ancestor (gần root → gần leaf, bao gồm cả path), tìm rule CUỐI
 *    CÙNG trong file khớp ancestor — "last matching pattern wins".
 * 2. Nếu verdict của ancestor là EXCLUDE, path bị loại, TRỪ khi một ancestor
 *    sâu hơn (hoặc chính path) có verdict INCLUDE — khi đó subtree từ ancestor
 *    đó được coi là "đã mở lại" và walk tiếp tục từ đó.
 * 3. Rule không có dấu `!` là EXCLUDE, có `!` là INCLUDE; `#` là comment (đã
 *    lọc khi đọc file); glob `*` không vượt `/`, `**` khớp 0+ segment (nên
 *    pattern `**` + `/x` khớp cả `x` nằm ngay root), `?` khớp đúng một ký tự
 *    khác `/`.
 */
type Rule = { readonly pattern: string; readonly include: boolean; readonly regex: RegExp };

/** Escape một đoạn glob (đã tách `*`/`**`) thành literal regex an toàn. */
function escapeLiteral(literal: string): string {
  let out = '';
  for (const char of literal) {
    out += /[a-zA-Z0-9_/-]/u.test(char) ? char : `\\${char}`;
  }
  return out;
}

/** Quy một segment glob (không chứa `**`) thành regex, không khớp xuyên `/`. */
function globSegmentToRegex(segment: string): string {
  let out = '';
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    if (char === '*') {
      out += '[^/]*';
    } else if (char === '?') {
      out += '[^/]';
    } else if (char !== undefined) {
      out += escapeLiteral(char);
    }
  }
  return out;
}

function compile(patternLine: string): Rule {
  // Docker bỏ qua `/` đầu pattern (pattern là path tương đối với context root)
  // và một pattern kết thúc `/` vẫn khớp file bên trong thư mục, nên không cần
  // xử lý riêng trường hợp thư mục — regex khớp path file lẫn path thư mục.
  const include = patternLine.startsWith('!');
  const pattern = include ? patternLine.slice(1) : patternLine;
  const stripped = pattern.startsWith('/') ? pattern.slice(1) : pattern;
  const segments = stripped.split('/');
  const source = segments
    .map((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === '**') {
        if (last) return '.*';
        // `**` đứng đầu khớp cả trường hợp 0 thư mục (path nằm ngay root);
        // `**` ở giữa khớp 0+ thư mục trung gian.
        return index === 0 ? '(?:.*/)?' : '(?:[^/]+/)*';
      }
      return `${globSegmentToRegex(segment)}${last ? '' : '/'}`;
    })
    .join('');
  return { pattern, include, regex: new RegExp(`^${source}$`, 'u') };
}

function lastMatch(rules: readonly Rule[], candidatePath: string): Rule | undefined {
  let found: Rule | undefined;
  for (const rule of rules) {
    if (rule.regex.test(candidatePath)) found = rule;
  }
  return found;
}

/** Verdict cuối của một path: EXCLUDE khi rule cuối khớp là exclude (không rule nào khớp thì mặc định là giữ). */
function finalInclude(rules: readonly Rule[], candidatePath: string): boolean {
  const rule = lastMatch(rules, candidatePath);
  return rule === undefined || rule.include;
}

/**
 * Chỉ một INCLUDE TƯỜNG MINH (có rule cuối khớp và rule đó là `!`) mới mở lại
 * subtree — Docker không thể match một file mà walk đã cắt khỏi cây, nên
 * "không rule nào khớp" ở node sâu hơn không cứu được node cha bị loại.
 */
function explicitInclude(rules: readonly Rule[], candidatePath: string): boolean {
  const rule = lastMatch(rules, candidatePath);
  return rule !== undefined && rule.include;
}

function isExcluded(candidatePath: string): boolean {
  const rules = PATTERNS.map(compile);
  // Duyệt ancestor gần root → gần leaf: ancestor nào verdict EXCLUDE thì
  // subtree của nó bị cắt, trừ khi một ancestor sâu hơn (hoặc chính path) được
  // INCLUDE tường minh — khi đó walk tiếp tục từ ancestor đó như một gốc mới
  // đã mở. Mirror đúng walk prune của Docker trên cây context.
  const segments = candidatePath.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    if (finalInclude(rules, segments.slice(0, i + 1).join('/'))) continue;
    let reopened = false;
    for (let j = i + 1; j < segments.length; j += 1) {
      if (explicitInclude(rules, segments.slice(0, j + 1).join('/'))) {
        reopened = true;
        i = j;
        break;
      }
    }
    if (!reopened) return true;
  }
  return false;
}

describe('root .dockerignore: matcher semantics', () => {
  it('last matching pattern wins', () => {
    const rules = ['a/*', '!a/keep.txt'].map(compile);
    expect(finalInclude(rules, 'a/keep.txt')).toBe(true);
    expect(finalInclude(rules, 'a/drop.txt')).toBe(false);
  });

  it('negation with ! re-includes', () => {
    const rules = ['*.log', '!keep.log'].map(compile);
    expect(finalInclude(rules, 'keep.log')).toBe(true);
  });

  it('* does not cross / and ** crosses', () => {
    const doubleStar = compile('**/node_modules');
    expect(doubleStar.regex.test('node_modules')).toBe(true);
    expect(doubleStar.regex.test('apps/home/node_modules')).toBe(true);
    expect(doubleStar.regex.test('node_modulesx')).toBe(false);
    const star = compile('apps/*');
    expect(star.regex.test('apps/home')).toBe(true);
    expect(star.regex.test('apps/home/app.vue')).toBe(false);
  });

  it('excluding a directory excludes its subtree', () => {
    const rules = ['apps/*'].map(compile);
    expect(finalInclude(rules, 'apps/account')).toBe(false);
    // App không nằm trong whitelist của `.dockerignore` thật (`apps/auth` —
    // deploy local của nó là worker, không qua image này): subtree bị loại.
    expect(isExcluded('apps/auth/src/x.ts')).toBe(true);
  });

  it('re-included directory makes its subtree includable again', () => {
    // Cùng trình tự `tools/*` → `!tools/dx` → `tools/dx/*` → `!tools/dx/
    // package.json` như trong file thật, chạy trên matcher thuần: thư mục
    // `tools/dx` được mở lại tường minh nên subtree của nó trở nên khả dĩ,
    // còn file cụ thể nào được INCLUDE tường minh thì thắng `tools/dx/*`.
    const rules = ['tools/*', '!tools/dx', 'tools/dx/*', '!tools/dx/package.json'].map(compile);
    expect(explicitInclude(rules, 'tools/dx')).toBe(true);
    expect(finalInclude(rules, 'tools/dx')).toBe(true);
    expect(finalInclude(rules, 'tools/dx/src')).toBe(false);
    expect(finalInclude(rules, 'tools/dx/package.json')).toBe(true);
    expect(finalInclude(rules, 'tools/other')).toBe(false);
  });
});

describe('root .dockerignore: sensitive paths are excluded', () => {
  it('env files and pulumi state never enter the context', () => {
    expect(isExcluded('.env')).toBe(true);
    expect(isExcluded('apps/home/.env.local')).toBe(true);
    expect(isExcluded('.pulumi-local-state/.pulumi/stacks/platform-deploy/local-x.json')).toBe(
      true,
    );
    expect(isExcluded('.pulumi/credentials.json')).toBe(true);
    expect(isExcluded('Pulumi.local-wabc.yaml')).toBe(true);
    expect(isExcluded('deploys/Pulumi.local-wabc.yaml')).toBe(true);
    expect(isExcluded('.pulumi-local-passphrase')).toBe(true);
    expect(isExcluded('deploys/platform-deploy/.pulumi-local-passphrase')).toBe(true);
  });

  it('local TLS private key and VCS metadata never enter the context', () => {
    expect(isExcluded('deploys/platform-deploy/local-certs/fbi.com.key')).toBe(true);
    expect(isExcluded('.git/config')).toBe(true);
  });

  it('dependency trees, sibling workspaces and build output never enter the context', () => {
    expect(isExcluded('node_modules/x/index.js')).toBe(true);
    expect(isExcluded('apps/home/node_modules/x/index.js')).toBe(true);
    expect(isExcluded('apps/other-app/src/x.ts')).toBe(true);
    expect(isExcluded('libs/other-lib/src/x.ts')).toBe(true);
    expect(isExcluded('tools/dx/src/index.spec.ts')).toBe(true);
    expect(isExcluded('docs/README.md')).toBe(true);
    expect(isExcluded('apps/home/.output/server/index.mjs')).toBe(true);
    expect(isExcluded('dist/x.js')).toBe(true);
  });
});

describe('root .dockerignore: required build inputs are included', () => {
  it('workspace manifests, lockfile and patches enter the context', () => {
    expect(isExcluded('pnpm-workspace.yaml')).toBe(false);
    expect(isExcluded('package.json')).toBe(false);
    expect(isExcluded('pnpm-lock.yaml')).toBe(false);
    expect(isExcluded('patches/@nx__js@23.3.0.patch')).toBe(false);
  });

  it('home app, ui-ecoma-logo and dx manifest enter the context', () => {
    expect(isExcluded('tools/dx/package.json')).toBe(false);
    expect(isExcluded('apps/home/package.json')).toBe(false);
    expect(isExcluded('apps/home/.npmrc')).toBe(false);
    expect(isExcluded('apps/home/app/app.vue')).toBe(false);
    expect(isExcluded('apps/home/server/routes/index.get.ts')).toBe(false);
    expect(isExcluded('libs/ui-ecoma-logo/package.json')).toBe(false);
    expect(isExcluded('libs/ui-ecoma-logo/src/index.ts')).toBe(false);
    expect(isExcluded('tsconfig.base.json')).toBe(false);
  });

  it('backoffice app and backoffice-domain enter the context', () => {
    expect(isExcluded('apps/backoffice/package.json')).toBe(false);
    expect(isExcluded('apps/backoffice/.npmrc')).toBe(false);
    expect(isExcluded('apps/backoffice/nuxt.config.ts')).toBe(false);
    expect(isExcluded('libs/backoffice-domain/src/index.ts')).toBe(false);
    // Hai libs DDD layer mới của backoffice (#316): app import trực tiếp,
    // Dockerfile COPY — thiếu whitelist là image build chết "not found".
    expect(isExcluded('libs/backoffice-application/src/index.ts')).toBe(false);
    expect(isExcluded('libs/backoffice-infrastructure/src/index.ts')).toBe(false);
  });

  it('backoffice colocated specs never enter the context — they import the excluded tests/ helpers', () => {
    // #277 colocated specs dưới `app/**`; `nuxt build` typecheck (loại trừ
    // specs không được set) chết TS2307 nếu specs vào context mà helper
    // `tests/` thì bị loại (`../tests/nuxt-globals`, `../../tests/harness`,
    // `../../tests/fake-adapter`, `../../tests/nuxt-app-state`).
    expect(isExcluded('apps/backoffice/app/app-locale.spec.ts')).toBe(true);
    expect(isExcluded('apps/backoffice/app/composables/use-async-state.spec.ts')).toBe(true);
    expect(isExcluded('apps/backoffice/app/pages/pages-data-states.spec.ts')).toBe(true);
    // Spec e2e/app-owned suite/server không tham chiếu helper `tests/` —
    // chúng có thể vào context; assertion này ghim rằng dòng mới KHÔNG dập
    // cả subtree `app/`.
    expect(isExcluded('apps/backoffice/app/app.vue')).toBe(false);
  });

  it('account app and account libs enter the context', () => {
    expect(isExcluded('apps/account/package.json')).toBe(false);
    expect(isExcluded('apps/account/.npmrc')).toBe(false);
    expect(isExcluded('apps/account/nuxt.config.ts')).toBe(false);
    expect(isExcluded('libs/account-contracts/src/index.ts')).toBe(false);
    expect(isExcluded('libs/auth-contracts/src/index.ts')).toBe(false);
    // Account re-export lib này (dependency qua `package.json` và project
    // reference qua `tsconfig.lib.json`), nên nó cũng là input của image account.
    expect(isExcluded('libs/internal-auth-contracts/src/index.ts')).toBe(false);
    expect(isExcluded('libs/account-domain/src/index.ts')).toBe(false);
    expect(isExcluded('libs/transactional-mail-contracts/src/index.ts')).toBe(false);
  });

  it('staff-access contracts enter the context', () => {
    expect(isExcluded('libs/staff-access-contracts/package.json')).toBe(false);
    expect(isExcluded('libs/staff-access-contracts/src/index.ts')).toBe(false);
  });

  it('pact-broker-app and its ui closure enter the context', () => {
    expect(isExcluded('apps/pact-broker-app/package.json')).toBe(false);
    expect(isExcluded('apps/pact-broker-app/.npmrc')).toBe(false);
    expect(isExcluded('apps/pact-broker-app/nuxt.config.ts')).toBe(false);
    expect(isExcluded('apps/pact-broker-app/server/routes/health.get.ts')).toBe(false);
    // Hai lib trong closure của app — alias tường minh trong `nuxt.config.ts`
    // trỏ thẳng vào `src/index.ts` của từng lib, nên cả hai phải nằm trong
    // context (closure dừng ở đây: hai lib là lá, không tham chiếu workspace
    // package nào khác).
    expect(isExcluded('libs/ui-app-shell/package.json')).toBe(false);
    expect(isExcluded('libs/ui-app-shell/src/index.ts')).toBe(false);
    expect(isExcluded('libs/ui-app-shell/src/styles/app-shell.css')).toBe(false);
    expect(isExcluded('libs/ui-ecoma-logo/src/index.ts')).toBe(false);
    // Giữ assertion sibling excluded — lib ngoài closure không có lý do vào
    // context của image nào.
    expect(isExcluded('libs/other-lib/src/x.ts')).toBe(true);
  });

  it('pact-broker-app test sources and test configs never enter the context', () => {
    expect(isExcluded('apps/pact-broker-app/tests/broker-config.spec.ts')).toBe(true);
    expect(isExcluded('apps/pact-broker-app/vitest.config.mts')).toBe(true);
  });

  it('account test sources and test configs never enter the context', () => {
    expect(isExcluded('apps/account/tests/unit/bindings.spec.ts')).toBe(true);
    expect(isExcluded('apps/account/vitest.config.mts')).toBe(true);
    expect(isExcluded('apps/account/tsconfig.db.json')).toBe(true);
    expect(isExcluded('apps/account/tsconfig.spec.json')).toBe(true);
  });

  it('auth WIC entrypoint enters the context while the rest of deploys stays out', () => {
    // Image WIC COPY đúng một file của `deploys/` (wic-entrypoint.sh); mọi
    // resource Pulumi khác của thư mục này không thuộc build context.
    expect(isExcluded('deploys/auth-deploy/wic-entrypoint.sh')).toBe(false);
    expect(isExcluded('deploys/auth-deploy/index.ts')).toBe(true);
    expect(isExcluded('deploys/auth-deploy/Dockerfile')).toBe(true);
    expect(isExcluded('deploys/account-deploy/index.ts')).toBe(true);
    expect(isExcluded('deploys/platform-deploy/index.ts')).toBe(true);
  });

  it('pact-broker-api WIC entrypoint enters the context while its Pulumi program stays out', () => {
    // Image WIC thứ hai (pact-broker-api-deploy) COPY đúng một file của
    // `deploys/` — cùng trình tự re-include với auth-deploy phía trên; thiếu
    // dòng `!` trong `.dockerignore` là `docker build` chết ngay ở COPY
    // (bài học #228: COPY path ngoài context là lỗi build, không phải warning).
    expect(isExcluded('deploys/pact-broker-api-deploy/wic-entrypoint.sh')).toBe(false);
    expect(isExcluded('deploys/pact-broker-api-deploy/index.ts')).toBe(true);
    expect(isExcluded('deploys/pact-broker-api-deploy/Dockerfile')).toBe(true);
    expect(isExcluded('deploys/pact-broker-api-deploy/package.json')).toBe(true);
  });

  it('mail WIC entrypoint enters the context while the rest of its deploy stays out', () => {
    // Image WIC của transactional-mail-deploy COPY đúng một file thứ hai của
    // `deploys/` — cùng trình tự re-include với auth-deploy phía trên.
    expect(isExcluded('deploys/transactional-mail-deploy/wic-entrypoint.sh')).toBe(false);
    expect(isExcluded('deploys/transactional-mail-deploy/index.ts')).toBe(true);
    expect(isExcluded('deploys/transactional-mail-deploy/Dockerfile')).toBe(true);
  });

  it('staff-access WIC entrypoint enters the context while the rest of its deploy stays out', () => {
    // Image WIC của staff-access-deploy (P1.4 #428) COPY đúng một file nữa của
    // `deploys/` — cùng trình tự re-include; thiếu dòng `!` là `docker build`
    // chết ngay ở COPY với lỗi "not found" trong CI (không tái hiện local khi
    // build bằng context khác).
    expect(isExcluded('deploys/staff-access-deploy/wic-entrypoint.sh')).toBe(false);
    expect(isExcluded('deploys/staff-access-deploy/index.ts')).toBe(true);
    expect(isExcluded('deploys/staff-access-deploy/Dockerfile')).toBe(true);
    expect(isExcluded('deploys/staff-access-deploy/package.json')).toBe(true);
  });

  it('remote-cache WIC entrypoint enters the context while the rest of its deploy stays out', () => {
    // Image WIC của remote-cache-deploy (P4.1 #442) COPY đúng một file nữa của
    // `deploys/` — cùng trình tự re-include; thiếu dòng `!` là `docker build`
    // chết ngay ở COPY với lỗi "not found" trong CI.
    expect(isExcluded('deploys/remote-cache-deploy/wic-entrypoint.sh')).toBe(false);
    expect(isExcluded('deploys/remote-cache-deploy/index.ts')).toBe(true);
    expect(isExcluded('deploys/remote-cache-deploy/Dockerfile')).toBe(true);
    expect(isExcluded('deploys/remote-cache-deploy/package.json')).toBe(true);
  });
});
