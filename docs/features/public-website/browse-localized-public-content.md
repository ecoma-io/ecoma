# Duyệt homepage public đa ngôn ngữ

> **Feature area:** `public-website/` · **Mô tả một dòng:** khách truy cập đọc homepage public bằng tiếng Việt hoặc tiếng Anh, trên URL locale ổn định (`/en`, `/vi`) với redirect locale từ `/` và 404 cho mọi đường lạ.
>
> Thiết kế hệ thống → [`architecture/01-architecture.md`](../../architecture/01-architecture.md) §2 · quy tắc viết → [`../README.md`](../README.md).

## 1. Problem

Homepage public của sản phẩm phải đọc được bằng cả tiếng Việt và tiếng Anh, nhưng người đọc cần một URL cố định cho mỗi ngôn ngữ để chia sẻ và đánh dấu. Nếu ngôn ngữ được chọn bằng cookie hoặc bằng `Accept-Language` thì cùng một URL trả nội dung khác nhau cho từng người, link chia sẻ trỏ sai ngôn ngữ, và công cụ tìm kiếm không lập chỉ mục được từng bản dịch.

Homepage cũng phải tải nhanh và không phụ thuộc dữ liệu động, vì trang ít thay đổi.

## 2. Outcome

Homepage public có một URL riêng cho từng ngôn ngữ, và URL đó luôn trả đúng ngôn ngữ đó.

- Ngôn ngữ là segment đầu tiên của URL; `/` chỉ là locale-resolution entry point và 302 về locale mặc định.
- Hai locale-root `/en` và `/vi` là HTML prerendered (SSG) lúc build, phục vụ từ static assets — không invoke Worker, không truy vấn database khi phục vụ.
- Trang khai báo `lang` theo registry locale, canonical tuyệt đối trỏ chính nó, và `hreflang` hai chiều `en` ↔ `vi-VN` — mọi URL tuyệt đối dưới production origin.
- Shell dùng chung chỉ còn brand và công tắc ngôn ngữ.
- Đường dẫn lạ trả 404 qua error page SSR trên Worker, không tự sửa thành một đường dẫn hợp lệ.

## 3. Scope

### Bao gồm

- Homepage ở hai locale-root: `/en` và `/vi`; `en` là mặc định.
- Redirect `/` → `/{HOME_DEFAULT_LOCALE}` bằng 302 server-side.
- Prerender SSG cho hai locale-root lúc build (`nitro.config.ts` seed `prerender.routes`); phục vụ từ static assets không invoke Worker.
- SEO metadata của homepage: `lang` lấy từ registry locale, canonical tuyệt đối self-canonical, alternate hai chiều cho cả hai locale, mọi URL pin dưới production origin.
- Công tắc ngôn ngữ hai mục trong header, chỉ giữa `/en` và `/vi`.
- 404 cho locale không hỗ trợ và mọi path lạ: route `validate` từ chối → `error.vue` render SSR trên Worker.

### Không bao gồm

