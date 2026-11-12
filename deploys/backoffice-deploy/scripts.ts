/**
 * Xây script shell cho provision của `backoffice-deploy` — HÀM THUẦN, input là
 * dữ liệu thô (tên container, đường dẫn worktree, TÊN biến môi trường), output
 * là script text KHÔNG chứa giá trị secret nào. Chương trình Pulumi
 * (`index.ts`) gọi đúng hàm này nên script chạy thật và script được test là
 * MỘT nguồn sự thật.
 *
 * Unit này KHÔNG có script migrate riêng: migration đi cùng provision — pipe
 * các file SQL thẳng vào psql qua socket trust trong container (advisory lock
 * `hashtext('db-backoffice')` bao quanh, ON_ERROR_STOP dừng) — giữ nguyên hình
 * baseline, chỉ kênh mật khẩu đổi.
 *
 * Bất biến bảo mật: giá trị secret (mật khẩu role) KHÔNG BAO GIỜ nằm trong
 * script text — tức không nằm trong argv của `sh -c` mà provider dùng để chạy
 * script — cũng như trong argv của bất kỳ process nào script sinh ra. Giá trị
 * đi vào tiến trình shell qua biến môi trường (kênh `environment` của
 * `command.local.Command`), rồi được tiêu thụ bằng đúng TÊN biến trong script.
 * Tham số đầu vào của hàm build là dữ liệu thô vô secret (worktreeRoot KHÔNG
 * phải secret — chỉ là đường dẫn), nên harness test dựng được script y hệt
 * production mà không cần Pulumi hay secret thật.
 */

import { shellQuote } from '@ecoma-io/deployment';

/**
 * TÊN biến môi trường chứa mật khẩu của từng role. Script provision đọc mật
 * khẩu bằng đúng tên này, và wiring Pulumi (`index.ts`) dựng map `environment`
 * với cùng hằng — tên biến không thể lệch giữa hai phía. Giá trị KHÔNG đi qua
 * đây: giá trị được bọc `pulumi.secret` trong `environment` của provider.
 *
 * KHÔNG có biến owner: bounded context này KHÔNG có owner role dùng riêng —
 * `db-backoffice` do `ecoma_local` sở hữu (điều kiện hoá ownership theo unit
 * sở hữu; khác account/auth có `ecoma_owner`).
 */
export const MIGRATOR_PASSWORD_ENV_VAR = 'BACKOFFICE_PW_MIGRATOR';
export const RUNTIME_PASSWORD_ENV_VAR = 'BACKOFFICE_PW_RUNTIME';

/** Input của {@link buildProvisionScript}. */
export interface ProvisionScriptInputs {
  /** Tên container PostgreSQL của platform mà `docker exec` nhắm vào. */
  readonly postgresContainerName: string;
  /**
   * Đường dẫn worktree chứa `apps/backoffice/db/migrations/*.sql` cho pipe
   * migration — dữ liệu thô vô secret, được `shellQuote` trước khi nối vào
   * script (không nối trần).
   */
  readonly worktreeRoot: string;
}

/**
 * Script provision: guard-create `db-backoffice` + 2 role + ALTER password qua
 * STDIN + grant + hardening + migration, chạy trên host qua `docker exec` vào
 * container PostgreSQL của platform. Idempotent: mỗi câu SQL guard bằng
 * `IF NOT EXISTS` (migration dùng `\gexec`/guard tương đương), ALTER password
 * idempotent sẵn — chạy lại áp cùng giá trị, KHÔNG rotate.
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
  return `set -e
PG=${inputs.postgresContainerName}
PSQL_STDIN="docker exec -i $PG psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1"
# 1. Tạo database nếu chưa có (idempotent qua shell guard).
if ! docker exec "$PG" psql -U ecoma_local -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='db-backoffice'" | grep -q 1; then docker exec "$PG" psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE "db-backoffice"'; fi
# 2. Tạo hai role nếu chưa có.
if ! docker exec "$PG" psql -U ecoma_local -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_backoffice_migrator'" | grep -q 1; then docker exec "$PG" psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ecoma_backoffice_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;"; fi
if ! docker exec "$PG" psql -U ecoma_local -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_backoffice_runtime'" | grep -q 1; then docker exec "$PG" psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ecoma_backoffice_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;"; fi
# 3. Mật khẩu role — giá trị đến từ biến môi trường của shell (kênh
#    \`environment\` của command.local.Command), script text chỉ chứa TÊN biến:
#    không argv của \`sh -c\`, không script text trong state Pulumi, không argv
#    của sed/psql. sql_quote nhận password qua đối số HÀM shell (không sinh
#    process) và đẩy qua STDIN của sed; câu SQL hoàn tất được nạp vào psql qua
#    STDIN của \`docker exec -i\` — không process nào trong chuỗi giữ giá trị
#    trong argv, và psql vẫn thấy nguyên literal sau khi escape (giữ nguyên
#    ngữ nghĩa quoting SQL mà hai biên escaping trước đây bảo vệ).
sql_quote() {
  printf '%s' "$1" | sed "s/'/''/g"
}

apply_password() {
  # $1 = role, $2 = password (ô nhớ shell — lời gọi hàm không sinh process).
  quoted=$(sql_quote "$2")
  printf '%s\\n' "ALTER ROLE $1 WITH PASSWORD '$quoted';" | $PSQL_STDIN
}

apply_password ecoma_backoffice_migrator "$${MIGRATOR_PASSWORD_ENV_VAR}"
apply_password ecoma_backoffice_runtime "$${RUNTIME_PASSWORD_ENV_VAR}"
# 4. Grant migrator.
docker exec "$PG" psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1 -c 'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "db-backoffice" TO ecoma_backoffice_migrator;'
# Hardening schema public — chạy bằng owner mới revoke được; migration statement là no-op trên PG15+.
docker exec "$PG" psql -U ecoma_local -d db-backoffice -v ON_ERROR_STOP=1 -c 'REVOKE ALL ON SCHEMA public FROM PUBLIC'
# 5. Migration qua socket trong container (trust local) — dùng runner SQL thật.
#    worktreeRoot do người dùng truyền — shellQuote, không nối trần vào script.
#    Pipe này KHÔNG chứa secret: chỉ SQL migration (dữ liệu public của repo) và
#    tên role migrator.
{ echo "SELECT pg_advisory_lock(hashtext('db-backoffice'));"; cat ${shellQuote(inputs.worktreeRoot)}/apps/backoffice/db/migrations/*.sql; echo "SELECT pg_advisory_unlock(hashtext('db-backoffice'));"; } | docker exec -i "$PG" psql -U ecoma_backoffice_migrator -d db-backoffice -v ON_ERROR_STOP=1
`;
}
