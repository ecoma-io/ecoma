/**
 * Inventory databases + roles của staging PostgreSQL host (#349) — dữ liệu
 * thuần, KHÔNG đụng Pulumi runtime: các builder SQL ở đây là hàm pure để unit
 * test xác minh được hợp đồng inventory (MOD1/#373 mục A) mà không cần host
 * thật.
 *
 * Hợp đồng cách ly (`02-delivery.md` §4.1.2, invariant 5/25): mỗi logical
 * database ĐÚNG MỘT cặp role runtime/migrator; không hai role nào dùng chung
 * password; không `CONNECT` chéo giữa các database. Role name dùng underscore
 * (`<unit>_runtime`) vì PostgreSQL cho phép identifier có `-` nhưng buộc
 * quote ở mọi câu lệnh — underscore là hình đơn giản nhất vẫn tường minh.
 */

/** 11 logical databases, inventory đã verify từ từng `deploys/<unit>/index.ts`. */
export const STAGING_PG_DATABASES = [
  'db-account',
  'db-auth',
  'db-backoffice',
  'db-staff-access',
  'db-llm-gateway',
  'db-llm-tenant',
  'db-llm-marketplace',
  'db-pact-broker',
  'db-pact-broker-app',
  'db-remote-cache',
  'db-remote-cache-app',
] as const;

export type StagingPgDatabase = (typeof STAGING_PG_DATABASES)[number];

/**
 * Tên role runtime của một database — `<unit>_runtime` (bỏ tiền tố `db-`,
 * `-` đổi thành `_`): PostgreSQL identifier không quote không chứa `-`, và
 * tên underscore cũng hợp lệ làm biến shell (caller đặt `PW_<role>`).
 */
export function runtimeRoleName(db: StagingPgDatabase): string {
  return `${db.slice('db-'.length).replaceAll('-', '_')}_runtime`;
}

/** Tên role migrator của một database — `<unit>_migrator` (cùng quy tắc tên). */
export function migratorRoleName(db: StagingPgDatabase): string {
  return `${db.slice('db-'.length).replaceAll('-', '_')}_migrator`;
}

/**
 * SQL tạo database IDEMPOTENT (chạy lại không lỗi, không drop dữ liệu):
 * `CREATE DATABASE` chỉ khi chưa tồn tại, qua `\gexec` của psql. Identifier
 * LUÔN double-quote (tên DB có `-` — unquoted là lỗi cú pháp).
 */
export function createDatabaseSql(db: StagingPgDatabase): string {
  const check = `SELECT 1 FROM pg_database WHERE datname = '${db}'`;
  return `SELECT 'CREATE DATABASE "${db}" OWNER "${migratorRoleName(db)}"' WHERE NOT EXISTS (${check})\\gexec`;
}

/**
 * SQL tạo cặp role của MỘT database IDEMPOTENT: `CREATE ROLE` chỉ khi chưa
 * tồn tại (qua `\gexec`), rồi `ALTER ROLE ... PASSWORD` chạy VÔ ĐIỀU KIỆN —
 * chạy lại chỉ xoay password, không bao giờ lỗi vì role đã có.
 *
 * Đối số password là VĂN BẢN chèn trực tiếp vào script — caller (#349) truyền
 * tham chiếu biến shell (`$PW_...`) sinh bằng `openssl rand` TRÊN HOST, nên
 * password chưa từng xuất hiện trong text script (state Pulumi lưu script
 * không password; giá trị thật chỉ về qua stdout của command, quấn
 * `pulumi.secret()` ở caller). Giá trị vẫn được escape dấu nháy đơn (`'` →
 * `''`) ở builder: caller hôm nay chỉ truyền tham chiếu biến shell, nhưng hợp
 * đồng của builder là SQL hợp lệ với MỌI giá trị text — không đường chèn nào
 * phá cú pháp ngay cả khi nguồn mật khẩu đổi sau này.
 *
 * CỐTÝNH dùng `\gexec` thay vì `DO $$ ... $$`: script chạy trong heredoc
 * shell KHÔNG quote, `$$` bị shell mở rộng thành PID — `\gexec` không có ký
 * tự nào shell chạm vào.
 */
/** Chuỗi SQL literal: nhân đôi nháy đơn (`'` → `''`) theo escape chuẩn. */
const sqlString = (value: string): string => value.replaceAll("'", "''");

export function createRolesSql(
  db: StagingPgDatabase,
  runtimePassword: string,
  migratorPassword: string,
): string {
  const runtime = runtimeRoleName(db);
  const migrator = migratorRoleName(db);
  return [
    `SELECT 'CREATE ROLE "${runtime}" LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${runtime}')\\gexec`,
    `ALTER ROLE "${runtime}" WITH LOGIN PASSWORD '${sqlString(runtimePassword)}';`,
    `SELECT 'CREATE ROLE "${migrator}" LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${migrator}')\\gexec`,
    `ALTER ROLE "${migrator}" WITH LOGIN PASSWORD '${sqlString(migratorPassword)}';`,
  ].join('\n');
}

/**
 * SQL cấp quyền của MỘT database — isolation per-DB (A2, invariant 5/25):
 * `CONNECT` bị RỜI khỏi PUBLIC rồi cấp đúng cho hai role của database ĐÓ;
 * migrator sở hữu schema (chạy migration), runtime dùng đủ DML qua role
 * mặc định của PostgreSQL (`public` schema grant). Không role nào của
 * database khác xuất hiện trong script này.
 */
export function grantsSql(db: StagingPgDatabase): string {
  const runtime = runtimeRoleName(db);
  const migrator = migratorRoleName(db);
  return [
    `REVOKE CONNECT ON DATABASE "${db}" FROM PUBLIC;`,
    `GRANT CONNECT ON DATABASE "${db}" TO "${runtime}";`,
    `GRANT CONNECT ON DATABASE "${db}" TO "${migrator}";`,
    `\\c "${db}"`,
    `REVOKE ALL ON SCHEMA public FROM PUBLIC;`,
    `GRANT USAGE, CREATE ON SCHEMA public TO "${migrator}";`,
    `GRANT USAGE ON SCHEMA public TO "${runtime}";`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${migrator}" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${runtime}";`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${migrator}" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "${runtime}";`,
  ].join('\n');
}
