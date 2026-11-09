# `@ecoma-io/account`

App Nuxt 4 chạy trên Cloudflare Workers, giữ **account UI + BFF** của bounded context
`identity` — kể cả login và consent UI.

Đây là **một trong hai** deploy unit của context đó. Endpoint protocol OAuth 2.0/OIDC
thuộc deploy unit kia (`auth` ở `apps/auth`, Worker `ecoma-auth`), không phải app này.
Reference: `docs/architecture/01-architecture.md` §2.

## Phạm vi app

| Phần                                   | Trạng thái                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /health`                          | có — protocol-only, không query DB                                                      |
| `GET /ready`                           | có — kiểm `db-account`, fail closed                                                     |
| `GET /internal/account/status`         | có — contract HMAC, `auth` là consumer                                                  |
| `POST /api/auth/challenge`             | có — cấp OTP đăng nhập email, 204 anti-enumeration                                      |
| `POST /api/auth/verify`                | có — xác minh OTP, phát hành session cookie                                             |
| `GET /api/auth/session`                | có — đọc session hiện tại (sliding idle)                                                |
| `POST /api/auth/logout`                | có — thu hồi session + xoá cookie                                                       |
| `POST /api/auth/handoff`               | có — push `/internal/session/verified` về `auth` (BFF, kết quả nhánh fail trả HTTP 200) |
| `POST /api/consent/context`            | có — proxy consent context từ `auth` cho UI consent                                     |
| `POST /api/consent/decide`             | có — proxy quyết định consent (approve/deny) tới `auth`                                 |
| Login UI (`/login`, `/login/continue`) | có — email-OTP qua server adapter; password/passkey vẫn mock (`isPreview`)              |
| Consent UI (`/consent`)                | có — render context từ `auth`, relay `continueUrl` do auth cấp                          |
| Data pages (`/emails`, `/security`, …) | **mock** — các thao tác dữ liệu tài khoản chưa có BFF thật, banner Preview vẫn hiển thị |

## Chạy

```bash
pnpm nx dev account          # http://localhost:4202
pnpm nx test account
pnpm nx lint account
pnpm nx build account
pnpm dx arch-check
```

Dev server dùng `wrangler.jsonc` cho binding. Vì `db-account` **chưa được provision**,
`/ready` sẽ trả `503` ở local — đó là hành vi đúng, xem mục "Những gì chưa có".

## Biến môi trường

Tất cả qua `runtimeConfig` của Nuxt, tức convention `NUXT_*`. Không có chỗ nào trong
code tự đọc `process.env` cho config.

| Biến                              | Bắt buộc | Mặc định                                | Ý nghĩa                                                                                                                                                   |
| --------------------------------- | -------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NUXT_INTERNAL_HMAC_SECRET`       | **có**   | không có                                | Secret HMAC cho internal contract. Tối thiểu 32 ký tự.                                                                                                    |
| `NUXT_INTERNAL_AUTH_SKEW_SECONDS` | không    | `300` (trong `internal-auth-contracts`) | Cửa sổ skew của envelope HMAC, tính bằng giây.                                                                                                            |
| `NUXT_OTP_HMAC_SECRET`            | **có**   | không có                                | Secret HMAC cho digest mã OTP (`otp_challenges.code_digest`). Tối thiểu 32 ký tự.                                                                         |
| `NUXT_MAIL_SERVICE_URL`           | không    | rỗng                                    | Origin http(s) của `transactional-mail` cho gửi mail OTP. Rỗng = chưa cấu hình mail: luồng OTP fail-closed ở request (503), còn lại app chạy bình thường. |

⚠️ Worker **không khởi động được** nếu thiếu secret hoặc secret quá ngắn
(`server/plugins/config.ts` kiểm lúc boot và `throw`). Cố tình: internal HMAC với
secret rỗng thì **chấp nhận mọi chữ ký**, tức tắt hẳn xác thực. "Cho chạy được với
secret rỗng" không phải degrade an toàn.

Ở production, đặt secret bằng Worker Secret (`wrangler secret put`), không đặt trong
`wrangler.jsonc`.

### `NUXT_OTP_HMAC_SECRET` — vận hành

- Bảng `otp_challenges` **không lưu mã OTP**, chỉ lưu `HMAC-SHA256(key, "login:" + mã)`.
  Mất secret = toàn bộ challenge đang hiệu lực không verify được nữa (người dùng xin
  mã mới), không có dữ liệu nào bị lộ hay bị khôi phục từ digest.
- **Không dùng chung** với `NUXT_INTERNAL_HMAC_SECRET`: hai hợp đồng khác nhau
  (envelope internal và OTP digest). Dùng chung một key là một key lộ làm chết cả hai,
  và mục đích xoay riêng của mỗi cái bị mất.
