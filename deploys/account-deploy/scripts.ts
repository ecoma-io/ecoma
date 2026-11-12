/**
 * Xây script shell cho provision và migrate của `account-deploy` — HÀM THUẦN,
 * input là dữ liệu thô (tên container, tên network, đường dẫn worktree, tên
 * image, TÊN biến môi trường), output là script text KHÔNG chứa giá trị secret
 * nào. Chương trình Pulumi (`index.ts`) gọi đúng các hàm này nên script chạy
 * thật và script được test là MỘT nguồn sự thật.
 *
 * Bất biến bảo mật của cả hai script: giá trị secret (mật khẩu role, chuỗi
 * kết nối) KHÔNG BAO GIỜ nằm trong script text — tức không nằm trong argv của
 * `sh -c` mà provider dùng để chạy script — cũng như trong argv của bất kỳ
 * process nào script sinh ra. Giá trị đi vào tiến trình shell qua biến môi
 * trường (kênh `environment` của `command.local.Command`), rồi được tiêu thụ
 * bằng đúng TÊN biến trong script. Tham số đầu vào của hàm build là dữ liệu thô
 * vô secret, nên harness test dựng được script y hệt production mà không cần
 * Pulumi hay secret thật.
 */

import { shellQuote } from '@ecoma-io/deployment';

/**
 * TÊN biến môi trường chứa mật khẩu của từng role. Script provision đọc mật
 * khẩu bằng đúng tên này, và wiring Pulumi (`index.ts`) dựng map `environment`
 * với cùng hằng — tên biến không thể lệch giữa hai phía. Giá trị KHÔNG đi qua
 * đây: giá trị được bọc `pulumi.secret` trong `environment` của provider.
 */
export const OWNER_PASSWORD_ENV_VAR = 'ACCOUNT_PW_OWNER';
export const MIGRATOR_PASSWORD_ENV_VAR = 'ACCOUNT_PW_MIGRATOR';
export const RUNTIME_PASSWORD_ENV_VAR = 'ACCOUNT_PW_RUNTIME';
export const PRUNER_PASSWORD_ENV_VAR = 'ACCOUNT_PW_PRUNER';

/** Input của {@link buildProvisionScript}. */
export interface ProvisionScriptInputs {
  /** Tên container PostgreSQL của platform mà `docker exec` nhắm vào. */
  readonly postgresContainerName: string;
}

/**
 * Script provision: `db-account` + 4 role (owner/migrator/runtime/pruner) +
 * revoke chéo, chạy trên host qua `docker exec` vào container PostgreSQL của
 * platform. Idempotent: role/database guard-create bằng shell `if`, ALTER
 * password idempotent sẵn — chạy lại áp cùng giá trị, KHÔNG rotate.
 *
 * Kênh mật khẩu: mỗi `ALTER ROLE ... PASSWORD` được DỰNG TRONG shell từ biến
 * môi trường rồi nạp vào psql qua **STDIN** của `docker exec -i` — không `-c`
 * nào chứa giá trị, nên psql nhìn thấy SQL qua stdin chứ không qua argv. Biên
 * escaping giữ nguyên ngữ nghĩa quoting SQL: hàm `sql_quote` bên trong script
 * nhận password qua đối số HÀM shell (lời gọi hàm không sinh process, giá trị
 * nằm trong ô nhớ của shell) và tự đẩy qua **stdin** của `sed` (argv của sed
 * chỉ chứa script `s/'/''/g`, không chứa giá trị) — bảo vệ literal SQL.
 */
