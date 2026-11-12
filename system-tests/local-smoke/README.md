# Local Smoke

Suite smoke (`@ecoma-io/local-smoke`) của local platform: script Node thuần verify serving path thật của home qua Traefik — TLS bắt tay với certificate local của repo, `GET /` trả 302 → `/en`, `GET /en` trả 2xx HTML chứa title `Ecoma.io`. Script là thứ target `local-smoke` của `platform-deploy` gọi sau khi lane local up xong.

Theo `docs/architecture/06-testing.md` §3, đây là **system test** ở nhóm `smoke` — verify cả hệ thống đang chạy thật qua một luồng cụ thể, không phải test của một app đơn lẻ; suite nằm dưới `system-tests/` với project config, test riêng (§2). Nx tags `type:tooling`, `scope:public`, `runtime:native`.

## Purpose

- Chứng minh serving path ngoài internet của stack local hoạt động: DNS → TLS → router Traefik → container `home` trả đúng chuỗi redirect, không chỉ "server còn sống".
- TLS được verify thật: `ca` của request trỏ vào `deploys/platform-deploy/local-certs/fbi.com.crt`; không đụng trust store toàn cục, không đặt `NODE_TLS_REJECT_UNAUTHORIZED` — smoke mà bỏ kiểm TLS là smoke nói dối.
- Retry chỉ áp cho chữ ký "chưa sẵn sàng" của cold start (connection refused/reset/timeout, 404/502/503/504 trong cửa sổ đăng ký router) với budget mặc định 90s; lỗi TLS, 4xx/500, redirect sai đích hay thiếu title fail tức thời. Hợp đồng output: `smoke OK` chỉ in sau khi chain xanh; mọi đường fail in `smoke FAILED` ra stderr, exit code khác 0 và không in `smoke OK`.

## Responsibilities

- **`src/local-smoke.mjs`** — script smoke: parse CLI (`<rootHost>` dạng `hostname:port` cùng cờ `--connect`, `--budget-ms`, `--request-timeout-ms`), chạy `verifyChain()` trong vòng retry có budget, in kết quả và đặt exit code. Positional là `ROOT_HOST` đã sinh từ Pulumi outputs — không phải port đoán trước.
- **`src/local-smoke.spec.ts`** — vitest chạy script bằng tiến trình thật trên fixture HTTPS `127.0.0.1:0` dựng từ cert local, dùng `--connect` nên TLS hostname check vẫn chạy thật (SNI vẫn là `fbi.com`). Mỗi case spawn một tiến trình riêng vì exit code và stderr là contract công khai của script.
- Nhóm case trong spec: contract input CLI (thiếu argument, port sai/ngoài range, cờ lạ, giá trị cờ không phải positive integer ⇒ exit 2); chuỗi verify HTTPS (happy path 302 → 200 với title marker, redirect sai/status sai/404/500/502, budget exhaustion, cleartext nơi cần TLS, hostname mismatch, socket không phản hồi, socket đứt giữa body); hợp đồng `smoke OK` (in đúng stdout sau thành công, không in khi fail, retry-then-success).
- Nguồn sự thật của hành vi được assert: route `/` của home trả 302 vô điều kiện (`apps/home/server/routes/index.get.ts`) và title ổn định của trang `/en`.

## Boundaries

- Project này không deploy gì và không phải một node của lane deploy: nó cung cấp script cho target `local-smoke` của `platform-deploy` — consumer duy nhất — chạy với `ROOT_HOST` đọc từ `.env` của worktree. `implicitDependencies` khai đúng hai cạnh `platform-deploy` (certificate local + consumer) và `home-deploy` (chuỗi redirect và title là hành vi serving của home); smoke đo đúng một luồng đó nên không kéo unit nào khác.
- Smoke không phải health check: `pulumi up` xanh đã là bằng chứng container phục vụ (mỗi container khai healthcheck + `wait: true`); smoke chứng minh serving path qua Traefik cho một luồng cụ thể.
- Không có thư viện dùng chung với các suite e2e — mỗi system-test suite tự sở hữu support của nó (§2); script này chỉ dùng Node thuần, không dependency ngoài.

## Development

- Script chỉ dùng Node built-in (`node:https`, `node:fs`, `node:path`, `node:url`), không dependency ngoài; chạy trực tiếp để kiểm một hostname cụ thể (không cần trust certificate ở cấp hệ điều hành):

```bash
node system-tests/local-smoke/src/local-smoke.mjs fbi.com:<port>
```

- `--connect <host:port>` dial địa chỉ khác hostname (hook cho test: SNI/`Host` vẫn dùng hostname positional); `--budget-ms` và `--request-timeout-ms` chỉnh budget retry và timeout từng request.
- Typecheck qua `tsconfig.json`/`tsconfig.lib.json`/`tsconfig.spec.json`; lint chạy oxlint trên toàn project.

## Testing

Target canonical của project là `test` (unit/component) cho spec của script; thực thi smoke thật là target `local-smoke` của `platform-deploy` (`docs/architecture/06-testing.md` §3–§4), tự up prerequisite `home-deploy:local-up` trước khi chạy.

```bash
pnpm nx run @ecoma-io/local-smoke:test
pnpm nx run platform-deploy:local-smoke -c local
```

- `@ecoma-io/local-smoke:test` — vitest với 23 test trong 1 file spec; không cần stack local (fixture HTTPS tại chỗ).
- `platform-deploy:local-smoke -c local` — lane canonical: đọc `ROOT_HOST` từ `.env` rồi chạy script; `dependsOn home-deploy:local-up`, nên chưa deploy thì `.env` vắng và target fail với message rõ. Target `smoke` của project này chạy cùng script nhưng không truyền positional, nên đường chạy có giá trị là target của `platform-deploy`.
- Prerequisites: platform + home đang up; `ROOT_HOST` trong `.env` repo root; cert local `deploys/platform-deploy/local-certs/fbi.com.crt`.

## Related Documentation

- [`docs/architecture/06-testing.md`](../../docs/architecture/06-testing.md) — taxonomy (§3), canonical targets, selection và prerequisite (§4).
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — vận hành stack local, URL và smoke.
- [`docs/features/public-website/browse-localized-public-content.md`](../../docs/features/public-website/browse-localized-public-content.md) — capability mà chuỗi redirect của smoke đi qua.
