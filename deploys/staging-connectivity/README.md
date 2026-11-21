# Staging Connectivity (Workers VPC Service + Tunnel)

Lane connectivity staging (#349): tạo Workers VPC Service TCP nối Worker →
PostgreSQL staging qua Cloudflare Tunnel. Quyền sở hữu là bảng canonical §9.1
`02-delivery.md` — hàng "Workers VPC Service + Tunnel" thuộc **Wrangler**;
project này là điểm vào Nx + docs cho operator, còn thực thi nằm ở CLI của
`@ecoma-io/delivery` (module `tools/delivery/src/staging-connectivity.ts`,
wiring `cli.ts vpc-service create`, unit test `staging-connectivity.spec.ts`).

Nx project `staging-connectivity`, tags `type:deployment`, `scope:platform`,
`runtime:native`; marker `ecoma.deployment.status: "scaffold"` (lần tạo service
thật chưa chạy).

## Purpose

- Một lệnh tạo VPC service đúng shape lane PG staging: `--type tcp`,
  `--app-protocol postgresql`, `--tcp-port 5432`, `--tunnel-id <uuid>`,
  `--hostname pg-staging.ecoma.io.vn` (VP2/VP3; `--tunnel-id` bắt buộc —
  đo trên pin wrangler 4.165.0, VP4).
- In ra dòng machine-readable `service_id=<uuid>` — output contract cho wiring
  Hyperdrive #350: Hyperdrive config thuộc **Pulumi** (§9.1 — Wrangler không
  tạo config), Pulumi reference `service_id` này; không khai tay vào
  `wrangler.jsonc`.
- Identity gate staging: tên service bắt buộc prefix `stg-` (cùng quy ước với
  pipeline Worker secret) và cặp credential control-plane của lane staging
  `ECOMA_CLOUDFLARE_STAGING_API_TOKEN` + `ECOMA_CLOUDFLARE_STAGING_ACCOUND_ID`
  (§6.12, #548) — thiếu một trong hai là từ chối trước khi wrangler
  chạy; credential chỉ tồn tại trong env của subprocess, không bao giờ qua argv.

## Responsibilities

- Sở hữu điểm vào Nx + docs cho lane: target `staging-vpc-service-create`
  (một lần tạo VPC service, đối số operator append sau `--`) và README này.
- Thực thi lane nằm ở `@ecoma-io/delivery`: module
  `tools/delivery/src/staging-connectivity.ts` (guard fail-closed, parse
  `service_id`) và surface CLI `tools/delivery/src/cli.ts vpc-service create`
  — project này KHÔNG chứa TS source, chỉ invoke CLI qua target.
- Đảm bảo output contract: stdout dòng `service_id=<uuid>` cho wiring
  Hyperdrive #350; không khai tay `service_id` vào `wrangler.jsonc`.
- Áp dụng ranh giới credential: token control-plane duy nhất §6.12 qua
  `resolveSecretRunEnv`, identity `stg-` qua `classifyWorkerName` — tái sử
  dụng đúng helper của `worker-secrets.ts`, không nhân bản logic guard.

## Prerequisites (mỗi prerequisite một owner khác)

- Host PostgreSQL staging + cluster (#349, Pulumi `staging-pg-host`) đã
  provision; `cloudflared` chạy trên host với tunnel token (VP7:
  `cloudflared` ≥ 2025.7.0, outbound UDP 7844). Host chưa có ⇒ chưa có
  tunnel UUID ⇒ lane fail-closed khi thiếu `--tunnel-id` — đó đúng là hành vi
  "refuse khi #349 chưa provision" yêu cầu.
- Cloudflare Tunnel resource tồn tại (UUID cấp cho `--tunnel-id`). Việc tạo
  tunnel resource là bước vận hành có kiểm soát (wrangler có `wrangler tunnel`
  nhưng còn experimental) — KHÔNG thuộc lane này.
- DNS CNAME `pg-staging.ecoma.io.vn`: unit DNS của `platform-deploy` provision
  (PR riêng); lane chỉ **tiêu thụ** hostname làm input, không tạo record.

## Boundaries

- KHÔNG tạo Hyperdrive config — Pulumi (#350) sở hữu; lane chỉ expose
  `service_id`.
- KHÔNG tạo DNS record — unit DNS `platform-deploy` sở hữu.
- KHÔNG chạy/xoá tunnel trên host, KHÔNG xoá VPC service: xoá là bước vận hành
  tường minh qua `wrangler vpc service delete` theo runbook; target của lane
  chỉ có `create`.
- KHÔNG chạy ngoài staging: identity `stg-` + token control-plane là hai chốt
  fail-closed của module (`tools/delivery/src/staging-connectivity.ts`).

## Development

```bash
pnpm nx run staging-connectivity:staging-vpc-service-create -- \
  stg-pg-staging \
  --tunnel-id <uuid> \
  --hostname pg-staging.ecoma.io.vn
```

Credential bắt buộc (env-only, không argv, không Git) — cặp staging:
`ECOMA_CLOUDFLARE_STAGING_API_TOKEN` + `ECOMA_CLOUDFLARE_STAGING_ACCOUND_ID`.

## Testing

- Unit test của lane chạy trong target `test` của `@ecoma-io/delivery`:
  `tools/delivery/src/staging-connectivity.spec.ts` — fake-wrangler theo kỹ
  thuật `worker-secrets.spec.ts` (gate identity, validate
  tunnel-id/hostname/port, shape argv, parse `service_id` khỏi stdout thật
  của wrangler 4.165.0, fail-closed khi thiếu token hoặc line). Chạy:
  `pnpm nx run @ecoma-io/delivery:test`.
- Project này không có TS source nên không có target `test` riêng; hợp đồng
  cấu trúc được kiểm bằng `pnpm dx arch-check` và `pnpm dx readme-check`.
- Test runtime refusal đã chạy thật (không credential): sai usage exit 2,
  tên không `stg-` bị từ chối exit 1 trước khi wrangler chạy.

## Status

- `scaffold`: lần tạo service thật CHƯA chạy — đợi host #349 provision xong
  (tunnel UUID + origin reachable), credential operator, và Spike S1 (`01` §2:
  đo thật đường `Hyperdrive → Workers VPC Service → Tunnel` với TLS
  `verify-full`, gated "Trước D2b").
- HTTPS smoke `platform-deploy:local-smoke` không đụng lane này: local platform
  dùng PostgreSQL container local, không đi tunnel.

## Related Documentation

- [`docs/architecture/02-delivery.md`](../../docs/architecture/02-delivery.md)
  §9.1 — bảng ownership (hàng "Workers VPC Service + Tunnel", hàng "Hyperdrive
  config").
- [`docs/architecture/04-platform-facts.md`](../../docs/architecture/04-platform-facts.md)
  §2.6 — VP1–VP7 (VP4: `wrangler vpc service create`, verified 2026-11-20 trên
  wrangler 4.165.0; VP5 open beta; VP7 cloudflared/UDP 7844).
- [`tools/delivery/src/worker-secrets.ts`](../../tools/delivery/src/worker-secrets.ts)
  — pattern fail-closed token + identity gate mà lane này tái sử dụng.
- Issue #349 — host + criterion tunnel TLS; #350 — Hyperdrive wiring tiêu thụ
  `service_id`.
