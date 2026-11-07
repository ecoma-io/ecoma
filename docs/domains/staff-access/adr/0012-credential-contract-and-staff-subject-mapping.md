# ADR-0012 — Credential contract của `backoffice`: Authorization Code + PKCE qua `auth`, BFF verify access token offline, ánh xạ `sub` → staff

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4): ADR này chốt quyết định cho nghiệp vụ staff/RBAC khi được tách khỏi `backoffice` (A21–A24). Ngày nay `backoffice` còn sở hữu staff/RBAC.

> **Trạng thái:** Accepted · **Ngày:** 2026-10-23 · **Quyết định từ:** [`domain-model.md`](../domain-model.md) §4, §5 · **Issue:** #116 · **Hiện thực:** PR B của Backoffice MVP (J2)

## Bối cảnh

[ADR-0011](./0011-authn-boundary-and-unauthenticated-response.md) đã chốt **ranh giới** authn (ai verify, 401/503/403 theo từng class lỗi) nhưng **cố ý** không chốt cơ chế mang credential tới server route — nó ghi rõ: "ADR này **không** chốt cơ chế mang credential tới server route; đó là chi tiết của PR dựng tầng authn". Issue #116 mở đúng câu hỏi đó, với bốn câu hỏi con: (1) cơ chế mang credential, (2) audience, (3) ánh xạ `sub` → staff, (4) ai đăng ký OAuth client.

Trạng thái đã xác minh trên source tại thời điểm quyết định (`origin/main` @ `1095f7d6`):

- `auth` là authorization server OIDC hoàn chỉnh: `GET /authorize` (entrypoint public, glue) → interaction ép `prompt=login+consent` trên **mọi** authorization (`apps/auth/src/oidc/provider.ts:496+`) → login/consent UI thật của `account` → code phát hành khi provider resume. Access token là **JWT ES256** `typ: at+jwt`, TTL 300s, có `kid` trong header; refresh token opaque, rotation, reuse ⇒ thu hồi cả grant, TTL 30 ngày tuyệt đối; revocation RFC 7009 bật tại `/revocation`; **không** introspection endpoint.
- Claims runtime của access token (đối chiếu oidc-provider 9.12.2 `models/formats/jwt.js:111-124`): `sub`, `aud`, `iss`, `exp`, `iat`, `scope`, `client_id`, `jti`. **Không có `nbf`** và **không có `authorization_details`** — claim sau chỉ được gán khi RAR có mặt (`features.richAuthorizationRequests` mặc định FALSE, `auth` không bật, glue không gửi param `authorization_details`), còn `AccessTokenClaims` trong `libs/auth-application/src/token-service.ts` khai `nbf` nhưng đường phát hành production không đi qua interface này (`issueAccessToken` chỉ được `exchangeAuthorizationCode` cùng lib gọi — oidc-provider là tầng phát hành thật). `auth_time`/`acr` chỉ xuất hiện trong **ID token** khi scope `openid` (`provider.ts:104-120`), không có trong access token.
- Audience: một `AUTH_AUDIENCE` duy nhất (`apps/auth/src/config.ts:215`); `resourceIndicators` của provider chỉ phục vụ resource indicator đúng giá trị đó (`provider.ts:418-429`), và glue **tự chèn** `resource=<AUTH_AUDIENCE>` vào authorize URL (`apps/auth/src/browser-handlers.ts:156`) — caller không chọn được resource.
- Chỉ **client public** được nạp (`loadStaticClients`: `client_type = 'public'`, `token_endpoint_auth_method: 'none'`, PKCE S256 bắt buộc, `id_token_signed_response_alg: 'ES256'` khai tường minh). Redirect URI so khớp exact string. Scope qua allowlist `allowed_scopes` của client; `scopes_supported = ['openid', 'offline_access', 'profile']`; scope `offline_access` ⇒ glue tự chèn `prompt=consent` ⇒ mới có refresh token.
- `auth.oauth_clients` **chưa có hàng seed nào** (INSERT chỉ nằm trong test) — provider ném khi bảng rỗng lúc boot (`provider.ts:326`). Đây là gap dữ liệu của bounded context `auth`, không phải của `backoffice`.
- Cookie phiên của `account` là `__Host-account-session` — prefix `__Host-` + không `Domain`, **host-bound**: về mặt kỹ thuật browser không gửi nó sang hostname khác, nên không tồn tại phương án "dùng chung phiên `account` cho `backoffice`" mà không phá shared-origin boundary. Không có app nào hiện tiêu thụ token của `auth` từ browser — `backoffice` là resource server đầu tiên.
- Trên server `backoffice`: `readPrincipal()` đọc bị động `event.context`, `loadPrincipalAuthorization()` ánh xạ `sub` → staff + assignment + permission từ `db-backoffice`; chưa có middleware gắn principal (mọi route 503 fail-closed đúng giai đoạn ADR-0010/0011).
- Docs auth §5.1.4 mô tả endpoint hoàn tất `GET /authorize/complete`; source thật trả `continue_url` = **resume URL của provider** cho nhánh `granted` và code được cấp tại resume (deviation được chính code ghi nhận: `session-verified-handler.ts` "deviation: resume là completion của nhánh granted"; 404 của `/authorize/complete` được ghim bằng test `apps/auth/src/main.spec.ts:330`). Docs auth mô tả **target design**; hợp đồng của ADR này bám theo **hành vi đã chạy**.

