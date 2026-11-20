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
 * kết nối Workers → PostgreSQL thuộc lane connectivity riêng (docs ở
 * `deploys/staging-connectivity/`, CLI `tools/delivery/src/cli.ts vpc-service
 * create`): VP4 đã verified trên pin wrangler 4.165.0 (2026-11-20) — lệnh
 * `wrangler vpc service create` TỒN TẠI (TODO cũ nói "chưa tồn tại" là
 * stale); DNS CNAME `pg-staging.ecoma.io.vn` thuộc unit DNS của
 * `platform-deploy`.
 *
 * Ranh giới credential (§6/§7.4.1): private key SSH đọc từ đường dẫn config
 * (file ngoài Git); password DB sinh bằng `openssl rand` TRÊN HOST trong lúc
 * chạy script — text script (và do đó state Pulumi) KHÔNG chứa password; giá
 * trị thật chỉ về qua stdout của command và được export dưới dạng secret
 * (`pulumi.secret`), state mã hóa bằng passphrase per-stack.
 *
 * Backup base + WAL archive → R2 (§3.1, §6.1 Required) được provision trong
 * chính chương trình này — cơ chế placeholder built-ins + rclone, công cụ
 * cuối vẫn là mục "Chưa chốt" §10 (xem TODO(349/tool) tại `pg-backup-prereq`).
 * Hardening `pg_hba` là việc còn lại — xem README.
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
// Backup → R2 (§3.1 mô hình đã chốt): bucket + credential do operator cấp qua
// config (secret mã hoá trong state bằng passphrase per-stack). Bucket tồn tại
// TRƯỚC — chương trình này không tạo bucket (cần accountId #350, và retention
// lifecycle rule của PITR window thuộc operator cấu hình trên bucket, mục 3.1
// cạm bẫy (1): cắt WAL là lifecycle rule, KHÔNG phải pg_archivecleanup).
const backupBucketName = config.require('backupBucketName');
const backupR2Endpoint = config.require('backupR2Endpoint');
const backupR2AccessKey = config.requireSecret('backupR2AccessKey');
const backupR2SecretKey = config.requireSecret('backupR2SecretKey');

/**
 * Đường dẫn hệ thống dùng chung mọi script — một nguồn sự thật, không hardcode
 * rải rác. Giả định layout Debian/Ubuntu + PostgreSQL từ apt là CỐ ĐỊNH của
 * unit này (`pg-install` cài qua `apt-get`); đổi distro/PostgreSQL-from-source
 * là đổi giả định provision, phải sửa khối này cùng `pg-install`.
 */
const PATHS = {
  walArchiveDir: '/var/lib/postgresql/wal-archive',
  pgBaseDir: '/var/backups/pg-base',
  backupEnvFile: '/etc/pg-backup.env',
  rclone: '/usr/bin/rclone',
  pgBaseBackup: '/usr/bin/pg_basebackup',
} as const;

/**
 * Connection SSH dùng chung cho mọi command — ở `@pulumi/command` v1.3,
 * `connection` là args object (`inputs.remote.ConnectionArgs`), KHÔNG phải
 * resource `remote.Connection` (biểu mẫu đó của bản cũ). Private key đọc từ
 * đường dẫn config (file ngoài Git) tại lúc chạy chương trình — lỗi đọc file
 * được bọc thành lỗi tường minh với đúng khóa config cần sửa; vật liệu key
 * tất yếu nằm trong bộ nhớ tiến trình suốt vòng đời (yêu cầu của connection
 * args, không có hình thay thế trong `@pulumi/command` v1.3).
 */
