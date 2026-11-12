/**
 * Xây script shell cho provision và migrate của `staff-access-deploy` — HÀM
 * THUẦN, input là dữ liệu thô (tên container, tên network, đường dẫn worktree,
 * tên image, TÊN biến môi trường), output là script text KHÔNG chứa giá trị
 * secret nào. Chương trình Pulumi (`index.ts`) gọi đúng các hàm này nên script
 * chạy thật và script được test là MỘT nguồn sự thật.
 *
 * Bất biến bảo mật của cả hai script: giá trị secret (mật khẩu role, chuỗi
 * kết nối) KHÔNG BAO GIỜ nằm trong script text — tức không nằm trong argv của
 * `sh -c` mà provider dùng để chạy script — cũng như trong argv của bất kỳ
 * process nào script sinh ra. Giá trị đi vào tiến trình shell qua biến môi
 * trường (kênh `environment` của `command.local.Command`), rồi được tiêu thụ
 * bằng đúng TÊN biến trong script. Tham số đầu vào của hàm build là dữ liệu thô
 * vô secret, nên harness test dựng được script y hệt production mà không cần
 * Pulumi hay secret thật.
 *
 * Bảo toàn từ baseline cũ (trước khi mật khẩu rời khỏi command text): các
 * phép GẮN KẾT QUẢ kiểm tra tồn tại vào biến (`MIGRATOR_EXISTS=$(...)`,
 * `DATABASE_EXISTS=$(...)`, `EXISTS=$(...)` trong vòng `for TARGET`) —
 * fail-closed, và vòng chặn chéo `for TARGET in db-account db-auth
 * db-backoffice` giữ nguyên ngữ nghĩa.
 */

import { shellQuote } from '@ecoma-io/deployment';

/**
 * TÊN biến môi trường chứa mật khẩu của từng role. Script provision đọc mật
 * khẩu bằng đúng tên này, và wiring Pulumi (`index.ts`) dựng map `environment`
 * với cùng hằng — tên biến không thể lệch giữa hai phía. Giá trị KHÔNG đi qua
 * đây: giá trị được bọc `pulumi.secret` trong `environment` của provider.
 *
 * KHÔNG có biến owner: bounded context này KHÔNG có owner role dùng chung
 * (ADR-0020 Quyết định 11 — `ecoma_owner` không tồn tại cho db-staff-access;
 * migrator sở hữu schema `staff_access` sau migration `0001`).
 */
export const MIGRATOR_PASSWORD_ENV_VAR = 'STAFF_PW_MIGRATOR';
export const RUNTIME_PASSWORD_ENV_VAR = 'STAFF_PW_RUNTIME';

/** Input của {@link buildProvisionScript}. */
export interface ProvisionScriptInputs {
  /** Tên container PostgreSQL của platform mà `docker exec` nhắm vào. */
  readonly postgresContainerName: string;
}