## Phương án

| #   | Phương án                                                                                                                                  | Đánh giá                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Authorization Code + PKCE, `backoffice` là public client; BFF đổi code → token, giữ phiên riêng; verify access token offline bằng JWKS** | Chấp nhận — phù hợp toàn bộ năng lực đã chạy của `auth`; token không bao giờ nằm ở browser; phiên của `backoffice` tự kiểm soát; verify offline không thêm dependency serving-path vào `auth`                             |
| 2   | Dùng cookie phiên của `account` làm bằng chứng xác thực cho `backoffice`                                                                   | Loại — cookie `__Host-` host-bound, không gửi cross-host; chia sẻ đòi bỏ prefix/đặt `Domain` là phá shared-origin boundary; `backoffice` còn phải hỏi lại `account` mỗi request (serving-path dependency cấm theo SR-019) |
| 3   | BFF giữ **ID token** làm credential gọi API                                                                                                | Loại — ID token là bằng chứng authentication event giữa OP và client, không phải permission gọi resource server (`domain-model.md` §5; OIDC Core); TTL 300s của nó đòi refresh path riêng không có trong contract         |
| 4   | Verify token bằng introspection của `auth`                                                                                                 | Loại — `auth` tắt introspection; bật nó là thay đổi của context `auth`, và biến `auth` thành serving-path dependency của mọi request `backoffice` (ADR-0011 §2 đã chốt verify offline)                                    |
| 5   | Token nằm ở browser (implicit/fragment), client gọi API kèm Bearer trực tiếp                                                               | Loại — implicit bị `auth` loại (`response_types: ['code']` duy nhất); token trong URL/fragment là cấm tường minh của docs auth §4.1; UI không được giữ credential của resource server                                     |

## Quyết định

### 1. Luồng credential: Authorization Code + PKCE, phiên BFF riêng

1. Browser (chưa có phiên `backoffice`) được UI điều hướng tới route login của `backoffice` BFF.
2. BFF sinh `state` + PKCE `code_verifier`/`code_challenge` (S256), lưu server-side gắn một giá trị cookie `__Host-` dùng một lần, rồi `302` browser tới `GET {AUTH_ISSUER}/authorize` với `response_type=code`, `client_id` của `backoffice`, `redirect_uri` đăng ký, scope theo §6, `state`, `code_challenge`.
3. `auth` ép login + consent qua `account` (interaction bắt buộc trên mọi authorization — không có SSO-skip). Sau resume, browser về `redirect_uri` của `backoffice` kèm `?code` (+ `state`).
4. BFF callback: so `state`, đối chiếu cookie dùng-một-lần, **đổi code → token tại `POST {AUTH_ISSUER}/token`** (auth method `none`, kèm `code_verifier`), rồi **thiết lập phiên riêng của `backoffice`**: cookie `__Host-backoffice-session` (Secure, HttpOnly, SameSite=Lax) trỏ tới phiên server-side; token không bao giờ về browser.
5. Từ đó, mọi request tới server route của `backoffice` mang phiên này; middleware authn verify **access token** (§2) trước `readPrincipal`/`requirePermission` hiện có.