- **Không còn nội dung public nào khác.** Documentation, blog và legal đã bị gỡ cùng demo content stack `@nuxt/content` (Issue #72, PR #73): `home` không còn mount, không còn cây `content/` và không có trang nội dung nào ngoài hai locale-root. Việc có đưa hệ thống nội dung public trở lại hay không là mục chưa chốt trong [`architecture/01-architecture.md`](../../architecture/01-architecture.md) §10.
- **Không có `robots.txt`, sitemap hay RSS feed.**
- **Mở menu ngôn ngữ cần JavaScript.** Trigger là nút, không phải link; các `href`/`hreflang` của menu vẫn có trong HTML prerender.
- **Staging `noindex` chỉ áp dụng cho response do Worker phục vụ** (redirect `/`, 404, `/api/greet`). Homepage prerendered (SSG) và `404.html` được phục vụ thẳng từ static assets, không qua Worker, nên `noindex` cho bề mặt đó phụ thuộc việc inject `_headers` lúc deploy staging — cơ chế này chưa có trong repo và là giới hạn đã biết được ghi ở `apps/home/nitro.config.ts`.
- **`/api/greet` là endpoint demo** trả `Hello <name>` theo query `name` (mặc định `World`), không phải capability nội dung.
- **Chưa có deployment record hay pipeline release vận hành trong repo hiện tại.** `apps/home/wrangler.jsonc` có khai báo environment staging và production, nhưng không có Nx target deploy và không có workflow release nào trên `main`. Feature này vì vậy không có bằng chứng `Released`.

## 4. Acceptance Scenarios

```text
Cho  khách truy cập gửi GET /
Khi  request tới với Accept: text/html
Thì  nhận 302 với Location /en
```

```text
Cho  khách truy cập mở /
Khi  trình duyệt đi theo redirect
Thì  kết thúc ở /en với homepage tiếng Anh render thật
```

```text
Cho  khách truy cập mở /en
Khi  trang tải
Thì  thấy homepage tiếng Anh với title và heading hero đúng
```

```text
Cho  khách truy cập mở /vi
Khi  trang tải
Thì  thấy homepage tiếng Việt, `<html lang="vi-VN">`, canonical `https://ecoma.io/vi`,
     và alternate cho cả `en` và `vi-VN`
```

```text
Cho  khách truy cập mở một path lạ dưới locale, ví dụ /en/no-such-page
Khi  trang tải
Thì  nhận 404 và thấy error page SSR thật với heading "Page not found"
```

```text
Cho  khách truy cập mở /fr
Khi  trang tải
Thì  nhận 404 — locale không có trong registry không được tự sửa thành locale hợp lệ
```

```text
Cho  URL không phải dạng canonical, ví dụ /EN, /en/ hoặc //en
Khi  request tới
Thì  bị từ chối thay vì chuẩn hoá thành /en
```

```text
Cho  khách truy cập mở công tắc ngôn ngữ trên /en
Khi  menu hiển thị
Thì  chỉ thấy đề nghị /vi — bản dịch của cùng resource, không trang nào khác
```

## 5. Domain & Application Mapping

| Domain / Application | Vai trò trong Feature                                                                                         | Canonical                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/home`          | Deploy unit duy nhất phục vụ bề mặt public homepage: redirect `/`, hai locale-root SSG, 404 SSR, `/api/greet` | [`architecture/01-architecture.md`](../../architecture/01-architecture.md) §2 |

Feature này không chạm bounded context nào: homepage là nội dung tĩnh theo locale và không sở hữu dữ liệu nghiệp vụ, nên nó không xuất hiện trong domain map. Registry locale (`app/i18n/lib/locale-registry.ts`) và `HOME_CONTENT` (`app/domain/home-content.ts`) là nguồn sự thật của cấu trúc URL và nội dung hai locale; production origin được pin ở `app/domain/home-origin.ts`, không suy từ request.

## 6. Verification Mapping

Feature được kiểm chứng ở hai tầng: unit/component và kiểm tra trên artifact build thật (`test`), cùng system E2E trên stack local thật (`system-test`). `apps/home` **không có** target `test-integration`.

| Scenario                                                                                                                                       | Test file / suite                                                                           | Loại test                | Nx target                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------- |
| `/` → 302 `/en` (header location)                                                                                                              | `system-tests/e2e/home-public-e2e/e2e/public-routing.spec.ts`                               | system E2E               | `system-test`                 |
| `/` đổ về `/en` với nội dung render thật trong browser                                                                                         | cùng suite (test browser)                                                                   | system E2E               | `system-test`                 |
| `/en` trả 200 HTML với title + H1 đúng                                                                                                         | `system-tests/e2e/home-public-e2e/e2e/english-home.spec.ts`                                 | system E2E               | `system-test`                 |
| `/vi` trả 200 HTML với title + H1 tiếng Việt                                                                                                   | `system-tests/e2e/home-public-e2e/e2e/vietnamese-home.spec.ts`                              | system E2E               | `system-test`                 |
| Path lạ dưới locale → 404; `/fr` → 404; error page là SSR thật với heading "Page not found"                                                    | `system-tests/e2e/home-public-e2e/e2e/unknown-routes.spec.ts`                               | system E2E               | `system-test`                 |
| `/api/greet` trả JSON demo đúng shape                                                                                                          | `system-tests/e2e/home-public-e2e/e2e/public-api.spec.ts`                                   | system E2E               | `system-test`                 |
| Inventory prerendered đúng contract — đủ `404.html`, `en/index.html`, `vi/index.html`, thừa/thiếu đều đỏ                                       | `apps/home/tests/static-output.spec.ts`                                                     | kiểm tra artifact build  | `test`                        |
| Hai locale-root là SSG thật (`data-ssr="true"`, đầy đủ `<main>`/heading), không phải shell SPA                                                 | `apps/home/tests/static-output.spec.ts`                                                     | kiểm tra artifact build  | `test`                        |
| `lang`/canonical/hreflang trong HTML prerendered: tuyệt đối, dưới `https://ecoma.io`, hai chiều `en` ↔ `vi-VN`                                 | `apps/home/tests/static-output.spec.ts`                                                     | kiểm tra artifact build  | `test`                        |
| Shell prerendered chỉ còn brand + locale switcher; không link chết tới mount đã gỡ; không tham chiếu `__nuxt_content`                          | `apps/home/tests/static-output.spec.ts`                                                     | kiểm tra artifact build  | `test`                        |
| Contract deploy trên `wrangler.jsonc` thật: Worker SSR + static assets, không SPA fallback, không `not_found_handling`, không binding database | `apps/home/tests/static-output.spec.ts`                                                     | kiểm tra artifact build  | `test`                        |
| Redirect `/` server-side 302 về `/en`, không loop                                                                                              | `apps/home/server/routes/index.get.spec.ts`                                                 | unit                     | `test`                        |
| Validate locale-root: nhận `/en`·`/vi`, từ chối `/`, trailing slash, sai case, biến thể encoded và `//en`                                      | `apps/home/app/domain/home-locale.spec.ts`                                                  | unit                     | `test`                        |
| Parse path public canonical, từ chối biến thể bất thường (backslash, percent-encoded, whitespace)                                              | `apps/home/app/i18n/lib/parse-public-path.spec.ts`, `parse-public-path-adversarial.spec.ts` | unit                     | `test`                        |
| Registry locale: đúng hai locale, hreflang `en` → `en`, `vi` → `vi-VN`, registry đóng và frozen                                                | `apps/home/app/i18n/lib/locale-registry.spec.ts`                                            | unit                     | `test`                        |
| SEO payload: self-canonical, alternates phủ toàn registry, mọi URL tuyệt đối dưới production origin, bất biến theo hostname                    | `apps/home/app/domain/home-seo.spec.ts`                                                     | unit                     | `test`                        |
| Shell: brand + locale switcher là chrome duy nhất; switcher link cùng resource ở locale khác                                                   | `apps/home/app/layout/lib/components/public-shell.spec.ts`, `public-shell-ssr.spec.ts`      | unit/component           | `test`                        |
| Render page Home: mount jsdom và SSR thật trong node                                                                                           | `apps/home/app/domain/home-page.spec.ts`, `home-ssr.spec.ts`                                | unit/component           | `test`                        |
| Header `X-Robots-Tag: noindex` chỉ khi flag bật tuyệt đối                                                                                      | `apps/home/server/middleware/no-index.spec.ts`                                              | unit                     | `test`                        |
| `/` → 302 `/en` và `/en` phục vụ HTML qua TLS của stack local                                                                                  | `system-tests/local-smoke/src/local-smoke.mjs` (target `smoke`)                             | smoke của local platform | `platform-deploy:local-smoke` |

**Giới hạn của verification hiện tại:**

- **System E2E không kiểm chứng** `lang`/canonical/hreflang trong response thật hay công tắc ngôn ngữ qua browser. Những phần đó chỉ có bằng chứng ở tầng unit hoặc artifact build.
- Kiểm tra artifact build (`static-output.spec.ts`) chạy sau `build` và đọc `.output/`; nó chứng minh nội dung của bản build, không chứng minh response thật.
- Hai suite cũ trong cùng thư mục E2E — `content-sections.spec.ts` và `navigation.spec.ts` — vẫn assert các mount đã bị gỡ (`/en/docs`, `/en/blog`, `/en/legal` trả 200) nên không phản ánh capability này; chúng **không** phải bằng chứng của feature và cần được xử lý riêng trong suite.
- **Smoke local không chạy trong CI.** `platform-deploy:local-smoke` chỉ chạy khi có người gọi trên stack local; không job CI nào chạy nó.
- Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass. Kết luận `Verified` cần kết quả chạy của `test` và `system-test`; `Released` không thể kết luận vì chưa có deployment record hay pipeline release vận hành.
