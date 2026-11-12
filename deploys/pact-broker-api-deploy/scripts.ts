/**
 * Xây script shell cho provision, migrate, bootstrap tenant và provision token
 * máy của `pact-broker-api-deploy` — HÀM THUẦN, input là dữ liệu thô (tên
 * container, tên network, đường dẫn worktree, tên image, sub owner, mật khẩu
 * thô CHỈ cho hàm dựng URL), output là script text KHÔNG chứa giá trị secret
 * nào. Chương trình Pulumi (`index.ts`) gọi đúng các hàm này nên script chạy
 * thật và script được test là MỘT nguồn sự thật.
 *
 * Bất biến bảo mật của cả bốn script: giá trị secret (mật khẩu role, chuỗi
 * kết nối, plaintext token máy) KHÔNG BAO GIỜ nằm trong script text — tức
 * không nằm trong argv của `sh -c` mà provider dùng để chạy script — cũng như
 * trong argv của bất kỳ process nào script sinh ra. Mật khẩu role đi vào tiến
 * trình shell qua biến môi trường (kênh `environment` của
 * `command.local.Command`), rồi được tiêu thụ bằng đúng TÊN biến trong script;
 * `DATABASE_URL` và `PACT_MACHINE_TOKEN_PLAINTEXT` đi theo cùng kênh và
 * `docker run -e` chỉ mang TÊN biến (docker CLI đọc giá trị từ environ của
 * chính nó). Mật khẩu trong URL được percent-encode ngay trong hàm dựng URL
 * (một nguồn sự thật cho cả wiring lẫn spec unit).
 */

import { shellQuote } from '@ecoma-io/deployment';

/** Database sở hữu của unit — `db-pact-broker`. */
export const DATABASE_NAME = 'db-pact-broker';

/** Role migrator của db-pact-broker — sở hữu schema `pact` sau migration 0001. */
export const MIGRATOR_ROLE = 'ecoma_pact_broker_migrator';

/** Role runtime của db-pact-broker — CONNECT + DML grant theo bảng trong migration 0001. */
export const RUNTIME_ROLE = 'ecoma_pact_broker_runtime';

/** Alias DNS của PostgreSQL platform trong network nội bộ. */
export const POSTGRES_HOST = 'ecoma-postgres';

/**
 * TÊN biến môi trường chứa mật khẩu của một role. Script provision đọc mật
 * khẩu bằng đúng tên này, và wiring Pulumi (`index.ts`) dựng map `environment`
 * với cùng hằng — tên biến không thể lệch giữa hai phía. Giá trị KHÔNG đi qua
 * đây: giá trị là output bọc secret được đặt vào environ của process shell.
 */
export const MIGRATOR_PASSWORD_ENV_VAR = 'PACT_PW_MIGRATOR';
export const RUNTIME_PASSWORD_ENV_VAR = 'PACT_PW_RUNTIME';

/**
 * TÊN biến môi trường chứa plaintext token máy mà runner
 * `db/provision-machine-token.mts` đọc. Script chỉ chứa TÊN biến; giá trị bọc
 * `pulumi.secret` trong map `environment` của wiring.
 */
export const MACHINE_TOKEN_PLAINTEXT_ENV_VAR = 'PACT_MACHINE_TOKEN_PLAINTEXT';

/** Input của {@link buildProvisionScript}. */
export interface ProvisionScriptInputs {
  /** Tên container PostgreSQL của platform mà `docker exec` nhắm vào. */
  readonly postgresContainerName: string;
}