export function buildProvisionScript(inputs: ProvisionScriptInputs): string {
  const pg = inputs.postgresContainerName;

  return `set -e
PG=${pg}
PSQL="docker exec $PG psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1"
PSQL_STDIN="docker exec -i $PG psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1"
# 1. Role owner dùng chung account/auth — stack này SỞ HỘI password của nó:
#    auth stack guard-create khi thiếu nhưng KHÔNG BAO GIỜ ALTER password ở đây.
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_owner'" | grep -q 1; then $PSQL -c "CREATE ROLE ecoma_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
# 2. Ba role của db-account — guard-create khi thiếu.
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_account_migrator'" | grep -q 1; then $PSQL -c "CREATE ROLE ecoma_account_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_account_runtime'" | grep -q 1; then $PSQL -c "CREATE ROLE ecoma_account_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_account_nonce_pruner'" | grep -q 1; then $PSQL -c "CREATE ROLE ecoma_account_nonce_pruner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
# 3. Mật khẩu bốn role — giá trị đến từ biến môi trường của shell (kênh
#    \`environment\` của command.local.Command), script text chỉ chứa TÊN biến:
#    không argv của \`sh -c\`, không script text trong state Pulumi, không argv
#    của sed/psql. sql_quote nhận password qua đối số HÀM shell (không sinh
#    process) và đẩy qua STDIN của sed; câu SQL hoàn tất được nạp vào psql qua
#    STDIN của \`docker exec -i\` — không process nào trong chuỗi giữ giá trị
#    trong argv, và psql vẫn thấy nguyên literal sau khi escape (giữ nguyên
#    ngữ nghĩa quoting SQL của pattern hai biên trước đây).
sql_quote() {
  printf '%s' "$1" | sed "s/'/''/g"
}

apply_password() {
  # $1 = role, $2 = password (ô nhớ shell — lời gọi hàm không sinh process).
  quoted=$(sql_quote "$2")
  printf '%s\\n' "ALTER ROLE $1 WITH PASSWORD '$quoted';" | $PSQL_STDIN
}

apply_password ecoma_owner "$${OWNER_PASSWORD_ENV_VAR}"
apply_password ecoma_account_migrator "$${MIGRATOR_PASSWORD_ENV_VAR}"
apply_password ecoma_account_runtime "$${RUNTIME_PASSWORD_ENV_VAR}"
apply_password ecoma_account_nonce_pruner "$${PRUNER_PASSWORD_ENV_VAR}"
# 4. Database + owner. CREATE là lệnh guard (bash if), ALTER idempotent sẵn.
if ! $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='db-account'" | grep -q 1; then $PSQL -c 'CREATE DATABASE "db-account"'; fi
$PSQL -c 'ALTER DATABASE "db-account" OWNER TO ecoma_owner'
# 5. Chặn chéo: revoke trên database đích phải ĐIỀU KIỆN HOÁ — db-auth có thể
#    chưa tồn tại (auth stack up sau account) mà REVOKE CONNECT trên database
#    không tồn tại là lỗi, không phải no-op. Đảo lại cũng vậy: khi db-auth
#    ĐÃ có thì revoked ở đây, kể cả qua PUBLIC.
if $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='db-auth'" | grep -q 1; then $PSQL -c 'REVOKE CONNECT ON DATABASE "db-auth" FROM PUBLIC'; fi
if $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='db-auth'" | grep -q 1; then $PSQL -c 'REVOKE CONNECT ON DATABASE "db-auth" FROM ecoma_account_runtime'; fi
# 6. Thu CONNECT của PUBLIC trước, rồi grant per-role (README account §"Chặn
#    chéo": chỉ revoke role là no-op vì PUBLIC giữ CONNECT theo mặc định).
$PSQL -c 'REVOKE CONNECT ON DATABASE "db-account" FROM PUBLIC'
$PSQL -c 'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "db-account" TO ecoma_account_migrator'
$PSQL -c 'GRANT CONNECT ON DATABASE "db-account" TO ecoma_account_runtime'
$PSQL -c 'GRANT CONNECT ON DATABASE "db-account" TO ecoma_account_nonce_pruner'
# 7. Hardening schema public — ecoma_local (owner/superuser) mới revoke được;
#    migration statement là no-op trên PG15+ khi chạy bằng migrator.
docker exec $PG psql -U ecoma_local -d db-account -v ON_ERROR_STOP=1 -c 'REVOKE ALL ON SCHEMA public FROM PUBLIC'
`;
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
 * `tsx db/apply.mts` của repo (`apps/account/db/apply.mts` — advisory lock
 * `hashtext('db-account')`, GUC, danh sách file theo thứ tự tên — giữ nguyên).
 *
 * Kênh chuỗi kết nối: `DATABASE_URL` của migrator đến từ biến môi trường của
 * tiến trình shell (kênh `environment` của command.local.Command), rồi
 * `docker run -e DATABASE_URL` — CHỈ TÊN biến, không `=giá trị` — bảo docker
 * CLI đọc giá trị từ environ của chính nó và chuyển vào container env. Do đó
 * URL (chứa password) không nằm trong argv của `sh -c`, của `docker run`, của
 * tsx bên trong container, hay trong script text nào.
 */
export function buildMigrateScript(inputs: MigrateScriptInputs): string {
  return `set -e
docker run --rm \\
  --network ${inputs.networkName} \\
  -v ${shellQuote(inputs.worktreeRoot)}:/repo:ro \\
  -v ${shellQuote(inputs.worktreeRoot)}/node_modules:/repo/node_modules \\
  -w /repo/apps/account \\
  -e DATABASE_URL \\
  ${inputs.nodeImage} \\
  /repo/node_modules/.bin/tsx --tsconfig tsconfig.db.json db/apply.mts
`;
}
