# Transactional Mailer Job Deploy

Pulumi deployment project provision **tài nguyên Cloudflare của delivery plane** (`transactional-mailer-job`) trên lane staging: D1 `stg-mail-job` (#355). Trước #355 project chỉ là scaffold marker trống (`pulumi.log.info`, không resource) — thoát scaffold đúng kịch bản `02-delivery.md` (job D1 được khai khi project exits scaffold).

Nx project `transactional-mailer-job-deploy`, tags `type:deployment`, `scope:messaging`, `runtime:native`. Marker `ecoma.deployment.status` trong `package.json` vẫn là `scaffold` cho tới khi deployment map của `tools/dx` được flip (coordinator-owned — arch-check đối chiếu hai nơi).

## Purpose

- Provision D1 `stg-mail-job` — job/delivery execution state của worker trên lane staging — theo bảng ownership `02-delivery.md` §9.1: Pulumi tạo/cập nhật/xoá D1 và cung cấp `database_id`; Wrangler KHÔNG tự tạo resource.
- Giữ identity Nx của deploy unit worker: deployment map trong `tools/dx` ghi app `transactional-mailer-job` với owner là project này, và arch-check đối chiếu map đó với repo.

## Responsibilities

- **Lane guard** (`index.ts`): project KHÔNG có lane local — stack DUY NHẤT được nhận là `staging` (nạp `staging-program.ts`). Stack `staging-candidate` bị từ chối tường minh (tên tài nguyên slot `-cand` thuộc #381; D1 là tài nguyên account-unique, chạy chương trình continuous trên đó là collision trên cùng account); stack `local-*` và lạ fail-closed — local runtime của worker thuộc WIC container của `transactional-mail-deploy`, project này không khai Docker resource nào.
- **Engine staging** (`staging-run.ts`, bản copy có chủ đích của pattern `platform-deploy` #453 / `auth-deploy` #539): inventory credential fail-closed (`ECOMA_PULUMI_STATE_URL_STAGING`, `PULUMI_CONFIG_PASSPHRASE`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `CLOUDFLARE_API_TOKEN` — credential chỉ đi qua env, không argv, token không vào provider config/state); chỉ mở phase `preview`/`up`; evidence append-only `.staging-evidence/`. Sau một lần `up` xanh, entry đọc stack output `mailJobDatabaseId` để operator fill vào `env.staging.d1_databases` của `apps/transactional-mailer-job/wrangler.jsonc` — wiring là commit review-able, không phải ghi-deploy-time.
- **Spec hợp đồng config** (`staging-config.spec.ts` + `wrangler-jsonc.ts`): đọc trực tiếp `wrangler.jsonc` của app và chốt identity `stg-ecoma-transactional-mailer-job`, binding audit (d1 + queues + services + send_email phải được khai lại trong `env.staging` — Wrangler không kế thừa binding top-level), trạng thái D1 "chưa provision" đúng §9.1 (thiếu `database_id`, không placeholder), chuỗi queue `stg-` với retry policy 3/2, service binding trỏ về `stg-ecoma-transactional-mail`, provider `cloudflare` khớp sender ghim, cron kế thừa top-level.
- `package.json` khai `implicitDependencies: [platform-deploy, @ecoma-io/deployment, @ecoma-io/transactional-mailer-job]`.

## Boundaries

- KHÔNG provision Queue nào: chuỗi queue `stg-ecoma-mail-delivery`(+`-dlq`) và `stg-ecoma-mail-lifecycle-events`(+`-dlq`) được provision bởi `transactional-mail-deploy` — ĐÚNG MỘT chỗ cho cả bounded context (§9.1); consumer chỉ khai binding phía wrangler.jsonc của app.
- KHÔNG sở hữu vòng đời runtime của worker trên local — worker chạy trong WIC container của `transactional-mail-deploy`; project này không khai target `local-up`/`local-down`.
- KHÔNG sở hữu migration D1 — migration là việc của `tools/dx d1-migrate` (cutover #382).
- KHÔNG deploy Worker — deploy là Wrangler (lane dùng chung `tools/delivery staging-deploy`, #535).
- Không sở hữu code của `apps/transactional-mailer-job`; ownership nghiệp vụ của delivery plane → `docs/domains/transactional-mail/` và `docs/applications/transactional-mailer-job/`.

## Development

```bash
pnpm nx run transactional-mailer-job-deploy:lint
pnpm nx run transactional-mailer-job-deploy:typecheck
```

Lane staging mutate Pulumi state staging thật — chỉ chạy khi chủ đích thay đổi tài nguyên staging, với inventory credential đã set (bootstrap backend #350, token Cloudflare, R2 token bucket-scoped, passphrase per-stack):

```bash
pnpm nx run transactional-mailer-job-deploy:staging-preview -c staging
pnpm nx run transactional-mailer-job-deploy:staging-up -c staging
```

Sau lần `staging-up` xanh đầu tiên: fill `database_id` thật (từ `pulumi stack output mailJobDatabaseId`, entry `staging.ts` surface id) vào `apps/transactional-mailer-job/wrangler.jsonc`, rồi mới đủ điều kiện flip eligibility (coordinator-owned).

## Testing

Target `test` chạy Vitest trên `staging-run.spec.ts` (engine lane staging — pure functions + exec inject, không chạy Pulumi thật) và `staging-config.spec.ts` (hợp đồng `env.staging` của app). Không có target `test-integration`/`system-test`. Bằng chứng serving của worker trên local vẫn là healthcheck của WIC container trong `transactional-mail-deploy:local-up`.

## Related Documentation

- [`docs/applications/transactional-mailer-job/03-operations.md`](../../docs/applications/transactional-mailer-job/03-operations.md) — runtime, retry policy, provider credential của job.
- [`docs/applications/transactional-mail/README.md`](../../docs/applications/transactional-mail/README.md) — cặp control plane + delivery plane của cùng context.
- [`docs/domains/transactional-mail/README.md`](../../docs/domains/transactional-mail/README.md) — bounded context sở hữu nghiệp vụ mail.
- [`docs/architecture/02-delivery.md`](../../docs/architecture/02-delivery.md) — §9.1 ownership tài nguyên, §4.1 identity per-env, §10.1 hợp đồng gate.
- [`deploys/transactional-mail-deploy/README.md`](../transactional-mail-deploy/README.md) — deploy unit provision chuỗi queue + D1 control plane, và vận hành worker này trên lane local.