/**
 * Script provision: hai role + database + grant + hardening, chạy trên host qua
 * `docker exec` vào container PostgreSQL của platform. Idempotent: guard-create
 * bằng shell `if`, ALTER password idempotent sẵn — chạy lại áp cùng giá trị,
 * KHÔNG rotate.
 *
 * Kênh mật khẩu: mỗi `ALTER ROLE ... PASSWORD` được DỰNG TRONG shell từ biến
 * môi trường rồi nạp vào psql qua **STDIN** của `docker exec -i` — không `-c`
 * nào chứa giá trị, nên psql nhìn thấy SQL qua stdin chứ không qua argv. Hai
 * biên escaping giữ nguyên ngữ nghĩa của hình cũ (`sqlQuote` + `shellQuote`
 * trong `index.ts`):
 * 1. `shellQuote` không còn cần ở biên này — giá trị KHÔNG đi qua argv của
 *    shell nào nữa; thay vào đó là hàm `sql_quote` bên trong script, nhận
 *    password qua đối số HÀM shell (lời gọi hàm không sinh process, giá trị
 *    nằm trong ô nhớ của shell) và tự đẩy qua **stdin** của `sed` (argv của
 *    sed chỉ chứa script `s/'/''/g`, không chứa giá trị) — bảo vệ literal SQL.
 * 2. Toàn bộ câu SQL thành MỘT dòng dữ liệu đi qua pipe của shell vào stdin
 *    psql — shell không bao giờ parse nó (không expansion vì nằm trong chuỗi
 *    double-quoted được printf `%s` in nguyên dạng).
 */
export function buildProvisionScript(inputs: ProvisionScriptInputs): string {
  const pg = inputs.postgresContainerName;
  return `set -e
PG=${pg}
PSQL="docker exec $PG psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1"
PSQL_STDIN="docker exec -i $PG psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1"
# 1. Hai role của db-pact-broker — guard-create khi thiếu.
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='${MIGRATOR_ROLE}'" | grep -q 1; then $PSQL -c "CREATE ROLE ${MIGRATOR_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='${RUNTIME_ROLE}'" | grep -q 1; then $PSQL -c "CREATE ROLE ${RUNTIME_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
# 2. Mật khẩu hai role — giá trị đến từ biến môi trường của shell (kênh
#    \`environment\` của command.local.Command), script text chỉ chứa TÊN biến:
#    không argv của \`sh -c\`, không script text trong state Pulumi, không argv
#    của sed/psql. sql_quote nhận password qua đối số HÀM shell (không sinh
#    process) và đẩy qua STDIN của sed; câu SQL hoàn tất được nạp vào psql qua
#    STDIN của \`docker exec -i\` — không process nào trong chuỗi giữ giá trị
#    trong argv, và psql vẫn thấy nguyên literal sau khi escape (ngữ nghĩa
#    quoting SQL của hai biên cũ giữ nguyên).
sql_quote() {
  printf '%s' "$1" | sed "s/'/''/g"
}

apply_password() {
  # $1 = role, $2 = password (ô nhớ shell — lời gọi hàm không sinh process).
  quoted=$(sql_quote "$2")
  printf '%s\\n' "ALTER ROLE $1 WITH PASSWORD '$quoted';" | $PSQL_STDIN
}

apply_password ${MIGRATOR_ROLE} "$${MIGRATOR_PASSWORD_ENV_VAR}"
apply_password ${RUNTIME_ROLE} "$${RUNTIME_PASSWORD_ENV_VAR}"
# 3. Database — guard-create (bash if), idempotent qua lần chạy sau.
if ! $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='${DATABASE_NAME}'" | grep -q 1; then $PSQL -c 'CREATE DATABASE "${DATABASE_NAME}"'; fi
# 4. Grant: migrator cần CREATE trên database để tạo schema pact (migration 0001
#    tự cấp USAGE/CREATE trên schema sau khi tạo); runtime chỉ CONNECT —
#    DML grant theo bảng nằm trong migration 0001.
$PSQL -c 'REVOKE CONNECT ON DATABASE "${DATABASE_NAME}" FROM PUBLIC'
$PSQL -c 'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${DATABASE_NAME}" TO ${MIGRATOR_ROLE}'
$PSQL -c 'GRANT CONNECT ON DATABASE "${DATABASE_NAME}" TO ${RUNTIME_ROLE}'
# 5. Hardening schema public — ecoma_local mới revoke được; migration statement là no-op trên PG15+.
docker exec $PG psql -U ecoma_local -d ${DATABASE_NAME} -v ON_ERROR_STOP=1 -c 'REVOKE ALL ON SCHEMA public FROM PUBLIC'
`;
}

