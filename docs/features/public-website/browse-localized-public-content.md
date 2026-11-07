# Duyệt nội dung public đa ngôn ngữ

> **Product area:** `public-website/` · **Mô tả một dòng:** khách truy cập đọc Home, documentation, blog và legal content bằng tiếng Việt hoặc tiếng Anh, trên URL ổn định và có thể chia sẻ.
>
> Thiết kế hệ thống → [`architecture/01-architecture.md`](../../architecture/01-architecture.md) §2 · quy tắc viết → [`../README.md`](../README.md).

## 1. Problem

Nội dung public của sản phẩm phải đọc được bằng cả tiếng Việt và tiếng Anh, nhưng người đọc cần một URL cố định cho mỗi trang để chia sẻ và đánh dấu. Nếu ngôn ngữ được chọn bằng cookie hoặc bằng `Accept-Language` thì cùng một URL trả nội dung khác nhau cho từng người, link chia sẻ trỏ sai ngôn ngữ, và công cụ tìm kiếm không lập chỉ mục được từng bản dịch.

Nội dung cũng phải tải nhanh và không phụ thuộc vào dữ liệu động, vì phần lớn trang là tài liệu ít thay đổi.

## 2. Outcome

Mỗi trang public có một URL riêng cho từng ngôn ngữ, và URL đó luôn trả đúng ngôn ngữ đó.

- Ngôn ngữ là segment đầu tiên của URL; `/` chuyển hướng tới ngôn ngữ mặc định.
- Mỗi trang khai báo `lang`, canonical và alternate cho các ngôn ngữ **thực sự có** nội dung tương ứng.
- Nội dung được render sẵn và phục vụ từ Worker, không truy vấn database khi phục vụ.
- Điều hướng dùng chung header, footer và menu nội dung cho mọi trang.
- Đường dẫn không hợp lệ hoặc không tồn tại trả 404 thay vì tự sửa thành một đường dẫn khác.
- Công tắc ngôn ngữ chỉ đề nghị bản dịch tồn tại cho đúng trang đang đọc.

## 3. Scope

### Bao gồm

- Home (`/<locale>`), Documentation (`/<locale>/docs/...`), Blog (`/<locale>/blog/...`, kèm trang series) và Legal Center (`/<locale>/legal/...`).
- Hai locale: `en` và `vi`; `en` là mặc định.
- Chuyển hướng `/` → `/en`.
- SEO metadata theo từng trang: `lang` lấy từ registry, canonical tuyệt đối, alternate chỉ cho bản dịch tồn tại.
- Điều hướng cấp cao và menu nội dung cho docs và legal.
- Công tắc ngôn ngữ client-side, chỉ liệt kê ngôn ngữ có bản dịch của trang hiện tại.
- 404 cho locale không hỗ trợ, path không khớp mount, tài liệu chưa tồn tại và series rỗng.
- Legal Center chỉ phục vụ tài liệu đã publish; tài liệu `draft` bị loại ở cả build và route.
- Trang được prerender; Worker không cần database để phục vụ nội dung.

### Không bao gồm

- **Blog không có nội dung tiếng Việt.** `/vi/blog` hiển thị danh mục bài viết tiếng Anh với `noindex, follow`, canonical trỏ chính nó và không có alternate. Đây là hành vi có chủ đích, không phải lỗi.
- **Documentation hiện là seed content**, tự mô tả là "reference/demo slice" chứ không phải hướng dẫn sử dụng đầy đủ. Blog là một curriculum học máy 30 bài dùng để kiểm tra khả năng render (công thức, media, series, mục lục), không mô tả sản phẩm.
- **Hai tài liệu legal là draft và không xuất hiện trong bản build production**: điều khoản platform và điều khoản marketplace LLM.
- **Mount `docs/api` chỉ là chỗ dành trước.** Chưa có nội dung và chưa có route; `/en/docs/api` trả 404.
- **Không có `robots.txt`, sitemap hay RSS feed.**
- **Mở menu ngôn ngữ cần JavaScript.** Trigger là nút, không phải link; các href của menu vẫn có trong HTML prerender.
- **`/api/greet` là endpoint demo** trả `Hello <name>` theo query `name` (mặc định `World`), không phải capability nội dung.
- **Staging `noindex` chỉ áp dụng cho response do Worker phục vụ**, không áp dụng cho asset prerender; cơ chế bù cho asset tĩnh được tài liệu nhắc tới nhưng chưa tồn tại trong repo.
- **Chưa có deployment record hay pipeline release vận hành trong repo hiện tại.** `apps/home/wrangler.jsonc` có khai báo environment staging và production, nhưng không có Nx target deploy và không có workflow release nào trên `main`. Feature này vì vậy không có bằng chứng `Released`.

## 4. Acceptance Scenarios

```text
Cho  khách truy cập gửi GET /
Khi  request tới
Thì  nhận 302 với Location /en
```

```text
Cho  khách truy cập mở /
Khi  trình duyệt đi theo redirect
Thì  thấy Home tiếng Anh với tiêu đề "Public web, built right"
```

```text
Cho  khách truy cập mở /vi
Khi  trang tải
Thì  thấy Home tiếng Việt, `<html lang="vi-VN">`, canonical `https://ecoma.io/vi`,
     và alternate cho cả `en` và `vi-VN`