- **Xoay secret** = đặt secret mới rồi deploy; mọi challenge đang hiệu lực (TTL 10
  phút) chết — chấp nhận được vì người dùng chỉ cần bấm "gửi lại mã". Không có bước
  data migration nào.
- Validation runtime yêu cầu tối thiểu 32 ký tự, fail closed ở request đầu (không ở
  module-init, xem `server/utils/config-validation.ts`).

## Internal contract

`GET /internal/account/status?sub=sub_…`

Trả **đúng một** trường `status`, thuộc `active | suspended | deleted | not_found`.
Không có email, tên, profile hay trường định danh nào khác (FR-011b).

Xác thực bằng **envelope HMAC** qua ba header `x-ecoma-internal-timestamp`,
`x-ecoma-internal-nonce`, `x-ecoma-internal-signature`. Endpoint này
**không** nhận cookie trình duyệt (SR-010) — Service Binding không thay được signature
vì Cloudflare không document bất kỳ tín hiệu nào cho Worker phân biệt request qua
binding với request từ internet.

### Back-channel `account → auth` (`auth-client.ts`)

Hướng ngược lại: sau khi OTP được chấp nhận, `account` **đẩy** kết quả về `auth` qua
cùng bộ header HMAC đó (`server/lib/auth-client.ts` — mirror của
`apps/auth/src/account-client.ts`):

- `POST /internal/session/verified` — sửa lỗi "login account xong nhưng transaction
  của auth đứng yên". `event_id` = `session_verified:<session_ref>` nên retry của
  BFF là idempotent (`already_processed`), không kích hoạt lại transaction.
- `POST /internal/consent/context` / `POST /internal/consent/decide` consent cho
  transaction `consent_pending`.

Transport là Service Binding `AUTH_SERVICE` (`runtimeConfig.cloudflare.env.AUTH_SERVICE`)
— khai trong `wrangler.jsonc` bên hạ tầng; **chưa có binding ⇒ fail-closed**
(`binding_missing`), không có đường fetch public-origin thay thế. Secret ký là
cùng `NUXT_INTERNAL_HMAC_SECRET` — hai đường auth-account dùng chung một dòng secret.

## BFF routes cho browser

Ba route `POST /api/auth/handoff`, `POST /api/consent/context`, `POST /api/consent/decide`
dùng session cookie của app (không envelope HMAC — đường đó là của server):

- Yêu cầu session **sống** với ACR thuộc `ACR_URN_VALUES` (`server/lib/bff-session.ts`);
  thiếu session ⇒ `401`, CSRF double-submit sai (`x-ecoma-csrf` vs
  `__Host-account-csrf`) ⇒ `403`.
- Không có binding `AUTH_SERVICE` hay secret ⇒ chết rõ (`503`/`ok:false
  binding_missing`), không có đường "coi như xong".
- Lỗi từ phía auth (4xx/503/unreachable) trả `ok:false` với mã lý do ổn định ở
  HTTP 200 — session không bị hủy, UI cho retry; các response không bao giờ tự
  dựng `continueUrl`. (HTTP status của BFF cố định; mã lý do trong body mới là
  chi tiết upstream — `rejected` = auth trả 4xx, `auth_unavailable` = auth trả
  503, `unreachable` = không tới được auth.)
- Kết quả relay bị kiểm shape trước khi coi là thành công: `granted`/
  `consent_required` phải mang `continue_url` tuyệt đối, `already_processed`
  không được mang `continue_url` (chỉ `transaction_state`) — lệch shape xếp
  `invalid_response`, không relay tùy ý.
- `handle`, `outcome`, `continue_url` đều được relay nguyên vẹn từ `auth`; BFF chỉ
  map scope thành nhãn hiển thị (`mapScopes`) và flag `highRisk`.

## Vì sao `/health` không query DB

`/health` chỉ chứng minh Worker đã khởi động. Nếu liveness phụ thuộc DB thì DB chết ⇒
`/health` lỗi ⇒ orchestrator restart Worker ⇒ Worker mới lại hỏi DB vẫn chết ⇒ restart
loop vô ích, vừa tăng tải lên DB đang chết vừa che mất nguyên nhân thật. Thứ cần hỏi
là `/ready`, và thứ cần sửa là `db-account`.

## Hyperdrive

Binding `DB_ACCOUNT` khai trong `wrangler.jsonc`, đọc ở `server/utils/bindings.ts`.