/** Input của các hàm dựng connection URL. */
export interface ConnectionUrlInputs {
  /**
   * Mật khẩu THÔ của role — builder tự percent-encode trước khi ghép vào
   * userinfo (an toàn khi orchestration set mật khẩu chứa `@ : / ? #`; encode
   * là việc của hàm thuần này nên spec unit chấm được chính hành vi encode).
   */
  readonly password: string;
}

/**
 * URL kết nối của role migrator tới db-pact-broker — giá trị mà wiring Pulumi
 * bọc `pulumi.secret` rồi đặt vào map `environment` của command migrate.
 * Password được percent-encode (URL-safe) trước khi ghép vào userinfo; parser
 * `pg` giải mã percent-encoding đúng chuẩn.
 */
export function buildMigratorConnectionUrl(inputs: ConnectionUrlInputs): string {
  return `postgresql://${MIGRATOR_ROLE}:${encodeURIComponent(inputs.password)}@${POSTGRES_HOST}:5432/${DATABASE_NAME}`;
}

/**
 * URL kết nối của role runtime tới db-pact-broker — giá trị mà wiring Pulumi
 * bọc `pulumi.secret` rồi đặt vào map `environment` của command provision
 * tenant và provision token máy (cùng cơ chế percent-encode với migrator).
 */
export function buildRuntimeConnectionUrl(inputs: ConnectionUrlInputs): string {
  return `postgresql://${RUNTIME_ROLE}:${encodeURIComponent(inputs.password)}@${POSTGRES_HOST}:5432/${DATABASE_NAME}`;
}

/** Input của {@link buildMigrateScript}. */
export interface MigrateScriptInputs {
  /** Tên Docker network của platform mà container migration gia nhập. */
  readonly networkName: string;
  /** Đường dẫn worktree — mount `/repo` read-only + `node_modules` RW. */
  readonly worktreeRoot: string;
  /** Image Node pin theo digest dùng để chạy tsx của repo. */
  readonly nodeImage: string;
}

/**
 * Script migrate: container ephemeral trên platform network chạy đúng
 * `/repo/node_modules/.bin/tsx --tsconfig tsconfig.db.json db/apply.mts` của
 * repo (advisory lock `hashtext('db-pact-broker')`, mọi DDL idempotent).
 * KHÔNG chạy qua binding Hyperdrive (HD6: Hyperdrive không hỗ trợ advisory
 * lock — `docs/applications/pact-broker/03-operations.md` §2).
 *
 * Kênh chuỗi kết nối: `DATABASE_URL` đến từ biến môi trường của tiến trình
 * shell (kênh `environment` của command.local.Command), rồi `docker run -e
 * DATABASE_URL` — CHỈ TÊN biến, không `=giá trị` — bảo docker CLI đọc giá trị
 * từ environ của chính nó và chuyển vào container env. Do đó URL (chứa
 * password) không nằm trong argv của `sh -c`, của `docker run`, của tsx bên
 * trong container, hay trong script text nào.
 */
export function buildMigrateScript(inputs: MigrateScriptInputs): string {
  return `set -e
docker run --rm \\
  --network ${inputs.networkName} \\
  -v ${shellQuote(inputs.worktreeRoot)}:/repo:ro \\
  -v ${shellQuote(inputs.worktreeRoot)}/node_modules:/repo/node_modules \\
  -w /repo/apps/pact-broker-api \\
  -e DATABASE_URL \\
  ${inputs.nodeImage} \\
  /repo/node_modules/.bin/tsx --tsconfig tsconfig.db.json db/apply.mts
`;
}

