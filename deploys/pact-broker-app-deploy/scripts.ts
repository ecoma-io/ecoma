/**
 * Xây script shell cho provision và migrate của `pact-broker-app-deploy` —
 * HÀM THUẦN, input là dữ liệu thô (tên container, tên network, đường dẫn
 * worktree, tên image), output là script text KHÔNG chứa giá trị secret nào.
 * Chương trình Pulumi (`index.ts`) gọi đúng các hàm này nên script chạy thật
 * và script được test là MỘT nguồn sự thật.
 *
 * #206 (ADR-0031 §2): unit `pact-broker-app` SỞ HỮU database riêng
 * `db-pact-broker-app` (BFF sessions — SHA-256 của cookie id, không state nào
 * của pact-broker), nên unit deploy này tự provision hai role + database và tự
 * chạy migration của `apps/pact-broker-app` — cùng mô hình với
 * `pact-broker-api-deploy` cho `db-pact-broker`. invariant 1 của
 * `01-architecture.md` §9 được cập nhật theo: một service — một database.
 *
 * Bất biến bảo mật của cả hai script: giá trị secret (mật khẩu role, chuỗi kết
 * nối) KHÔNG BAO GIỜ nằm trong script text — tức không nằm trong argv của
 * `sh -c` mà provider dùng để chạy script — cũng như trong argv của bất kỳ
 * process nào script sinh ra. Mật khẩu role đi vào tiến trình shell qua biến
 * môi trường (kênh `environment` của `command.local.Command`), rồi được tiêu
 * thụ bằng đúng TÊN biến trong script; `DATABASE_URL` đi theo cùng kênh và
 * `docker run -e` chỉ mang TÊN biến (docker CLI đọc giá trị từ environ của
 * chính nó). Mật khẩu trong URL được percent-encode ngay trong hàm dựng URL
 * (một nguồn sự thật cho cả wiring lẫn spec unit).
 */

import { shellQuote } from '@ecoma-io/deployment';

/** Database sở hữu của unit — `db-pact-broker-app` (ADR-0031 §2). */
export const DATABASE_NAME = 'db-pact-broker-app';

/** Role migrator của db-pact-broker-app — sở hữu schema `pact_broker_app` sau migration 0001. */
export const MIGRATOR_ROLE = 'ecoma_pact_broker_app_migrator';

/** Role runtime của db-pact-broker-app — CONNECT + DML grant theo bảng trong migration 0001. */
export const RUNTIME_ROLE = 'ecoma_pact_broker_app_runtime';

/** Alias DNS của PostgreSQL platform trong network nội bộ. */
export const POSTGRES_HOST = 'ecoma-postgres';

/**
 * TÊN biến môi trường chứa mật khẩu của một role — cùng cơ chế với
 * `pact-broker-api-deploy` nhưng đặt TÊN RIÊNG (prefix `PACT_APP_`) để environ
 * của hai unit không đè nhau nếu một lúc nào đó chạy chung process shell.
 * Script provision đọc mật khẩu bằng đúng tên này, và wiring Pulumi
 * (`index.ts`) dựng map `environment` với cùng hằng. Giá trị KHÔNG đi qua đây.
 */
export const MIGRATOR_PASSWORD_ENV_VAR = 'PACT_APP_PW_MIGRATOR';
export const RUNTIME_PASSWORD_ENV_VAR = 'PACT_APP_PW_RUNTIME';

/** Input của {@link buildProvisionScript}. */
export interface ProvisionScriptInputs {
  /** Tên container PostgreSQL của platform mà `docker exec` nhắm vào. */
  readonly postgresContainerName: string;
}

/**
 * Script provision: hai role + database + grant + hardening, chạy trên host qua
 * `docker exec` vào container PostgreSQL của platform. Idempotent: guard-create
 * bằng shell `if`, ALTER password idempotent sẵn — chạy lại áp cùng giá trị,
 * KHÔNG rotate. Cùng hình với provision script của `pact-broker-api-deploy`
 * (hai lớp escaping: `sql_quote` qua stdin sed, SQL hoàn chỉnh qua STDIN của
 * `docker exec -i`) — xem giải thích đầy đủ ở `scripts.ts` của unit đó.
 */
export function buildProvisionScript(inputs: ProvisionScriptInputs): string {
  const pg = inputs.postgresContainerName;
  return `set -e
PG=${pg}
PSQL="docker exec $PG psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1"
PSQL_STDIN="docker exec -i $PG psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1"
# 1. Hai role của db-pact-broker-app — guard-create khi thiếu.
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='${MIGRATOR_ROLE}'" | grep -q 1; then $PSQL -c "CREATE ROLE ${MIGRATOR_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='${RUNTIME_ROLE}'" | grep -q 1; then $PSQL -c "CREATE ROLE ${RUNTIME_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
# 2. Mật khẩu hai role — giá trị đến từ biến môi trường của shell (kênh
#    \`environment\` của command.local.Command), script text chỉ chứa TÊN biến.
#    Chú ý \`$$\`: bên trong template literal JavaScript, \`$$\` là cách escape
#    sinh ĐÚNG MỘT \`$\` trong script text — \`$${MIGRATOR_ROLE}\` ở dòng apply
#    dưới đây là biến shell của role, KHÔNG phải interpolation JS (interpolation
#    JS không escape sẽ nhét giá trị vào lúc build script text).
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
# 4. Grant: migrator cần CREATE trên database để tạo schema pact_broker_app
#    (migration 0001 tự cấp USAGE trên schema sau khi tạo); runtime chỉ CONNECT —
#    DML grant theo bảng nằm trong migration 0001 của app.
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
 * URL kết nối của role migrator tới db-pact-broker-app — giá trị mà wiring
 * Pulumi bọc `pulumi.secret` rồi đặt vào map `environment` của command migrate.
 * Password được percent-encode (URL-safe) trước khi ghép vào userinfo.
 */
export function buildMigratorConnectionUrl(inputs: ConnectionUrlInputs): string {
  return `postgresql://${MIGRATOR_ROLE}:${encodeURIComponent(inputs.password)}@${POSTGRES_HOST}:5432/${DATABASE_NAME}`;
}

/**
 * URL kết nối của role runtime tới db-pact-broker-app — giá trị mà wiring
 * Pulumi bọc `pulumi.secret` rồi đặt vào env `NITRO_PACT_BROKER_APP_DATABASE_URL`
 * của container app (cùng cơ chế percent-encode với migrator).
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
 * `apps/pact-broker-app` (advisory lock riêng của database này, mọi DDL
 * idempotent). Repo mount read-only. Kênh `DATABASE_URL` như migrate script của
 * `pact-broker-api-deploy`: `docker run -e DATABASE_URL` chỉ mang TÊN biến.
 */
export function buildMigrateScript(inputs: MigrateScriptInputs): string {
  return `set -e
docker run --rm \\
  --network ${inputs.networkName} \\
  -v ${shellQuote(inputs.worktreeRoot)}:/repo:ro \\
  -v ${shellQuote(inputs.worktreeRoot)}/node_modules:/repo/node_modules \\
  -w /repo/apps/pact-broker-app \\
  -e DATABASE_URL \\
  ${inputs.nodeImage} \\
  /repo/node_modules/.bin/tsx --tsconfig tsconfig.db.json db/apply.mts
`;
}
