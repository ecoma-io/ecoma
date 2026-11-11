/**
 * Xây script shell cho provision và migrate của `llm-api-deploy` — HÀM THUẦN,
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
 * bằng đúng TÊN biến trong script. Tham số đầu vào của hàm build là dữ liệu
 * thô vô secret, nên harness test dựng được script y hệt production mà không
 * cần Pulumi hay secret thật.
 */

import { shellQuote } from '@ecoma-io/deployment';

/** Ba database sở hữu của llm-api (một service sở hữu toàn bộ — A2). */
export const DATABASES = ['gateway', 'tenant', 'marketplace'] as const;
export type Database = (typeof DATABASES)[number];

/** Loại role trên một database — mỗi cặp (target, role) một credential riêng. */
export type RoleKind = 'migrator' | 'runtime';

/** Tên database của một target — `db-llm-<target>`. */
export function dbName(target: Database): string {
  return `db-llm-${target}`;
}

/** Tên role migrator của một target — `ecoma_llm_<target>_migrator`. */
export function migratorRole(target: Database): string {
  return `ecoma_llm_${target}_migrator`;
}

/** Tên role runtime của một target — `ecoma_llm_<target>_runtime`. */
export function runtimeRole(target: Database): string {
  return `ecoma_llm_${target}_runtime`;
}

/**
 * TÊN biến môi trường chứa mật khẩu của một role. Script provision đọc mật
 * khẩu bằng đúng tên này, và wiring Pulumi (`index.ts`) dựng map `environment`
 * với cùng hàm — tên biến không thể lệch giữa hai phía. Giá trị KHÔNG đi qua
 * đây: giá trị được bọc `pulumi.secret` trong `environment` của provider.
 */
export function passwordEnvVar(target: Database, role: RoleKind): string {
  return `LLM_PW_${target.toUpperCase()}_${role.toUpperCase()}`;
}

/** Input của {@link buildProvisionScript}. */
export interface ProvisionScriptInputs {
  /** Tên container PostgreSQL của platform mà `docker exec` nhắm vào. */
  readonly postgresContainerName: string;
}

/**
 * Script provision: `ecoma_owner` (guard-create, KHÔNG ALTER password —
 * account stack sở hữu password của role dùng chung này) + ba database + sáu
 * role + revoke chéo, chạy trên host qua `docker exec` vào container PostgreSQL
 * của platform. Idempotent: guard-create bằng shell `if`, ALTER password
 * idempotent sẵn — chạy lại áp cùng giá trị, KHÔNG rotate.
 *
 * Kênh mật khẩu: mỗi `ALTER ROLE ... PASSWORD` được DỰNG TRONG shell từ biến
 * môi trường rồi nạp vào psql qua **STDIN** của `docker exec -i` — không `-c`
 * nào chứa giá trị, nên psql nhìn thấy SQL qua stdin chứ không qua argv. Hai
 * biên escaping vẫn giữ nguyên ngữ nghĩa:
 * 1. {@link shellQuote} không còn cần ở biên này — giá trị KHÔNG đi qua argv
 *    của shell nào nữa; thay vào đó là hàm `sql_quote` bên trong script, nhận
 *    password qua đối số HÀM shell (lời gọi hàm không sinh process, giá trị
 *    nằm trong ô nhớ của shell) và tự đẩy qua **stdin** của `sed` (argv của
 *    sed chỉ chứa script `s/'/''/g`, không chứa giá trị) — bảo vệ literal SQL.
 * 2. Toàn bộ câu SQL thành MỘT dòng dữ liệu đi qua pipe của shell vào stdin
 *    psql — shell không bao giờ parse nó (không expansion vì nằm trong chuỗi
 *    double-quoted được printf `%s` in nguyên dạng).
 */
