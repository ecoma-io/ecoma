/**
 * Dựng lời gọi Docker cho bước giải quyết superadmin của entry này — module
 * THUẦN TÚNH: không I/O, không exec, chỉ dựng argv + env từ đầu vào đã có.
 * Tách khỏi `local.ts` vì entry đó tự chạy `main()` ở module top-level —
 * spec colocated import thẳng vào là đánh giá side-effect của cả lane, không
 * phải unit test. Phần impure (đọc password migrator cross-stack, đọc output
 * `networkName` của platform) nằm ở entry và truyền kết quả vào hàm ở đây.
 *
 * Bước này giống `deploys/pact-broker-api-deploy/superadmin-resolver.ts` về
 * bản chất: remote-cache không có tài khoản quản trị riêng — tenant canonical
 * `ecoma` được gán cho chủ thể administrator của nền tảng (đã bootstrap bởi
 * account/staff-access), nên `CANONICAL_TENANT_OWNER_SUB` được giải từ CÙNG
 * dx runner (`bootstrap-superadmin --resolve-if-bootstrapped`) trên CÙNG hai
 * database (`db-account`, `db-staff-access`). Bản sao có chủ đích, giữ cùng
 * contract với lane pact để hai entry không trôi lệch.
 *
 * Ranh giới credential của bước này (finding review #3 của lane pact): argv
 * của process Docker KHÔNG được chứa giá trị DATABASE_URL — argv đọc được bởi
 * mọi process cùng user qua `/proc/<pid>/cmdline` và `ps` (cùng lớp rò rỉ mà
 * repo đã chặn cho `pulumi config set` bằng kênh stdin). Giá trị chỉ sống
 * trong env của process docker; argv Docker mang TÊN biến dạng `-e TÊN`
 * (pass-through env — Docker copy biến đó từ env của process CLI vào
 * container).
 */

import type { EntryFoundation } from '@ecoma-io/deployment';

/**
 * Image Node pin (theo DIGEST) để chạy dx runner trong container gắn platform
 * network — bản sao chữ-số-chữ của `NODE_IMAGE` trong `index.ts`. KHÔNG import
 * index.ts để dùng chung: file đó là chương trình Pulumi, import là đánh giá
 * toàn bộ resource graph tại thời điểm load.
 */
export const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

/** Alias DNS của PostgreSQL platform trong network nội bộ (giống index.ts). */
export const POSTGRES_HOST = 'ecoma-postgres';

/** Tham chiếu tự khai của lane local cho bước superadmin (ADR-0021 Quyết định 6). */
export const LANE_OPERATOR_REF = 'local-lane';

/** Role + database migrator của hai service mà bước superadmin chạm tới. */
export const ACCOUNT_MIGRATOR_ROLE = 'ecoma_account_migrator';
export const ACCOUNT_DATABASE = 'db-account';
export const STAFF_ACCESS_MIGRATOR_ROLE = 'ecoma_staff_access_migrator';
export const STAFF_ACCESS_DATABASE = 'db-staff-access';

/**
 * Tên biến env của container mang DATABASE_URL — argv Docker chỉ mang TÊN này
 * (`-e TÊN`, không `=giá trị`); giá trị thật đi qua env của process docker.
 */
export const ACCOUNT_DATABASE_URL_ENV = 'ECOMA_ACCOUNT_DATABASE_URL';
export const STAFF_ACCESS_DATABASE_URL_ENV = 'ECOMA_STAFF_ACCESS_DATABASE_URL';

/**
 * Database URL của role migrator — mật khẩu percent-encoded trước khi ghép vào
 * userinfo (mật khẩu sinh ngẫu nhiên có thể chứa `@ : / ? #`), đúng cơ chế mà
 * chương trình Pulumi (`index.ts`) dùng cho các URL tương tự.
 */
export function buildMigratorDatabaseUrl(role: string, password: string, database: string): string {
  return `postgresql://${role}:${encodeURIComponent(password)}@${POSTGRES_HOST}:5432/${database}`;
}

/** Kết quả dựng lời gọi Docker cho bước superadmin. */
export interface SuperadminResolverInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/**
 * Dựng argv + env + cwd cho `docker run` của dx runner.
 *
 * Kênh credential: hai DATABASE_URL đi vào env của PROCESS docker
 * (`{ ...foundation.env, ... }` — cùng env mà mọi lệnh Pulumi của entry dùng),
 * argv chỉ mang TÊN biến dạng `-e TÊN` và Docker copy giá trị từ env của CLI
 * vào container. `worktreeRoot` đến từ `foundation.ctx` (resolveEntryFoundation)
 * — KHÔNG đọc stack config ở đây: entry chạy ngoài `pulumi up`,
 * `namespace:worktreeRoot` chỉ được truyền bằng `--config` cho chương trình
 * Pulumi bên trong (local-entry).
 */
export function buildSuperadminResolverInvocation(
  foundation: EntryFoundation,
  networkName: string,
  accountUrl: string,
  staffUrl: string,
): SuperadminResolverInvocation {
  const { worktreeRoot } = foundation.ctx;
  return {
    args: [
      'run',
      '--rm',
      '--network',
      networkName,
      '-v',
      `${worktreeRoot}:/repo:ro`,
      '-v',
      `${worktreeRoot}/node_modules:/repo/node_modules`,
      '-w',
      '/repo',
      '-e',
      ACCOUNT_DATABASE_URL_ENV,
      '-e',
      STAFF_ACCESS_DATABASE_URL_ENV,
      NODE_IMAGE,
      '/repo/node_modules/.bin/tsx',
      '/repo/tools/dx/index.ts',
      'bootstrap-superadmin',
      '--resolve-if-bootstrapped',
      '--json',
      '--operator-ref',
      LANE_OPERATOR_REF,
    ],
    env: {
      ...foundation.env,
      [ACCOUNT_DATABASE_URL_ENV]: accountUrl,
      [STAFF_ACCESS_DATABASE_URL_ENV]: staffUrl,
    },
    cwd: worktreeRoot,
  };
}
