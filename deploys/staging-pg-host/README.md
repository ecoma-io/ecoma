# Staging PostgreSQL Host Deploy

Pulumi deployment project provision host PostgreSQL staging dùng chung (#349)
trên VPS tự vận hành. Pulumi MODELS VPS do operator mua — lựa chọn
provider/region là quyết định hạ tầng riêng (mục "Spec VPS" `03-operations.md`
§10). Chạy trên stack `staging`, backend state R2, qua engine lane chung của
`platform-deploy` (cờ `--project staging-pg-host`).

Nx project `staging-pg-host`, tags `type:deployment`, `scope:platform`,
`runtime:native`; marker `ecoma.deployment.status: "scaffold"` (lần `up` thật
chưa xảy ra).

## Purpose

- Cài cluster PostgreSQL trên host staging, tạo 11 logical database theo
  inventory với cặp role `runtime`/`migrator` per-DB và isolation `CONNECT`
  per-DB (§4.1.2, invariant 5/25).
- Bật backup base + WAL archive → R2 (§3.1, §6.1 Required): `archive_mode` +
  `archive_command` (atomic `.part` + `mv`), systemd timer đẩy WAL 5 phút và
  `pg_basebackup` hằng ngày qua rclone lên bucket operator cấp.
- Đơn vị hạ tầng duy nhất cho PostgreSQL của lane staging liên tục; VPC
  Service + Tunnel KHÔNG thuộc project này (xem Boundaries).

## Responsibilities

- Khai Pulumi program `index.ts` + module inventory thuần `pg-inventory.ts`
  (có unit test hợp đồng inventory: 11 DB, 22 role shell-safe, builder SQL
  idempotent, identifier quote, không grant chéo).
- Hai target lane `staging-preview`/`staging-up` reuse engine
  `platform-deploy/staging.ts` qua `--project` — credential fail-closed và
  evidence record `.staging-evidence/` là một nguồn sự thật chung; targets
  `lint`/`typecheck`/`test` theo chuẩn Nx.
- Password DB sinh `openssl rand` TRÊN HOST: script + state Pulumi không chứa
  password; stdout export `pulumi.secret`. Credential backup R2 là config
  secret, đích cuối `/etc/pg-backup.env` (0600 root) trên host.
- Config stack fail-closed: `hostAddress`, `sshUser`, `sshPrivateKeyPath`,
  `backupBucketName`, `backupR2Endpoint`, `backupR2AccessKey`,
  `backupR2SecretKey`. Retention PITR là lifecycle rule trên bucket R2 —
  operator cấu hình (§3.1 cạm bẫy (1): không dùng `pg_archivecleanup`).

## Boundaries

- KHÔNG provision Cloudflare Tunnel, Workers VPC Service hay DNS CNAME
  `pg-staging.ecoma.io.vn` — §9.1 `02-delivery.md` giao Wrangler (`04` VP4);
  scope reading chính thức đã ghi trên issue #349. Kết nối Workers →
  PostgreSQL thuộc lane #350.
- KHÔNG chọn công cụ backup cuối — placeholder built-ins + rclone với
  `TODO(349/tool)`; mục "Chưa chốt" `03-operations.md` §10 giữ quyền quyết.
- KHÔNG sở hữu migration schema (các `deploys/*-db`, §3a) hay runtime Worker;
  KHÔNG có lane local (PostgreSQL local cho worktree thuộc lane local của
  `platform-deploy`).
- KHÔNG xóa/destroy: chỉ hai phase `preview`/`up` — teardown staging là
  checklist tay runbook #364 (§7.4.1).

## Development

```bash
pnpm nx run staging-pg-host:staging-preview -c staging   # preview
pnpm nx run staging-pg-host:staging-up -c staging        # up
pnpm nx run staging-pg-host:lint
pnpm nx run staging-pg-host:typecheck
```

Credential bắt buộc của lane (env-only, không argv, không Git):
`ECOMA_PULUMI_STATE_URL_STAGING`, `PULUMI_CONFIG_PASSPHRASE`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

Giả định layout Debian/Ubuntu + PostgreSQL từ apt là cố định của provision
(`pg-install` dùng `apt-get`; đường dẫn hệ thống tập trung ở khối `PATHS`
của `index.ts`).

## Testing

- Target `test` (Vitest): unit test hợp đồng inventory trong
  `pg-inventory.spec.ts` — module thuần, không cần host thật.
- Guard stack được verify runtime trên backend `file://` vứt: stack lạ →
  refusal; stack `staging` thiếu config → fail-closed.
- `pulumi up` thật CHƯA chạy — deviation record trên issue #349: gated #504
  merge + credential operator + mua VPS.

## Related Documentation

- [`docs/architecture/03-operations.md`](../../docs/architecture/03-operations.md) —
  chính sách backup/DR §3.1, Tier 0 §6.1, mục chưa chốt §10.
- [`docs/architecture/02-delivery.md`](../../docs/architecture/02-delivery.md) §4.1.2,
  §9.1 — shared-host acceptance, inventory DB, bảng ownership hạ tầng.
- [`deploys/platform-deploy/README.md`](../platform-deploy/README.md) — engine lane
  staging được reuse qua cờ `--project`.
- Issue #349 — scope reading + deviation record; #350 — bootstrap state backend
  và lane Wrangler (VPC Service + Tunnel).