Ranh giới bất biến của luồng:

- **Principal chỉ được dựng từ token đã verify** — không đọc danh tính từ header/body/query/cookie nào ngoài phiên §3. `state` + PKCE verifier + cookie callback là dùng một lần, single-use, TTL ngắn; callback replay (code dùng lại, `state` không khớp, cookie vắng/lặp) bị từ chối và không tạo phiên. Authorization code bản thân đã single-use CAS ở `auth`.
- **BFF không trở thành IdP thứ hai** (ADR-0011 §2): phiên BFF chỉ là **bộ đệm token đã được `auth` cấp và `backoffice` verify**, không phát hành assertion nào mang ý nghĩa xác thực ngoài phạm vi này; logout/re-auth phải đi qua luồng `auth`.
- UI không tự dựng authorize URL từ dữ liệu client; URL login do BFF dựng từ cấu hình server.

### 2. Token và cách verify — resource server profile

- **Token loại:** access token JWT (`typ: at+jwt`) của `auth`. **Không** dùng ID token làm credential gọi API (phương án 3).
- **Verify offline** ([ADR-0011](./0011-authn-boundary-and-unauthenticated-response.md) §2): chữ ký **ES256** với `kid` từ `GET {AUTH_ISSUER}/jwks.json` (fetch + cache; `kid` lạ ⇒ fetch lại JWKS trước khi kết luận 401 — key rotation mà xoá `kid` khỏi JWKS là chính sách công bố của `auth`), `iss` = `AUTH_ISSUER` exactly, `aud` = audience của `backoffice` (§5), `exp` trong quá khứ.
- **Không đòi `nbf`:** access token runtime không có claim này (đối chiếu ở Bối cảnh). Verifier ghim theo payload thực đo được của oidc-provider 9.12.2, **không** theo `AccessTokenClaims` của `libs/auth-application` (interface không nằm trên đường phát hành production — oidc-provider là tầng phát hành thật). Nếu tương lai `auth` thêm `nbf` thì verifier bổ sung check qua PR riêng có test — không thêm check "phải có `nbf`" từ trước.
- **Phân loại lỗi đúng ADR-0011 §1:** thiếu phiên/token → `401`; chữ ký sai, `iss`/`aud` sai, hết hạn, `kid` không còn trong JWKS (sau khi đã fetch lại) → `401`; JWKS không fetch được khi cache không đủ, phiên store không đọc được → `503`; permission deny / staff không active → `403` (đường `requirePermission` hiện có, giữ nguyên).
- **Không tin `scope` làm authorization:** scope trong token là snapshot lúc cấp (A22, A24); quyền được đánh giá **mỗi request** từ `db-backoffice` qua `loadPrincipalAuthorization` (§4). Access token TTL 300s dài hơn ngưỡng revocation `high` 5s ([ADR-0002](./0002-revocation-latency-risk-class.md)) nên authn layer không bao giờ là chốt chặn thu hồi.
- **Không log token**, không log verifier error chi tiết ra response — phân loại 401/503 là contract, message chi tiết chỉ vào log server không chứa token (SR-014).

### 3. Phiên BFF, refresh, logout

