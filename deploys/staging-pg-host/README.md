# staging-pg-host

Provision host PostgreSQL staging dùng chung (#349) trên VPS tự vận hành:
cài cluster, tạo 11 database + cặp role `runtime`/`migrator` per-DB với
isolation `CONNECT` (§4.1.2, invariant 5/25). Chạy trên stack `staging`,
backend state R2, qua engine lane chung của `platform-deploy`.

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

| Key                 | Ý nghĩa                       |
| ------------------- | ----------------------------- |
| `hostAddress`       | Địa chỉ IP VPS staging        |
| `sshUser`           | User SSH (script dùng `sudo`) |
| `sshPrivateKeyPath` | Đường dẫn key SSH ngoài Git   |

## Bảo mật

- Password DB sinh bằng `openssl rand` TRÊN HOST lúc chạy script — text
  script và state Pulumi không chứa password; giá trị về qua stdout, được
  export `pulumi.secret` (output `pgRolePasswords`).
- PostgreSQL lắng nghe localhost mặc định — chưa có đường truy cập ngoài
  nào được mở.

## Chưa làm (block/escalate)

- Marker `ecoma.deployment.status: "scaffold"`: unit này là lifecycle project
  provision hạ tầng (không sở hữu app entry nào trong DEPLOYMENT_MAP), và lần
  `pulumi up` thật chưa xảy ra (chờ VPS + credential #350). Nâng thành
  `implemented` đòi hỏi mở rộng DEPLOYMENT_MAP (entry `platform` mới cho
  provisioning unit) — quyết định contract, đã escalate.
- TODO(349/blocking): Cloudflare Tunnel + Workers VPC Service + DNS CNAME
  `pg-staging.ecoma.io.vn` — §9.1 giao Wrangler, issue #349 nhận là outcome của
  unit; quyết định VP4 đã escalate, chưa tự suy.
- TODO(349/blocking): hardening `pg_hba` (scram, localhost-only tường minh),
  backup + WAL archive (§6.1 Tier 0, §3.1) — cần đích lưu trữ off-host.
- `pulumi up` thật chờ VPS + credential #350 (bootstrap state staging).
