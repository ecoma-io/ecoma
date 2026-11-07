# ADR-0011 — Authn boundary của `backoffice` server routes: 401 cho credential vắng/hỏng, 503 cho credential không verify được lúc này

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4): ADR này chốt quyết định cho nghiệp vụ staff/RBAC khi được tách khỏi `backoffice` (A21–A24). Ngày nay `backoffice` còn sở hữu staff/RBAC.

> **Trạng thái:** Accepted · **Ngày:** 2026-10-22 · **Quyết định từ:** [`domain-model.md`](../domain-model.md) §9 (hàng 11), §2, §4, §5 · **Issue:** #107 (P3)

## Bối cảnh

ADR-0010 chốt một quyết định phụ: ở giai đoạn hiện tại, principal không verify được được xử lý theo đường **503**, và 401 không được dùng cho đường này. Quyết định đó có hiệu lực, đã merge vào `main`, và được implement trong các route read của #99 (PR #111). Nhưng nó gộp **hai class lỗi khác nhau về bản chất**:

- **(a) Caller không có credential, hoặc credential hỏng** — đây là một khẳng định về _caller_: không ai đã xác thực, và server có thể kết luận điều đó ngay. Repo đã có convention cho class này: internal contract thiếu envelope HMAC trả `401` ([`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md) SR-012, AC-013), và `account` làm đúng như vậy — `apps/account/server/middleware/internal-auth.ts` trả `401` khi thiếu secret/envelope hoặc verify không đạt, chỉ `503` khi DB không gọi được.
- **(b) Credential có, nhưng không verify được _lúc này_** — JWKS không fetch được, verifier chưa cấu hình hoặc misconfigure, dependency chết. Ở đây server **không** kết luận được gì về caller.

Hệ quả cụ thể khi workstream C phase 2 wire adapter thật: một người dùng chưa đăng nhập sẽ nhận `503` kèm nút retry thay vì được đưa tới login — một vòng retry không thoát được, vì retry không bao giờ tạo ra credential. Ngược lại, nếu dùng `401` cho cả hai class thì một sự cố tạm thời của auth sẽ khiến client xoá token hợp lệ — client mất session vì lỗi của hệ thống.

Vậy nên cần một quyết định riêng cho ranh giới **authn** của `backoffice` server routes: status cho từng class lỗi, bên nào chịu trách nhiệm verify credential, và hành vi client theo từng status.

Ranh giới phải giữ: `backoffice` **không** phải IdP thứ hai và **không** phải credential store ([`domain-model.md`](../domain-model.md) §2) — đây chính là ràng buộc đã định hình cơ chế step-up ([ADR-0005](./0005-step-up-fresh-session.md)). ADR này **không** thiết kế lại luồng xác thực; nó chốt contract của ranh giới.

## Phương án

| #   | Phương án                                                                                      | Đánh giả                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tách hai class: 401 cho credential vắng/hỏng, 503 cho credential không verify được lúc này** | Chấp nhận — phản ánh đúng hai câu hỏi khác nhau ("không có ai xác thực" vs "chưa xác minh được"), khớp convention `401` của repo (SR-012/AC-013), và cho client hai hành vi khác nhau: login vs retry                                                    |
| 2   | Giữ `503` cho cả hai class (đường ADR-0010 hiện tại)                                           | Loại ở giai đoạn có authn layer — đúng khi _chưa có_ đường xác thực (thiếu principal là "hệ thống chưa dựng được đường xác thực" ⇒ không trả lời được), nhưng sai khi đã có: caller không đăng nhập sẽ bị đẩy vào vòng retry không thoát được            |
| 3   | Dùng `401` cho cả hai class                                                                    | Loại — lỗi tạm thời của auth sẽ biến thành "credential hỏng", client xoá token/session hợp lệ; một sự cố hệ thống làm mất session của người dùng                                                                                                         |
| 4   | Server tự `302` tới login khi thiếu credential                                                 | Loại — `backoffice` server route phục vụ cả API (JSON) lẫn document; một status duy nhất cho mọi loại caller không đúng. Redirect là **hành vi của client** sau khi server đã trả `401` — nó không thay thế được contract machine-readable mà repo đã có |
| 5   | Dùng `403` cho credential vắng                                                                 | Loại — `403` là kết quả _authorization_: principal đã xác thực rồi nhưng không đủ quyền. Dùng nó cho "chưa xác thực" trộn hai trục và phá khả năng đọc kết quả từ response                                                                               |

## Quyết định

### 1. Phân loại lỗi: server có kết luận được lúc này không

Một câu hỏi duy nhất phân loại mọi tình huống trên đường authn của `backoffice` server routes: **server có xác định được kết quả ngay bây giờ không?** Có ⇒ status mang tính quyết định (401 hoặc 403). Không ⇒ `503`, vì server không được coi "chưa biết" là "không hợp lệ".

| Tình huống                                                                                                                                                                           | Status | Lý do                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Không có credential (không mang token, không có phiên đã xác thực)                                                                                                                   | `401`  | Server biết chắc không có ai đã xác thực — kết luận được ngay, không cần hỏi thêm gì                                                                                      |
| Credential có nhưng hỏng: không phải JWT, sai scheme, sai chữ ký, sai `iss`/`aud`, hết hạn (`exp`), ký bằng key đã bị `auth` gỡ khỏi JWKS                                            | `401`  | Server đã verify được và kết luận credential không hợp lệ — đây là thông tin về caller, không phải sự cố hệ thống                                                         |
| Credential có nhưng **không verify được lúc này**: JWKS không lấy được khi cache không có key cần dùng, verifier chưa cấu hình hoặc misconfigure, dependency chết, DB không gọi được | `503`  | Server **không** kết luận được gì về caller ⇒ không được coi là "không hợp lệ"; client retry được và có thể thành công                                                    |
| Credential hợp lệ nhưng principal thiếu permission                                                                                                                                   | `403`  | Quyết định authorization — đã chốt ở [`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md) (AC-001), không mở lại ở đây |
| Credential hợp lệ, principal đã verify, nhưng **không phải staff member đang active**                                                                                                | `403`  | Kết quả **authorization**, không phải authentication — người đó đã chứng minh danh tính rồi                                                                               |

**Authn ≠ authz — hai trục phải giữ tách.** Trục _authentication_ trả lời "tao có biết đây là ai không?" và chỉ có thể kết thúc bằng `401` hoặc `503`; `403` **không** xuất hiện ở trục này. Trục _authorization_ trả lời "tao đã biết đây là ai, và họ có quyền không?" và kết thúc bằng `403`. Vì vậy một principal đã verify nhưng không phải staff active là `403`, không phải `401`; và staff status là trục độc lập với account status (§3.2), nên "không active" cũng không phải lý do để coi là chưa xác thực.

### 2. Ai verify credential

- **Bên verify là server side của `backoffice`** (BFF). Không phải UI/client — SR-001 cấm tin identity do client supply, T-10 (confused deputy) cấm BFF hành động thay identity chưa xác minh. Và không phải `auth` ở runtime: `auth` là authorization server phát hành token, còn resource server verify offline.
- **Đường verify dự kiến:** OIDC token do `auth` cấp, verify offline bằng **JWKS ES256** của `auth` — cùng đường mà ADR-0005 đã chốt cho bằng chứng step-up ("`backoffice` verify token bằng JWKS ES256 của `auth` như mọi token khác"), theo token profile của resource server: chữ ký, `iss`, `aud`, `exp` ([`domain-model.md`](../domain-model.md) §5). Ánh xạ `sub` → Account ID → staff context diễn ra **server-side** từ token đã xác thực (§4) — không có đường nào để client supply principal.
- Vì `auth` **không** có introspection endpoint (`introspection: { enabled: false }` — `apps/auth/src/oidc/provider.ts`), verify là offline; đó là lý do "JWKS không lấy được" thuộc class `503` chứ không phải `401`.
- **`backoffice` không trở thành credential store và không trở thành IdP thứ hai:** không giữ password/MFA/passkey state, không phát hành token, không tự dựng bằng chứng xác thực. Mọi bằng chứng xác thực đến từ flow `auth`/`account` đáng tin cậy (SR-017) — cùng ràng buộc đã định hình ADR-0005.
- ADR này **không** chốt cơ chế mang credential tới server route (cookie do `backoffice` quản lý, hay phiên của `account`); đó là chi tiết của PR dựng tầng authn. Nó chốt: ai verify, status theo từng class lỗi, và hành vi client tương ứng.

### 3. Tương tác với ADR-0010 và quy tắc chuyển tiếp

- **ADR-0010 giữ nguyên hiệu lực cho giai đoạn hiện tại.** `apps/backoffice` chưa có tầng xác thực nào, nên "thiếu principal" **không phải** khẳng định "caller chưa xác thực" — nó là "hệ thống chưa dựng được đường xác thực", tức **không trả lời được**, và `503` là câu trả lời đúng. `503` hiện tại là **dạng tạm** của cùng nguyên tắc fail-closed (unknown ≠ allow, T-14), không phải một quyết định khác: cả hai đều là "từ chối vì chưa đủ căn cứ", chỉ khác ở việc status có nói thẳng ra lý do với client hay không.
- **Quy tắc chuyển tiếp:** khi PR đầu tiên làm `backoffice` server routes đọc và verify credential thật — tức tầng authn OIDC với JWKS của `auth` được wire vào (workstream C phase 2: wire adapter thật **kèm** tầng xác thực) — thì class (a) đổi từ `503` sang `401` **ngay trong chính PR đó**. Không được hiện thực một nửa: verify token thật nhưng vẫn trả `503` cho caller chưa đăng nhập.
- **Điều kiện buộc (trigger):** đúng một sự kiện — tầng authn thật được wire vào `apps/backoffice` server routes. Không phải "khi production lên", không phải "khi có nhiều người dùng", không phải "khi route đầu tiên cần quyền". Một trigger duy nhất giữ quyết định này không bị hiện thực _tình cờ_.
- **ADR-0010 không bị sửa.** Nó vẫn là canonical cho câu hỏi "route unavailable trong giai đoạn chưa có authn layer"; ADR-0011 là canonical cho ranh giới authn khi authn layer tồn tại. Đây là bổ sung phạm vi, không phải đảo nghĩa.

### 4. Contract phía client (UI)

- **`401` → chuyển hướng tới flow đăng nhập/re-auth chuẩn.** Login UI ở `account` (`/login`, `/login/continue`), authorization endpoint ở `auth` (luồng login/consent protocol → [`../../auth/01-architecture.md`](../../../applications/auth/01-architecture.md) §5). `backoffice` không tự dựng URL: `auth` là bên duy nhất dựng `continue_url` từ origin đã cấu hình ([`../../auth/01-architecture.md`](../../../applications/auth/01-architecture.md) §5.2) — điều kiện chống open redirect.
- **`503` → retry có backoff, có giới hạn; tuyệt đối không fallback về dữ liệu mẫu.** Đây là invariant "UI không giả lập backend": khi adapter thật được wire, một `503` không được khiến UI hiển thị dữ liệu prototype như thể đó là dữ liệu thật. Cơ chế fail-closed hiện có chỉ mở prototype ở đúng chuỗi `'prototype'`; mọi giá trị khác rơi về `'unavailable'` (`apps/backoffice/app/backoffice-data/data-mode.ts`).
- **UI không coi `401` là denial quyền** (không hiển thị "bạn không có quyền" — đó là ngôn ngữ của `403`) **và không coi `403` là lỗi xác thực** (không redirect login — người dùng đã xác thực rồi; chuyển hướng login khi gặp `403` là hành vi sai).
- Vì `503` không bao giờ dùng cho "credential vắng", hành vi phổ biến "client xoá token khi gặp `401`" trở lại an toàn: nó chỉ chạy đúng khi credential thật sự vắng hoặc hỏng, không bao giờ khi auth chỉ đang tạm unavailable.
- ⚠️ **Hiện trạng:** entry point mà client sẽ redirect tới **đã tồn tại**, nhưng **chưa** dùng được end-to-end với môi trường thật. `account` **đã có** login/consent UI và BFF thật — `/login`, `/login/continue`, `/consent` cùng adapter thật `apps/account/app/account-data/real-adapter.ts` nối BFF của chính app (`POST /api/auth/{challenge,verify,handoff,logout}`, `GET /api/auth/session`, `POST /api/consent/{context,decide}`; cookie `__Host-account-session` + `__Host-account-csrf`) — nên URL redirect có thật. Còn `/authorize/complete` của `auth` mới chỉ là route trong thiết kế, **chưa** được mount ([`../../auth/01-architecture.md`](../../../applications/auth/01-architecture.md) §5.1.4; 404 được ghim bằng test tại `apps/auth/src/main.spec.ts:330`), và `db-account` **chưa** được provision — nên các entry point đó **chưa** dùng được end-to-end. Hợp đồng ở đây là **hợp đồng của client khi tầng authn có mặt**; phần hiện thực thuộc các workstream của `account`/`auth`, không thuộc ADR này.

## Hệ quả

- Workstream C phase 2 có một contract để implement, không phải một quyết định còn mở: map status → hành vi client theo §4, **và** đổi `503` → `401` cho caller chưa đăng nhập trong cùng PR với lúc tầng authn được wire.
- Acceptance matrix hiện **chưa có** dòng nào cho lớp authn ([`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md) §5 dừng ở AC-020). Dòng acceptance cho từng class ở §1 của ADR này phải được thêm vào tài liệu requirements đó khi tầng authn được implement — không sửa ngầm, và không được coi là đã được chứng minh trước khi có test.
- Mọi `503` đang tồn tại bên trong `requirePermission` (dữ liệu authorization không đọc được, audit ghi hỏng, actor sai định dạng) thuộc trục **authorization**, không thuộc trục authn mà ADR này chốt, và **không đổi**: chúng vẫn `503` fail-closed. Riêng nhánh actor sai định dạng là lỗi ánh xạ `sub` → Account ID ở server (không phải credential của caller — token đã verify thành công), nên nó không thuộc class (a) của bảng §1 và giữ `503`.
- ADR này **không kèm code nào**. `apps/backoffice` không được sửa; việc hiện thực thuộc workstream C phase 2, sau khi có issue riêng.
- Rủi ro còn lại được ghi nhận: một số client hiện xoá token khi gặp `401`; tách hai class chính là để hành vi đó chỉ xảy ra đúng lúc lẽ ra phải xảy ra.

## Cross-reference

- **SR/T-**: SR-001, SR-002, SR-003, SR-012, SR-017 · T-10, T-14 ([`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md)).
- **Thiết kế:** [`domain-model.md`](../domain-model.md) §2, §3.2, §4, §5 · §9 (hàng "Authn boundary của `backoffice` server routes").
- **ADR liên quan:** [ADR-0005](./0005-step-up-fresh-session.md) — bằng chứng step-up đến từ flow `auth` đáng tin cậy, cùng ràng buộc không trở thành IdP thứ hai · [ADR-0010](./0010-permission-naming-and-read-catalog.md) — quyết định phụ "principal không verify được → `503`" ở giai đoạn chưa có authn layer.
- **System:** [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) §2.2 · A21, A22, A23.
- **Đối chiếu implementation hiện có:** `apps/account/server/middleware/internal-auth.ts` — convention `401` cho credential thiếu/sai, `503` cho DB không gọi được · `apps/auth/src/oidc/provider.ts` — `introspection: { enabled: false }`, JWKS tại `/jwks.json`.
- **Issue:** #107 (P3) — ADR này đóng đúng P3, không đóng các finding khác của issue đó.
