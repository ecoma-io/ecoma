# `@ecoma-io/llm-console`

Composition app của LLM Console: **SPA non-SSR + BFF** trên Cloudflare Workers, dựng UI trên
`@ecoma-io/ui-app-shell`. Deploy unit này **không sở hữu database**, không có Hyperdrive, D1, R2,
KV hay Queue — mọi dữ liệu nghiệp vụ đi qua API của context owning (`llm-api`, `llm-financial`,
`payment`, `llm-usage`), và tới nay **chưa có** đường nào như vậy được nối.

Đây là scaffold. Nội dung dưới đây mô tả đúng những gì tồn tại, và mục "Những gì chưa có" liệt kê
cụ thể phần không tồn tại để không ai đoán nhầm từ tên file.

Reference kiến trúc: [`docs/applications/llm-console/01-architecture.md`](../../docs/applications/llm-console/01-architecture.md);
ranh giới bounded context: [`docs/domains/`](../../docs/domains/).

## Phạm vi app

| Phần                             | Trạng thái                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------- |
| Shell dashboard (sidebar, nav)   | có — `AppShell` của `@ecoma-io/ui-app-shell`, một mục nav trỏ `/`                |
| Đa ngôn ngữ (en, vi, zh-CN)      | có — registry locale, language selector, cookie lựa chọn                         |
| Tuỳ chọn shell (màu, chiều)      | có — cookie `app-shell-preferences`, validate qua `parseAppShellPreferences()`   |
| Trang Overview `/`               | có — nói đúng phần đã sẵn sàng và phần chưa có; **không** metric hay dữ liệu mẫu |
| `GET /health`                    | có — liveness, không phụ thuộc dịch vụ nào                                       |
| `GET /ready`                     | có — readiness của scaffold, không phụ thuộc downstream                          |
| Component empty/loading/error    | có — primitive có sẵn cho trang nghiệp vụ sau này                                |
| API key, routing, usage, billing | **chưa có** — chưa có BFF route, chưa có contract nào được nối                   |

## Chạy

```bash
pnpm nx dev @ecoma-io/llm-console        # http://localhost:4208
pnpm nx run @ecoma-io/llm-console:test
pnpm nx run @ecoma-io/llm-console:lint
pnpm nx run @ecoma-io/llm-console:typecheck
pnpm nx run @ecoma-io/llm-console:build  # preset Cloudflare, output `.output/`
```

Triển khai local (Docker + Traefik, song song với các app khác trong worktree):

```bash
pnpm nx run llm-console-deploy:local-up -c local    # cần platform-deploy:local-up trước
pnpm nx run llm-console-deploy:local-down -c local
```

Hostname local là `llm-console.<ROOT_HOST>` — đọc `ROOT_HOST` từ `.env` của worktree (platform ghi
sau lần up đầu), không đoán port.

## Cấu hình

`nuxt.config.ts` **cố ý không** khai `runtimeConfig`: app chưa có BFF route nào cần cấu hình hay
secret. Khi BFF thật xuất hiện, khai key tường minh và cho từng env trong `wrangler.jsonc` — không
default một giá trị đoán được, vì default rỗng biến "chưa cấu hình" thành "chạy được với giá trị
rỗng" thay vì fail closed.

**Không có** OIDC client id/secret, session signing key hay bất kỳ credential nào trong app này.

## Route và hành vi

- `/` — trang Overview duy nhất. Chỉ **một** `<h1>`; không link tới route chưa tồn tại.
- `/health` — liveness. Trả `{ status: 'ok', service: 'llm-console' }`, không chạm downstream.
- `/ready` — readiness. Trả `{ status: 'ready' }` vì scaffold chưa có phụ thuộc nào. Khi thêm phụ
  thuộc cấu hình thật, route phải **fail closed** (503 + mã ổn định), không mặc định ready.
- Các path còn lại — SPA fallback: Nitro trả shell HTML để client router xử lý. Một `/api/*` không
  có handler cũng rơi vào nhánh này và trả HTML 200, **không** phải 404.