- **Phiên server-side:** cookie `__Host-backoffice-session` chỉ mang định danh phiên bất động (opaque, entropy cao); nội dung phiên (token set, metadata) nằm ở store server-side của `backoffice`, không ở cookie. TTL idle + TTL tuyệt đối; giới hạn số phiên song song theo tài nguyên khả dụng (không phải yêu cầu bảo mật riêng).
- **Refresh:** dùng refresh token trong phiên để lấy access token mới khi hết hạn; rotation là cơ chế sẵn có của `auth`, **reuse bị phát hiện (`invalid_grant`) ⇒ `auth` thu hồi cả grant ⇒ BFF phải hủy phiên và ép đăng nhập lại** — không retry, không fallback.
- **Logout:** hủy phiên server-side + gọi `POST {AUTH_ISSUER}/revocation` cho access + refresh token (RFC 7009); xoá cookie. RP-initiated end-session của `auth` dùng khi cần logout toàn cục, không phải điều kiện cho logout cục bộ.
- **CSRF:** mọi route mutation (J4) phải qua defence CSRF (so nguồn gốc request — `Origin`/`Sec-Fetch-Site` — kết hợp token phiên same-site); read-only routes không cần vì không đổi trạng thái. Route callback/login chỉ chấp nhận đúng luồng §1.
- **Step-up ([ADR-0005](./0005-step-up-fresh-session.md)):** bằng chứng `auth_time` chỉ có trong ID token, nên BFF **verify ID token lúc code exchange** (chữ ký/iss/aud/exp/nội dung `sub` khớp access token), ghi `auth_time` đã verify vào phiên server-side; privileged operation đòi `auth_time` ≤ 5 phút tính tại thời điểm thao tác — không phải thời điểm tạo phiên. Hết cửa sổ ⇒ điều hướng lại authorize (policy `auth` vốn ép login+consent trên mọi authorization nên mỗi authorize mới là một re-auth thật). `acr` được lưu kèm cho audit, không dùng làm điều kiện allow.

### 4. Ánh xạ `sub` → staff và authorization

- `sub` của access token = Account ID (`sub_` + 32 base32, CHECK `staff_sub_account_id_format_check` ở migration 0004). Ánh xạ diễn ra **server-side, mỗi request**: `loadPrincipalAuthorization(client, actorSub)` đọc `db-backoffice` (staff + role assignment + role permission), hoàn toàn giữ nguyên cơ chế hiện có của #99/#101/#112.
- Một token hợp lệ với `sub` không có staff entry active → `403` (ADR-0011 §1 hàng cuối — đây là authorization, không phải authn). Staff `suspended`/`terminated` → `403`. Assignment hết hạn/thu hồi → denial theo `can()` hiện có.
- Thứ tự trong request: **middleware authn (verify token → gắn principal) → `requirePrincipal` → Hyperdrive/DB → `loadPrincipalAuthorization` → `requirePermission`**. Flip chuyển tiếp theo ADR-0011 §3: PR wire authn đổi `503` → `401` cho caller chưa đăng nhập **trong cùng PR**, giữ `503` cho JWKS/DB outage và cho actor sai định dạng (trục authorization).

### 5. Audience — quyết định đã chốt

`backoffice` dùng **audience riêng** (`AUTH_AUDIENCE` hiện tại là giá trị chung). Việc cấp audience riêng là **thay đổi cấu hình của `auth`** (env + policy resourceIndicators) và **thuộc context `auth`** — `backoffice` không sửa `apps/auth`. Ràng buộc cho hai phía:

- **Verifier phía `backoffice` đọc audience từ cấu hình của mình** (env riêng, ví dụ `NUXT_BACKOFFICE_AUTH_AUDIENCE`), không hard-code; PR B chạy được với audience bất kỳ vì test dùng token tự ký theo đúng contract.
- **Context `auth` phải:** cấp audience riêng cho `backoffice`, đăng ký client public `backoffice` trong `oauth_clients` + `client_redirect_uris` (exact match), `allowed_scopes` theo §6 — bằng migration seed hoặc provisioning do context `auth` sở hữu. Cho tới khi landing, `backoffice` vẫn chạy đúng với audience chung đang có (verifier theo cấu hình), nhưng **staging/production không bật real mode trước khi audience riêng + client seed có mặt** — đây là điều kiện của flip staging ở workstream C phase 2.

### 6. Scope của client `backoffice`

