# Transactional Mailer Job Deploy

Pulumi deployment project được khai cho worker `transactional-mailer-job` (delivery plane của context `transactional-mail`) trong Nx graph: `tools/dx` đối chiếu ownership qua deployment map với `transactional-mailer-job` → `transactional-mailer-job-deploy`. Program `index.ts` khởi tạo Pulumi runtime và ghi một dòng log; không resource, không stack output, không entry `local.ts`.

Nx project `transactional-mailer-job-deploy`, tags `type:deployment`, `scope:messaging`, `runtime:native`.

## Purpose

- Giữ identity Nx của deploy unit worker: deployment map trong `tools/dx` ghi app `transactional-mailer-job` với owner là project này, và arch-check đối chiếu map đó với repo.
- Trên lane local, worker `ecoma-transactional-mailer-job` chạy trong WIC container của `transactional-mail-deploy` — bundle `apps/transactional-mailer-job/dist` được mount và consumer được entrypoint spawn cùng control plane; project này không đóng góp resource nào cho lane.

## Responsibilities

- Khai Pulumi program tối thiểu (`index.ts`) và hai target tĩnh `lint` (oxlint), `typecheck` (tsc build) — hai target duy nhất trong project graph, đã xác nhận qua `pnpm nx show project transactional-mailer-job-deploy --json`.
- `package.json` khai `implicitDependencies: [platform-deploy]` — cạnh platform trong Nx project graph.

## Boundaries

- Không provision Docker/Pulumi resource nào và không khai target lifecycle `local-up`/`local-down` — vòng đời runtime của worker trên local thuộc `transactional-mail-deploy`.
- Không sở hữu code của `apps/transactional-mailer-job`; ownership nghiệp vụ của delivery plane → `docs/domains/transactional-mail/` và `docs/applications/transactional-mailer-job/`.

## Development

```bash
pnpm nx run transactional-mailer-job-deploy:lint
pnpm nx run transactional-mailer-job-deploy:typecheck
```

Không có target lifecycle nào — không chạy `pulumi up`/`destroy` từ project này.

## Testing

Project không có target `test`/`test-integration`/`system-test` — targets đã xác nhận từ project graph: `lint`, `typecheck`. Bằng chứng serving của worker trên local là healthcheck của WIC container trong `transactional-mail-deploy:local-up`.

## Related Documentation

- [`docs/applications/transactional-mailer-job/03-operations.md`](../../docs/applications/transactional-mailer-job/03-operations.md) — runtime, retry policy, provider credential của job.
- [`docs/applications/transactional-mail/README.md`](../../docs/applications/transactional-mail/README.md) — cặp control plane + delivery plane của cùng context.
- [`docs/domains/transactional-mail/README.md`](../../docs/domains/transactional-mail/README.md) — bounded context sở hữu nghiệp vụ mail.
- [`deploys/transactional-mail-deploy/README.md`](../transactional-mail-deploy/README.md) — deploy unit vận hành worker này trên lane local.
