# Home Public E2E

Suite system test (`@ecoma-io/home-public-e2e`) verify năng lực **homepage public đa ngôn ngữ** của deploy unit `home` trên stack local đang chạy thật: DNS → TLS (certificate local) → router Traefik → container home (`home-deploy`, network alias `ecoma-home`) — gồm hai locale-root, trang lỗi SSR và API public.

Theo `docs/architecture/06-testing.md` §3, đây là **system test** — verify cả hệ thống nhiều deploy unit, không phải test của một app đơn lẻ; suite nằm dưới `system-tests/e2e/` với project config, setup, support riêng (§2). Nx tags `type:tooling`, `scope:public`, `runtime:native`.

## Purpose

- Chứng minh bề mặt public của `home` hoạt động qua serving path thật với TLS verify thật: `ca` scoped cho mọi Node request, SPKI pin cho Chromium — không `ignoreHTTPSErrors` (quyết định TLS ghi tường minh trong `playwright.config.ts`).
- Khoá hành vi đã deploy vào contract nội dung của app: chuỗi assert lấy từ nguồn sự thật `HOME_CONTENT` của `apps/home`, suite không nhúng lại nội dung — đổi content của app là test đỏ theo đúng nghĩa.

## Responsibilities

- **`public-routing.spec.ts`** — hợp đồng locale resolution: `/` với negotiator HTML trả 302 đúng `location: /en`; browser landed ở `/en` với heading render thật.
- **`english-home.spec.ts`** — `/en` trả 200 HTML với title `Ecoma.io — public home`; browser render heading hero EN.
- **`vietnamese-home.spec.ts`** — `/vi` tương tự với nội dung VI là hạng nhất trong registry locale, không fallback sang EN.
- **`unknown-routes.spec.ts`** — hai đường vào 404 riêng biệt (path lạ dưới locale hợp lệ, locale lạ ngoài registry) đều 404 qua error renderer SSR thật, assert heading `Page not found`.
- **`public-api.spec.ts`** — hợp đồng `GET /api/greet`: shape JSON `{ message: "Hello World" }` mặc định và echo `name` qua query.
- **Stack gate fail-closed** (`global-setup.ts`): trước test đầu tiên, probe `GET /` phải 302 → `/en` đúng literal qua chuỗi DNS/TLS/Traefik/upstream; stack không reachable là kết quả đỏ, không bao giờ skip. Retry chỉ cho chữ ký "chưa sẵn sàng"; lỗi TLS hay redirect sai là fail tức thời.
- Assertion API thuần qua Node `https` (`e2e/support/local-origin.ts`, khẳng định `socket.authorized` sau response); project duy nhất `chromium` giữ SPKI pin cho các test cần nội dung render thật.

## Boundaries

- Suite chỉ chạm origin apex của `home`: `implicitDependencies` khai đúng hai deploy unit `platform-deploy` và `home-deploy`; không seed container hay database nào — mọi assertion là read-only qua HTTP.
- Suite không verify đăng nhập hay luồng OIDC của `account`/`auth` và không chạm backoffice: các luồng đó thuộc `identity-login-e2e`, `identity-oidc-e2e`, `backoffice-access-control-e2e`.
- TLS trust tường minh và scoped: certificate local chỉ được tin cho request của suite này; không đụng trust store hệ điều hành, không biến môi trường `NODE_TLS_REJECT_UNAUTHORIZED` nào bị đặt.

## Development

- Thêm spec: assert lấy từ nguồn sự thật của app (`HOME_CONTENT` cho nội dung, route handler cho API), và chọn bề mặt đúng — Node `https` cho API assertion, `page` cho nội dung render thật.
- `playwright.config.ts` không throw khi thiếu `ROOT_HOST` — trả origin `.invalid` vô hại (origin không thể route); fail-closed thật nằm ở `global-setup.ts` với message nêu remedy.
- Cấu hình chạy: `workers: 2` (ghim — worker lớn hơn làm SSR home đói và timeout), `retries: 0` kể cả CI, timeout 60s, expect 15s.

## Testing

Target canonical là `system-test` (`docs/architecture/06-testing.md` §4), suite tự định nghĩa thực thi; `cache: false` có chủ đích — stack local là external state sống ngoài inputs của Nx, cache hit trả xanh cho một hệ thống không còn chạy như lúc cache được ghi.

```bash
pnpm nx run @ecoma-io/home-public-e2e:system-test -c local
```

- `dependsOn` kéo `local-up` của đúng hai deploy project mà suite phụ thuộc (`platform-deploy`, `home-deploy`) trước khi Playwright chạy — một invocation tự dựng đủ phần stack nó cần; `-c local` lan configuration vào task prerequisite.
- Prerequisites: platform + home đang up; `ROOT_HOST` qua env hoặc `.env` repo root (platform `local-up` ghi giá trị); cert local `deploys/platform-deploy/local-certs/fbi.com.crt`.
- 11 test trong 5 file spec.
- Các suite system-test dùng chung một local stack — chạy batch với `--parallel=1` (§4).

## Related Documentation

- [`docs/architecture/06-testing.md`](../../../docs/architecture/06-testing.md) — taxonomy (§3), canonical targets, selection và prerequisite (§4).
- [`docs/features/public-website/browse-localized-public-content.md`](../../../docs/features/public-website/browse-localized-public-content.md) — capability mà suite verify trên hệ thống chạy thật.
- [`docs/architecture/local-development/03-operations.md`](../../../docs/architecture/local-development/03-operations.md) — vận hành stack local.
- Suite cùng nhóm: [`identity-login-e2e`](../identity-login-e2e/), [`identity-oidc-e2e`](../identity-oidc-e2e/), [`backoffice-access-control-e2e`](../backoffice-access-control-e2e/).
