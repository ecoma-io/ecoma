/**
 * Xây script shell cho provision và migrate của `auth-deploy` — HÀM THUẦN,
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
 *
 * KHÔNG có biến cho `ecoma_owner`: stack này guard-create role khi thiếu nhưng
 * KHÔNG BAO GIỜ ALTER password của nó — password của `ecoma_owner` thuộc về
 * account stack (ALTER ở hai nơi là race xoá mật khẩu nhau).
 */
export const MIGRATOR_PASSWORD_ENV_VAR = 'AUTH_PW_MIGRATOR';
export const RUNTIME_PASSWORD_ENV_VAR = 'AUTH_PW_RUNTIME';
export const PRUNER_PASSWORD_ENV_VAR = 'AUTH_PW_PRUNER';

/** Input của {@link buildProvisionScript}. */
export interface ProvisionScriptInputs {
  /** Tên container PostgreSQL của platform mà `docker exec` nhắm vào. */
  readonly postgresContainerName: string;
}

/**
 * Script provision: guard-create `ecoma_owner` (KHÔNG ALTER password) + 3 role
 * riêng của db-auth + revoke chéo, chạy trên host qua `docker exec` vào
 * container PostgreSQL của platform. Idempotent: role/database guard-create
 * bằng shell `if`, ALTER password idempotent sẵn — chạy lại áp cùng giá trị,
 * KHÔNG rotate.
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
# 1. Owner role dùng chung — CHỈ tạo khi thiếu; KHÔNG ALTER password (account
#    stack sở hữu password của ecoma_owner; ALTER ở hai nơi là race xoá nhau).
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_owner'" | grep -q 1; then $PSQL -c "CREATE ROLE ecoma_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
# 2. Ba role của db-auth — guard-create khi thiếu.
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_auth_migrator'" | grep -q 1; then $PSQL -c "CREATE ROLE ecoma_auth_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_auth_runtime'" | grep -q 1; then $PSQL -c "CREATE ROLE ecoma_auth_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_auth_nonce_pruner'" | grep -q 1; then $PSQL -c "CREATE ROLE ecoma_auth_nonce_pruner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
# 3. Mật khẩu ba role — giá trị đến từ biến môi trường của shell (kênh
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

apply_password ecoma_auth_migrator "$${MIGRATOR_PASSWORD_ENV_VAR}"
apply_password ecoma_auth_runtime "$${RUNTIME_PASSWORD_ENV_VAR}"
apply_password ecoma_auth_nonce_pruner "$${PRUNER_PASSWORD_ENV_VAR}"
# 4. Database + owner. CREATE là lệnh guard (bash if), ALTER idempotent sẵn.
if ! $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='db-auth'" | grep -q 1; then $PSQL -c 'CREATE DATABASE "db-auth"'; fi
$PSQL -c 'ALTER DATABASE "db-auth" OWNER TO ecoma_owner'
# 5. Chặn chéo chiều ngược: điều kiện hoá theo db-account — account stack có
#    thể up sau auth (thứ tự orchestration là account trước auth, nhưng một
#    pulumi up riêng lẻ của stack này không được chết vì database kia vắng).
if $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='db-account'" | grep -q 1; then $PSQL -c 'REVOKE CONNECT ON DATABASE "db-account" FROM PUBLIC'; fi
if $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='db-account'" | grep -q 1; then $PSQL -c 'REVOKE CONNECT ON DATABASE "db-account" FROM ecoma_auth_runtime'; fi
# 6. Thu CONNECT của PUBLIC trước, rồi grant per-role.
$PSQL -c 'REVOKE CONNECT ON DATABASE "db-auth" FROM PUBLIC'
$PSQL -c 'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "db-auth" TO ecoma_auth_migrator'
$PSQL -c 'GRANT CONNECT ON DATABASE "db-auth" TO ecoma_auth_runtime'
$PSQL -c 'GRANT CONNECT ON DATABASE "db-auth" TO ecoma_auth_nonce_pruner'
# 7. Hardening schema public — ecoma_local (owner/superuser) mới revoke được;
#    migration statement là no-op trên PG15+ khi chạy bằng migrator.
docker exec $PG psql -U ecoma_local -d db-auth -v ON_ERROR_STOP=1 -c 'REVOKE ALL ON SCHEMA public FROM PUBLIC'
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
 * `tsx db/apply.mts` của repo (`apps/auth/db/apply.mts` — advisory lock
 * `hashtext('db-auth')`, history `auth.schema_migrations`, checksum
 * drift-abort, thứ tự tên file — giữ nguyên).
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
  -w /repo/apps/auth \\
  -e DATABASE_URL \\
  ${inputs.nodeImage} \\
  /repo/node_modules/.bin/tsx --tsconfig tsconfig.db.json db/apply.mts
`;
}