/**
 * Script provision: guard-create 2 role riêng của db-staff-access + ALTER
 * password qua STDIN + database + grant + chặn chéo, chạy trên host qua
 * `docker exec` vào container PostgreSQL của platform. Idempotent: role/database
 * guard-create bằng shell `if`, ALTER password idempotent sẵn — chạy lại áp
 * cùng giá trị, KHÔNG rotate.
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
# Mọi lần kiểm tra tồn tại đều gắn kết quả vào biến TRƯỚC khi so sánh: 'set -e'
# không áp dụng cho điều kiện của 'if', nên dạng 'if ! $PSQL ... | grep -q 1'
# đọc một lần psql lỗi thành "không tồn tại" và chạy CREATE (hoặc bỏ qua REVOKE)
# trong khi command resource vẫn báo thành công. Với phép gán, lỗi psql làm cả
# script dừng (fail-closed).
# 1. Hai role của db-staff-access — guard-create khi thiếu.
MIGRATOR_EXISTS=$($PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_staff_access_migrator'")
if [ "$MIGRATOR_EXISTS" != "1" ]; then $PSQL -c "CREATE ROLE ecoma_staff_access_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
RUNTIME_EXISTS=$($PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_staff_access_runtime'")
if [ "$RUNTIME_EXISTS" != "1" ]; then $PSQL -c "CREATE ROLE ecoma_staff_access_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
# 2. Mật khẩu hai role — giá trị đến từ biến môi trường của shell (kênh
#    \`environment\` của command.local.Command), script text chỉ chứa TÊN biến:
#    không argv của \`sh -c\`, không script text trong state Pulumi, không argv
#    của sed/psql. sql_quote nhận password qua đối số HÀM shell (không sinh
#    process) và đẩy qua STDIN của sed; câu SQL hoàn tất được nạp vào psql qua
#    STDIN của \`docker exec -i\` — không process nào trong chuỗi giữ giá trị
#    trong argv, và psql vẫn thấy nguyên literal sau khi escape (giữ nguyên
#    ngữ nghĩa quoting SQL).
sql_quote() {
  printf '%s' "$1" | sed "s/'/''/g"
}

apply_password() {
  # $1 = role, $2 = password (ô nhớ shell — lời gọi hàm không sinh process).
  quoted=$(sql_quote "$2")
  printf '%s\\n' "ALTER ROLE $1 WITH PASSWORD '$quoted';" | $PSQL_STDIN
}

apply_password ecoma_staff_access_migrator "$${MIGRATOR_PASSWORD_ENV_VAR}"
apply_password ecoma_staff_access_runtime "$${RUNTIME_PASSWORD_ENV_VAR}"
# 3. Database — guard-create, idempotent qua lần chạy sau.
DATABASE_EXISTS=$($PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='db-staff-access'")
if [ "$DATABASE_EXISTS" != "1" ]; then $PSQL -c 'CREATE DATABASE "db-staff-access"'; fi
# 4. Grant: migrator cần CREATE trên database để tạo schema staff_access
#    (migration 0001 tự cấp USAGE/CREATE trên schema sau khi tạo); runtime chỉ
#    CONNECT — DML grant theo bảng nằm trong migration 0001.
$PSQL -c 'REVOKE CONNECT ON DATABASE "db-staff-access" FROM PUBLIC'
$PSQL -c 'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "db-staff-access" TO ecoma_staff_access_migrator'
$PSQL -c 'GRANT CONNECT ON DATABASE "db-staff-access" TO ecoma_staff_access_runtime'
# 4b. Chặn chéo chiều RA: rút CONNECT TRỰC TIẾP của hai role staff-access
#     trên database của service khác. Điều kiện hoá theo sự tồn tại của
#     database đích — nó có thể chưa được tạo ở lần up đầu, và REVOKE trên
#     database không tồn tại là lỗi chứ không phải no-op (cùng hình với
#     account/auth).
#     ⚠️ Giới hạn đã đo: thu hồi này chỉ xoá grant TRỰC TIẾP. db-backoffice
#     hiện vẫn cấp CONNECT cho PUBLIC (datacl giữ "=Tc/...") và unit sở hữu nó
#     không rút quyền đó, nên has_database_privilege(...) vẫn là true qua
#     PUBLIC cho tới khi backoffice-deploy tự rút PUBLIC rồi GRANT lại cho
#     role của chính nó. Việc đó thuộc unit sở hữu database — staff-access
#     không được cấp/rút quyền thay. db-account/db-auth đã rút PUBLIC nên ở
#     đó thu hồi này là hiệu lực thật.
for TARGET in db-account db-auth db-backoffice; do
  # ⚠️ Gắn kết quả vào biến TRƯỚC rồi mới so sánh: 'set -e' không áp dụng cho
  # điều kiện của 'if', nên dạng 'if $PSQL ... | grep -q 1' thì một lần psql
  # lỗi (database đang restart, socket lỗi) bị đọc thành "không tồn tại" và
  # REVOKE bị bỏ qua trong im lặng — command resource vẫn báo thành công.
  # Với phép gán, lệnh substitution lỗi làm cả script dừng (fail-closed).
  EXISTS=$($PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='$TARGET'")
  if [ "$EXISTS" = "1" ]; then
    $PSQL -c "REVOKE CONNECT ON DATABASE \\"$TARGET\\" FROM ecoma_staff_access_migrator"
    $PSQL -c "REVOKE CONNECT ON DATABASE \\"$TARGET\\" FROM ecoma_staff_access_runtime"
  fi
done
# 5. Hardening schema public — chạy bằng owner (ecoma_local) mới thực sự revoke
#    được; statement tương đương trong migration 0002 là no-op trên PG15+ khi chạy
#    bằng migrator. Idempotent.
docker exec $PG psql -U ecoma_local -d db-staff-access -v ON_ERROR_STOP=1 -c 'REVOKE ALL ON SCHEMA public FROM PUBLIC'
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
 * `tsx db/apply.mts` của repo (`apps/staff-access/db/apply.mts` — advisory
 * lock `hashtext('db-staff-access')`, mọi DDL idempotent — giữ nguyên).
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
  -w /repo/apps/staff-access \\
  -e DATABASE_URL \\
  ${inputs.nodeImage} \\
  /repo/node_modules/.bin/tsx --tsconfig tsconfig.db.json db/apply.mts
`;
}