const connection = ((): { host: string; user: string; privateKey: string } => {
  try {
    return {
      host: hostAddress,
      user: sshUser,
      privateKey: readFileSync(sshPrivateKeyPath, 'utf8'),
    };
  } catch (error) {
    throw new Error(
      `cannot read the SSH private key at "sshPrivateKeyPath=${sshPrivateKeyPath}" — ` +
        `check the path exists and is readable outside Git (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
})();

/**
 * Bọc một script SQL vào `psql` qua heredoc KHÔNG quote (cần cho `$PW_*`).
 * `-q` + `>/dev/null`: psql in thẻ lệnh (CREATE ROLE/ALTER ROLE) ra stdout —
 * redirect giữ stdout thuần TSV `role<TAB>password` để `pgRolePasswords` parse
 * được; lỗi SQL vẫn đi stderr và `ON_ERROR_STOP=1` dừng script.
 */
const runPsql = (sql: string): string =>
  `sudo -u postgres psql -q -v ON_ERROR_STOP=1 <<PSQL_END >/dev/null\n${sql}\nPSQL_END`;

/**
 * Cài cluster PostgreSQL + openssl (sinh password trên host) — idempotent.
 * CỐTÝNH không có `triggers` (script tĩnh, create-once): cài đặt chạy một lần
 * tại provision; đổi script (vd hardening TODO) phải taint tường minh thay
 * vì chạy lại âm thầm trên mọi lần `up`.
 */
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
  // TODO(349/blocking): hardening pg_hba (scram + localhost-only tường minh)
  // — lần provision sau.
);

/**
 * Prerequisite backup (§3.1, §6.1 Required): WAL archive bật ở mức cluster —
 * `archive_mode` + `archive_command` đẩy segment vào thư mục local (hàng đợi
 * push), `archive_timeout` chặn cửa sổ WAL im lặng dài.
 *
 * Khối này đứng TRƯỚC `pg-roles` trong đồ thị (`pg-roles` dependsOn nó): nó
 * restart PostgreSQL, nên mọi lệnh SQL sau đó phải đợi restart xong — nếu
 * chạy song song, psql có thể thất bại giữa chừng restart.
 *
 * CỐTÝNH không có `triggers`: resource là create-once — script chỉ chạy lại
 * khi taint/recreate, restart chỉ xảy ra một lần tại provision (không phải
 * mỗi `pulumi up`). Đổi script hardening sau này phải taint tường minh, không
 * restart âm thầm.
 *
 * TODO(349/tool): cơ chế base + WAL → R2 ở đây là PLACEHOLDER built-ins
 * (`pg_basebackup` + `archive_command` + `rclone`) — công cụ backup cuối
 * (pgBackRest/wal-g/...) là mục "Chưa chốt" của `03-operations.md` §10
 * (trigger: trước khi có dữ liệu thật); quyết định đó KHÔNG được suy từ
 * placeholder này.
 */
const pgBackupPrereq = new command.remote.Command(
  'pg-backup-prereq',
  {
    connection,
    create: [
      'set -eu',
      'export DEBIAN_FRONTEND=noninteractive',
      'sudo apt-get install -y -qq rclone',
      `sudo install -d -o postgres -g postgres ${PATHS.walArchiveDir} ${PATHS.pgBaseDir}`,
      runPsql(
        [
          `ALTER SYSTEM SET archive_mode = 'on';`,
          // Atomic copy (`.part` + `mv`): segment bán phần không bao giờ bị
          // `test ! -f` nhận nhầm là đã archive xong — lỗi đó tạo lỗ PITR thầm
          // lặng. cp thất bại trả exit != 0 → PostgreSQL giữ segment và retry
          // + log, đúng hành vi WAL archiving chuẩn.
          `ALTER SYSTEM SET archive_command = 'test ! -f ${PATHS.walArchiveDir}/%f && cp %p ${PATHS.walArchiveDir}/%f.part && mv ${PATHS.walArchiveDir}/%f.part ${PATHS.walArchiveDir}/%f';`,
          `ALTER SYSTEM SET archive_timeout = '60s';`,
        ].join('\n'),
      ),
      // archive_mode chỉ có hiệu lực sau restart — một lần tại provision.
      'sudo systemctl restart postgresql',
    ].join('\n'),
  },
  { dependsOn: pgInstall },
);

/**
 * Tạo 22 role (11 cặp) — password `openssl rand` TRÊN HOST, chưa từng xuất
 * hiện trong text script; stdout là TSV `role<TAB>password` được export
 * secret ở cuối file. Chạy lại resource (taint/recreate) = xoay password.
 *
 * `triggers: [script]` (đúng chỗ CommandArgs): đổi inventory (thêm DB) đổi
 * script sinh ra — resource PHẢI chạy lại, vì `@pulumi/command` KHÔNG tự chạy
 * lại khi text `create` đổi (gotcha chính thức của provider).
 */
const pgRolesScript = [
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
].join('\n');
const pgRoles = new command.remote.Command(
  'pg-roles',
  { connection, create: pgRolesScript, triggers: [pgRolesScript] },
  { dependsOn: pgBackupPrereq },
);

/**
 * Tạo 11 database idempotent — OWNER là role migrator của chính DB đó.
 * `triggers: [script]` cùng lý do `pg-roles`: thêm DB vào inventory phải chạy
 * lại script, provider không tự chạy lại theo text.
 */
const pgDatabasesScript = [
  'set -eu',
  ...STAGING_PG_DATABASES.map((db) => runPsql(createDatabaseSql(db))),
].join('\n');
const pgDatabases = new command.remote.Command(
  'pg-databases',
  { connection, create: pgDatabasesScript, triggers: [pgDatabasesScript] },
  { dependsOn: pgRoles },
);

/**
 * Isolation per-DB: REVOKE CONNECT public, grant đúng cặp role của DB đó.
 * `triggers: [script]` cùng lý hai resource trên — inventory đổi là grant
 * phải chạy lại, không kẹt state cũ.
 */
const pgGrantsScript = [
  'set -eu',
  ...STAGING_PG_DATABASES.map((db) => runPsql(grantsSql(db))),
].join('\n');
export const pgGrants = new command.remote.Command(
  'pg-grants',
  { connection, create: pgGrantsScript, triggers: [pgGrantsScript] },
  { dependsOn: pgDatabases },
);

/**
 * Jobs backup (§3.1: base hằng ngày, WAL liên tục): unit systemd oneshot +
 * timer đẩy WAL archive (5 phút) và base backup (`pg_basebackup`, 02:30) lên
 * R2 qua rclone. Credential R2 nằm trong `/etc/pg-backup.env` (0600 root) —
 * nội dung sinh từ config secret, không vào Git, không vào log. Retention
 * (PITR window) là lifecycle rule trên bucket R2 — operator cấu hình ngoài
 * chương trình này (§3.1 cạm bẫy (1): cắt WAL là lifecycle rule, không phải
 * `pg_archivecleanup`).
 */
export const pgBackupJobs = new command.remote.Command(
  'pg-backup-jobs',
  {
    connection,
    create: pulumi
      .all([backupBucketName, backupR2Endpoint, backupR2AccessKey, backupR2SecretKey])
      .apply(([bucket, endpoint, accessKey, secretKey]) =>
        [
          'set -eu',
          `sudo install -m 0600 -o root -g root /dev/null ${PATHS.backupEnvFile}`,
          `sudo tee ${PATHS.backupEnvFile} >/dev/null <<'ENV_END'\nRCLONE_CONFIG_R2_TYPE=s3\nRCLONE_CONFIG_R2_ENDPOINT=${endpoint}\nRCLONE_CONFIG_R2_ACCESS_KEY_ID=${accessKey}\nRCLONE_CONFIG_R2_SECRET_ACCESS_KEY=${secretKey}\nENV_END`,
          // `rclone copy` (KHÔNG `sync`): không bao giờ xoá phía R2 — retention
          // WAL thuộc lifecycle rule của bucket (§3.1), xoá cục bộ không được
          // phép lan sang remote (PITR).
          `sudo tee /etc/systemd/system/pg-wal-push.service >/dev/null <<'UNIT_END'\n[Unit]\nDescription=Push PostgreSQL WAL archive to R2\n[Service]\nType=oneshot\nEnvironmentFile=${PATHS.backupEnvFile}\nExecStart=${PATHS.rclone} copy ${PATHS.walArchiveDir} r2:${bucket}/wal\nUNIT_END`,
          `sudo tee /etc/systemd/system/pg-wal-push.timer >/dev/null <<'UNIT_END'\n[Unit]\nDescription=Push PostgreSQL WAL archive every 5 minutes\n[Timer]\nOnCalendar=*:0/5\nPersistent=true\n[Install]\nWantedBy=timers.target\nUNIT_END`,
          `sudo tee /etc/systemd/system/pg-base-backup.service >/dev/null <<'UNIT_END'\n[Unit]\nDescription=Daily PostgreSQL base backup to R2\n[Service]\nType=oneshot\nEnvironmentFile=${PATHS.backupEnvFile}\nExecStart=/bin/bash -c 'DIR=${PATHS.pgBaseDir}/$$(date +%%Y%%m%%dT%%H%%M%%S) && sudo -u postgres ${PATHS.pgBaseBackup} -D "$$DIR" -Fp -Xs -P && ${PATHS.rclone} copy "$$DIR" "r2:${bucket}/base/$$(basename "$$DIR")"'\nUNIT_END`,
          `sudo tee /etc/systemd/system/pg-base-backup.timer >/dev/null <<'UNIT_END'\n[Unit]\nDescription=Run PostgreSQL base backup daily\n[Timer]\nOnCalendar=*-*-* 02:30:00\nPersistent=true\n[Install]\nWantedBy=timers.target\nUNIT_END`,
          'sudo systemctl daemon-reload',
          'sudo systemctl enable --now pg-wal-push.timer pg-base-backup.timer',
        ].join('\n'),
      ),
    // Xoay credential R2 hoặc đổi bucket/endpoint phải REWRITE env file + unit
    // systemd — triggers (CommandArgs) thay thế resource khi config đổi; script
    // chạy lại idempotent, secret mới chắc chắn tới `/etc/pg-backup.env`.
    triggers: [backupBucketName, backupR2Endpoint, backupR2AccessKey, backupR2SecretKey],
  },
  { dependsOn: pgBackupPrereq },
);

export const pgHostAddress = hostAddress;
export const pgSshUser = sshUser;
export const pgDatabasesProvisioned = [...STAGING_PG_DATABASES];
export const pgBackupBucket = backupBucketName;
export const pgRolePasswords = pulumi.secret(pgRoles.stdout);