`wrangler.jsonc` khai `assets.run_worker_first` cho `/api/*`, `/health`, `/ready` để hai nhóm này
tới handler Nitro thay vì asset worker. Đã đo trên build thật bằng `wrangler dev`.

## Non-SSR

`nuxt.config.ts` khai `ssr: false` tường minh (không dựa vào default của framework): server không
render HTML cho route của client, chỉ phục vụ asset + BFF route. Hệ quả cần nhớ:

- Build **không** emit `index.html` tĩnh; shell HTML do Nitro render ở runtime.
- Không có `useHead` phía server cho nội dung trang — mọi head do app set ở client.
- Không được dùng Node built-in trong code chạy ở client; `runtime:edge` chặn Node-only dependency.

## CSS và Tailwind v4

`app/assets/css/styles.css` import `tailwindcss`, `@import` **tương đối** stylesheet của shell
(`libs/ui-app-shell/src/styles/app-shell.css`) và khai `@source` cho cả hai lib UI. Không dùng
specifier package cho `@import`: alias của app áp cho cả resolver stylesheet của Tailwind và build
đỏ `ENOTDIR` — lỗi này chỉ lộ ở `nuxt build`.

Hai chi tiết dễ mất mà `tests/tailwind-source.spec.ts` ghim: số cấp `..` của `@source` (đếm sai là
lỗi **im lặng**, chỉ mất utility trong bản production) và `fonts.defaults.weights` đủ sáu weight
(shell đặt `font-synthesis-weight: none`, nên face thiếu weight không được tải).

## Kiểm thử

`pnpm nx run @ecoma-io/llm-console:test` chạy Vitest với harness mount component thật (không cần
browser):

| File                              | Ghim điều gì                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `tests/ready.spec.ts`             | `/health` và `/ready` không set status; `/ready` không tham chiếu `llm-api`/`fetch(`/D1 |
| `app/pages/index.spec.ts`         | Trang Overview render đúng một `<h1>`, không có link chết                               |
| `tests/tailwind-source.spec.ts`   | Số cấp `@source`, sự tồn tại của base tĩnh, không import CSS qua package                |
| `tests/catalogs.spec.ts`          | Ba catalog cùng tập key và cùng placeholder; mọi key app gọi đều có                     |
| `tests/harness.spec.ts`           | Harness mount shell + page, nội dung không phụ thuộc locale mặc định                    |
| `tests/shell-integration.spec.ts` | App dùng đúng contract của shell (props, emit, slot)                                    |

## Những gì chưa có

- **Không có BFF nghiệp vụ.** Không route `/api/*`, không proxy tới `llm-api`, không contract
  tenant/membership/offer/API key/wallet/usage nào được nối.
- **Không có xác thực.** Không OIDC, không session, không cookie phiên, không authorization. Mọi
  API cần xác thực trong tương lai phải fail closed; không có đường bypass cho demo.
- **Không có dữ liệu.** Không mock API, không metric giả, không fixture nghiệp vụ. Trang Overview
  cố ý không hiển thị con số nào.
- **Không có `devOrigin` thật.** Hai env trong `wrangler.jsonc` giữ placeholder
  `https://REPLACE-WITH-REAL-SUBDOMAIN.workers.dev`; pipeline sẽ fail closed tới khi điền subdomain
  thật của account Cloudflare.
- **Không có target deploy.** `package.json` không khai target `deploy` nào — staging/production
  chưa được nối trong repo này.

## Ghi chú

- Nx tags: `type:composition`, `scope:llm-consumer`, `runtime:edge`. App này không được import
  implementation của Seller hay của `llm-api`; dependency chỉ được đi qua contract/API.
- `nuxt.config.ts` phát warning `MODULE_TYPELESS_PACKAGE_JSON` (không có `"type": "module"` trong
  `package.json`) — vô hại, cùng hình dạng với các app Nuxt khác trong repo.
