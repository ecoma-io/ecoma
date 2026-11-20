# staging-pg-host

Provision host PostgreSQL staging dùng chung (#349) trên VPS tự vận hành
(Pulumi MODELS VPS do operator mua — lựa chọn provider/region là quyết định
riêng, mục "Spec VPS" của `03-operations.md` §10): cài cluster, tạo 11
database + cặp role `runtime`/`migrator` per-DB với isolation `CONNECT`
(§4.1.2, invariant 5/25), và bật backup base + WAL archive → R2 (§3.1).
Chạy trên stack `staging`, backend state R2, qua engine lane chung của
`platform-deploy`.

## Chạy

```bash
pnpm nx run staging-pg-host:staging-preview -c staging   # preview
pnpm nx run staging-pg-host:staging-up -c staging        # up
```

Target tái sử dụng engine `deploys/platform-deploy/staging.ts` với cờ
`--project staging-pg-host` — inventory credential fail-closed, evidence
record `.staging-evidence/` và refusal destroy là một nguồn sự thật chung.
Credential bắt buộc (env-only, không argv, không Git):
`ECOMA_PULUMI_STATE_URL_STAGING`, `PULUMI_CONFIG_PASSPHRASE`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

## Config stack

| Key                 | Ý nghĩa                                             |
| ------------------- | --------------------------------------------------- |
| `hostAddress`       | Địa chỉ IP VPS staging                              |
| `sshUser`           | User SSH (script dùng `sudo`)                       |
| `sshPrivateKeyPath` | Đường dẫn key SSH ngoài Git                         |
| `backupBucketName`  | Bucket R2 đích backup (tồn tại TRƯỚC, operator cấp) |
| `backupR2Endpoint`  | Endpoint S3 của R2                                  |
| `backupR2AccessKey` | Secret — token R2 scope bucket backup               |
| `backupR2SecretKey` | Secret — token R2 scope bucket backup               |

## Bảo mật

- Password DB sinh bằng `openssl rand` TRÊN HOST lúc chạy script — text
  script và state Pulumi không chứa password; giá trị về qua stdout, được
  export `pulumi.secret` (output `pgRolePasswords`).
- Credential backup R2 nằm trong `/etc/pg-backup.env` trên host (0600 root),
  nội dung sinh từ config secret — không vào Git, không vào log.
- PostgreSQL lắng nghe localhost mặc định — chưa có đường truy cập ngoài
  nào được mở.
- Retention PITR (cắt WAL theo cửa sổ) là lifecycle rule trên bucket R2 —
  operator cấu hình trên bucket, không phải `pg_archivecleanup` (§3.1).

## Chưa làm (block/escalate)

- Marker `ecoma.deployment.status: "scaffold"`: unit này là lifecycle project
  provision hạ tầng (không sở hữu app entry nào trong DEPLOYMENT_MAP), và lần
  `pulumi up` thật chưa xảy ra (chờ VPS + credential #350). Nâng thành
  `implemented` đòi hỏi mở rộng DEPLOYMENT_MAP (entry `platform` mới cho
  provisioning unit) — quyết định contract, đã escalate.
- TODO(349/blocking): Cloudflare Tunnel + Workers VPC Service + DNS CNAME
  `pg-staging.ecoma.io.vn` — §9.1 giao Wrangler, quyết định scope reading
  đã ghi trên issue #349 (Pulumi chỉ provision host + PostgreSQL +
  databases/roles + backup); kết nối Workers → PostgreSQL thuộc lane #350.
- TODO(349/tool): cơ chế backup hiện là placeholder built-ins
  (`pg_basebackup` + `archive_command` + `rclone`); công cụ backup cuối là
  mục "Chưa chốt" `03-operations.md` §10 — không suy từ placeholder này.
- TODO(349/blocking): hardening `pg_hba` (scram, localhost-only tường minh).
- `pulumi up` thật chờ VPS (operator mua) + credential #504/#350 (bootstrap
  state staging).
