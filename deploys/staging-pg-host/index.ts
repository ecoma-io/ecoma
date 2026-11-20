/**
 * Chương trình Pulumi của `staging-pg-host` (#349): provision host VPS staging
 * — cài PostgreSQL, tạo 11 database + cặp role runtime/migrator per-DB với
 * isolation CONNECT (§4.1.2, invariant 5/25) — chạy trên stack `staging`
 * backend R2, qua engine lane chung của `platform-deploy` (cờ
 * `--project staging-pg-host`).
 *
 * Phạm vi TƯỜNG MINH của chương trình này (quyền sở hữu §9.1 `02-delivery.md`):
 * bảng ownership giao VPS/PostgreSQL host cho Pulumi, còn Workers VPC Service
 * + Cloudflare Tunnel cho Wrangler. Vì vậy chương trình KHÔNG khai tunnel —
 * TODO(349/blocking): DNS CNAME `pg-staging.ecoma.io.vn` và kết nối Workers →
 * PostgreSQL đợi quyết định VP4 (lệnh `wrangler vpc service create` chưa tồn
 * tại cho lane staging; unit nào provision tunnel — Wrangler hay đây — là
 * quyết định kiến trúc, đã escalate lên orchestrator, KHÔNG tự suy).
 *
 * Ranh giới credential (§6/§7.4.1): private key SSH đọc từ đường dẫn config
 * (file ngoài Git); password DB sinh bằng `openssl rand` TRÊN HOST trong lúc
 * chạy script — text script (và do đó state Pulumi) KHÔNG chứa password; giá
 * trị thật chỉ về qua stdout của command và được export dưới dạng secret
 * (`pulumi.secret`), state mã hóa bằng passphrase per-stack.
 *
 * Hardening + backup/WAL archive (§6.1 Tier 0) là việc còn lại của unit này —
 * xem README; không nằm trong lần provision đầu.
 */

import { readFileSync } from 'node:fs';

import * as command from '@pulumi/command';
import * as pulumi from '@pulumi/pulumi';

import {
  STAGING_PG_DATABASES,
  createDatabaseSql,
  createRolesSql,
  grantsSql,
  migratorRoleName,
  runtimeRoleName,
} from './pg-inventory.js';

/**
 * Guard stack fail-closed: chương trình này đụng HOST THẬT qua SSH — chạy
 * nhầm stack là provision sai environment. Chỉ nhận slot `staging`; slot
 * candidate chưa có chương trình (#381), lane local không liên quan.
 */
const fullStackRef = pulumi.getStack();
const stackSlug = fullStackRef.slice(fullStackRef.lastIndexOf('/') + 1);
if (stackSlug !== 'staging') {
  throw new Error(
    `staging-pg-host refused: stack "${fullStackRef}" is not the staging slot — this program ` +
      'provisions the real staging PostgreSQL host over SSH (#349) and must never run on a ' +
      'local or unknown stack (candidate slot has no program yet, #381)',
  );
}

/** Config bắt buộc fail-closed: thiếu key nào là Pulumi từ chối chạy ngay. */
const config = new pulumi.Config();
const hostAddress = config.require('hostAddress');
const sshUser = config.require('sshUser');
const sshPrivateKeyPath = config.require('sshPrivateKeyPath');

/**
 * Connection SSH dùng chung cho mọi command — ở `@pulumi/command` v1.3,
 * `connection` là args object (`inputs.remote.ConnectionArgs`), KHÔNG phải
 * resource `remote.Connection` (biểu mẫu đó của bản cũ). Private key đọc từ
 * đường dẫn config (file ngoài Git) tại lúc chạy chương trình.
 */
const connection = {
  host: hostAddress,
  user: sshUser,
  privateKey: readFileSync(sshPrivateKeyPath, 'utf8'),
};

/** Bọc một script SQL vào `psql` qua heredoc KHÔNG quote (cần cho `$PW_*`). */
const runPsql = (sql: string): string =>
  `sudo -u postgres psql -v ON_ERROR_STOP=1 <<PSQL_END\n${sql}\nPSQL_END`;

/** Cài cluster PostgreSQL + openssl (sinh password trên host) — idempotent. */
const pgInstall = new command.remote.Command(
  'pg-install',
  {
    connection,
    create: [
      'set -eu',
      'export DEBIAN_FRONTEND=noninteractive',
      'sudo apt-get update -qq',
      'sudo apt-get install -y -qq postgresql postgresql-contrib openssl',
      'sudo systemctl enable --now postgresql',
    ].join('\n'),
  },
  // TODO(349/blocking): hardening pg_hba (scram + localhost-only) và cấu hình
  // backup/WAL archive (§6.1 Tier 0, §3.1) — lần provision sau, cần đích
  // lưu trữ off-host được duyệt.
);

/**
 * Tạo 22 role (11 cặp) — password `openssl rand` TRÊN HOST, chưa từng xuất
 * hiện trong text script; stdout là TSV `role<TAB>password` được export
 * secret ở cuối file. Chạy lại resource (taint/recreate) = xoay password.
 */
const pgRoles = new command.remote.Command(
  'pg-roles',
  {
    connection,
    create: [
      'set -eu',
      ...STAGING_PG_DATABASES.flatMap((db) => {
        const runtimeVar = `PW_${runtimeRoleName(db)}`;
        const migratorVar = `PW_${migratorRoleName(db)}`;
        return [
          `${runtimeVar}=$(openssl rand -hex 24)`,
          `${migratorVar}=$(openssl rand -hex 24)`,
          runPsql(createRolesSql(db, `$${runtimeVar}`, `$${migratorVar}`)),
          `printf '${runtimeRoleName(db)}\\t%s\\n' "$${runtimeVar}"`,
          `printf '${migratorRoleName(db)}\\t%s\\n' "$${migratorVar}"`,
        ];
      }),
    ].join('\n'),
  },
  { dependsOn: pgInstall },
);

/** Tạo 11 database idempotent — OWNER là role migrator của chính DB đó. */
const pgDatabases = new command.remote.Command(
  'pg-databases',
  {
    connection,
    create: ['set -eu', ...STAGING_PG_DATABASES.map((db) => runPsql(createDatabaseSql(db)))].join(
      '\n',
    ),
  },
  { dependsOn: pgRoles },
);

/** Isolation per-DB: REVOKE CONNECT public, grant đúng cặp role của DB đó. */
export const pgGrants = new command.remote.Command(
  'pg-grants',
  {
    connection,
    create: ['set -eu', ...STAGING_PG_DATABASES.map((db) => runPsql(grantsSql(db)))].join('\n'),
  },
  { dependsOn: pgDatabases },
);

export const pgHostAddress = hostAddress;
export const pgSshUser = sshUser;
export const pgDatabasesProvisioned = [...STAGING_PG_DATABASES];
export const pgRolePasswords = pulumi.secret(pgRoles.stdout);