⚠️ **Query cache của Hyperdrive phải OFF** (`max_age = 0`). Cache bật mặc định 60s và
**không** invalidate khi ghi, nên contract status sẽ trả `active` cho một account vừa
bị `suspended` — đúng loại lỗi fail-open mà đường xác thực không được phép có. Tắt cache
là thao tác vận hành trên config `db-account`, **không** phải key trong
`wrangler.jsonc`.

Driver là `pg` (node-postgres), không phải Postgres.js: transaction-mode pooling của
Hyperdrive không hỗ trợ tin cậy `prepare: false`, mà `pg` không bật prepare.

## Những gì chưa có

Phần này liệt kê cái **không** tồn tại, để không ai đoán nhầm từ tên route:

- **`db-account` chưa được provision.** `id` Hyperdrive trong `wrangler.jsonc` là
  placeholder (`000…0`) cho tới khi config thật tồn tại; deploy sẽ fail tới lúc đó.
  Điền id giả vào production để "cho deploy chạy" là đổi một lỗi lộ ra sớm lấy một
  lỗi im lặng lúc chạy thật.
- **Service Binding `AUTH_SERVICE` chưa được khai báo.** `server/lib/auth-client.ts`
  chỉ chứa **tên** binding (invariant 4); `wrangler.jsonc` chưa có mục khai
  `AUTH_SERVICE` — do hạ tầng (Workstream E) provision. Chưa có binding thì ba
  route BFF trên fail-closed như đã mô tả; không có URL dự phòng.
- **Password / passkey / OIDC UI chưa có.** Chỉ luồng email-OTP được nối server;
  các luồng còn lại trên `/login` vẫn dùng mock adapter (`isPreview: true`,
  banner Preview hiển thị).
- **Data pages vẫn mock.** Profile, emails, sessions, applications, privacy… chưa
  có BFF; adapter thật vẫn là mock cho phần đó.
- **UI cấp/xác minh email chưa có.** BFF `POST /api/emails` và
  `POST /api/emails/:id/verify` đã có, nhưng UI profile chưa có ô nhập địa chỉ và ô
  nhập mã xác minh; từ góc người dùng, luồng OTP hiện chỉ đăng nhập được địa chỉ đã
  `verified` sẵn (seed hoặc qua API).
- **Prune job cho `internal_nonces` chưa có.** Mỗi request internal hợp lệ ghi một
  nonce; TTL (`timestamp của envelope + skew + buffer`) đã được test đảm bảo đúng
  thời lượng, nhưng `wrangler.jsonc` chưa khai `triggers.crons` nào dọn hàng hết
  hạn — bảng phình theo traffic cho tới khi prune tồn tại. `otp_challenges` cũng
  vậy: hàng consumed/hết hạn được giữ làm dữ liệu rate-limit (giới hạn 1 giờ cần
  lịch sử), chưa có cron dọn theo sau cửa sổ đó.
- **Hyperdrive chưa được đo bằng test.** Integration test kết nối `pg` thẳng vào
  PostgreSQL; hành vi Hyperdrive thật (transaction-mode pooling, query cache OFF)
  chỉ có ở môi trường deploy.
- **transactional-mail thật chưa được đo.** Adapter gửi mail được test với fetch stub;
  hợp đồng `POST /v1/messages` neo bằng validator của `transactional-mail-contracts`
  (gồm cả `Idempotency-Key` bắt buộc — replay trả 200, 409 là lỗi hợp đồng), nhưng
  service thật (hiện là scaffold) chưa nhận mail nào từ đường này.
- **Chạy trên Cloudflare Workers thật** (`wrangler dev` / Preview): không có
  smoke test nào sau deploy.

## Ghi chú build

`nuxt.config.ts` khai `nitro.alias` cho `pg-native`. Đây là bắt buộc, không phải tuỳ
chọn: preset `cloudflare-module` bật `noExternals`, nên `pg/lib/native/client.js`
`require('pg-native')` (optional dependency mà Node nuốt lỗi được) khiến Rollup fail
build. Stub ở `server/lib/pg-native.cjs` **ném lỗi khi được dựng** — trả object rỗng sẽ
biến code gọi `pg.native` thành client giả và hỏng im lặng ở production.

## Tham chiếu

- `docs/applications/account/01-architecture.md` — §4 session/cookie, §5 contract
- `docs/applications/account/02-requirements.md` — FR-011x, SR-010
- `docs/applications/account/03-operations.md` — §1 runtime, §2 deployment, §5 Hyperdrive, §6 observability, §8 failure modes
- `docs/architecture/01-architecture.md` §9 — invariants (2: Preview không ghi production, 4: application code chỉ chứa tên binding, 14: Hyperdrive query cache OFF, 25: `account` chỉ đọc/ghi `db-account`, 30: kiểm tra trạng thái account lúc phát hành)
