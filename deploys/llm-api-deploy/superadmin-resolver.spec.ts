/**
 * Spec của module thuần túy dựng lời gọi Docker cho bước superadmin.
 *
 * Contract cốt lõi (finding review #3): giá trị credential (DATABASE_URL chứa
 * mật khẩu migrator) KHÔNG được nằm trong argv của process `docker` — argv đọc
 * được bởi mọi process cùng user qua `/proc/<pid>/cmdline` và `ps`. Giá trị
 * phải sống trong env của process docker, còn argv chỉ mang TÊN biến dạng
 * `-e TÊN` (pass-through env). Spec chấm đúng điểm đó trên argv/env do
 * `buildSuperadminResolverInvocation` sinh ra.
 */
import { describe, expect, it } from 'vitest';

import type { EntryFoundation } from '@ecoma-io/deployment';

import {
  ACCOUNT_DATABASE,
  ACCOUNT_DATABASE_URL_ENV,
  ACCOUNT_MIGRATOR_ROLE,
  buildMigratorDatabaseUrl,
  buildSuperadminResolverInvocation,
  NODE_IMAGE,
  STAFF_ACCESS_DATABASE,
  STAFF_ACCESS_DATABASE_URL_ENV,
  STAFF_ACCESS_MIGRATOR_ROLE,
} from './superadmin-resolver.js';

/** Foundation hình đúng EntryFoundation — chỉ `worktreeRoot` + vài biến env gốc. */
const foundation: EntryFoundation = {
  ctx: {
    worktreeRoot: '/tmp/wt',
    namespace: 'w0123456789ab',
    stackName: 'local-w0123456789ab',
    stateUrl: 'file:///tmp/wt/.pulumi-local-state',
  },
  // Env gốc có chủ đích mang biến PATH + biến Pulumi: phải thấy chúng trong env
  // trả về (case inheritance), không chỉ hai URL.
  env: { PATH: '/usr/bin:/bin', PULUMI_BACKEND_URL: 'file:///tmp/wt/.pulumi-local-state' },
};

const NETWORK_NAME = 'ecoma-w0123456789ab_network';

/**
 * Mật khẩu chứa ký tự dành riêng của userinfo URL (`@ : /`) — sau khi ghép vào
 * URL phải ở dạng percent-encoded; dạng thô không được xuất hiện ở đâu cả.
 */
const RESERVED_PASSWORD = 'p@ss:word';
const ACCOUNT_PASSWORD = 'acc-secret-1';
const STAFF_PASSWORD = 'staff-secret-2';

describe('buildMigratorDatabaseUrl', () => {
  it('percent-encodes reserved characters in the password userinfo', () => {
    // `encodeURIComponent` mã hóa `@ : /` thành `%40 %3A %2F` — parser `pg` đọc
    // được userinfo đúng kể cả khi mật khẩu chứa ký tự dành riêng.
    const url = buildMigratorDatabaseUrl(
      ACCOUNT_MIGRATOR_ROLE,
      RESERVED_PASSWORD,
      ACCOUNT_DATABASE,
    );
    expect(url).toBe(
      `postgresql://${ACCOUNT_MIGRATOR_ROLE}:p%40ss%3Aword@ecoma-postgres:5432/${ACCOUNT_DATABASE}`,
    );
    expect(url).not.toContain(RESERVED_PASSWORD);
  });
});

describe('buildSuperadminResolverInvocation', () => {
  const accountUrl = buildMigratorDatabaseUrl(
    ACCOUNT_MIGRATOR_ROLE,
    ACCOUNT_PASSWORD,
    ACCOUNT_DATABASE,
  );
  const staffUrl = buildMigratorDatabaseUrl(
    STAFF_ACCESS_MIGRATOR_ROLE,
    STAFF_PASSWORD,
    STAFF_ACCESS_DATABASE,
  );
  const invocation = buildSuperadminResolverInvocation(
    foundation,
    NETWORK_NAME,
    accountUrl,
    staffUrl,
  );

  it('carries env variable NAMES only in docker args — neither database URL value appears in argv', () => {
    // Tên biến phải là argument ĐỨNG SAU `-e`, và KHÔNG được có phần tử nào
    // dạng `TÊN=...` (dạng pass-through: Docker copy biến từ env của CLI vào
    // container; dạng `TÊN=giá trị` là đường leak argv mà finding chặn).
    for (const name of [ACCOUNT_DATABASE_URL_ENV, STAFF_ACCESS_DATABASE_URL_ENV]) {
      const index = invocation.args.indexOf(name);
      expect(index, `args must contain the bare env name ${name}`).toBeGreaterThan(-1);
      expect(invocation.args[index - 1], `bare ${name} must follow -e without '='`).toBe('-e');
      expect(
        invocation.args.some((arg) => arg.startsWith(`${name}=`)),
        `no NAME=value form of ${name} in argv`,
      ).toBe(false);
    }
    const joined = invocation.args.join('\u0000');
    // Không URL nào — nguyên văn lẫn phần mật khẩu đã percent-encoded — được
    // phép xuất hiện trong argv. Join bằng ký tự không thể xuất hiện trong URL
    // để không tạo chuỗi giả qua nối mép phần tử.
    expect(joined).not.toContain(accountUrl);
    expect(joined).not.toContain(staffUrl);
    expect(joined).not.toContain(encodeURIComponent(ACCOUNT_PASSWORD));
    expect(joined).not.toContain(encodeURIComponent(STAFF_PASSWORD));
    expect(joined).not.toContain(encodeURIComponent(RESERVED_PASSWORD));
  });

  it('returns a child env that carries both URL values and inherits the base env', () => {
    expect(invocation.env[ACCOUNT_DATABASE_URL_ENV]).toBe(accountUrl);
    expect(invocation.env[STAFF_ACCESS_DATABASE_URL_ENV]).toBe(staffUrl);
    // Kế thừa env gốc của foundation (PATH, PULUMI_* — nền mà mọi lệnh entry dùng).
    expect(invocation.env['PATH']).toBe(foundation.env.PATH);
    expect(invocation.env['PULUMI_BACKEND_URL']).toBe(foundation.env.PULUMI_BACKEND_URL);
  });

  it('preserves image, entrypoint and dx runner script arguments', () => {
    // Ghim các argument quan trọng của container: image pin theo DIGEST, tsx
    // binary của repo, entry dx runner và các cờ mode của bước superadmin.
    const expected = [
      NODE_IMAGE,
      '/repo/node_modules/.bin/tsx',
      '/repo/tools/dx/index.ts',
      'bootstrap-superadmin',
      '--resolve-if-bootstrapped',
      '--json',
    ];
    for (const arg of expected) {
      expect(invocation.args).toContain(arg);
    }
    expect(invocation.args[0]).toBe('run');
    expect(invocation.cwd).toBe(foundation.ctx.worktreeRoot);
    // Mount repo + node_modules và `--network` giữ nguyên vị trí contract.
    expect(invocation.args).toContain('--network');
    expect(invocation.args).toContain(`${foundation.ctx.worktreeRoot}:/repo:ro`);
    expect(invocation.args).toContain(
      `${foundation.ctx.worktreeRoot}/node_modules:/repo/node_modules`,
    );
    expect(invocation.args).toContain('/repo');
  });
});