```

```text
Cho  bất kỳ trang nào trong /en/docs, /vi/docs, /en/blog, /vi/blog, /en/legal, /vi/legal
Khi  mở trang
Thì  nhận 200 HTML
```

```text
Cho  khách truy cập mở một bài blog không tồn tại
Khi  trang tải
Thì  nhận 404 và thấy trang lỗi chung với tiêu đề "Page not found"
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
Cho  một trang docs chỉ có bản tiếng Anh
Khi  người đọc mở công tắc ngôn ngữ
Thì  menu không đề nghị tiếng Việt cho trang đó
```

```text
Cho  khách truy cập mở /vi/blog
Khi  danh mục bài viết hiển thị
Thì  thấy danh mục bài tiếng Anh, kèm `noindex, follow`, canonical trỏ chính nó, và không có alternate
```

```text
Cho  một tài liệu legal ở trạng thái draft
Khi  build production chạy
Thì  tài liệu đó không có HTML, không có trong payload và không được link tới
```

```text
Cho  khách truy cập mở /en/docs/api
Khi  trang tải
Thì  nhận 404 — `docs/api` là mount dành trước, chưa có nội dung
```

## 5. Domain & Application Mapping

| Domain / Application            | Vai trò trong Feature                                                                                | Canonical                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/home`                     | Deploy unit duy nhất phục vụ toàn bộ bề mặt public: Home, docs, blog, legal, 404, prerender manifest | [`architecture/01-architecture.md`](../../architecture/01-architecture.md) §2 |
| Nội dung (`apps/home/content/`) | Nguồn nội dung theo locale; không phải bounded context                                               | —                                                                             |

Feature này không chạm bounded context nào: nó đọc nội dung tĩnh và không sở hữu dữ liệu nghiệp vụ. Đây là lý do nó không xuất hiện trong domain map. Registry locale (`app/i18n/lib/locale-registry.ts`), registry mount (`app/layout/lib/mount-registry.ts`) và registry điều hướng (`app/layout/lib/public-navigation.ts`) là nguồn sự thật duy nhất cho cấu trúc URL và menu.

## 6. Verification Mapping

Feature được kiểm chứng ở hai tầng: unit/component và kiểm tra trên artifact build thật (`test`), cùng system E2E trên stack local thật (`system-test`). `apps/home` **không có** target `test-integration`.

| Scenario                                                                                                                                                     | Test file / suite                                                                                                                 | Loại test                | Nx target                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------- |
| `/` → 302 `/en`                                                                                                                                              | `system-tests/e2e/home-public-e2e/e2e/public-routing.spec.ts`                                                                     | system E2E               | `system-test`                 |
| Home `en` và `vi` trả 200 với title/H1 đúng                                                                                                                  | `english-home.spec.ts`, `vietnamese-home.spec.ts` cùng suite                                                                      | system E2E               | `system-test`                 |
| `/en/docs`, `/en/blog`, `/en/legal` trả 200; 9 link menu docs trả 200; điều hướng Docs → Getting started                                                     | `navigation.spec.ts`                                                                                                              | system E2E               | `system-test`                 |
| Sáu trang mục lục nội dung trả 200 HTML, `/en/docs` render được                                                                                              | `content-sections.spec.ts`                                                                                                        | system E2E               | `system-test`                 |
| 404 cho bài blog không tồn tại, cho `/fr`, và trang lỗi hiển thị đúng                                                                                        | `unknown-routes.spec.ts`                                                                                                          | system E2E               | `system-test`                 |
| `/api/greet` trả JSON demo                                                                                                                                   | `public-api.spec.ts`                                                                                                              | system E2E               | `system-test`                 |
| Danh mục trang theo locale, `lang`/canonical/alternate, hreflang chỉ cho blog có bài, trang series, 12 trang legal, draft vắng mặt, sidebar/breadcrumb legal | `apps/home/tests/static-output.spec.ts`                                                                                           | kiểm tra artifact build  | `test`                        |
| Sáu route thực sự render, `title`/heading theo locale                                                                                                        | `apps/home/app/domain/{home-page,home-ssr,legal-page}.spec.ts`, `app/blog/blog-routing.spec.ts`, `app/utils/docs-routing.spec.ts` | unit/component           | `test`                        |
| Parse path canonical, từ chối biến thể không canonical, thứ tự ưu tiên lỗi                                                                                   | `apps/home/app/i18n/lib/parse-public-path.spec.ts`, `parse-public-path-adversarial.spec.ts`                                       | unit                     | `test`                        |
| Cấu trúc menu, hành vi bàn phím, `aria-current`, mobile panel                                                                                                | spec colocated của `PublicHeader`/`PublicShell`                                                                                   | unit/component           | `test`                        |
| `/` → 302 `/en` và `/en` phục vụ HTML qua TLS của stack local                                                                                                | `system-tests/local-smoke/src/local-smoke.mjs` (target `smoke`)                                                                   | smoke của local platform | `platform-deploy:local-smoke` |

**Giới hạn của verification hiện tại:**

- **System E2E không kiểm chứng** công tắc ngôn ngữ, `lang`/canonical/hreflang trong response thật, bất kỳ trang legal nào, việc loại draft, chi tiết bài blog, hay tiêu đề 404 tiếng Việt. Những phần đó chỉ có bằng chứng ở mức unit hoặc artifact build.
- Kiểm tra artifact build (`static-output.spec.ts`) chạy sau `build` và đọc `.output/`; nó chứng minh nội dung của bản build, không chứng minh response thật.
- **`/en/docs/api` trả 404 chỉ được kiểm chứng ở tầng unit** (parse path và layout path loại mount dành trước) và ở danh mục của artifact build; không có test nào assert response 404 thật cho đường dẫn đó.
- **Smoke local không chạy trong CI.** `platform-deploy:local-smoke` chỉ chạy khi có người gọi trên stack local; không job CI nào chạy nó.
- Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass. Kết luận `Verified` cần kết quả chạy của `test` và `system-test`; `Released` không thể kết luận vì chưa có deployment record hay pipeline release vận hành.
