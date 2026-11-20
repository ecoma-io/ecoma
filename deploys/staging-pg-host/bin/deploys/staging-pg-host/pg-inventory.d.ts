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
export declare const STAGING_PG_DATABASES: readonly [
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
];
export type StagingPgDatabase = (typeof STAGING_PG_DATABASES)[number];
/**
 * Tên role runtime của một database — `<unit>_runtime` (bỏ tiền tố `db-`,
 * `-` đổi thành `_`): PostgreSQL identifier không quote không chứa `-`, và
 * tên underscore cũng hợp lệ làm biến shell (caller đặt `PW_<role>`).
 */
export declare function runtimeRoleName(db: StagingPgDatabase): string;
/** Tên role migrator của một database — `<unit>_migrator` (cùng quy tắc tên). */
export declare function migratorRoleName(db: StagingPgDatabase): string;
/**
 * SQL tạo database IDEMPOTENT (chạy lại không lỗi, không drop dữ liệu):
 * `CREATE DATABASE` chỉ khi chưa tồn tại, qua `\gexec` của psql. Identifier
 * LUÔN double-quote (tên DB có `-` — unquoted là lỗi cú pháp).
 */
export declare function createDatabaseSql(db: StagingPgDatabase): string;
/**
 * SQL tạo cặp role của MỘT database IDEMPOTENT: `CREATE ROLE` chỉ khi chưa
 * tồn tại (qua `\gexec`), rồi `ALTER ROLE ... PASSWORD` chạy VÔ ĐIỀU KIỆN —
 * chạy lại chỉ xoay password, không bao giờ lỗi vì role đã có.
 *
 * Đối số password là VĂN BẢN chèn trực tiếp vào script — caller (#349) truyền
 * tham chiếu biến shell (`$PW_...`) sinh bằng `openssl rand` TRÊN HOST, nên
 * password chưa từng xuất hiện trong text script (state Pulumi lưu script
 * không password; giá trị thật chỉ về qua stdout của command, quấn
 * `pulumi.secret()` ở caller). Giá trị hex/an toàn-đặt-tên biến không cần
 * escape dấu nháy đơn.
 *
 * CỐTÝNH dùng `\gexec` thay vì `DO $$ ... $$`: script chạy trong heredoc
 * shell KHÔNG quote, `$$` bị shell mở rộng thành PID — `\gexec` không có ký
 * tự nào shell chạm vào.
 */
export declare function createRolesSql(
  db: StagingPgDatabase,
  runtimePassword: string,
  migratorPassword: string,
): string;
/**
 * SQL cấp quyền của MỘT database — isolation per-DB (A2, invariant 5/25):
 * `CONNECT` bị RỜI khỏi PUBLIC rồi cấp đúng cho hai role của database ĐÓ;
 * migrator sở hữu schema (chạy migration), runtime dùng đủ DML qua role
 * mặc định của PostgreSQL (`public` schema grant). Không role nào của
 * database khác xuất hiện trong script này.
 */
export declare function grantsSql(db: StagingPgDatabase): string;
