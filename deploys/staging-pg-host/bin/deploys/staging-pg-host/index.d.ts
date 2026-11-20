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
 * Hardening + backup/WAL archive (§6.1 Tier 0) là việc còn lại của unit này —
 * xem README; không nằm trong lần provision đầu.
 */
import type * as pulumi from '@pulumi/pulumi';
/** Isolation per-DB: REVOKE CONNECT public, grant đúng cặp role của DB đó. */
export declare const pgGrants: import('@pulumi/command/remote/command.js').Command;
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
export declare const pgRolePasswords: pulumi.Output<string>;