export function buildProvisionScript(inputs: ProvisionScriptInputs): string {
  const pg = inputs.postgresContainerName;

  const roleDbBlocks = DATABASES.map((target) => {
    const mr = migratorRole(target);
    const rr = runtimeRole(target);
    const db = dbName(target);
    return `# Role của ${db} — guard-create khi thiếu.
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='${mr}'" | grep -q 1; then $PSQL -c "CREATE ROLE ${mr} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='${rr}'" | grep -q 1; then $PSQL -c "CREATE ROLE ${rr} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
# Database + owner. CREATE là lệnh guard (bash if), ALTER idempotent sẵn.
if ! $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'" | grep -q 1; then $PSQL -c 'CREATE DATABASE "${db}"'; fi
$PSQL -c 'ALTER DATABASE "${db}" OWNER TO ecoma_owner'
`;
  }).join('');

  const alterLines = DATABASES.flatMap((target) => [
    `apply_password ${migratorRole(target)} "$${passwordEnvVar(target, 'migrator')}"`,
    `apply_password ${runtimeRole(target)} "$${passwordEnvVar(target, 'runtime')}"`,
  ]).join('\n');

  const crossRevokeBlocks = DATABASES.map((target) => {
    const rr = runtimeRole(target);
    const lines = DATABASES.filter((other) => other !== target).map((other) => {
      const otherDb = dbName(other);
      return `# Chặn chéo: ${rr} không được CONNECT vào ${otherDb} (điều kiện: DB đích tồn tại).
if $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='${otherDb}'" | grep -q 1; then $PSQL -c 'REVOKE CONNECT ON DATABASE "${otherDb}" FROM PUBLIC'; fi
if $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='${otherDb}'" | grep -q 1; then $PSQL -c 'REVOKE CONNECT ON DATABASE "${otherDb}" FROM ${rr}'; fi`;
    });
    return lines.join('\n') + '\n';
  }).join('');

  const grantBlocks = DATABASES.map((target) => {
    const mr = migratorRole(target);
    const rr = runtimeRole(target);
    const db = dbName(target);
    return `$PSQL -c 'REVOKE CONNECT ON DATABASE "${db}" FROM PUBLIC'
$PSQL -c 'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${db}" TO ${mr}'
$PSQL -c 'GRANT CONNECT ON DATABASE "${db}" TO ${rr}'
`;
  }).join('');

  const hardeningBlocks = DATABASES.map(
    (target) =>
      `docker exec $PG psql -U ecoma_local -d ${dbName(target)} -v ON_ERROR_STOP=1 -c 'REVOKE ALL ON SCHEMA public FROM PUBLIC'
`,
  ).join('');

  return `set -e
PG=${pg}
PSQL="docker exec $PG psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1"
PSQL_STDIN="docker exec -i $PG psql -U ecoma_local -d postgres -v ON_ERROR_STOP=1"
# 1. Owner role dùng chung — CHỈ tạo khi thiếu; KHÔNG ALTER password (account
#    stack sở hữu password của ecoma_owner; ALTER ở hai nơi là race xoá nhau).
if ! $PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='ecoma_owner'" | grep -q 1; then $PSQL -c "CREATE ROLE ecoma_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"; fi
# 2. Ba database + sáu role — guard-create.
${roleDbBlocks}
# 3. Mật khẩu sáu role — giá trị đến từ biến môi trường của shell (kênh
#    \`environment\` của command.local.Command), script text chỉ chứa TÊN biến:
#    không argv của \`sh -c\`, không script text trong state Pulumi, không argv
#    của sed/psql. sql_quote nhận password qua đối số HÀM shell (không sinh
#    process) và đẩy qua STDIN của sed; câu SQL hoàn tất được nạp vào psql qua
#    STDIN của \`docker exec -i\` — không process nào trong chuỗi giữ giá trị
#    trong argv, và psql vẫn thấy nguyên literal sau khi escape (hai biên
#    escaping giữ nguyên ngữ nghĩa quoting SQL).
sql_quote() {
  printf '%s' "$1" | sed "s/'/''/g"
}

apply_password() {
  # $1 = role, $2 = password (ô nhớ shell — lời gọi hàm không sinh process).
  quoted=$(sql_quote "$2")
  printf '%s\\n' "ALTER ROLE $1 WITH PASSWORD '$quoted';" | $PSQL_STDIN
}

${alterLines}
# 4. Revoke chéo giữa các database của unit — runtime role của một DB bị chặn
#    CONNECT vào hai DB kia (bất biến không cross-database query), điều kiện
#    theo DB đích tồn tại.
${crossRevokeBlocks}
# 5. Thu CONNECT của PUBLIC trước, rồi grant per-role (chỉ revoke role là no-op
#    vì PUBLIC giữ CONNECT theo mặc định). Migrator cần CREATE+TEMP để tạo
#    schema (migration 0001 tự cấp USAGE trên schema sau khi tạo); runtime chỉ
#    CONNECT — DML grant theo bảng nằm trong migration 0001 (ALTER DEFAULT
#    PRIVILEGES FOR ROLE migrator).
${grantBlocks}
# 6. Hardening schema public — ecoma_local (owner/superuser) mới revoke được.
${hardeningBlocks}`;
}

/** Input của {@link buildMigrateScript}. */
export interface MigrateScriptInputs {
  /** Tên Docker network của platform mà container migration gia nhập. */
  readonly networkName: string;
  /** Đường dẫn worktree — mount `/repo` read-only + `node_modules` RW. */
  readonly worktreeRoot: string;
  /** Target database cần apply — đối số của `db/apply.mts`. */
  readonly target: Database;
  /** Image Node pin theo digest dùng để chạy tsx của repo. */
  readonly nodeImage: string;
}

/**
 * Script migrate cho MỘT target: container ephemeral trên platform network chạy
 * đúng `npx tsx --tsconfig tsconfig.db.json db/apply.mts <target>` của repo
 * (advisory lock `hashtext('db-llm-<target>')`, verify `current_database()`
 * khớp DB đích — chống chạy nhầm credential, giữ nguyên trong `db/apply.mts`).
 * KHÔNG chạy qua binding Hyperdrive (HD6: Hyperdrive không hỗ trợ advisory
 * lock).
 *
 * Kênh chuỗi kết nối: `DATABASE_URL` của migrator đến từ biến môi trường của
 * tiến trình shell (kênh `environment` của command.local.Command), rồi
 * `docker run -e DATABASE_URL` — CHỈ TÊN biến, không `=giá trị` — bảo docker
 * CLI đọc giá trị từ environ của chính nó và chuyển vào container env. Do đó
 * URL (chứa password) không nằm trong argv của `sh -c`, của `docker run`, của
 * tsx bên trong container, hay trong script text nào; password được
 * percent-encode ở wiring Pulumi trước khi ghép vào userinfo (giữ ở
 * `index.ts`, nơi giá trị được bọc `pulumi.secret`).
 */
export function buildMigrateScript(inputs: MigrateScriptInputs): string {
  return `set -e
docker run --rm \\
  --network ${inputs.networkName} \\
  -v ${shellQuote(inputs.worktreeRoot)}:/repo:ro \\
  -v ${shellQuote(inputs.worktreeRoot)}/node_modules:/repo/node_modules \\
  -w /repo/apps/llm-api \\
  -e DATABASE_URL \\
  ${inputs.nodeImage} \\
  npx tsx --tsconfig tsconfig.db.json db/apply.mts ${inputs.target}
`;
}