/** Input của {@link buildBootstrapTenantScript}. */
export interface BootstrapTenantScriptInputs {
  /** Tên Docker network của platform mà container bootstrap gia nhập. */
  readonly networkName: string;
  /** Đường dẫn worktree — mount `/repo` read-only + `node_modules` RW. */
  readonly worktreeRoot: string;
  /** Image Node pin theo digest dùng để chạy tsx của repo. */
  readonly nodeImage: string;
  /**
   * `sub` chủ thể sở hữu tenant `ecoma` — ĐỊNH DANH, KHÔNG phải credential,
   * nên giữ nội suy giá trị (đã `shellQuote`) trong argv `-e VAR=giá trị`.
   */
  readonly tenantOwnerSub: string;
}

/**
 * Script bootstrap tenant canonical `ecoma`: container ephemeral chạy đúng
 * `db/bootstrap-tenant.mts` của repo. `DATABASE_URL` chỉ mang TÊN biến trong
 * argv (`docker run -e DATABASE_URL` — giá trị từ environ của shell qua kênh
 * `environment` của provider); `CANONICAL_TENANT_OWNER_SUB` là định danh nên
 * vẫn nội suy giá trị.
 */
export function buildBootstrapTenantScript(inputs: BootstrapTenantScriptInputs): string {
  return `set -e
docker run --rm \\
  --network ${inputs.networkName} \\
  -v ${shellQuote(inputs.worktreeRoot)}:/repo:ro \\
  -v ${shellQuote(inputs.worktreeRoot)}/node_modules:/repo/node_modules \\
  -w /repo/apps/pact-broker-api \\
  -e DATABASE_URL \\
  -e CANONICAL_TENANT_OWNER_SUB=${shellQuote(inputs.tenantOwnerSub)} \\
  ${inputs.nodeImage} \\
  /repo/node_modules/.bin/tsx --tsconfig tsconfig.db.json db/bootstrap-tenant.mts
`;
}

/** Input của {@link buildMachineTokenProvisionScript}. */
export interface MachineTokenProvisionScriptInputs {
  /** Tên Docker network của platform mà container provision token gia nhập. */
  readonly networkName: string;
  /** Đường dẫn worktree — mount `/repo` read-only + `node_modules` RW. */
  readonly worktreeRoot: string;
  /** Image Node pin theo digest dùng để chạy tsx của repo. */
  readonly nodeImage: string;
  /** Tên token máy (natural key cùng tenant) — non-secret. */
  readonly tokenName: string;
  /** Danh sách scope cách nhau bởi khoảng trắng — non-secret, có thể chứa space. */
  readonly tokenScopes: string;
}

/**
 * Script provision token máy của consumer local: container ephemeral chạy đúng
 * `db/provision-machine-token.mts` của repo. Hai giá trị secret (`DATABASE_URL`
 * chứa mật khẩu runtime, `PACT_MACHINE_TOKEN_PLAINTEXT` là plaintext token)
 * CHỈ mang TÊN biến trong argv; giá trị đi qua kênh `environment` của provider.
 * Tên và scopes token là non-secret nên vẫn nội suy giá trị, nhưng builder TỰ
 * bọc `shellQuote` — an toàn theo cấu trúc với mọi input caller truyền vào
 * (nháy đơn/semicolon/space không thể phá shell hay tách từ của `docker run`).
 */
export function buildMachineTokenProvisionScript(
  inputs: MachineTokenProvisionScriptInputs,
): string {
  return `set -e
docker run --rm \\
  --network ${inputs.networkName} \\
  -v ${shellQuote(inputs.worktreeRoot)}:/repo:ro \\
  -v ${shellQuote(inputs.worktreeRoot)}/node_modules:/repo/node_modules \\
  -w /repo/apps/pact-broker-api \\
  -e DATABASE_URL \\
  -e PACT_MACHINE_TOKEN_NAME=${shellQuote(inputs.tokenName)} \\
  -e PACT_MACHINE_TOKEN_SCOPES=${shellQuote(inputs.tokenScopes)} \\
  -e ${MACHINE_TOKEN_PLAINTEXT_ENV_VAR} \\
  ${inputs.nodeImage} \\
  /repo/node_modules/.bin/tsx --tsconfig tsconfig.db.json db/provision-machine-token.mts
`;
}
