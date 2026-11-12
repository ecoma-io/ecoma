# Web Push Notification Job Deploy

Pulumi deployment project được khai cho worker `web-push-notification-job` (delivery plane của context `push-notification`) trong Nx graph: `tools/dx` đối chiếu ownership qua deployment map với `web-push-notification-job` → `web-push-notification-job-deploy`. Program `index.ts` khởi tạo Pulumi runtime và ghi một dòng log; không resource, không stack output, không entry `local.ts`.

Nx project `web-push-notification-job-deploy`, tags `type:deployment`, `scope:notifications`, `runtime:native`.

## Purpose

- Giữ identity Nx của deploy unit worker: deployment map trong `tools/dx` ghi app `web-push-notification-job` với owner là project này, và arch-check đối chiếu map đó với repo.
- Trên lane local, worker `ecoma-web-push-notification-job` chạy trong WIC container của `push-notification-deploy` — bundle `apps/web-push-notification-job/dist` được mount và consumer được entrypoint spawn cùng control plane; project này không đóng góp resource nào cho lane.

## Responsibilities

- Khai Pulumi program tối thiểu (`index.ts`) và hai target tĩnh `lint` (oxlint), `typecheck` (tsc build) — hai target duy nhất trong project graph, đã xác nhận qua `pnpm nx show project web-push-notification-job-deploy --json`.
- `package.json` khai `implicitDependencies: [platform-deploy]` — cạnh platform trong Nx project graph.

## Boundaries

- Không provision Docker/Pulumi resource nào và không khai target lifecycle `local-up`/`local-down` — vòng đời runtime của worker trên local thuộc `push-notification-deploy`.
- Không sở hữu code của `apps/web-push-notification-job`; ownership nghiệp vụ của delivery plane → `docs/domains/push-notification/` và `docs/applications/web-push-notification-job/`.

## Development

```bash
pnpm nx run web-push-notification-job-deploy:lint
pnpm nx run web-push-notification-job-deploy:typecheck
```

Không có target lifecycle nào — không chạy `pulumi up`/`destroy` từ project này.

## Testing

Project không có target `test`/`test-integration`/`system-test` — targets đã xác nhận từ project graph: `lint`, `typecheck`. Bằng chứng serving của worker trên local là healthcheck của WIC container trong `push-notification-deploy:local-up`.

## Related Documentation

- [`docs/applications/web-push-notification-job/03-operations.md`](../../docs/applications/web-push-notification-job/03-operations.md) — runtime, retry policy, DLQ của job.
- [`docs/applications/push-notification/README.md`](../../docs/applications/push-notification/README.md) — cặp control plane + delivery plane của cùng context.
- [`docs/domains/push-notification/README.md`](../../docs/domains/push-notification/README.md) — bounded context sở hữu nghiệp vụ push.
- [`deploys/push-notification-deploy/README.md`](../push-notification-deploy/README.md) — deploy unit vận hành worker này trên lane local.