- `openid` — bắt buộc để có ID token cho `auth_time` (§3 step-up).
- `offline_access` — để có refresh token cho phiên dài hạn (glue tự chèn `prompt=consent`; reuse refresh ⇒ hủy phiên, §3).
- `profile` — không cần cho authn/authz của `backoffice` MVP (không dùng claim nào từ nó); xin khi cần hiển thị hồ sơ, không phải điều kiện của luồng.
- **Không có scope nào map thành permission** — scope ≠ permission (A22); mọi permission đi qua catalog `backoffice` ([ADR-0010](./0010-permission-naming-and-read-catalog.md)).

### 7. Deviation với docs auth §5.1.4 (completion protocol)

Hợp đồng của ADR này bám **hành vi đã chạy**: nhánh `granted` trả `continue_url` = resume URL của provider và code được cấp tại resume; `GET /authorize/complete` chưa được mount (404 ghim bằng test). BFF `backoffice` không phụ thuộc endpoint nào chưa tồn tại: nó chỉ nhận `?code` tại `redirect_uri` của mình. Nếu `auth` sau này mount `/authorize/complete` như docs auth mô tả, hợp đồng bên phía `backoffice` **không đổi** — `backoffice` không bao giờ là consumer của endpoint đó.

## Hệ quả

- PR B (J2) có contract đầy đủ để implement: middleware authn + luồng login/callback/logout + session store + step-up session metadata; test matrix 401/503/403 theo ADR-0011 + §2 của ADR này.
- Workstream C phase 2 (J3) nhận thêm điều kiện flip staging: audience riêng + client seed của context `auth` phải có mặt trước (§5) — nếu chưa, dừng ở khai báo và ghi cho deploy lane/context `auth` (đúng AC của #109).
- Context `auth` có hai việc đi kèm, tracked riêng khỏi PR `backoffice`: (1) audience riêng cho `backoffice`, (2) seed client public `backoffice` + redirect URI + `allowed_scopes` (`openid`, `offline_access`) — đúng quyết định D-2/D-3 của issue #116.
- `AccessTokenClaims` (interface khai `nbf` nhưng không nằm trên đường phát hành production) không được dùng làm chuẩn verifier; nếu cần dọn code gây nhầm lẫn về sau, việc dọn thuộc context `auth` (lib nằm ở `libs/auth-application`).
- Hyperdrive query cache không thuộc ADR này — tác động của nó tới cửa sổ revocation đã ghi ở [`domain-model.md`](../domain-model.md) §5 và được deploy lane xác nhận OFF (không set được từ `wrangler.jsonc`).
- Acceptance matrix [`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md) bổ sung dòng authn khi PR B implement (đúng hệ quả của ADR-0011) — không sửa ngầm ở đây.

## Cross-reference

- **SR/T-**: SR-001, SR-002, SR-003, SR-012, SR-014, SR-017, SR-019 · T-04, T-05, T-07, T-10, T-14 ([`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md)).
- **Thiết kế:** [`domain-model.md`](../domain-model.md) §2, §4, §5, §6 · §9 (hàng "Authn boundary").
- **ADR liên quan:** [ADR-0002](./0002-revocation-latency-risk-class.md) · [ADR-0005](./0005-step-up-fresh-session.md) · [ADR-0010](./0010-permission-naming-and-read-catalog.md) · [ADR-0011](./0011-authn-boundary-and-unauthenticated-response.md).
- **Đối chiếu implementation hiện có:** `apps/auth/src/oidc/provider.ts` (interaction ép login+consent, resourceIndicators, static public clients, JWT ES256, refresh rotation, `/revocation`) · `apps/auth/src/browser-handlers.ts` (glue `/authorize`, tự chèn `resource`, `prompt=consent` khi `offline_access`) · `apps/auth/src/session-verified-handler.ts` (deviation resume-completion) · `apps/account/server/lib/session.ts` (pattern cookie `__Host-`) · `libs/backoffice-infrastructure/src/queries.ts` (`loadPrincipalAuthorization`).
- **Issue:** #116 — ADR này trả lời bốn câu hỏi mở của issue; phần việc của context `auth` được tách rõ ở §5.
