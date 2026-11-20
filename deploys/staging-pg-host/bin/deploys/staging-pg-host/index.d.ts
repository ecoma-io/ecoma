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
 * TODO(349/blocking): DNS CNAME `pg-staging.ecoma.io.vn` và kết nối Workers →
 * PostgreSQL đợi quyết định VP4 (lệnh `wrangler vpc service create` chưa tồn
 * tại cho lane staging; unit nào provision tunnel — Wrangler hay đây — là
 * quyết định kiến trúc, đã escalate lên orchestrator, KHÔNG tự suy).
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
import type * as pulumi from '@pulumi/pulumi';
export declare const pgGrants: import('@pulumi/command/remote/command.js').Command;
/**
 * Jobs backup (§3.1: base hằng ngày, WAL liên tục): unit systemd oneshot +
 * timer đẩy WAL archive (5 phút) và base backup (`pg_basebackup`, 02:30) lên
 * R2 qua rclone. Credential R2 nằm trong `/etc/pg-backup.env` (0600 root) —
 * nội dung sinh từ config secret, không vào Git, không vào log. Retention
 * (PITR window) là lifecycle rule trên bucket R2 — operator cấu hình ngoài
 * chương trình này (§3.1 cạm bẫy (1): cắt WAL là lifecycle rule, không phải
 * `pg_archivecleanup`).
 */
export declare const pgBackupJobs: import('@pulumi/command/remote/command.js').Command;
export declare const pgHostAddress: string;
export declare const pgSshUser: string;
export declare const pgDatabasesProvisioned: (
  | 'db-account'
  | 'db-auth'
  | 'db-backoffice'
  | 'db-staff-access'
  | 'db-llm-gateway'
  | 'db-llm-tenant'
  | 'db-llm-marketplace'
  | 'db-pact-broker'
  | 'db-pact-broker-app'
  | 'db-remote-cache'
  | 'db-remote-cache-app'
)[];
export declare const pgBackupBucket: string;
export declare const pgRolePasswords: pulumi.Output<string>;
