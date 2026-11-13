# Auth — Architecture (ứng dụng)

> Phạm vi: thiết kế ứng dụng `auth` — deploy unit Cloudflare Worker (Hono, API-only) phục vụ authorization server OAuth 2.0/OIDC: runtime, schema `db-auth`, giao thức login/consent, bốn contract back-channel, envelope nội bộ, cơ chế token và revocation.
> Mô hình miền — ranh giới, ngôn ngữ, quyết định chính sách OAuth/OIDC → [`docs/domains/auth/domain-model.md`](../../domains/auth/domain-model.md) · yêu cầu → [`02-requirements.md`](./02-requirements.md) · vận hành → [`03-operations.md`](./03-operations.md) · bằng chứng đăng nhập → [`../account/01-architecture.md`](../account/01-architecture.md) · system boundary → [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) §2.1.
> **Hiện trạng:** authorization server đã có trong code (`apps/auth` — provider `oidc-provider` 9.12.2, glue internal, 14 migration `apps/auth/migrations/`); các phần protocol của tài liệu này phản chiếu cấu hình provider hiện hành. **Chưa có**: `db-auth` chưa provision, Worker chưa khai environment staging/production.

---

## 1. Mục đích và ranh giới

Ranh giới nghiệp vụ, danh sách thứ `auth` sở hữu và không sở hữu, quan hệ với `account`, và ranh giới scope ↔ permission → [`docs/domains/auth/domain-model.md`](../../domains/auth/domain-model.md) §1. Tài liệu này mô tả **cách ứng dụng hiện thực** ranh giới đó.

`auth` là **authorization server** OAuth 2.0 / OpenID Connect của Ecoma. Nó **không có UI** — không Nuxt, không Vue, không trang login hay consent. Mọi tương tác với trình duyệt đi qua redirect; mọi tương tác với `account` đi qua contract back-channel (§5.1.7).

Hai ràng buộc cấu trúc của ứng dụng, lặp lại ở đây vì chúng quyết định hình dạng của mọi thứ còn lại:

- **Issuer: `https://auth.ecoma.io`** ([`01` §7](../../architecture/01-architecture.md)) — khớp `issuer` trong discovery và trong `id_token`. Mọi `iss` khác đều bị từ chối.
- **`auth` không đọc `db-account`** và **không có đường nào tự trả lời "phiên này có thật không"**. Câu trả lời đó đến từ `account` qua contract đẩy (§5.1). Trạng thái account thì `auth` hỏi theo hướng ngược lại (§6.0). Hai contract, hai hướng, không được trộn.

## 2. Runtime

```text
auth.ecoma.io  (Cloudflare Worker, API-only, Hono)
├── Hyperdrive binding → db-auth          (query cache OFF)
├── Service Binding  → account            (auth LÀ CONSUMER: hỏi trạng thái account lúc phát hành — §6.0)
└── Worker Secrets                        (signing key — custody đã chốt là Worker Secret `AUTH_SIGNING_KEY`, lịch xoay chưa chốt, §9)
```

⚠️ **Binding này KHÔNG phải đường xác thực và không được dùng để xác minh session.** Nó phục vụ đúng một việc: hỏi trạng thái account tại thời điểm phát hành token (§6.0). Việc xác minh "phiên này có thật không" đi theo **hướng ngược lại** — `account` đẩy sang `auth` qua contract mà `auth` là provider (§5.1). Trộn hai hướng này chính là mâu thuẫn mà §5.1(a) giải quyết.

⚠️ **`Service Binding` từ Preview gọi production** (`04` PW4). Worker production giữ Hyperdrive production → một Preview gọi binding là đang **ghi vào database production qua một Worker production**. Vì vậy cả login/consent E2E lẫn bài kiểm tra trạng thái account trong Preview **không** dùng dependency mode A ([`02` §5.3](../../architecture/02-delivery.md), [`../account/01-architecture.md`](../account/01-architecture.md) §2).

Provider `oidc-provider` 9.12.2 chạy trên Workers qua bridge `cloudflare:node` (`apps/auth/src/oidc/runtime.ts`, `handleAsNodeRequest`). `nodejs_compat` được khai **chỉ** cho bridge; code ứng dụng giữ `runtime:edge` và `.oxlintrc.json` chặn import trực tiếp Node builtin. Toàn bộ glue quanh provider (route internal, envelope, cấu hình client, adapter `db-auth`) là code riêng trong `apps/auth/src/`.

### 2.1 Observability của serving path

- **Observability không phải serving-path dependency.** Log, metric và trace không nằm trên đường quyết định cấp token; mất chúng không được làm đổi kết quả authorization.
- **Audit là dữ liệu, không phải log.** `authorization_audit_events` (§3.2) là bản ghi append-only trong `db-auth`; log runtime không thay thế nó và không được chứa nội dung mà audit cấm.
- **Không log token, authorization code, `code_verifier`, refresh token, client secret, private key, handle, `account_session_ref`, giá trị cookie, raw body hay canonical string của envelope.** Chữ ký trong log là giá trị còn tái dùng được trong cửa sổ skew; message của driver `pg` có thể chứa connection string.

Metric, alert và ngưỡng cụ thể → [`03-operations.md`](./03-operations.md) §7–§8.

## 3. Data model — `db-auth`

Greenfield: **không có** schema hay migration history chung nào để kế thừa. Dưới đây là **logical specification**, không phải DDL.

Quy ước: mọi cột thời gian UTC; mọi token/handle lưu **hash**, không lưu giá trị dùng được lần hai.

### 3.1 Sơ đồ quan hệ

```text
oauth_clients 1───* client_redirect_uris
     │
     └───* oauth_consent_decisions ───* oauth_grants
                                        │
client_grant_scopes 1───* oauth_grants ─┤
                                        ├───* refresh_token_families
                                        │        └───* refresh_tokens
                                        ├───* authorization_transactions
                                        │        └───1 authorization_codes
                                        └───* token_revocations

signing_keys              (chỉ metadata — private key KHÔNG nằm ở đây, §3.4)
authorization_audit_events
outbox_events             (event sang account)
```

### 3.2 Entity

| Entity                       | Mục đích                                                                                                                                                                                                                                                                                                                                                | Ràng buộc chính                                                                                                                                                                                       | Vòng đời                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `oauth_clients`              | Đăng ký client: `client_id`, tên hiển thị, `client_type` (`public`/`confidential`), `client_secret_hash`, `subject_type`, allowed scope, trạng thái                                                                                                                                                                                                     | `client_secret_hash` chỉ tồn tại với `confidential`; `public` client **không có** secret                                                                                                              | Vĩnh viễn, có thể `disabled` |
| `client_redirect_uris`       | Redirect URI đã đăng ký                                                                                                                                                                                                                                                                                                                                 | UNIQUE; **`auth` chỉ so khớp exact string**, không wildcard/prefix/scheme+host (§4.1)                                                                                                                 | Theo client                  |
| `authorization_transactions` | Transaction của một lần `/authorize`: `transaction_id`, handle X, `browser_binding_hash` + `key_version`, `browser_confirmed_at`, `client_id`, `redirect_uri`, requested scope, `state`, `nonce`, `code_challenge` + method, `sub` + `account_session_ref` sau xác thực, `event_id` idempotency + `payload_hash` + `outcome` + `handle_hash(Y\|Z)`, TTL | **Handle X là opaque random**, UNIQUE; **single-use**; mọi trường bind từ `/authorize`, không bao giờ từ browser về sau; ⚠️ **`browser_binding_hash` là điều kiện tiên quyết của bước push** (§5.1.0) | TTL ngắn, xoá hẳn            |
| `authorization_codes`        | Code đã phát hành, chỉ đổi lấy token một lần                                                                                                                                                                                                                                                                                                            | **Lưu hash** code; UNIQUE; `consumed_at`; **consume là compare-and-set** (§3.3); gắn `code_challenge` đã lưu                                                                                          | TTL ngắn, xoá hẳn            |
| `oauth_consent_decisions`    | **Quyết định của user** tại một thời điểm: `decided_at`, `decision` (`approve`/`deny`), bind `sub` + client + redirect_uri + scope + transaction                                                                                                                                                                                                        | **Bản ghi lịch sử, không phải quyền hiện hành** (ngữ nghĩa → domain-model §3.4)                                                                                                                       | Theo retention               |
| `oauth_grants`               | **Quyền hiện hành**: `sub` + client + scope đang có hiệu lực, trạng thái                                                                                                                                                                                                                                                                                | Grant **không** bắt nguồn từ consent còn hiệu lực → phải consent lại; thu hồi grant = token mới không được cấp                                                                                        | Sống, thu hồi được           |
| `client_grant_scopes`        | Scope cụ thể của từng grant                                                                                                                                                                                                                                                                                                                             | Dùng để kiểm scope **tại thời điểm phát hành token** và tại introspection                                                                                                                             | Theo grant                   |
| `refresh_token_families`     | Một family cho một grant, dùng phát hiện reuse                                                                                                                                                                                                                                                                                                          | `sub` + client + grant; bị đánh dấu compromised → thu hồi **toàn bộ** family                                                                                                                          | Theo grant                   |
| `refresh_tokens`             | Token refresh hiện tại: hash, `family_id`, `rotated_to`, `expires_at`, `revoked_at`, `used_at`                                                                                                                                                                                                                                                          | **Rotation**: dùng token cũ → cấp token mới, đánh dấu token cũ đã dùng; **dùng lại token đã rotate → reuse detection → thu hồi cả family**                                                            | TTL, thu hồi được            |
| `token_revocations`          | Trạng thái thu hồi append-only: `subject_ref`, `client_id`, scope, `revoked_at`, lý do                                                                                                                                                                                                                                                                  | Ghi **append-only**; là nguồn sự thật của revocation control plane (§6)                                                                                                                               | Theo retention               |
| `signing_keys`               | **Metadata chỉ**: `kid`, algorithm, status, `not_before`, `expires_at`                                                                                                                                                                                                                                                                                  | ⚠️ **Private key không nằm trong `db-auth`.** Xem §3.4                                                                                                                                                | Theo lịch xoay               |
| `authorization_audit_events` | Audit: token issuance, consent, revocation, grant thay đổi, client auth                                                                                                                                                                                                                                                                                 | Append-only; **không** ghi token/secret/assertion                                                                                                                                                     | Lâu hơn dữ liệu chức năng    |
| `outbox_events`              | Event sang `account`; ghi cùng transaction                                                                                                                                                                                                                                                                                                              | Idempotency key UNIQUE                                                                                                                                                                                | Dọn sau publish              |

### 3.3 Single-use — cơ chế cụ thể

Single-use là **compare-and-set**, không phải "đọc rồi ghi":

```sql
UPDATE authorization_codes
   SET consumed_at = now(), consumed_by = <transaction>
 WHERE code_hash = $1
   AND consumed_at IS NULL
   AND expires_at > now()
RETURNING authorization_transaction_id, code_challenge;
```

`UPDATE … WHERE consumed_at IS NULL` là điều kiện cạnh tranh **trong database**. Hai request đồng thời dùng cùng một code: đúng một nhận được row, nhận `0` row → `invalid_grant`. Không có read-then-write nào, nên không có cửa sổ double-spend. Cùng cơ chế cho `authorization_transactions` khi consume handle.

Cùng pattern này bảo vệ **quyết định consent**: `account` gửi quyết định, `auth` đánh dấu transaction đã consume **trong cùng transaction** với việc cấp code — không có đường nào cấp code mà không consume handle.

Ngữ nghĩa nghiệp vụ của single-use → domain-model §3.3.

### 3.4 Signing key — metadata, không phải private key

`db-auth` lưu **chỉ metadata**: `kid`, algorithm, status, `not_before`, `expires_at` (`auth.signing_keys`, migration 0007). ⚠️ **Private key không được lưu trong `db-auth`.**

Custody đã chốt ở mức runtime: private key là **Worker Secret** `AUTH_SIGNING_KEY` (PKCS#8 PEM, `apps/auth/src/config.ts`); lịch xoay vẫn **chưa chốt** — xem [`01` §10](../../architecture/01-architecture.md) và §9. Lý do custody là quyết định miền, không phải chi tiết lưu trữ → [`docs/domains/auth/domain-model.md`](../../domains/auth/domain-model.md) §3.8.

JWKS phục vụ **public key** cho client verify token. Xoá `kid` khỏi JWKS **trước** khi phát hành bản thay thế, để token ký bằng key đã lỗi không còn được chấp nhận cho các lần cấp mới; giới hạn của thao tác đó với token đã cấp → §6.5.

### 3.5 Cross-service reference

Mọi `sub` trong `db-auth` là **tham chiếu opaque không có foreign key** tới `db-account`. `auth` không có bảng user và không được tạo một cái chỉ để chứa `sub` — nó sẽ biến thành projection của account mà không có ai chịu trách nhiệm đồng bộ. Toàn vẹn tham chiếu là **responsibility của contract**, phát hiện bằng reconciliation ([`03-operations.md`](./03-operations.md)). Ngữ nghĩa của ràng buộc này → [`docs/domains/auth/domain-model.md`](../../domains/auth/domain-model.md) §3.7.

## 4. OAuth 2.0 / OIDC — cấu hình và tích hợp

### 4.1 Secure defaults — nơi thực thi

Các quyết định chính sách (grant type, loại bỏ Implicit/ROPC, client type, exact redirect match, quyền sở hữu `state`/`nonce`, single-use, cấm token trong URL, CORS, xử lý key compromise) và lý do của chúng → [`docs/domains/auth/domain-model.md`](../../domains/auth/domain-model.md) §3.1. Ứng dụng thực thi chúng ở:

| Hạng mục           | Nơi thực thi trong `apps/auth`                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Grant type         | Cấu hình provider; `code_challenge_method=S256` bắt buộc cho **cả** `public` và `confidential`                              |
| Redirect URI       | Bảng `client_redirect_uris`, so khớp exact string tại `/authorize`; không wildcard, không prefix, không scheme+host         |
| `state`            | Lưu nguyên văn trong `authorization_transactions`, echo lại đúng giá trị khi dựng redirect (§5.1.4)                         |
| `nonce`            | Bind vào transaction ở `/authorize`, đưa vào `id_token`                                                                     |
| Authorization code | `authorization_codes` chỉ lưu hash; consume bằng CAS (§3.3)                                                                 |
| CORS               | `/authorize`, `/token` không bật CORS wildcard; JWKS và discovery là public read-only                                       |
| Key compromise     | Runbook xoá `kid` **trước**, ghi revocation mức toàn subject **sau** → §6.5, [`03-operations.md`](./03-operations.md) §11.1 |

### 4.2 Ba pattern handoff — và cái bị loại

| Pattern                         | Mô tả                                                                    | Vấn đề                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (i) Front-channel handoff       | `account` redirect về `auth` kèm assertion trong query param             | Đặt credential/assertion vào **URL** → lọt vào log, `Referer`, history; `auth` không kiểm chứng được mà không bị replay                                |
| (ii) **Push result**            | `account` push kết quả xác thực sang `auth` qua Service Binding          | ✅ Không đặt credential lên URL; chỉ `account` giữ session nên chỉ `account` trả lời được; browser chỉ mang **opaque handle do `auth` cấp**            |
| (iii) Pull session verification | `auth` **gọi** `account` qua back-channel để hỏi phiên này có thật không | ❌ **Không khả thi** — lệnh gọi mang credential của Worker, không mang cookie trình duyệt; `auth` không phân biệt được nạn nhân với kẻ đang giữ handle |

→ **Chọn (ii).** Đây là contract đã xác thực qua Service Binding, **không phải giao thức mã hoá tự chế**: `auth` tin `account` qua một call đã xác thực, thay vì tin một chuỗi trên browser.

⚠️ **(iii) từng được ghi là lựa chọn đúng và đó là sai.** Một back-channel call **không** mang danh tính trình duyệt — nó mang danh tính của chính Worker gọi. Nên nếu `auth` kéo session, `auth` hoàn toàn **không** có cách nào biết handle đó đang được trình duyệt của nạn nhân hay của kẻ tấn công. Toàn bộ phần còn lại của luồng là hệ quả của quyết định này, xem §5.1(a).

## 5. Login và consent protocol

### 5.1 Luồng — một completion protocol duy nhất

⚠️ **Toàn bộ luồng authorization đi qua _một_ completion protocol, và đó là điều bắt buộc.** Trước đây có hai đường hoàn tất khác nhau: nhánh đã có grant đi qua `GET /authorize/complete?handle=Z`, còn nhánh consent được chấp thuận thì `POST /internal/consent/decide` trả `redirect_url` để `account` redirect thẳng. Hai đường đó có idempotency, cách phát hành code và cách recovery khác nhau, nên một số giả định chỉ đúng ở một nhánh. Bây giờ **cả hai nhánh đều kết thúc ở cùng một endpoint `GET /authorize/complete`**, và **chỉ `auth` dựng OAuth success/error redirect**.

Cơ chế nền: `POST /internal/session/verified` là **contract đồng bộ có response body**. `auth` quyết định ngay trong response đó, và `account` dùng đúng kết quả ấy để điều hướng browser. **Không** có continuation nào được `auth` đẩy ra ngoài, và **không** có endpoint nào để `account` hỏi lại "lần trước tôi nhận được gì".

⚠️ **`resume_url` và `204` đã bị bỏ; chúng không phải bản sửa tối thiểu mà là bỏ hẳn một mâu thuẫn.** `204` không mang body, nên `account` không biết `auth` quyết định điều gì — bước kế tiếp **không tồn tại**. `resume_url` cũ mang `redirect_uri` vào response back-channel, nghĩa là `account` phải dựng `redirect_uri?code=…` mà nó không được phép dựng. Thay hai thứ đó bằng `continue_url` **dựng từ origin đã cấu hình**, và chuyển việc phát hành code sang chỗ `auth` kiểm soát được response.

#### 5.1.0 Bốn bước bắt buộc trước khi có thể phát hành code

Đây là bốn điều kiện mà **mọi** nhánh hoàn tất đều phải thoả — kể cả nhánh đã có grant. Trước đây chỉ nhánh consent có một số trong số đó, và đó là chỗ hai nhánh lệch nhau.

| #   | Điều kiện                                       | Kiểm ở đâu                            | Nếu thiếu                                                                             |
| --- | ----------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Client hợp lệ, `redirect_uri` exact, `S256`     | `/authorize` (bước 2)                 | Từ chối ở `/authorize`; không tạo transaction                                         |
| 2   | Transaction đã **`browser_confirmed`**          | Bước 8 của mọi diagram §5.1.3         | `POST /internal/session/verified` bị từ chối; không bind danh tính                    |
| 3   | Session account còn sống và thuộc đúng `sub`    | Bước 6 (X) và lại ở bước 14 (Z), §5.5 | Từ chối; không cấp code                                                               |
| 4   | Grant còn hiệu lực và đáp ứng đủ client + scope | Bước 11 (push) **và** lại ở bước 16   | Bước 11 → `consent_required`; bước 16 → `access_denied`. **Không** nhánh nào cấp code |

⚠️ **Điều kiện 2 là điều kiện mới, và nó là thứ chặn handle-theft.** `auth` **không** đọc cookie `account` (invariant 2, §8), nên nó không tự biết "trình duyệt này có phải trình duyệt đã bắt đầu request này không". Bước `/authorize/confirm` ở §5.1.1 giải quyết đúng chỗ đó bằng cookie riêng của origin `auth`. **Thiếu nó thì bước push vẫn "chạy được" nhưng là chạy được với một handle bị đánh cắp** — và đó chính là lỗ hổng mà bản trước của thiết kế này để lọt.

#### 5.1.1 Contract `POST /internal/session/verified`

Consumer `account`, provider `auth`, hướng `account → auth` (bảng contract ở §5.1.7). Request body: `{ handle, sub, acr, authn_at, account_session_ref, event_id }` — không mang `client_id`, `redirect_uri`, `scope`, `state`, `nonce`, PKCE challenge. Trường `acr` là ACR URN (`urn:ecoma:acr:*`, mô hình trong [`../account/01-architecture.md`](../account/01-architecture.md) §10); contract cấm theo cấu trúc sáu trường protocol (`FORBIDDEN_SESSION_VERIFIED_FIELDS`, `libs/auth-contracts/src/session-verified.ts`).

⚠️ **Điều kiện tiên quyết bắt buộc: transaction phải `browser_confirmed`.** Request mang handle chưa qua bước `/authorize/confirm` bị từ chối (`invalid_request` + audit) **trước khi** bất kỳ trường nào khác được đọc — kể cả trước khi tra idempotency record. Đây là chốt chặn duy nhất chống việc attacker chiếm X và đẩy kết quả xác thực bằng session của chính hắn.

**Thứ tự kiểm — bốn bước, và mỗi bước trả về ngay khi không khớp:**

| #   | Kiểm tra                           | Không khớp → kết quả                                                  |
| --- | ---------------------------------- | --------------------------------------------------------------------- |
| 1   | Transaction đã `browser_confirmed` | `invalid_request` + audit                                             |
| 2   | Idempotency record cho `event_id`  | Có + payload khớp → trả lại outcome đã lưu; cần bước 3                |
| 3   | Payload hash của record có khớp    | Khớp → trả lại outcome đã lưu (**không** đánh giá lại)                |
| 4   | State của transaction              | `completed` → `already_processed`; handle hết TTL → `invalid_request` |

⚠️ **Bước 2 và bước 3 phải là một lần tra cứu, không phải hai.** Nếu bước 3 trả "không khớp" thì đó là `event_id` bị **tái sử dụng với payload khác** — `invalid_request` + audit, và transaction giữ nguyên trạng thái. Đây là phân biệt giữa retry hợp lệ và việc gửi lại một `event_id` cũ kèm nội dung khác; nếu hai bước này tách rời thì request hợp lệ phải chờ một lần ghi, còn request độc hại thì không.

⚠️ **Response `200` có body `application/json`.** Không dùng `204` cho contract này ở bất kỳ outcome nào — kể cả outcome không có continuation.

| Outcome                                                 | HTTP | Body                             | `account` điều hướng browser tới                                                          |
| ------------------------------------------------------- | ---- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| `consent_required`                                      | 200  | `{ outcome, continue_url }`      | `continue_url` → consent UI của `account`                                                 |
| `granted`                                               | 200  | `{ outcome, continue_url }`      | `continue_url` → `GET /authorize/complete` của `auth`                                     |
| `already_processed` (retry của một transaction đã xong) | 200  | `{ outcome, transaction_state }` | Không có continuation để cấp; `account` coi như đã xử lý — **không** sinh transaction mới |

⚠️ **Không có handle nào đi trong response nữa.** Bản trước trả `consent_handle`/`completion_handle` để caller tự ghép URL. Bây giờ `continue_url` là **URL tuyệt đối do `auth` dựng**, còn handle nằm bên trong nó — `account` không ghép chuỗi, không biết tên tham số, và không có đường nào để nó trỏ URL đó chỗ khác. Đây là điều kiện chống open redirect, đồng thời làm `granted` và `consent_required` khác nhau **duy nhất ở nơi browser tiếp tục**, không khác nhau ở cách hoàn tất.

⚠️ **`continue_url` không mang credential nào.** Nó chứa handle opaque, không chứa `sub`, token, assertion hay `account_session_ref`.

**Hai loại `continue_url`, hai chủ sở hữu khác nhau:**

| Outcome            | `continue_url` trỏ tới                              | Ai sở hữu endpoint tiếp tục | `account` phải làm gì |
| ------------------ | --------------------------------------------------- | --------------------------- | --------------------- |
| `consent_required` | `https://account.ecoma.io/consent?handle=Y`         | `account`                   | Chỉ `302` browser     |
| `granted`          | `https://auth.ecoma.io/authorize/complete?handle=Z` | `auth`                      | Chỉ `302` browser     |

⚠️ **Vì sao `granted` không redirect thẳng tới client.** Response back-channel đi tới `account`, không đi tới browser — `account` sẽ phải render `redirect_uri?code=…` mà nó không được phép dựng. Thay vào đó `auth` cấp Z, và **chính `auth`** hoàn tất authorization khi browser quay lại nó (§5.1.4). `redirect_uri` chỉ được dùng ở nơi `auth` kiểm soát response.

#### 5.1.2 State machine của authorization transaction

Mọi chuyển trạng thái xảy ra bên trong một transaction `db-auth`. Cột "retry / đã dùng" là bắt buộc, không phải ghi chú.

| #   | Trạng thái trước        | Request / sự kiện                                  | Điều kiện kiểm tra                                                                                                   | Trạng thái sau                  | Response / navigation của browser                                                  | Khi retry hoặc đã ở trạng thái sau                                                                                                                                                                                                                                                                       |
| --- | ----------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pending_browser`       | `/authorize`                                       | client hợp lệ, exact `redirect_uri`, `S256`                                                                          | `pending_browser` + X + B       | `302 /login?handle=X` + `Set-Cookie __Host-auth-browser`                           | `/authorize` lại → transaction mới; transaction cũ không tái dùng                                                                                                                                                                                                                                        |
| 2   | `pending_browser`       | `GET /authorize/confirm?handle=X`                  | cookie `__Host-auth-browser` khớp hash trên transaction                                                              | `browser_confirmed`             | `302 /login/continue?handle=X`                                                     | Cùng browser (cookie + binding khớp) khi transaction đã `browser_confirmed` và còn TTL → replay idempotent: cùng `302 /login/continue?handle=X`, **không** CAS lại và **không** sinh event mới; cookie không khớp / hết TTL / trạng thái khác → `invalid_request`, không chuyển sang `browser_confirmed` |
| 3   | `browser_confirmed`     | `POST /internal/session/verified`                  | `event_id` chưa ghi; payload khớp X; `sub` khớp transaction                                                          | `awaiting_consent` + Y          | `200 {consent_required}` → `302 /consent?handle=Y`                                 | Cùng `event_id` → trả lại Y; payload khác → `invalid_request` + audit                                                                                                                                                                                                                                    |
| 4   | `browser_confirmed`     | `POST /internal/session/verified`                  | grant hiện tại đáp ứng **đủ** client + scope                                                                         | `ready_to_complete` + Z         | `200 {granted}` → `302 /authorize/complete?handle=Z`                               | Cùng `event_id` → trả lại Z; transaction đã `completed` → `already_processed`                                                                                                                                                                                                                            |
| 5   | `awaiting_consent`      | `POST /internal/session/verified` (retry)          | `event_id` đã ghi với payload hash khớp                                                                              | `awaiting_consent` (không đổi)  | `200 {outcome:consent_required, continue_url}` — **cùng Y**                        | **Không** sinh Y thứ hai; transaction không chuyển trạng thái                                                                                                                                                                                                                                            |
| 6   | `awaiting_consent`      | `POST /internal/consent/context`                   | `account_session_ref` khớp `sub` của transaction                                                                     | `awaiting_consent`              | `200 {client_name, scope[], risk_level}`                                           | Lặp lại vẫn trả cùng context; transaction không đổi                                                                                                                                                                                                                                                      |
| 7   | `awaiting_consent`      | `POST /internal/consent/decide` `approve`          | `account_session_ref` khớp; CAS consume Y                                                                            | `ready_to_complete` + grant + Z | `200 {outcome:approved, continue_url}`                                             | Y đã consume → `invalid_grant`; **không** code thứ hai                                                                                                                                                                                                                                                   |
| 8   | `awaiting_consent`      | `POST /internal/consent/decide` `deny`             | `account_session_ref` khớp; CAS consume Y                                                                            | `denied` + Z                    | `200 {outcome:denied, continue_url}`                                               | Y đã consume → `invalid_grant`; **không** grant, **không** code                                                                                                                                                                                                                                          |
| 9   | `ready_to_complete`     | `GET /authorize/complete?handle=Z`                 | Cookie B khớp; grant **còn** hiệu lực; CAS consume Z; đọc `redirect_uri`/`state`/`code_challenge` **từ transaction** | `completed` + code              | `302 redirect_uri?code=…&state=<echo nguyên văn>`                                  | Z đã consume → `invalid_grant`, **không** phát hành code lần hai                                                                                                                                                                                                                                         |
| 10  | `denied`                | `GET /authorize/complete?handle=Z`                 | Cookie B khớp; CAS consume Z; không có grant                                                                         | `denied` (không đổi)            | `302 redirect_uri?error=access_denied&state=…`                                     | Z đã consume → `invalid_grant`; không redirect lần nữa                                                                                                                                                                                                                                                   |
| 11  | `ready_to_complete`     | `GET /authorize/complete?handle=Z` (retry)         | Z đã consume, transaction `completed`                                                                                | `completed` (không đổi)         | `invalid_grant`; `account` đưa browser về `/authorize` **mới**                     | Không bao giờ cấp code lần hai cho cùng transaction                                                                                                                                                                                                                                                      |
| 12  | bất kỳ                  | bất kỳ request với handle hết TTL                  | `expires_at <= now()`                                                                                                | giữ nguyên, đánh dấu hết hạn    | `invalid_request` → `account` đưa browser về `/authorize` mới                      | Không có đường gia hạn; transaction cũ không tái sử dụng được                                                                                                                                                                                                                                            |
| 13  | `completed` \| `denied` | `POST /internal/session/verified` (`event_id` mới) | Transaction đã kết thúc; **không** còn continuation để cấp                                                           | không đổi                       | `200 {outcome:already_processed, transaction_state}` — **không** có `continue_url` | `account` coi như đã xử lý và **không** sinh transaction mới; đây là hàng duy nhất sinh ra `already_processed`                                                                                                                                                                                           |
| 14  | `ready_to_complete`     | `GET /authorize/complete?handle=Z`                 | Cookie B khớp; Z chưa consume; **nhưng** grant đã mất hiệu lực                                                       | `denied`                        | `302 redirect_uri?error=access_denied&state=…`                                     | Z đã consume → `invalid_grant`; không redirect lần nữa; phải `/authorize` mới để thử lại                                                                                                                                                                                                                 |

⚠️ **Hàng 9 là hàng quan trọng nhất của bảng, và nó là hệ quả của CAS chứ không phải một kiểm tra riêng.** Khi `/authorize/complete` CAS-consume Z và phát hành code **trong cùng một transaction `db-auth`**, thì "Z đã dùng" và "code đã phát hành" là **một sự kiện duy nhất**. Không có khoảnh khắc nào mà Z đã consume nhưng code chưa phát hành, và không có đường nào phát hành code mà không consume Z. Vì vậy retry trả `invalid_grant` là **an toàn theo bản chất**, không phải vì một check dễ quên.

⚠️ **Nhánh `deny` đi qua cùng endpoint, không phải qua một đường riêng.** Hàng 10 cho thấy: người dùng từ chối vẫn nhận một Z, vẫn tới `GET /authorize/complete`, và ở đó mới nhận OAuth error với `state` nguyên vẹn tới đúng `redirect_uri`. Nhánh này **không** cấp code, và nó **không** cần `account` dựng bất kỳ URL nào. Nếu nó quay về kiểu cũ — `POST /internal/consent/decide` trả `redirect_url` để `account` redirect — thì `account` lại phải render một OAuth response mà nó không sở hữu, và hai nhánh lại lệch nhau.

⚠️ **Cột "Response / navigation" được đặc tả để không có nhánh nào bị cụt.** Mỗi trạng thái đều có **một** navigation target hợp lệ hoặc **một** lỗi xác định; không tồn tại trạng thái mà browser đứng yên không có đường tiếp tục.

#### 5.1.3 Sequence diagram — bốn nhánh

⚠️ **Cả bốn nhánh dùng chung số bước 1–17.** Bước 1–10 giống nhau; bước 11 trở đi phân kỳ theo kết quả mà `auth` đánh giá. Số bước này là **từ vựng chuẩn** mà §5.2–§5.5 và các invariant trích dẫn. Dòng **không** đánh số là phần tiếp của bước ngay trên nó.

⚠️ **Bước 7–8 là bước mới, và nó là điều kiện tiên quyết của bước 9.** Không có nó thì toàn bộ phần còn lại vẫn "chạy" nhưng không chống được handle theft — xem §5.1.0 điều kiện 2.

**A. Chưa có grant phù hợp — consent được chấp thuận**

```text
         Client        Browser       account        auth
           │GET /authorize?…                         │
1          │─────────────────────────────────────────▶
2          │             │             │             │kiểm client · exact redirect_uri · S256
3          │             │             │             │tạo transaction T · mint X · Set-Cookie __Host-auth-browser=B
                                                     │(hash của B gắn vào transaction T)
4                        │                           │302 account.ecoma.io/login?handle=X
4                        ◀───────────────────────────│
5                        │GET /login?handle=X
5                        │─────────────▶
6          │             │             │atomic bind X ↔ session (first-binding-wins)
6          │             │             │xác thực · rotate session · CAS handoff · sinh ASR · event E
7                        │             │302 auth.ecoma.io/authorize/confirm?handle=X
7                        ◀─────────────│
                         │GET /authorize/confirm?handle=X
                         │───────────────────────────▶
                         │Cookie: __Host-auth-browser=B
8          │             │             │             │đối chiếu B với transaction T → browser_confirmed
                         │                           │302 account.ecoma.io/login/continue?handle=X
                         ◀───────────────────────────│
                         │GET /login/continue?handle=X
                         │─────────────▶
                                       │POST /internal/session/verified  (event E)
9                                      │─────────────▶
10         │             │             │             │chặn nếu transaction chưa browser_confirmed
10         │             │             │             │idempotency(event E) · CAS consume X · bind sub+ASR
11         │             │             │             │grant chưa đủ → mint Y · 200 {outcome:consent_required}
11                                     ◀─────────────│
12                       │             │302 /consent?handle=Y
12                       ◀─────────────│
                         │GET /consent?handle=Y
                         │─────────────▶
                                       │kiểm session thuộc đúng sub · POST /internal/consent/context
                                       │─────────────▶
13         │             │             │             │đối chiếu Y + ASR với transaction → 200 {client_name, scope[], risk}
                         │             │200 render consent
                         ◀─────────────│
                         │POST /consent  (approve)
                         │─────────────▶
                                       │kiểm session lại · POST /internal/consent/decide
                                       │─────────────▶
14         │             │             │             │CAS consume Y · ghi decision=approve
                                                     │approve → ghi oauth_grants · deny → không grant
14         │             │             │             │mint Z
                                       │             │200 {outcome:approved, continue_url}
                                       ◀─────────────│
15                       │             │302 /authorize/complete?handle=Z
15                       ◀─────────────│
                         │GET /authorize/complete?handle=Z
                         │───────────────────────────▶
                         │Cookie: __Host-auth-browser=B
16         │             │             │             │đối chiếu B + sub/ASR của transaction
16         │             │             │             │CAS consume Z + cấp code — CÙNG một transaction
                         │                           │302 redirect_uri?code=…&state=…
17                       ◀───────────────────────────│
           ◀─────────────│
```

**B. Đã có grant phù hợp — không mở consent screen**

```text
         Client        Browser       account        auth
           │GET /authorize?…                         │
1          │─────────────────────────────────────────▶
2          │             │             │             │kiểm client · exact redirect_uri · S256
3          │             │             │             │tạo transaction T · mint X · Set-Cookie __Host-auth-browser=B
                                                     │(hash của B gắn vào transaction T)
4                        │                           │302 account.ecoma.io/login?handle=X
4                        ◀───────────────────────────│
5                        │GET /login?handle=X
5                        │─────────────▶
6          │             │             │atomic bind X ↔ session (first-binding-wins)
6          │             │             │xác thực · rotate session · CAS handoff · sinh ASR · event E
7                        │             │302 auth.ecoma.io/authorize/confirm?handle=X
7                        ◀─────────────│
                         │GET /authorize/confirm?handle=X
                         │───────────────────────────▶
                         │Cookie: __Host-auth-browser=B
8          │             │             │             │đối chiếu B với transaction T → browser_confirmed
                         │                           │302 account.ecoma.io/login/continue?handle=X
                         ◀───────────────────────────│
                         │GET /login/continue?handle=X
                         │─────────────▶
                                       │POST /internal/session/verified  (event E)
9                                      │─────────────▶
10         │             │             │             │chặn nếu transaction chưa browser_confirmed
10         │             │             │             │idempotency(event E) · CAS consume X · bind sub+ASR
11                                     │             │grant đủ → mint Z · 200 {outcome:granted, continue_url}
11                                     ◀─────────────│
15                       │             │302 /authorize/complete?handle=Z
15                       ◀─────────────│
                         │GET /authorize/complete?handle=Z
                         │───────────────────────────▶
                         │Cookie: __Host-auth-browser=B
16         │             │             │             │đối chiếu B + sub/ASR của transaction
16         │             │             │             │CAS consume Z + cấp code — CÙNG một transaction
                         │                           │302 redirect_uri?code=…&state=…
17                       ◀───────────────────────────│
           ◀─────────────│
```

**C. Người dùng từ chối consent**

```text
         Client        Browser       account        auth
           │GET /authorize?…                         │
1          │─────────────────────────────────────────▶
2          │             │             │             │kiểm client · exact redirect_uri · S256
3          │             │             │             │tạo transaction T · mint X · Set-Cookie __Host-auth-browser=B
                                                     │(hash của B gắn vào transaction T)
4                        │                           │302 account.ecoma.io/login?handle=X
4                        ◀───────────────────────────│
5                        │GET /login?handle=X
5                        │─────────────▶
6          │             │             │atomic bind X ↔ session (first-binding-wins)
6          │             │             │xác thực · rotate session · CAS handoff · sinh ASR · event E
7                        │             │302 auth.ecoma.io/authorize/confirm?handle=X
7                        ◀─────────────│
                         │GET /authorize/confirm?handle=X
                         │───────────────────────────▶
                         │Cookie: __Host-auth-browser=B
8          │             │             │             │đối chiếu B với transaction T → browser_confirmed
                         │                           │302 account.ecoma.io/login/continue?handle=X
                         ◀───────────────────────────│
                         │GET /login/continue?handle=X
                         │─────────────▶
                                       │POST /internal/session/verified  (event E)
9                                      │─────────────▶
10         │             │             │             │chặn nếu transaction chưa browser_confirmed
10         │             │             │             │idempotency(event E) · CAS consume X · bind sub+ASR
11         │             │             │             │grant chưa đủ → mint Y · 200 {outcome:consent_required}
11                                     ◀─────────────│
12                       │             │302 /consent?handle=Y
12                       ◀─────────────│
                         │GET /consent?handle=Y
                         │─────────────▶
                                       │kiểm session thuộc đúng sub · POST /internal/consent/context
                                       │─────────────▶
13         │             │             │             │đối chiếu Y + ASR với transaction → 200 {client_name, scope[], risk}
                         │             │200 render consent
                         ◀─────────────│
                         │POST /consent  (deny)
                         │─────────────▶
                                       │kiểm session lại · POST /internal/consent/decide
                                       │─────────────▶
14         │             │             │             │CAS consume Y · ghi decision=deny
                                                     │approve → ghi oauth_grants · deny → không grant
14         │             │             │             │mint Z (không grant)
                                       │             │200 {outcome:denied, continue_url}
                                       ◀─────────────│
15                       │             │302 /authorize/complete?handle=Z
15                       ◀─────────────│
                         │GET /authorize/complete?handle=Z
                         │───────────────────────────▶
                         │Cookie: __Host-auth-browser=B
16         │             │             │             │đối chiếu B + sub/ASR của transaction
16         │             │             │             │CAS consume Z — tx denied, KHÔNG cấp code
                         │                           │302 redirect_uri?error=access_denied&state=…
17                       ◀───────────────────────────│
           ◀─────────────│
```

**D. Response của bước push bị mất — retry cùng `event_id`**

```text
         Client        Browser       account        auth
                                       │POST /internal/session/verified  (event E)
9                                      │─────────────▶
10         │             │             │             │commit: CAS consume X · ghi event E + handle_hash(Z)
11                                     │             │200 {outcome:granted, continue_url}
11                                     ◀─────────────│
12                                     │✖ response bị mất — `account` không biết kết quả
                                       │retry CÙNG event E — KHÔNG mở transaction mới
                                       │─────────────▶
13                                                   │event E đã ghi · payload hash khớp → không đánh giá lại
13         │             │             │             │Z tính lại từ transaction T bằng HMAC → CÙNG Z
                                       │             │200 {outcome:granted, continue_url}
14                                     ◀─────────────│
```

⚠️ **Cột `account` ở bước 6 là nơi duy nhất session của browser được ràng buộc với X.** Không có `account_session_ref` nào đi vào payload bước 9 mà không đi qua bước 6 trước — và bước 9 còn bị chặn bởi `browser_confirmed` nữa. Đó là hai lớp ràng buộc độc lập: một lớp ở phía `account` (session nào được bind với X), một lớp ở phía `auth` (trình duyệt nào bắt đầu transaction).

⚠️ **Cookie `__Host-auth-browser` không phải credential của user.** Nó chứng minh "trình duyệt này là trình duyệt đã nhận `302` từ `/authorize`", **không** chứng minh user đã đăng nhập. Bằng chứng đăng nhập vẫn là session `account` ở bước 6 và bước 16. Vì vậy mất cookie này không phải sự cố xác thực, và có nó cũng không cho attacker đăng nhập hộ ai.

⚠️ **Cookie B phải có `Max-Age`/`Expires` bằng TTL transaction, và phải bị xoá khi transaction kết thúc.** Nếu để nó sống như session cookie thì một cookie mồ côi sẽ tồn tại lâu hơn mọi transaction nó từng liên kết — và mọi `/authorize` sau đó đều phải ghi đè nó. Việc xoá sau khi `completed`/`denied` là để browser không giữ một giá trị không còn dùng; giữ lại cũng không tạo lỗ hổng (không transaction nào còn tham chiếu tới hash của nó), nhưng để lại là trạng thái không ai dọn.

#### 5.1.4 Endpoint hoàn tất — `GET /authorize/complete`

Consumer `Browser`, provider `auth`. Đây là endpoint **public** của `auth`, không phải back-channel, và **không** lấy cookie `account` làm xác thực.

⚠️ **Nhưng nó _có_ kiểm một thứ: cookie `__Host-auth-browser`.** Không phải để xác thực user, mà để chắc rằng browser đang hoàn tất chính transaction này chứ không phải transaction khác mà kẻ tấn công đã đọc được URL. Đây là lý do §5.1.4 không thể bỏ kiểm tra này chỉ vì Z "đã gắn với transaction".

| Thuộc tính                  | Bắt buộc                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Input                       | `handle=Z` duy nhất. **Không** nhận `client_id`, `redirect_uri`, `scope`, `state`, `nonce`, `code_challenge` từ query string     |
| Ràng buộc transaction       | Z bind server-side với `sub` + client + `redirect_uri` + scope + `state` + `code_challenge` của **transaction gốc**              |
| Ràng buộc browser           | Cookie `__Host-auth-browser` phải khớp hash trên transaction; lệch → `invalid_request`, transaction giữ nguyên                   |
| Điều kiện chuyển trạng thái | CAS consume Z **và** phát hành code (hoặc ghi `denied` nếu grant đã mất hiệu lực — hàng 14) **trong cùng transaction `db-auth`** |
| Đồng thời                   | Đúng một request nhận được row; phần còn lại `invalid_grant`. Không có read-then-write (§3.3)                                    |
| Đã dùng                     | `invalid_grant`, **không** phát hành code lần hai (hàng 11)                                                                      |
| Hết hạn                     | `invalid_request` → `account` đưa browser về `/authorize` mới                                                                    |
| Storage                     | Chỉ lưu **hash** của Z; `db-auth` **không** lưu plaintext authorization code (FR-006a)                                           |
| Audit                       | Ghi completion, `sub`, client, kết quả — **không** ghi Z, B, code, `code_verifier` hay nội dung query                            |

⚠️ **`/authorize/complete` không nhận tham số authorization từ browser, và điều này là cấu trúc chứ không phải kiểm tra.** Nó không có nhánh nào đọc `redirect_uri` từ query string, nên không có đường nào để trình duyệt trỏ authorization response về một client khác (invariant 28, [`01` invariant 28](../../architecture/01-architecture.md)).

⚠️ **Z là một capability, và tài liệu này không gọi nó là gì khác.** Bản trước nói "biết Z không đủ để lấy code" — câu đó **sai**: biết Z cộng với cookie B là đủ, và cookie B chỉ do chính browser của transaction đó nhận được. Vì vậy phát biểu đúng là: **Z + cookie B là capability đủ để hoàn tất**, và nó chỉ mạnh trong đúng một browser trong đúng một transaction. Đây là câu trả lời cho mâu thuẫn mà bản trước để lọt.

⚠️ **Cookie B bị mất thì sao — không phải hướng tấn công, mà là giới hạn đã biết.** Không có cookie B thì `/authorize/complete` từ chối và browser phải bắt đầu `/authorize` mới. Đây là hành vi **fail closed** có chủ đích: nó đổi lấy việc một URL bị lóe trong log hoặc `Referer` không trở thành credential. Đánh đổi phải ghi thẳng, không gọi là vô hại — xem §5.1.6 dòng cookie mất.

⚠️ **Retry `/authorize/complete` không bao giờ phát hành code lần hai, kể cả khi browser refresh.** Đây là hệ quả trực tiếp của CAS trên Z trong cùng transaction với việc cấp code.

#### 5.1.5 Idempotency — ba contract có side effect, ba bảng riêng

⚠️ **Mỗi contract có side effect có bảng idempotency riêng, vì chúng khác nhau về thứ gì định danh một lần xác nhận.** Gộp chúng thành một quy tắc chung là cách tạo ra lời hứa mà cơ chế lưu trữ không thực hiện được.

**Phạm vi duy nhất của `event_id`:** nó định danh **một lần xác thực** (`account` → `auth`), tức một cặp `(X, session đã xác thực)`. Nó **không** định danh transaction, **không** định danh consent decision, và **không** dùng lại ở bất kỳ contract nào khác.

**(a) `POST /internal/session/verified` — định danh bằng `event_id`:**

| Tình huống                                                | Hành vi bắt buộc                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `event_id` mới, X hợp lệ, transaction `browser_confirmed` | Xử lý bình thường → `consent_required` hoặc `granted`; **ghi** `event_id` + `outcome` + `handle_hash(Y)` hoặc `handle_hash(Z)` |
| **Cùng** `event_id`, **cùng** payload                     | Idempotent: trả **đúng** outcome đã lưu, cùng continuation; **không** ghi lần hai, **không** sinh Y/Z thứ hai                  |
| **Cùng** `event_id`, payload **khác**                     | `invalid_request` + audit. **Không** ghi đè kết quả đã quyết định; transaction giữ nguyên trạng thái                           |
| `event_id` mới nhưng X đã consume                         | `invalid_grant` + audit — đây là handle theft hoặc double-submit, không phải retry                                             |
| `event_id` mới, X còn TTL, transaction đã `completed`     | `already_processed` — transaction đã xong, không có continuation để cấp                                                        |
| X chưa `browser_confirmed`                                | `invalid_request` + audit — xử lý **trước** khi đọc trường khác (§5.1.0 điều kiện 2)                                           |

**(b) `POST /internal/consent/decide` — định danh bằng handle Y:**

| Tình huống                                         | Hành vi bắt buộc                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Y hợp lệ, session khớp, Y chưa consume             | Quyết định được ghi; mint Z; trả `approved` hoặc `denied`                                                                            |
| **Cùng** Y, **cùng** `decision`, sau khi đã commit | Trả lại **cùng** outcome và **cùng** continuation — retry không tạo Z thứ hai                                                        |
| **Cùng** Y, `decision` **khác**                    | `invalid_request` + audit. ⚠️ Không thể approve sau khi đã deny, hoặc ngược lại, chỉ bằng cách replay                                |
| Y đã consume, `decision` khác                      | `invalid_grant` — đã có quyết định rồi, không đổi được                                                                               |
| Response bị mất sau khi đã commit                  | Nhờ dòng 2, `account` retry cùng Y + cùng decision → nhận lại đúng outcome. **Không** có nhánh nào để browser bị mắc vì Y đã consume |

**(c) `GET /authorize/complete` — định danh bằng handle Z:**

| Tình huống                              | Hành vi bắt buộc                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Z hợp lệ, cookie B khớp, Z chưa consume | CAS consume Z + phát hành code (hoặc ghi `denied` nếu grant đã mất hiệu lực — hàng 14) **trong cùng transaction** |
| Z đã consume, transaction `completed`   | `invalid_grant`, **không** code thứ hai (hàng 11)                                                                 |
| Hai request Z đồng thời                 | Đúng một nhận row; request còn lại `invalid_grant`                                                                |
| Cookie B không khớp                     | `invalid_request`; Z **không** bị consume, transaction giữ nguyên — người dùng thử lại được                       |

⚠️ **Retry sau khi hoàn tất _không_ trả lại cùng code, và đây là một lựa chọn có chủ đích.** Bản trước ngụ ý rằng retry "khôi phục cùng kết quả" mà không nói rõ bằng cách nào — mà khôi phục cùng code đòi hoặc lưu plaintext code (cấm, FR-006a), hoặc dẫn xuất code từ khóa. Cả hai đều bị loại. Thay vào đó: **Z single-use, code single-use, và retry nhận `invalid_grant` xác định.** Cái mà retry muốn khôi phục — browser tiếp tục được — đạt được bằng cách bắt đầu `/authorize` mới, và việc đó là **luôn khả dụng**, không phụ thuộc transaction cũ còn sống hay không. Đây là câu trả lời trực tiếp cho yêu cầu "không để spec nói retry an toàn trong khi retry luôn dẫn tới trạng thái không thể tiếp tục": retry không dẫn tới trạng thái không thể tiếp tục, vì `/authorize` mới không cần bất kỳ trạng thái nào của transaction cũ.

⚠️ **Cơ chế lưu phải thực hiện được lời hứa trên, nếu không thì đừng hứa.** `db-auth` lưu `event_id`, **hash của payload**, `outcome`, và **hash của handle** — tất cả ghi trong **cùng transaction `db-auth`** sinh ra handle đó. Cơ chế là **derivation có HMAC**, không phải lưu trữ plaintext (chi tiết ở §5.6).

#### 5.1.6 Nhánh lỗi — không có nhánh nào bị cụt

| Tình huống                                    | Có retry được không                  | Hành vi                                                                                                                                       |
| --------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `account` down giữa luồng                     | Không — user thử lại từ `/authorize` | Fail closed, không cấp code; user không thấy "đã đăng nhập" giả                                                                               |
| `auth` down ở bước push (response bị mất)     | **Có** — cùng `event_id`             | `account` không khởi động transaction thứ hai; retry trả lại cùng outcome (§5.1.5a)                                                           |
| Back-channel lỗi ở bước push/decide           | Không                                | Fail closed — không có code; không có degraded path dùng cache                                                                                |
| Transaction / handle hết TTL                  | Không — **không** gia hạn            | `invalid_request` → bắt đầu lại từ `/authorize` (bảng 5.1.2 hàng 12)                                                                          |
| `account_session_ref` không khớp `sub`        | Không                                | Từ chối; transaction giữ nguyên, không tiêu thụ Y                                                                                             |
| `event_id`/payload không nhất quán            | Không                                | Từ chối + audit (§5.1.5a)                                                                                                                     |
| Cookie `__Host-auth-browser` mất              | Có, bằng cách bắt đầu lại            | `/authorize` mới mint cookie mới. **Đánh đổi có chủ đích**: URL bị lộ trong log/`Referer` không thành credential                              |
| Lỗi nội bộ giữa chừng                         | Có, nếu transaction rollback         | Không có gì được ghi, handle không bị consume                                                                                                 |
| Grant không còn hợp lệ ngay trước completion  | **Không** — phải `/authorize` mới    | `/authorize/complete` kiểm grant lại ngay trước khi cấp code (hàng 9 vs **hàng 14**); hết hiệu lực → `error=access_denied` tới `redirect_uri` |
| Handler trả lỗi **không** tạo transaction mới | Không cần retry                      | `invalid_request`/`invalid_grant` là **kết quả** của transaction đó, không phải của transaction khác                                          |

⚠️ **Retry sau khi `auth` đã quyết định là hành vi được thiết kế, không phải sự cố.** Nếu `account` không nhận được response, nó **không** được tự tạo transaction mới và **không** được đoán — nó gửi lại **cùng** `event_id` (§5.1.5a). Đây là câu trả lời cho trường hợp mà trước đây tài liệu không nói: caller mất response thì khôi phục được **chính** continuation đó.

⚠️ **Không có nhánh nào đưa browser tới một trạng thái không có đường tiếp tục.** Mỗi dòng trên hoặc cho một `continue_url`, hoặc cho một `invalid_request`/`invalid_grant` xác định mà `account` chuyển thành trang lỗi có nút quay lại `/authorize`. ⚠️ `access_denied` **không** nằm trong danh sách này: nó là OAuth error redirect do chính `auth` dựng từ `/authorize/complete`, và `account` không thấy nó — invariant 12.

**(a) `account` đẩy (push), không phải `auth` kéo (pull).** Đây là hệ quả tất yếu, không phải lựa chọn thoải mái: sau bước 6, **chỉ `account` mới giữ session đã xác thực**. Nếu `auth` gọi ngược back-channel, lệnh gọi đó mang credential của chính Worker chứ không mang cookie trình duyệt — `auth` sẽ **không** phân biệt được trình duyệt của nạn nhân với trình duyệt của kẻ tấn công đang giữ handle. Vì vậy hướng là `account → auth`, và **route `POST /internal/session/verified` thuộc `auth`** — nó nhận kết quả xác thực đã được kiểm chứng, không phải trả lời câu hỏi.

**(b) Handle được ràng buộc với trình duyệt ngay ở bước gắn handle, và với transaction ngay ở bước confirm.** Bản thân `handle` không chứng minh điều gì — nó là **định danh một authorization request**. Ràng buộc đến từ hai thao tác độc lập: `account` ghi nhận X với session trình duyệt ở bước 6 (xem §5.3), và cookie B ràng buộc transaction với trình duyệt đã nhận `302` từ `/authorize` ở bước 3 và được đối chiếu ở bước 8. Bỏ thứ nhất thì handle theft chạy được; bỏ thứ hai thì attacker vẫn dùng chính session của nạn nhân để hoàn tất.

**(c) Consent handle Y sinh ra ở nhánh consent với binding riêng, không tái dùng bằng chứng nào của bước push.** Bước push đó là **push qua Service Binding đã xác thực** — không có bearer token nào sinh ra để mang theo, nên ở đây cũng không có gì để tái dùng. `account_session_ref` ASR mà `account` gửi lên ở bước context và bước quyết định là **reference tới session đang hoạt động**, lấy từ `account` trong lúc nó kiểm cookie trình duyệt — nó không phải bằng chứng đã consume, và bản thân nó **không** cấp quyền gì nếu không có cặp `(Y, sub, …)` khớp trong `db-auth`.

⚠️ **Payload bước push mang `sub`, `acr`, `authn_at` và `account_session_ref`, nhưng KHÔNG mang `client_id`, `redirect_uri`, `scope`, `state`, `nonce` hay PKCE challenge.** Sự khác biệt này là có chủ đích: danh tính là thứ **duy nhất** `account` mới xác minh được từ session của nó, nên nó đi trong payload; còn nhóm kia là thứ `auth` đã lưu từ `/authorize` và **không** được phép để request push ghi đè. Bỏ nhóm thứ hai khỏi payload làm transaction substitution bất khả thi **về mặt cấu trúc** ([`01` invariant 28](../../architecture/01-architecture.md)).

⚠️ **`account_session_ref` KHÔNG phải bằng chứng tự xác thực.** Nó là identifier nội bộ, **không** phải cookie, **không** dùng được để đăng nhập, và chỉ có ý nghĩa khi nó được lấy từ session đang hoạt động ở `account` rồi truyền qua contract đã xác thực. `auth` **không** tự kiểm được nó — nó tin `account` qua một call đã xác thực, và chỉ dùng nó để đối chiếu với binding của transaction. Nếu `account` gửi một ASR mà nó không lấy từ session đang hoạt động thì đó là bug ở `account`, không phải điều kiện mà `auth` tự kiểm được.

⚠️ **`account` không được gửi `client_id`, `redirect_uri`, `scope`, `state`, `nonce` hay `code_verifier` ở bất kỳ bước nào.** Kể cả `POST /internal/consent/decide` cũng vậy — nó chỉ nhận `handle`, `decision` và `account_session_ref`. Không có bước nào trong đoạn này để caller đưa tham số authorization vào.

⚠️ **Bước relay cuối: `account` chỉ relay, không kiểm tra.** `account` nhận `continue_url` do `auth` dựng rồi 302 browser tới đó: không đọc `code`, không đổi `state`, không biết `redirect_uri` của client. Authorization code trong query param ở `redirect_uri` là **hành vi chuẩn của OAuth** — nó đi tới `redirect_uri` đã đăng ký, đúng chỗ nó phải tới; thứ bị cấm là **credential/assertion** trong URL, không phải code ([`01` invariant 27](../../architecture/01-architecture.md)).

#### 5.1.7 Bốn contract back-channel, bốn hướng

⚠️ **Cột "Hướng" đọc là `consumer → provider`.** Service gọi là **consumer**; service sở hữu route và xử lý là **provider**. Provider bao giờ cũng là đầu mũi tên bên phải — nếu một dòng ghi provider là service gọi thì dòng đó sai.

| Contract                          | Consumer  | Provider  | Hướng gọi                       | Route thuộc |
| --------------------------------- | --------- | --------- | ------------------------------- | ----------- |
| `POST /internal/session/verified` | `account` | `auth`    | `account → auth` (diễn A/B/C/D) | `auth`      |
| `POST /internal/consent/context`  | `account` | `auth`    | `account → auth` (diễn A/C)     | `auth`      |
| `POST /internal/consent/decide`   | `account` | `auth`    | `account → auth` (diễn A/C)     | `auth`      |
| `GET /internal/account/status`    | `auth`    | `account` | `auth → account` (§6.0)         | `account`   |

⚠️ **Ba contract đầu đều do `auth` phục vụ và `account` là bên gọi** — không mâu thuẫn gì: tên endpoint nằm trên **không gian tên của provider**, nên hai route `/internal/consent/*` thuộc `auth` dù `account` là bên gọi.

⚠️ **`GET /internal/consent/context` là `POST`, không phải `GET`.** Nó mang `{ handle: Y, account_session_ref }` — một payload có cấu trúc, không phải query string. Đây là service binding nội bộ, `GET` với body là thứ không nên giả định là hoạt động nhất quán giữa các runtime, và các trường tham chiếu session không nên nằm trong URL. Chi tiết → §5.7.

⚠️ **Các endpoint public của `auth` không nằm trong bảng này, và đó là chủ ý.** `/authorize`, `/authorize/confirm` và `/authorize/complete` có consumer là **browser**, không phải service nào. Bảng này liệt kê các contract **service-to-service**.

⚠️ **Contract thứ tư đi hướng ngược lại, và có lý do riêng.** Nó phục vụ _kiểm tra trạng thái account lúc phát hành_ — một câu hỏi mà chỉ `account` mới có câu trả lời. Nó **không** phải đường xác thực: nếu dùng nó để xác minh phiên thì chính nó sẽ sập vào cái bẫy mà §5.1(a) nêu. Chi tiết → §6.0.

#### 5.1.8 Envelope nội bộ — một giao thức canonical, chống replay bền vững

Cả bốn contract ở §5.1.7 dùng **một** envelope HMAC duy nhất, và giao thức đó có **một** bản cài đặt: `libs/internal-auth-contracts` (`internal-auth.ts`, `scope:platform` — protocol nền tảng dùng chung giữa các BC, không thuộc riêng `auth` hay `account`), tag `type:contracts` + `runtime:universal` nên import được từ cả `auth` (Workers) lẫn `account` (Nitro). `libs/account-contracts` và `libs/auth-contracts` **re-export** từ đó, không giữ bản thứ hai. Hai bên test với chính mình thì một bất tương thích không bao giờ đỏ — nên việc chỉ có một bản là điều kiện của tính đúng, không phải chuyện gọn gàng.

##### Định dạng trên đường truyền

| Header                       | Nội dung                                                          |
| ---------------------------- | ----------------------------------------------------------------- |
| `x-ecoma-internal-timestamp` | Epoch **giây** — chuỗi thập phân, số nguyên, không phần thập phân |
| `x-ecoma-internal-nonce`     | Token ≥128 bit entropy; `createNonce()` sinh UUID v4              |
| `x-ecoma-internal-signature` | `v1=<64 hex chữ thường>` — HMAC-SHA-256                           |
| `x-ecoma-internal-kid`       | **Tuỳ chọn** — `kid` của khoá đã ký: 8–16 hex chữ thường          |

Chuỗi được ký là một dạng canonical có **length prefix theo byte UTF-8**, phân tách bằng `\n`. Sáu dòng, theo đúng thứ tự này:

```
<method chữ thường>
ecoma-internal-v2
<byteLength(path)>:<path>
<byteLength(timestamp)>:<timestamp>
<byteLength(nonce)>:<nonce>
<bodyHash 64 hex>
```

`ecoma-internal-v2` (hằng `PROTOCOL_ID`) là dòng **thứ hai**, không phải dòng đầu; dòng cuối là SHA-256 của **đúng byte thân request**. Ba tính chất bắt buộc, và cả ba đều là lý do tồn tại của dạng này:

- **Đơn ánh (injective).** Không có length prefix thì `path="ab", nonce="c"` và `path="a", nonce="bc"` cho ra cùng một chuỗi byte — kẻ tấn công ghép lại được một thông điệp đã ký. Prefix làm phép mã hoá đơn ánh trên mọi đầu vào.
- **Tách miền theo giao thức.** Hằng `ecoma-internal-v2` nằm trong chuỗi ký, nên chữ ký của giao thức này không dùng lại được cho giao thức khác, kể cả khi trùng secret.
- **Đơn ánh trên chuỗi JS, không chỉ trên byte.** ⚠️ `TextEncoder` **thay** surrogate lẻ (unpaired surrogate) bằng U+FFFD, nên `/a\uD800` và `/a\uFFFD` encode ra **cùng** một mảng byte và sẽ cho cùng chữ ký — một va chạm ở tầng canonical, không phải ở tầng HMAC. Vì vậy `canonicalString` **từ chối** chuỗi chứa surrogate lẻ bằng `InvalidCanonicalFieldError` (lý do `invalid_field`) trước khi encode, thay vì hợp thức hoá va chạm đó bằng một comment. Length prefix được tính trên **chính** chuỗi byte sắp được ký, và `path` giữ nguyên văn dạng đã nhận.

##### Hai không gian tên phiên bản, không được trộn

Có **hai** chữ "v1" trong envelope này và chúng trả lời hai câu hỏi khác nhau:

| Tên trong code     | Ở đâu                                         | Trả lời câu hỏi                                 | Đổi khi nào                                                   |
| ------------------ | --------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| `PROTOCOL_ID`      | **trong** chuỗi được ký (`ecoma-internal-v2`) | "Envelope này dùng canonicalization nào?"       | Khi canonicalization đổi — tức giao thức đổi                  |
| `SIGNATURE_PREFIX` | header, `v1=<hex>`                            | "Chữ ký này được biểu diễn theo định dạng nào?" | Khi định dạng biểu diễn chữ ký đổi (ví dụ đổi sang base64url) |

⚠️ **`v1=` KHÔNG phải số phiên bản của giao thức.** Nó chỉ nói định dạng của giá trị trong header. PR hợp nhất này đổi canonicalization (thêm dòng `PROTOCOL_ID`, đổi length prefix từ UTF-16 sang byte UTF-8) mà **giữ nguyên** `v1=` — nên một envelope của bản cũ vẫn mang header `v1=…` và không có gì trong header cho biết nó không tương thích. Đọc `v1=` thành "envelope phiên bản 1" là suy sai.

⚠️ **Không có dual-accept.** `PROTOCOL_ID` nằm trong chuỗi ký, nên verifier của bản mới **từ chối** envelope do bản cũ ký (`bad_signature`), và tiền tố chữ ký không được dùng để quyết định chấp nhận hay không. Điều kiện triển khai vì vậy là: **hai Worker phải deploy cùng phiên bản giao thức.** Không có cửa sổ nào để một bên chạy bản cũ giao tiếp với bên chạy bản mới; thứ tự deploy không cứu được, chỉ có deploy cùng nhau. `libs/internal-auth-contracts/src/internal-auth.spec.ts` (vị trí canonical, dùng chung `auth` và `account`) có test dựng lại **chính xác** canonicalization của bản cũ và khẳng định verifier từ chối nó, cùng một test khẳng định tiền tố chữ ký lạ (`v2=…`) bị từ chối dù payload HMAC hợp lệ.

##### `kid` — chỉ dẫn chọn khoá, KHÔNG phải trường đã ký

Header `x-ecoma-internal-kid` mang `kid` của khoá đã ký: chuỗi **8–16 hex chữ thường** (`/^[0-9a-f]{8,16}$/u` — hằng giao thức ở `libs/internal-auth-contracts`, mọi service đọc **cùng** một hằng đó). Header này là **tuỳ chọn**: không có nó thì envelope dùng secret hiện hành, đúng như trước khi có `kid`.

⚠️ **`kid` KHÔNG nằm trong chuỗi canonical, và đây là điều kiện để nó không phải một thay đổi giao thức.** Chữ ký của envelope có `kid` và envelope không `kid` là **giống nhau từng byte** khi dùng cùng secret. Đổi lại, thêm `kid` không phá vector ký cũ, không đòi bump `PROTOCOL_ID`, và không cần dual-accept — hai bên ở hai phiên bản khác nhau vẫn giao tiếp được, chỉ khác ở chỗ envelope có mang `kid` hay không.

| Khái niệm       | `kid` mang nghĩa gì                                                                | Nó **không** mang nghĩa gì                           |
| --------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Chỉ dẫn         | "Hãy dùng khoá này để tính HMAC"                                                   | Không phải bằng chứng — HMAC mới là bằng chứng       |
| Đầu vào tin cậy | **Không** — `kid` do bên gọi kiểm soát, nên nó là dữ liệu đầu vào, không phải luật | Không phải principal, không phải danh tính người gọi |
| Hình dạng       | Sai hình dạng ⇒ `invalid_field`, và resolver **không** được kích hoạt              | Không phải `bad_signature` — đó là lỗi chữ ký        |

⚠️ **Thứ tự kiểm là hợp đồng:** thiếu header → **hình dạng `kid`** → **chọn khoá theo `kid`** → timestamp → nonce → dựng canonical → chữ ký → chiếm nonce. `kid` được kiểm **trước** timestamp và trước chữ ký vì nó là chỉ dẫn chọn khoá: hỏi "khoá nào?" phải đứng trước mọi phép băm.

⚠️ **`kid` lạ ⇒ `bad_signature`, và không có nhánh "chấp nhận bằng secret mặc định".** Receiver tra registry `kid → secret`; không biết `kid` nào thì không có khoá nào để khớp, nên envelope đó bị từ chối. Đây là fail-closed — một nhánh "không biết `kid` thì dùng secret hiện hành" sẽ biến `kid` thành trang trí và mở lại đúng lỗ hổng mà `kid` sinh ra để chặn.

Receiver dùng cơ chế này để **xoay secret không gián đoạn**: giữ hai khoá trong một registry `kid → secret` trong lúc overlap, rồi thu hồi khoá cũ. Runbook vận hành ở [`03-operations.md`](./03-operations.md) §3.3.

⚠️ **`kid` chọn được khoá để verify, nhưng không tách được "khoá để ký" khỏi "khoá để verify".** Mỗi Worker có **một** entry `current` duy nhất và entry đó **chính là** secret đang ký — không có slot thứ ba cho một khoá "mới nhưng chưa dùng để ký". Vì `auth` và `account` là **cặp song phương** (mỗi bên vừa gửi vừa nhận trên cùng cơ chế), quy trình xoay phải **nạp trước khoá mới vào slot `previous` ở cả hai Worker** rồi mới chuyển `current` — nếu chỉ "nạp trước ở phía nhận", phía nhận đó sẽ bắt đầu **ký** bằng khoá mới và làm hỏng hướng ngược lại. Runbook §3.3 nêu đúng thứ tự này.

⚠️ **Chữ ký phủ `path` nguyên văn, kể cả query string, và không bao giờ phủ JSON đã parse rồi serialize lại.** Ký trên dữ liệu tái tuần tự hoá làm chữ ký phụ thuộc thứ tự key và khoảng trắng — hai bên dùng hai thư viện JSON khác nhau là đủ để lệch nhau im lặng. Caller ký chuỗi nó thật sự gửi; verifier ký lại chuỗi nó thật sự nhận. Cùng lý do, không có quy tắc chuẩn hoá query riêng ở mỗi phía: không có bước chuẩn hoá nào cả.

##### Hai kiểm soát độc lập, không thay thế nhau

| Kiểm soát | Cơ chế                                                                                   | Chặn gì                                                                         |
| --------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Timestamp | `\|now − timestamp\| ≤ skew` (mặc định 300s)                                             | Envelope cũ bị phát lại ngoài cửa sổ — nhưng **không** chặn replay trong cửa sổ |
| Nonce     | Nonce đã chiếm trước đó bị từ chối, ghi bằng một câu lệnh nguyên tử vào kho **bền vững** | Replay trong cửa sổ, kể cả hai request **đồng thời**                            |

⚠️ **Timestamp một mình không phải replay protection.** Nó chỉ thu hẹp cửa sổ; trong cửa sổ đó chữ ký vẫn hợp lệ và envelope phát lại được. Nonce mới là thứ làm một request đã dùng không dùng lại được.

⚠️ **Nonce là duy nhất theo từng service nhận, và kho phải là durable storage.** Nonce đã chiếm ở `db-account` **không** bảo vệ được request đến `auth`, và ngược lại — nên cả hai service đều có bảng nonce riêng của mình (`account.internal_nonces`, `auth.internal_nonces`), mỗi bảng có retention riêng do chủ của nó quyết định. Cache node-local không thay thế được: `runtime:edge` cấm node-local application state.

⚠️ **Chiếm nonce là "kiểm tra VÀ ghi", không phải "kiểm tra".** Cài bằng `SELECT` rồi `INSERT` ở câu khác mất tính nguyên tử dưới tải đồng thời: hai request cùng nonce cùng thấy "chưa có" rồi cùng ghi, và cả hai đều qua. Đó là lý do tên callback là `claimNonce` (chiếm) chứ không phải `seenNonce` (thấy) — cái tên buộc người cài đặt thừa nhận phần **ghi**.

⚠️ **DB chết ⇒ từ chối (503), không bao giờ cho qua.** Khi kho nonce không gọi được thì ta _không biết_ nonce đã từng thấy hay chưa; coi "không biết" là "chưa thấy" là mở cửa sổ replay vô hạn. Cùng nguyên tắc với secret thiếu: đường internal không xác minh được thì không tồn tại.

⚠️ **Nonce chỉ được chiếm sau khi chữ ký đã được chứng minh.** Nếu chiếm chạy trước, kẻ tấn công đọc được nonce của một request thật từ log proxy hay `wrangler tail` có thể gửi một envelope đúng định dạng với chữ ký giả và **đốt** nonce đó; request thật sau đó rơi vào `replayed_nonce` dù chưa từng bị phát lại — và kẻ tấn công không cần secret.

##### Retention và prune

| Mục                    | Giá trị                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `expires_at` của nonce | `timestamp của envelope + skew chấp nhận + buffer`, buffer = `NONCE_TTL_BUFFER_SECONDS` (60s, hằng của giao thức)   |
| Neo theo mốc nào       | **Timestamp của envelope**, không theo đồng hồ của verifier — lý do đầy đủ ở JSDoc `claimNonce` của lib             |
| Câu prune              | `DELETE FROM <schema>.internal_nonces WHERE expires_at < now()` — chạy **theo lô có biên**, không phải một câu trần |
| Index phục vụ prune    | `internal_nonces_expires_at_idx` trên `expires_at` (cả hai bảng)                                                    |

⚠️ **Buffer không phải một cửa sổ thứ hai.** Nonce chỉ cần sống tới `timestamp + skew`: sau mốc đó envelope bị từ chối vì `bad_timestamp` và nonce không còn bảo vệ gì. Buffer tồn tại vì prune chạy theo lô chứ không chạy đúng thời điểm hết hạn. **TTL nhỏ hơn skew là hỏng**: prune xoá một nonce còn hiệu lực, và replay trong cửa sổ sẽ thành công.

⚠️ **Prune được lên lịch định kỳ.** Nhịp `17 3 * * *` (03:17 UTC = 10:17 ICT), chạy theo lô `BATCH_SIZE=20000` với trần `MAX_BATCHES=50` / `MAX_SECONDS=400` trên cron Worker `apps/auth-nonce-prune-job`, dùng role `ecoma_auth_nonce_pruner` (migration `0014`), kiểm `to_regclass` + `has_table_privilege` trước khi xoá và **fail closed** (chạm trần báo `cap_hit` + exit 1). Bảng phình mà không chạm trần **không** làm tăng khả năng replay nếu được báo đỏ và xử lý kịp: nonce nằm lại vẫn là nonce đã bị chiếm, nên vẫn chặn replay. Runbook và trường hợp vận hành chi tiết tại [`03-operations.md`](./03-operations.md) §3.3.

##### Thân request

- **Giới hạn 64 KiB** (`INTERNAL_BODY_LIMIT_BYTES`, hằng của giao thức ở lib canonical, không chép lại ở app).
- ⚠️ **Cách enforce khác nhau ở hai service, và chỉ một trong hai chặn được memory exhaustion.** `auth` (`POST /internal/session/verified`) là bên duy nhất nhận body trên đường production hôm nay: nó đọc `request.body` **theo stream** và từ chối **giữa** lúc đọc khi tổng vượt hạn mức (`readBodyLimited` trong `apps/auth/src/main.ts`) — đó là chốt chặn thật. `account` chỉ có một route internal là `GET /internal/account/status`, không có thân request; middleware của nó **vẫn** kiểm hạn mức trên `byteLength` của giá trị đã đọc (giữ hợp đồng 64 KiB nhất quán hai đầu), nhưng ở preset Workers của Nitro thân request đã được đọc hết vào bộ nhớ **trước** khi middleware chạy — nên phép kiểm đó là **sau khi buffer** và **không** ngăn được memory exhaustion. Nói nó ngăn được là nói sai.
- `Content-Length` **không** là phép kiểm có thẩm quyền ở bất kỳ phía nào: nó là dữ liệu của người gọi và chỉ là một gợi ý tối ưu. Phép kiểm có thẩm quyền là trên số byte **thật sự đã đọc**.
- **Ký trên đúng byte thân request, không bao giờ trên chuỗi đã decode.** Verifier đọc raw body dưới dạng `Uint8Array` và băm đúng mảng đó; caller cũng vậy. Trước PR hợp nhất này cả hai phía `TextDecoder.decode()` rồi ký chuỗi, nên byte không hợp lệ UTF-8 hoá thành U+FFFD **trước** khi băm: hai payload byte khác nhau cho cùng `bodyHash` và cùng chữ ký, và một sửa đổi ở tầng byte trên đường đi (WAF, proxy) không làm chữ ký sai đi. Không decode cũng có nghĩa một body JSON dị dạng bị từ chối vì **chữ ký không khớp**, không vì parse lỗi.
- **`body` là `Uint8Array | null | undefined` ở tầng API, và một giá trị không phải byte bị từ chối.** `hashBody` ném `TypeError` khi nhận thứ không phải `Uint8Array` (kể cả chuỗi): `new Uint8Array('<chuỗi>')` cho ra mảng **rỗng**, nên một chuỗi lọt vào sẽ băm thân rỗng trong im lặng — hai phía cùng "đúng" trên cùng một sai lầm. Body rỗng và body `null`/`undefined` cùng hash về hash của chuỗi rỗng (`e3b0c4…b855`).

##### Lỗi, mã và trạng thái

Một taxonomy duy nhất, mã ổn định để audit phân loại được, và **không** nêu lý do cụ thể trong response: nói `signature_mismatch` là biến response thành oracle dò chữ ký.

| Nhóm                                                                                                                                                      | HTTP  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Thiếu header, timestamp sai định dạng/ngoài skew, nonce yếu/đã chiếm, chữ ký sai, sai version scheme hoặc trường canonical không hợp lệ (`invalid_field`) | `401` |
| Thân vượt 64 KiB                                                                                                                                          | `413` |
| Không gọi được kho nonce hoặc DB                                                                                                                          | `503` |

Response **không bao giờ** chứa key, chữ ký mong đợi, nội dung canonical, raw body hay định danh nhạy cảm. Log cũng không: chữ ký trong log là một giá trị còn tái dùng được trong cửa sổ skew, và message của driver `pg` có thể chứa connection string.

##### Replay envelope ≠ retry nghiệp vụ

Ba tình huống khác nhau, ba hành vi khác nhau — không được trộn:

| Tình huống                                                            | Hành vi                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Cùng envelope** gửi lại (cùng nonce)                                | Từ chối ở tầng envelope (`replayed_nonce`) — đây là tấn công, không phải retry |
| **Envelope mới** (nonce mới) mang **cùng `event_id`** và payload khớp | Retry hợp lệ: trả lại **outcome đã lưu**, không chạy lại, không side effect    |
| Envelope mới mang `event_id` đã dùng với **payload khác**             | `event_id` bị tái sử dụng ⇒ từ chối + audit                                    |

⚠️ **Chống replay ở tầng envelope không thay thế idempotency nghiệp vụ, và ngược lại.** Nonce chỉ sống trong cửa sổ skew; retry hợp lệ có thể tới sau cửa sổ đó. Vì vậy idempotency theo `event_id` (FR-016r, §5.1.5) vẫn là lớp bắt buộc — và nó **không** được nới lỏng để làm test nonce xanh.

##### Thêm một endpoint internal mới

Route mới dưới `/internal/**` **tự động** được bảo vệ: `account` cài envelope verification bằng **middleware** ở prefix `/internal/` chứ không phải trong từng route, nên mặc định là **closed**. Đặt check trong từng route là mặc định **open** — route mới quên check là lỗ hổng và không test nào đỏ.

⚠️ **Service Binding không phải lớp bảo vệ nào cả** — xem §5.1 và [`../account/01-architecture.md`](../account/01-architecture.md) §6. Cloudflare không cung cấp header hay request property nào để phân biệt request qua binding với request từ internet; mô hình chính thức là _isolation_, không phải _verification_. Không được viết tài liệu hay code coi "đến qua Service Binding" là đã xác thực.

### 5.2 Ràng buộc bắt buộc

- **Query param chỉ mang handle opaque do `auth` cấp.** Không password, không session cookie, không access token, không trusted identity assertion ([`01` invariant 27](../../architecture/01-architecture.md)).
- **`continue_url` chỉ được dựng từ origin đã cấu hình của `auth`.** Không bao giờ từ `redirect_uri`, `Host`, `Origin` hay dữ liệu browser — đó là điều kiện chống open redirect (§5.1.1).
- **Handle Y/Z được derive bằng HMAC có khóa bí mật của `auth`**, không phải hash của `event_id`. Cùng transaction cho ra cùng Y/Z, nên retry trả lại đúng continuation mà `db-auth` chỉ cần lưu hash, không lưu plaintext handle hay code (§5.6).
- **Handle X, Y và Z là ba handle riêng, cả ba đều opaque, có TTL và single-use.** X cho `/login`, Y cho consent (§5.5), Z cho hoàn tất (§5.1.4). Chúng không thay thế nhau và không chia sẻ bất kỳ bằng chứng nào.
- **Consent do `auth` bind.** `account` gửi **quyết định** (`approve`/`deny`) cùng handle; `auth` tự gắn vào `sub` + client + redirect_uri + scope + transaction của chính nó.
- **Exact redirect match, exact scope check.** `auth` không tin scope `account` hiển thị; nó kiểm scope trong transaction của nó.
- **Trước khi render consent, nhận quyết định, hoặc cấp code, session account phải thuộc đúng subject của transaction.** Biết hoặc sở hữu URL chứa Y hay Z **không** phải bằng chứng danh tính.
- **Transaction phải `browser_confirmed` trước khi bind danh tính.** Không có ngoại lệ, và nhánh đã có grant cũng phải qua (§5.1.0).
- **TTL trên cả bốn** handle/transaction; hết hạn → `invalid_request`, bắt đầu lại từ bước 1.
- **Audit** mọi authn outcome, token issuance, consent decision, revocation. Không ghi token, `code_verifier`, assertion, handle hay giá trị cookie.

### 5.3 Session binding — chống handle theft

Ràng buộc này biến một URL thành **định danh một authorization request**, không phải **bằng chứng xác thực**.

⚠️ **Có hai lớp ràng buộc độc lập, và thiếu một lớp là một lỗ hổng thật.** Lớp ở phía `account` gắn X với session trình duyệt; lớp ở phía `auth` gắn transaction với trình duyệt đã nhận `302` từ `/authorize`. Bỏ lớp thứ nhất thì kẻ tấn công dùng session của chính hắn; bỏ lớp thứ hai thì kẻ tấn công dùng **chính session của nạn nhân**. Cả hai phải cùng tồn tại.

**Lớp 1 — ràng buộc X với session trình duyệt, theo đúng thứ tự:**

1. **Bước 5 — `account` gắn X vào session trình duyệt.** Khi browser mang X tới `/login`, `account` ghi nhận `(X_hash, session_id)` với TTL bằng TTL của X. Đây là mốc ràng buộc đầu tiên giữ handle và trình duyệt.
2. **Bước 6 — xác thực đúng session đã trình X.** `account` chỉ chấp nhận credential cho session khớp `(X_hash, session_id)` ở bước 6 (dòng trên). Trình duyệt khác trình X → không có dòng khớp → từ chối, dù handle hợp lệ.
3. **Bước 6 — rotate rồi mới sinh ASR.** Sau xác thực thành công, `account` **rotate session** rồi sinh `account_session_ref` ASR gắn với session mới đó.
4. **Bước 6 — chuyển binding sang session sau rotation, atomic.** Handoff của X phải được chuyển từ session trước xác thực sang session sau xác thực trong **cùng một transaction** với việc rotate. Nếu không, binding sẽ trỏ về session đã bị thu hồi và mọi request sau đó đều bị từ chối — hoặc tệ hơn, nó trỏ về một session mà bên thứ ba có thể nhận được.
5. **Bước 9 — danh tính đi back-channel, không đi URL.** `sub`, `acr`, `authn_at` và ASR nằm trong payload của Service Binding, không phải query param.
6. **Bước 10 — `auth` lưu rồi consume X.** `auth` CAS consume X, ghi `sub` + `acr` + `authn_at` + ASR vào transaction CỦA NÓ. ASR **không** single-use: nó thuộc về session đang sống và được dùng lại ở bước 13 và bước 16 (§5.5).

**Lớp 2 — ràng buộc transaction với trình duyệt đã khởi tạo:**

7. **Bước 3 — `/authorize` mint cookie B.** `auth` tạo `B` random ≥ 256 bit, đặt `Set-Cookie: __Host-auth-browser=B`, và ghi **hash của B** vào transaction. Cookie này ở origin `auth`, `__Host-` nên không có `Domain` và không bị subdomain khác ghi đè.
8. **Bước 8 — browser chứng minh nó là browser của transaction.** Khi browser quay lại `GET /authorize/confirm?handle=X`, nó gửi cookie B. `auth` so hash cookie với hash trên transaction; khớp thì chuyển transaction sang `browser_confirmed`.
9. **Bước 10 — push bị chặn nếu chưa `browser_confirmed`.** Đây là chốt chặn cuối: kể cả khi attacker có X, hắn cũng **không có** cookie B, vì cookie đó chỉ được set trong response `302` mà **trình duyệt đã bắt đầu transaction** nhận được.

⚠️ **Cookie B là _một_ giá trị cho _một_ transaction đang sống, và đây là ranh giới thật của cơ chế này.** Nó bảo vệ chống pre-binding, nhưng nó **không** giải quyết được trường hợp hai authorization transaction **cùng một trình duyệt**: `/authorize` lần hai sẽ `Set-Cookie` lại và làm mất liên kết của transaction lần đầu. Hệ quả bắt buộc, và phải nói ra thay vì giấu:

| Tình huống                                                 | Hành vi                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Một `/authorize` tại một thời điểm                         | Cookie B khớp → mọi thứ hoạt động như thiết kế                                             |
| `/authorize` lần hai **trước khi** xác nhận lần đầu        | T₁ **không** còn xác nhận được (cookie đã bị thay); người dùng bắt đầu lại từ `/authorize` |
| `/authorize` lần hai **sau khi** T₁ đã `browser_confirmed` | T₁ giữ liên kết đã xác nhận — trạng thái đã đạt không bị ghi đè ngược lại                  |

⚠️ **Đây là hệ quả vận hành, không phải lỗ hổng:** mất liên kệ thì bắt đầu `/authorize` mới, và việc đó luôn khả dụng. Nhưng nó **là** giới hạn, và tài liệu phải gọi đúng tên. Cách chống ghi đè triệt để (cookie mang danh sách các transaction đang sống, hay cookie riêng theo từng transaction) là một quyết định cấu trúc chưa chốt — nó đổi hình dạng của cookie và phải chốt cùng quyết định cookie per-transaction ở §9.

⚠️ **Vì sao lớp 1 là mấu chốt, và vì sao lớp 1 một mình vẫn chưa đủ.** Nếu `account` xác thực bất kỳ session nào mà không so với bước 5, kẻ tấn công chỉ cần đăng nhập bằng tài khoản của chính mình rồi mở URL handle của nạn nhân là hoàn tất được luồng dưới danh nạn nhân. So khớp ở bước 6 (bind → xác thực) chặn đúng trường hợp đó. **Nhưng** lớp 1 nói "session nào đã trình X", chứ **không** nói "trình duyệt nào đã tạo ra X" — và đó chính là chỗ mà một attacker đã có X từ trước có thể đi vòng. Lớp 2 là câu trả lời: `auth` tự biết trình duyệt nào nhận `302` từ `/authorize` của nó, và nó **không chấp nhận** kết quả xác thực cho transaction mà trình duyệt đó chưa từng mở.

⚠️ **Cookie B không phải và không được trở thành credential của user.** Nó chứng minh quan hệ giữa browser và transaction, **không** chứng minh user đã đăng nhập. Có nó không cho attacker đăng nhập hộ ai, và mất nó không phải sự cố xác thực — chỉ là phải bắt đầu `/authorize` mới (§5.1.6). Vì vậy nó **không** thay thế session `account` ở bất kỳ bước nào.

⚠️ **Cookie `account` và cookie `auth` không được trộn hay dùng chung domain.** `__Host-account-*` ở `account.ecoma.io`, `__Host-auth-browser` ở `auth.ecoma.io`. Cả hai đều là `__Host-` nên tự động bị cô lập theo host — nhưng điều này chỉ đúng **vì** cả hai đều dùng prefix đó; một cookie không có `__Host-` sẽ phá vỡ cô lập.

| Tấn công                                                            | Kết quả                                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Handle theft** — đọc URL của nạn nhân                             | Kẻ tấn công trình X từ trình duyệt khác → không khớp `(X, session)` ở bước 6 → không đăng nhập được, dù URL hợp lệ                   |
| **Pre-binding** — attacker lấy X trước, tự bind vào session hắn     | Bước 10 bị chặn: transaction chưa `browser_confirmed`, và attacker không có cookie B                                                 |
| **Replay handle**                                                   | CAS consume ở bước 10 → `invalid_grant`; Z consume ở bước 16 cũng vậy                                                                |
| **Replay request bước 9** (client không biết đã commit)             | `event_id` trùng → `auth` trả kết quả đã lưu, **không** ghi và không cấp code lần hai; cùng handle + payload khác → từ chối và audit |
| **Transaction substitution**                                        | Payload bước 9 không mang client/scope; `auth` bind từ transaction của nó, và chỉ bind vào transaction do chính nó tạo               |
| **Cookie B của transaction khác**                                   | Hash B gắn vào transaction cụ thể; dùng B của T₁ để mở T₂ → không khớp, từ chối                                                      |
| **Mix-up** — redirect kết quả về client khác                        | `redirect_uri` exact match; `state` echo nguyên văn; `id_token` kiểm `iss`/`aud`/`nonce`                                             |
| **Confused deputy**                                                 | `auth` không nhận `sub` từ browser; chỉ nhận từ `account` qua back-channel đã xác thực                                               |
| **Session fixation** — attacker đặt X lên trình duyệt nạn nhân      | Bước 6 gắn X với session của nạn nhân; xác thực đúng session đó → attacker vẫn phải có credential của nạn nhân                       |
| **Consent handle theft** — đọc URL `consent?handle=Y`               | Y ràng buộc server-side với `account_session_ref`; người mở URL bằng session khác bị từ chối ở bước 13 và bước 16 (§5.5)             |
| **Completion handle theft** — đọc URL `authorize/complete?handle=Z` | Z là capability **có** cookie B mới dùng được; cookie B không lấy được từ URL, chỉ có trình duyệt của transaction đó mới có          |

⚠️ **Bảng trên phải đọc cùng §5.1.0.** Pre-binding không bị chặn bởi first-binding-wins ở phía `account` — nó bị chặn bởi `browser_confirmed` ở phía `auth`. Đây là hai kiểm soát ở hai service khác nhau, và chỉ một trong hai là không đủ.

### 5.4 Edge case

| Tình huống                                                           | Hành vi                                                                                                                                |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| User đóng tab giữa bước 4 và 8                                       | Transaction hết TTL rồi cleanup theo lô; không cần xoá tức thời                                                                        |
| **Kẻ khác mở URL handle của nạn nhân**                               | Bước 6 gắn X với session của nạn nhân, không phải của kẻ khác → bước xác thực từ chối                                                  |
| **Kẻ tấn công đã đăng nhập tài khoản riêng, mở handle của nạn nhân** | Session trình X không khớp → từ chối ở bước 6; **và** dù lọt được thì transaction chưa `browser_confirmed`                             |
| **Submit trùng** (double-click, retry)                               | Handle đã consume → từ chối idempotent; **không** cấp code thứ hai                                                                     |
| **Denial**                                                           | `auth` trả Z cho nhánh denied; `GET /authorize/complete` dựng `redirect_uri?error=access_denied&state=`; transaction kết thúc          |
| **Timeout**                                                          | TTL hết hạn → `invalid_request`, bắt đầu lại từ bước 1                                                                                 |
| **`account` down** giữa luồng                                        | Bước 9 fail → `auth` **fail closed**, không cấp code. User thấy lỗi, không thấy "đã đăng nhập"                                         |
| **`auth` down** ở bước 9                                             | `account` không nhận được response → **retry cùng `event_id`** để khôi phục cùng outcome (§5.1.5); không có code nào được cấp trước đó |
| **Back-channel contract down**                                       | Cùng trường hợp `account` down — fail closed, không degraded path                                                                      |
| **Client retry toàn bộ authorization**                               | Quay về bước 1, transaction mới; transaction cũ không tái sử dụng được                                                                 |
| **Consent bị delay/replay**                                          | CAS consume → lần hai bị từ chối; không cấp code thứ hai                                                                               |
| **Cookie B mất** (xóa cookie, đổi trình duyệt)                       | `/authorize` mới mint cookie mới; không có đường nào phục hồi transaction cũ mà không gia hạn                                          |

⚠️ **Bảng trên phủ bước 1–10; các nhánh riêng của consent nằm ở §5.5.** Những nhánh lộ thêm handle Y — session bị đổi giữa login và consent, người khác mở URL Y, kẻ tấn công đã đăng nhập tài khoản riêng mở Y — cần cơ chế khác với bước 5, vì Y được tạo **sau** khi session đã xác thực.

### 5.5 Consent handle `Y` — sinh thế nào và bảo vệ thế nào

⚠️ **`Y` không thừa hưởng ràng buộc của `X`, và điều này dễ bị bỏ sót.** X được bind ở bước 6 — _trước_ khi xác thực. Y được tạo ở bước 11 — _sau_ khi đã xác thực, nên không có bước "gắn vào session trình" nào để bê nguyên từ X. Ai hiểu sai bằng cách coi Y là "cùng một loại handle" sẽ chỉ cần biết URL Y là chiếm được quyền consent.

**Đặc tính bắt buộc của `Y`:**

| Đặc tính             | Bắt buộc                                                                                                  | Vì sao                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Opaque**           | Chuỗi sinh bằng HMAC (§5.6), **không** chứa `sub`, `client_id` hay trường nào đọc được                    | URL bị log/`Referer` không nên tự tiết lộ nó authorize cho ai |
| **TTL**              | Có hạn, ngắn hơn hoặc bằng TTL của transaction; hết hạn → `invalid_request`                               | Consent bị bỏ dở không được sống mãi                          |
| **Single-use**       | CAS consume **trong cùng transaction** với việc ghi consent decision và mint Z                            | Không có đường nào cấp code lần hai cho một quyết định        |
| **Bind server-side** | `auth` lưu `(Y_hash, sub, client, redirect_uri, scope, transaction, account_session_ref)` trong `db-auth` | Toàn bộ ý nghĩa của Y nằm ở server, không nằm ở trình duyệt   |

**Ràng buộc phiên — điểm mấu chốt của toàn bộ mục này:**

`auth` **không** đọc cookie của trình duyệt (invariant 2, §8), nên nó không thể tự kiểm tra "session này có phải của subject đó" một mình. Việc đó thuộc `account`:

1. **`account` kiểm tra session hiện tại** — đọc cookie trình duyệt, xác thực session đó còn sống và thuộc đúng `sub` — rồi gửi **kết quả kiểm đó** qua Service Binding đã xác thực. Đây là **BFF endpoint của `account` đẩy sang `auth`**, không phải `auth` hỏi ngược session.
2. **Payload mang `handle Y` + `account_session_ref` lấy từ session vừa được xác minh** (`POST /internal/consent/context`, §5.7), và **không** mang `sub` do browser quyết định. `account` lấy subject **từ session của chính nó** và chỉ dùng nó để tự kiểm trước; `auth` so `account_session_ref` trong payload với `account_session_ref` đã bind trong transaction Y. ⚠️ `account_session_ref` chỉ có ý nghĩa vì nó đến từ session **đang hoạt động** qua contract đã xác thực — nó không phải bằng chứng tự xác thực và không dùng được để đăng nhập.
3. **`account` không được gửi `client_id`, `redirect_uri` hay `scope`** — `auth` tự lấy từ transaction của nó.
4. **Hai contract này đều thuộc `auth`** (`POST /internal/consent/context`, `POST /internal/consent/decide`); đường gọi là back-channel, **không** phải endpoint public và **không** lấy cookie trình duyệt làm xác thực.

⚠️ **Sở hữu URL chứa `Y` không phải bằng chứng danh tính.** Kẻ tấn công đã đăng nhập bằng tài khoản **của chính mình** vẫn bị từ chối, vì session của hắn không khớp `sub` của transaction Y. Đây là kịch bản giống hệt tấn công handle X ở §5.3, chỉ khác chỗ xảy ra.

**Kiểm tra ở ba chỗ, cả ba đều bắt buộc:**

| Chỗ         | Việc                                                                        | Chặn được gì                                             |
| ----------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Bước 13** | Trước khi **render consent** — không có context thì không có gì để hiển thị | Người khác đọc được `client_name`/`scope` của người khác |
| **Bước 14** | Trước khi **ghi quyết định** — CAS consume Y cùng transaction ghi decision  | Quyết định consent dưới danh tính người khác             |
| **Bước 16** | Trước khi **cấp code** — cookie B + CAS consume Z cùng transaction cấp code | Hoàn tất authorization bằng session đã thu hồi           |

⚠️ **Chỉ kiểm ở bước 13 và 14 là thiếu.** Giữa lúc lấy context và lúc hoàn tất, session có thể bị thu hồi, logout, hoặc đổi trên thiết bị khác. Bước 16 là chốt chặn cuối **ngay trước** khi code được cấp; bước 14 là lần kiểm thứ hai, ngay trước khi quyết định được ghi và Z được mint.

⚠️ **Bước 14 không còn là nơi cấp code — việc đó đã dời sang `GET /authorize/complete`.** Bản trước mô tả bước 14 là "cấp code trong cùng transaction với CAS consume Y". Bây giờ bước 14 chỉ ghi **quyết định + grant + mint Z**, và code được cấp ở bước 16. Lý do: nhánh đã có grant không có bước 14 nào, và nếu code chỉ được cấp ở bước 14 thì hai nhánh hoàn tất theo hai cách khác nhau — đó chính là mâu thuẫn mà §5.1 nói phải bỏ.

**Các trường hợp bắt buộc xử lý:**

| Tình huống                                                   | Hành vi                                                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Người khác mở URL Y** (kể cả đã đăng nhập tài khoản riêng) | Session không khớp `sub` → từ chối ở bước 13; **không** render consent                                               |
| **Session bị đổi giữa bước 10 và bước 13**                   | `account_session_ref` trong Y không còn khớp → từ chối ở bước 13; bắt đầu lại từ bước 1                              |
| **Session bị đổi hoặc thu hồi giữa bước 13 và 14**           | Bước 14 kiểm lại → từ chối; **không** ghi quyết định                                                                 |
| **Session bị đổi hoặc thu hồi giữa bước 14 và bước 16**      | Bước 16 kiểm lại → từ chối; **không** cấp code, Z **không** bị consume                                               |
| **Y bị lộ** (URL lọt vào log, `Referer`, history)            | Chủ sở hữu URL không đủ — cần đúng session của `sub`; TTL hạn chặn việc dùng lại muộn                                |
| **Replay Y** với cùng `decision`                             | Trả lại **cùng** outcome và **cùng** Z; không ghi lần hai (§5.1.5b)                                                  |
| **Replay Y** với `decision` khác                             | `invalid_request` + audit; **không** thể approve sau khi đã deny, hoặc ngược lại                                     |
| **Submit đồng thời** (race ở bước 14)                        | Compare-and-set trên Y: đúng một nhận được, phần còn lại `invalid_grant`                                             |
| **Hết TTL**                                                  | `invalid_request`, bắt đầu lại từ bước 1; transaction cũ không tái dùng được                                         |
| **Back-channel lỗi hoặc timeout ở bước 13/14**               | Fail closed — không render, không ghi quyết định. **Không** có degraded path cho qua bằng dữ liệu cache              |
| **Mất cookie B giữa bước 14 và bước 16**                     | Bước 16 từ chối; browser bắt đầu `/authorize` mới. Z còn sống nhưng không ai dùng được → hết TTL rồi xoá             |
| **`deny`**                                                   | Mint Z cho transaction `denied`; `GET /authorize/complete` trả `error=access_denied` + `state` nguyên vẹn; consume Z |

**Nguyên tử theo transaction:** quyết định consent, ghi `oauth_consent_decisions`, tạo/cập nhật `oauth_grants` và mint Z diễn ra **trong một transaction `db-auth`**. Nếu bất kỳ bước nào lỗi thì **không** có gì được ghi, Y không bị consume, và không có Z nào tồn tại.

**CSRF ở bước 13/14:** `POST /internal/consent/decide` là back-channel từ `account` qua Service Binding, **không** phải request trực tiếp từ trình duyệt — nên CSRF token của BFF không áp dụng cho nó, và cũng không được lấy cookie trình duyệt để "tiện tay" xác thực. Bảo vệ chống giả mạo ở đây là **Service Binding đã xác thực + kiểm session ở bước 14 và bước 16**. Điều này giữ nguyên nguyên tắc §5.1(a): back-channel mang danh tính Worker, nên nó không thể tự chứng minh danh tính người dùng — nó phải **hỏi** session qua một lệnh gọi riêng.

### 5.6 Handle Y/Z — sinh thế nào, và vì sao không phải hash của `event_id`

⚠️ **Bản trước nói Y/Z derive từ entropy của `event_id` bằng "hàm một chiều", rồi so hash handle trong DB. Cả hai vế đều sai, và sai theo hai hướng khác nhau.** Vế "một chiều" (hash) **không tạo ra bí mật**: biết `event_id` là biết trước kết quả. Vế "đối chiếu hash khi trả handle" thì vô nghĩa — nếu ta tính lại được Y từ `event_id` thì ta **không cần** đối chiếu gì cả, và nếu không tính lại được thì không có gì để đối chiếu. Cơ chế này hỗ trợ đúng hai việc mà nó không làm được: nó không tạo ra handle mà người khác tính được, và nó không cho ta khôi phục handle khi retry.

Cơ chế đúng là **derive bằng HMAC với khóa bí mật**, theo các thuộc tính sau:

| Thuộc tính            | Bắt buộc                                                                                                    | Vì sao                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Hàm**               | `HMAC-SHA-256(K_auth, domain ‖ transaction_id ‖ purpose)` — **có khóa**                                     | Hash không tạo bí mật; HMAC thì có                                  |
| **Domain separation** | `purpose` khác nhau cho từng loại: `login-handoff`, `consent-continuation`, `authorization-code`            | Cùng đầu vào với ba mục đích khác nhau phải ra ba giá trị khác nhau |
| **Nguồn entropy**     | `transaction_id` — random ≥ 256 bit, sinh **một lần** khi `/authorize` tạo transaction                      | Không phụ thuộc `event_id`, vì `event_id` không phải bí mật         |
| **Khóa**              | `K_auth` do `auth` quản lý, trong Worker Secrets; **`db-auth` không lưu** (đúng như FR-023 với signing key) | Không đọc được khóa thì không tính lại được handle                  |
| **Lưu gì**            | Chỉ `handle_hash(Y)`, `handle_hash(Z)` — **không** lưu plaintext handle, **không** lưu plaintext code       | Khôi phục retry bằng cách tính lại, không bằng cách đọc lại         |
| **So khớp khi trả**   | Tính lại từ `transaction_id`, rồi so `handle_hash` đã lưu; lệch thì **không** trả handle đó                 | Chặn handle của transaction khác dùng nhầm                          |
| **Key version**       | Ghi `key_version` lúc mint; retry dùng **đúng version** đó                                                  | Xoay khóa không làm hỏng handle đang sống                           |
| **Rotation**          | Giữ khóa cũ **cho tới khi mọi transaction dùng nó hết TTL**                                                 | Xoay khóa cũ sớm → handle của transaction cũ không khôi phục được   |
| **Key bị loại bỏ**    | Handle cũ hơn khoảng khóa → `invalid_request`, bắt đầu lại từ `/authorize`                                  | Không có đường nào phục hồi handle không còn khóa                   |
| **Replay**            | Không thể dùng handle của transaction khác: giá trị HMAC gắn `transaction_id`, UNIQUE trong DB              | Cùng handle khác transaction → không tồn tại, hoặc lệch hash        |

⚠️ **Đây là cơ chế chịu được sự kiện mất response, và đó là điểm khác biệt so với "chỉ lưu hash".** Khi `account` retry cùng `event_id`, `auth` tra transaction gốc theo `event_id` đã ghi, đọc `transaction_id` + `key_version`, tính lại Z bằng HMAC, so với `handle_hash(Z)` đã lưu, rồi trả. Không cần plaintext Z trong DB, và không cần lưu code để phục hồi.

⚠️ **Đánh đổi phải ghi thẳng: rotation bị trì hoãn bởi TTL transaction.** Không thể xoá khóa cũ ngay khi xoay, vì handle của transaction đang sống sẽ không tính lại được. Vì vậy việc xoá khóa cũ là một tác vụ theo lịch, có điều kiện (mọi transaction dùng key đó đã hết TTL), **không** phải một bước của lệnh xoay khóa. TTL transaction ngắn làm điều này rẻ; TTL dài làm nó tốn khoá hơn. Đó là lý do TTL transaction là một quyết định có chi phí, không chỉ là một con số tiện lợi.

⚠️ **`event_id` không phải bí mật và không được dùng như đầu vào bí mật.** Nó là idempotency identifier, đi trong payload back-channel, và có thể xuất hiện trong log lỗi hoặc audit của `account`. Thiết kế này coi nó là **công khai với `auth`**, và mọi bí mật đều đến từ `K_auth`.

### 5.7 Consent context — `POST /internal/consent/context`

⚠️ **Contract này là `POST` với `application/json`, không phải `GET`.** Payload `{ handle: Y, account_session_ref }` là có cấu trúc, và việc đặt `account_session_ref` trong query string sẽ đưa một tham chiếu session vào URL — nơi nó lọt vào log, `Referer` và history. `GET` với request body cũng là thứ **không nên giả định** là hoạt động nhất quán giữa các runtime, dù đôi khi chạy được. Đây là service binding nội bộ; `POST` với JSON là lựa chọn không có điểm mù nào.

| Thuộc tính        | Bắt buộc                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Method            | `POST`, `Content-Type: application/json`                                                        |
| Caller            | `account` (consumer) → `auth` (provider), qua **Service Binding đã xác thực**                   |
| Request           | `{ handle: Y, account_session_ref }` — **không** `sub`, `client_id`, `redirect_uri`, `scope`    |
| Response          | `200 { client_name, scope[], risk_level }` — không trả `sub`                                    |
| Session check     | `account` xác minh cookie trình duyệt thuộc đúng `sub` **trước khi** gọi; ASR lấy từ session đó |
| Đối chiếu         | `auth` so `Y` và ASR với transaction đã lưu; lệch → `invalid_grant` + audit                     |
| Không phải public | Route này **không** phải public endpoint và **không** cho browser gọi trực tiếp                 |
| Logging           | Không log `Y`, ASR, cookie hay body; chỉ log outcome và `client_id`                             |
| Cache             | `Cache-Control: no-store`                                                                       |

⚠️ **`account` không nhận ASR tùy ý từ browser rồi chuyển tiếp như bằng chứng.** Nó lấy ASR từ session mà **chính nó** vừa xác minh. Nếu ASR đến từ payload browser thì nó là một chuỗi tự do mà attacker chọn, và việc so nó với transaction sẽ chỉ chứng minh rằng attacker biết một giá trị đã lộ — không phải rằng hắn đang dùng session của đúng subject đó.

## 6. Token validation và revocation

⚠️ **Câu trả lời trung thực về "token đã cấp còn hợp lệ không".**

Nếu access token là **JWT self-contained** và resource server verify **offline** bằng chữ ký, thì `auth` **không có mặt** ở thời điểm token được dùng. Resource server không biết account vừa bị suspend, không biết grant vừa bị thu hồi. Trong mô hình đó token đã cấp **vẫn hợp lệ tới khi hết hạn** — nói ngược lại là nói sai. Ngữ nghĩa nghiệp vụ của giới hạn này → [`docs/domains/auth/domain-model.md`](../../domains/auth/domain-model.md) §4.

### 6.0 Kiểm tra trạng thái account lúc phát hành — contract riêng, hướng `auth → account`

`auth` không đọc `db-account` (invariant 1, §8), nên "token mới có được cấp cho account đang active hay không" là câu hỏi nó **phải hỏi**, qua contract riêng do `account` phục vụ. Đây **không** phải session-verification push và **không** phải consent contract — ba contract này có ba hướng khác nhau, và đây là hướng ngược lại với hai cái kia.

| Contract                                | Consumer   | Provider      | Hướng gọi            | Câu trả lời cho                            |
| --------------------------------------- | ---------- | ------------- | -------------------- | ------------------------------------------ |
| `POST /internal/session/verified`       | `account`  | `auth`        | `account → auth`     | "Phiên này có thật không?" (§5.1)          |
| `GET`/`POST /internal/consent/*`        | `account`  | `auth`        | `account → auth`     | "Consent context / quyết định?" (§5.1)     |
| **`GET /internal/account/status?sub=`** | **`auth`** | **`account`** | **`auth → account`** | **"Account này còn active không?" (§6.0)** |

⚠️ **Hướng gọi đọc là `consumer → provider`** (§5.1.1). `account` gọi `auth` ở ba contract đầu; `auth` gọi `account` ở contract cuối. **Tên endpoint nằm trên không gian tên của provider** — `/internal/account/status` thuộc `account` dù `auth` là bên gọi, giống hệt cách `/internal/consent/*` thuộc `auth` dù `account` là bên gọi.

**Yêu cầu bắt buộc:**

- **Read-only, không nhận cookie.** Đây là back-channel service-to-service, không phải BFF ([`../account/01-architecture.md`](../account/01-architecture.md) §5.1). `auth` không gửi session cookie của trình duyệt, và cũng **không được** gửi.
- **`sub` là tham số, không phải bằng chứng.** Nó là con trỏ tới account cần kiểm, không phải kết quả xác thực. Endpoint này **không** xác nhận "phiên trình `sub` này có thật" — nếu có, nó sẽ phá vỡ §5.1(a).
- **Chỉ trả về trạng thái**, không trả hồ sơ: `active` \| `suspended` \| `deleted` \| `not_found`. Không trả email, tên hay bất kỳ trường định danh nào.
- **Không có projection cache, không có stale read.** `auth` phải đọc `db-account` ở mỗi lần gọi. Lý do: câu hỏi duy nhất của contract này là "account này còn active **ngay lúc này** không", và một projection cũ trả về `active` cho một account vừa bị suspend là **trả lời sai**, không phải trả lời chậm. Bất kỳ cache nào ở đây đều phải có TTL gần bằng 0 — tức là không có cache.
- **Response phải gắn `Cache-Control: no-store`.** Cùng lý do, ở phía các tầng trung gian: trạng thái account là dữ liệu nhạy cảm theo thời điểm, và không được để HTTP cache hoặc CDN giữ nó lại rồi trả lại cho một lệnh gọi sau.
- **`not_found` và `deleted` không phân biệt với `suspended` về mặt phát hành:** cả ba đều nghĩa là **không cấp token**. `auth` chỉ cần biết "có cấp hay không", không cần biết vì sao.

**Quy tắc tại `auth` — không có nhánh nào cho qua:**

| Kết quả gọi                             | Hành vi                                                               |
| --------------------------------------- | --------------------------------------------------------------------- |
| `active`                                | Cấp token (với điều kiện còn lại: client, grant, revocation)          |
| `suspended` \| `deleted` \| `not_found` | **Không** cấp token. Grant bị chặn, không degraded path               |
| **Timeout, lỗi, 5xx, `account` down**   | **Không** cấp token — trạng thái unknown **không** được coi là active |

⚠️ **Đây là nơi fail-closed của điểm kiểm soát (A) bắt đầu đếm từ.** Không có nhánh nào trong bảng trên cấp token, và điều đó là thuộc tính của thiết kế chứ không phải hành vi cần bảo trì. ⚠️ **Phạm vi của bảo đảm này là _trạng thái mà contract đọc trả về_**, không phải "mọi response sau commit đều bị chặn" — xem race ở rule 1–5 ngay dưới.

**Đây là chặn token MỚI, không phải thu hồi token ĐÃ CẤP.** Ngay cả khi trả về `suspended`, mọi access token đã phát hành vẫn được chấp nhận tới hết TTL ở mô hình verify offline — xem §6.1, §6.2. Contract này **không** thay thế revocation check.

⚠️ **Contract này không làm được việc của event.** Nó bảo đảm _lần phát hành kế tiếp_ thấy trạng thái mới nhất; nó **không** làm token đã cấp mất hiệu lực. Độ trễ thu hồi token đã cấp vẫn là TTL access token ở mô hình offline, và **không** phải câu hỏi này trả lời được. Cơ chế event/outbox là đường **lan truyền và reconciliation**; giới hạn thật của nó ở §7.1.

**Thứ tự xử lý khi suspend/delete** — việc ghi state là của `account`, nhưng `auth` phải giữ được trạng thái nhất quán ở mọi bước:

1. `account` ghi state **trong `db-account`** (authority) và commit — **không** chờ `auth`.
2. `account` phát event qua transactional outbox; `auth` thu hồi grant, đánh dấu refresh family, ghi `token_revocations` mức toàn subject.
3. **Từ thời điểm bước 1, lần phát hành _tiếp theo_ bị chặn nếu nó đọc trạng thái _sau_ commit đó** — kể cả trước khi event tới, vì nó hỏi `account` chứ không hỏi projection. ⚠️ Câu này **có điều kiện thời điểm**: một request đã đọc `active` trước commit rồi ghi token sau commit vẫn cấp thành công. Bản trước viết "bất kỳ lần phát hành nào" — câu đó tuyệt đối hoá một điều kiện mà thiết kế hiện tại không bảo đảm, và mâu thuẫn trực tiếp với rule 2 ngay dưới.

**Race giữa kiểm tra trạng thái và cấp token** — ⚠️ **đây là một race in-flight, và tài liệu này không tuyên bố loại bỏ được nó.** Giữa thời điểm đọc trạng thái và thời điểm ghi token, một suspend/delete có thể commit. Năm quy tắc dưới đây là **toàn bộ** ngữ nghĩa được cam kết — không có câu nào khác được phép thêm vào:

1. **Điểm kiểm soát (A) chỉ hứa chặn token MỚI, và chỉ trong điều kiện ở rule 2.** Không câu nào ở đây nói rằng mọi token response sau thời điểm suspend commit đều bị chặn tuyệt đối.
2. **Sau khi `account` commit suspend, lần phát hành kế tiếp bị chặn — _nếu_ nó đọc trạng thái sau commit đó.** Đây là điều kiện **thời điểm**, không phải điều kiện hệ thống: một request đã đọc trạng thái _trước_ commit rồi ghi token _sau_ commit vẫn cấp token thành công. Không có gì trong thiết kế này ngăn được điều đó.
3. **Không lần phát hành nào được chỉ dựa vào projection event.** Projection trong `db-auth` là đường **lan truyền và reconciliation**; nó không thay thế lệnh gọi read-only ở §6.0 và không được phép là nguồn quyết định phát hành.
4. **Phải gọi tên đây là race in-flight, và không được tuyên bố "mọi token response sau khi suspend commit đều bị chặn".** Câu đó sai ở rule 2, và nó khiến người đọc tin rằng độ trễ thu hồi bằng 0. Độ trễ thu hồi token **đã cấp** vẫn là TTL access token ở mô hình verify offline (§6.1).
5. **Ngữ nghĩa mạnh hơn — "không có token response nào thành công sau khi suspend commit" — là một yêu cầu chưa được thỏa, và là decision gate.** Thỏa nó đòi serialize việc phát hành với việc ghi trạng thái, tức là một thỏa thuận về tính nhất quán giữa `db-account` và `db-auth` mà ranh giới service hiện tại **không** cung cấp — invariant 25 cấm cross-database query để làm việc đó. Cho tới khi có quyết định nối, `auth` hành xử đúng như bảng ở trên và **không** tuyên bố gì mạnh hơn.

**Rule 1–4 là hành vi bắt buộc; rule 5 là ranh giới của hành vi đó.** Nếu sau này cần đạt rule 5, đó là một thay đổi kiến trúc cần chốt riêng, không phải một chi tiết cài đặt.

**Giảm thiểu, không phải loại bỏ:**

| Biện pháp                                       | Chống được gì                  | Còn sót gì                                |
| ----------------------------------------------- | ------------------------------ | ----------------------------------------- |
| Đọc trạng thái **sau cùng** trước khi ghi token | Đóng cửa sổ race               | Suspend xảy ra _sau_ lệnh ghi đó          |
| Ghi token vào cùng transaction `db-auth`        | Không để trạng thái cấp nằm lẻ | Suspend đến sau commit vẫn là race hợp lệ |
| Projection event trong `db-auth` thu hồi grant  | Chặn _các lần cấp tiếp theo_   | Token đã cấp, theo §6.1                   |

⚠️ **Sai lầm phổ biến: gọi race này là "sẽ được xử lý bằng transaction".** Không có distributed transaction nào giữa `db-account` và `db-auth` — và không được có, vì invariant 25 cấm cross-database query. Race là thuộc tính của ranh giới này; phải ghi nhận chứ không giấu.

**Idempotency và retry:** contract là read-only nên **an toàn khi retry**; `auth` phải dùng timeout có giới hạn và **không** retry vô hạn — mỗi lần retry là thêm độ trễ cho một người dùng đang chờ token. Số lần retry tối đa và timeout cụ thể chưa chốt (§9).

**Trong lúc phục hồi database hoặc contract:** `account` phục hồi xong mà `db-auth` còn projection cũ, hay ngược lại — ở **cả hai** chiều, contract là nguồn sự thật cho lệnh phát hành. Projection cũ trong `db-auth` không được phép cấp token; trạng thái unknown xử lý như bảng trên.

### 6.1 Hai điểm kiểm soát khác nhau — không gộp làm một

Đây là chỗ dễ sai nhất. **Phát hành** và **sử dụng** là hai enforcement point tách biệt, mỗi cái có giới hạn riêng:

|                                                   | **(A) Phát hành token**                                                                           | **(B) Resource server xác thực token**                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Ai kiểm soát                                      | `auth`                                                                                            | Resource server (dùng JWT offline, hoặc gọi introspection) |
| Luôn hỏi được trạng thái account?                 | **Có** — qua contract `auth → account` (§6.0), không đọc DB                                       | **Không** nếu verify offline                               |
| Có thể chặn token **mới** của subject bị suspend? | **Có** — với điều kiện thời điểm ở §6.0 rule 2; race in-flight vẫn tồn tại                        | Chỉ khi còn mạch kiểm thu hồi                              |
| Khi hệ thống thu hồi hỏng                         | **Fail closed** — không cấp token mới                                                             | Phụ thuộc mô hình; xem bảng dưới                           |
| Bảo đảm được                                      | Không có lần phát hành **mới** nào cho subject đã suspend, **trừ** race in-flight đã mô tả ở §6.0 | **Không** bảo đảm gì nếu offline                           |

⚠️ **Chỉ (A) mới có bảo đảm fail-closed — và bảo đảm đó không bao gồm việc loại bỏ race.** `auth` nằm trên đường phát hành nên nó luôn hỏi được trạng thái account qua contract đã xác thực (§6.0); nhưng một request đã đọc trạng thái trước khi suspend commit vẫn cấp được token (§6.0 rule 2, 4). Resource server verify offline thì **không** có bảo đảm nào, kể cả fail-closed, và không nên được mô tả như có.

### 6.2 Mô hình verify của resource server

Đã chốt ở mức cấu hình provider: **access token là JWT ES256 TTL 300 giây, resource server verify offline bằng JWKS**; provider **không** mount `/introspect` (`features.introspection` tắt, `apps/auth/src/oidc/provider.ts`) và **bật** `/revocation` (RFC 7009). Bảng dưới giữ để đối chiếu ba mức đã phân tích khi chốt:

| Mức                       | Cách resource server validate            | Thấy thu hồi sau     | Thấy suspend sau     | Trạng thái thu hồi unavailable                              |
| ------------------------- | ---------------------------------------- | -------------------- | -------------------- | ----------------------------------------------------------- |
| **Offline JWT** ← chọn    | Verify chữ ký bằng key từ JWKS           | Tới hết TTL token    | Tới hết TTL token    | Không hỏi được → token vẫn được chấp nhận                   |
| **Introspection**         | Gọi `auth` mỗi request (hoặc cache ngắn) | Tới độ trễ kiểm tra  | Tới độ trễ kiểm tra  | **Fail closed** — từ chối                                   |
| **Short-lived + refresh** | Access token rất ngắn, verify offline    | Tới TTL access token | Tới TTL access token | Không hỏi được → token vẫn được chấp nhận, nhưng cửa sổ nhỏ |

⚠️ **Fail-closed chỉ có nghĩa ở mức introspection.** Ở mức offline, "không hỏi được trạng thái thu hồi" không dẫn tới từ chối — nó dẫn tới **không có gì để dựa vào**, và mô hình đó chấp nhận hậu quả là độ trễ thu hồi bằng TTL access token. Nói "fail closed" cho offline là tuyên bố sai.

Cơ chế xác thực chữ ký là của provider (`jose`/JWKS nội bộ của `oidc-provider`); `auth` chỉ chịu trách nhiệm công bố JWKS đúng `kid` và không mount endpoint introspection.

### 6.3 Cache và staleness

- **TTL cache kiểm thu hồi không bao giờ dài hơn TTL access token.** Cache hit trả "active" quá ngưỡng đó là sai.
- **Cache phải gắn với một đối tượng cụ thể**, không phải "subject còn active" chung — vì `sub` có thể bị thu hồi theo client, theo scope, hoặc toàn bộ.
- **Staleness tối đa chấp nhận được là quyết định chưa chốt**, và nó là con số duy nhất quyết định "thu hồi mất bao lâu". Không con số nào ở đây là cam kết đã chứng minh ([`01` §10](../../architecture/01-architecture.md)).

| Quyết định chưa chốt                                                   | Vì sao chưa chốt được ngay                                                                                                    | Owner                | Trigger                                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------- |
| **Staleness tối đa** của trạng thái account mà `auth` chấp nhận        | Nó là một con số phụ thuộc mô hình verify, độ trễ hạ tầng chấp nhận được và hậu quả khi đọc sai — cả ba đều chưa có           | Security + SRE       | Trước token ký đầu tiên; mọi con số ghi vào tài liệu trước đó là giả định         |
| **Timeout và số lần retry** của contract `auth → account`              | Quá ngắn thì hạ tầng bình thường sinh false negative; quá dài thì user chờ vô ích. Cần đo trước khi đặt                       | SRE                  | Trước endpoint phát hành đầu tiên                                                 |
| **Ngữ nghĩa mạnh hơn** "không token nào thành công sau suspend commit" | Đòi serialize phát hành với ghi trạng thái — thỏa thuận nhất quán xuyên database mà ranh giới hiện tại không có (§6.0 rule 5) | Security + kiến trúc | Khi có yêu cầu compliance đòi độ trễ thu hồi bằng 0 — **không** phải khi tiện tay |

⚠️ **Không được điền số vào đây để "chốt cho xong".** Ba dòng trên là quyết định đang mở; điền một con số chưa đo sẽ biến một giả định thành một cam kết mà tài liệu không có cơ sở để đứng sau.

### 6.4 Liên kết grant / token / subject

`token_revocations` (§3.2) ghi append-only và hỗ trợ **ba mức thu hồi**:

| Mức                  | Phạm vi                         | Ví dụ kích hoạt                                   |
| -------------------- | ------------------------------- | ------------------------------------------------- |
| **Toàn subject**     | Mọi token của `sub`, mọi client | Account bị suspend hoặc xoá                       |
| **Theo client**      | `sub` + `client_id`             | User thu hồi một app trong Connected applications |
| **Theo token/grant** | Một grant hoặc token cụ thể     | Phát hiện refresh token lộ                        |

Mức thu hồi phải được kiểm ở **thời điểm phát hành** và — ở mức introspection — ở **mỗi lần xác thực**. Thu hồi mức nhỏ hơn không được xoá bản ghi mức lớn hơn.

⚠️ **Suspended/deleted subject** bị chặn tại thời điểm phát hành **khi lần phát hành đó đọc trạng thái sau commit**, bất kể đã nhận event hay chưa ([`../account/01-architecture.md`](../account/01-architecture.md) §6) — đây là bảo đảm thuộc điểm kiểm soát (A), và nó **có điều kiện thời điểm** (§6.0 rule 2). Một request đã đọc `active` trước commit vẫn phát hành được sau commit; đó là race đã thừa nhận, không phải hành vi chưa định nghĩa.

### 6.5 Xoá `kid` khỏi JWKS không vô hiệu token đã cấp

⚠️ **Đây là tuyên bố sai nếu nói "xoá `kid` thu hồi được token".** Thực tế:

1. Resource server cache JWKS theo HTTP cache header của chính endpoint đó.
2. Sau khi `auth` xoá `kid`, resource server vẫn verify được token đã ký bằng key đó **cho tới khi cache của nó hết hạn**.
3. Với token **tự chứa** (`kid` nằm trong header), việc có kiểm `kid` còn trong JWKS hay không phụ thuộc có còn mạch introspection hay không — và nếu resource server không hỏi `auth`, nó **không** có cách nào biết `kid` đã bị xoá.

Vì vậy:

| Tuyên bố                                           | Đúng không                                           |
| -------------------------------------------------- | ---------------------------------------------------- |
| "Xoá `kid` ngăn token **mới** được ký bằng key đó" | ✅ Đúng                                              |
| "Xoá `kid` làm token **đã cấp** hết hiệu lực ngay" | ❌ **Sai** — phụ thuộc cache và cửa sổ introspection |

**Khi signing key bị compromise**, phải xử lý cả hai lớp: (i) xoá `kid` khỏi JWKS để chặn token mới, và (ii) ghi `token_revocations` mức toàn subject — vì (i) một mình không đủ. ⚠️ **Cả hai đều không đủ để tuyên bố containment**: (ii) chỉ có tác dụng ở verifier thực sự hỏi nguồn thu hồi, và ở mô hình verify offline thì không có verifier nào hỏi. Runbook → [`03-operations.md`](./03-operations.md) §11.

⚠️ **Hệ quả:** "đổi key ngay" là thao tác **bắt buộc có kế hoạch**, vì nó còn phụ thuộc TTL access token và cache của resource server. Đây là một trong các lý do TTL access token không nên dài.

⚠️ **Thu hồi theo subject KHÔNG bao phủ token tự ký — và đây là lỗ hổng thật, không phải chi tiết vụn vặt.** Khi attacker giữ private key, hắn **không cần** đánh cắp refresh token hay giành session: hắn tự ký token bất kỳ với `sub` bất kỳ — kể cả một `sub` chưa từng tồn tại, hoặc một tài khoản mà hắn không hề biết. Thu hồi theo "các subject đã biết" không chạm tới những token đó, và ở mô hình verify offline không có cơ chế nào để chặn chúng ngoài việc thay key.

| Tình huống                              | `kid` còn trong JWKS | `kid` đã xoá, verifier cache cũ | `kid` đã xoá, verifier đã refresh |
| --------------------------------------- | -------------------- | ------------------------------- | --------------------------------- |
| Token hợp lệ đã cấp từ trước            | Chấp nhận            | **Chấp nhận** (tới hết cache)   | Từ chối                           |
| Token attacker tự ký, `sub` **đã biết** | **Chấp nhận** ⚠️     | **Chấp nhận** ⚠️                | Từ chối                           |
| Token attacker tự ký, `sub` **bất kỳ**  | **Chấp nhận** ⚠️     | **Chấp nhận** ⚠️                | Từ chối                           |

⚠️ **Ở mô hình offline, cột giữa và cột phải là ranh giới containment.** Chỉ khi **mọi** resource server đã refresh JWKS (tức cache đã hết hạn hoặc bị purge) thì token ký bằng key bị lộ mới thật sự bị chặn. Trước thời điểm đó, attacker ký được token tùy ý mà không gặp rào cản nào.

⚠️ **Vì vậy: ở mô hình verify offline, không thể tuyên bố sự cố đã được containment chỉ bằng việc xoá `kid` và ghi `token_revocations`.** Điều kiện để tuyên bố containment là **cả hai**: (i) key bị lộ không còn ký được token nào được bất kỳ verifier nào chấp nhận — tức mọi cache JWKS đã hết hạn hoặc bị purge chủ động; và (ii) các token đã cấp hợp lệ đã hết TTL hoặc bị chặn. Với (i) đúng là **cửa sổ theo cache**, không phải thời điểm bạn chọn. Toàn bộ quy trình và điều kiện tuyên bố → [`03-operations.md`](./03-operations.md) §11.1.

### 6.6 Refresh token

- **Rotation**: mỗi lần dùng refresh token sinh token mới; token cũ đánh dấu đã dùng.
- **Reuse detection**: dùng lại token đã rotate là dấu hiệu lộ token → **thu hồi toàn bộ family**, buộc re-authenticate.
- Lưu hash, không lưu giá trị. Không refresh token nào vào URL, log hay audit.
- ⚠️ Vì refresh token **luôn** đi qua `auth`, nó thuộc điểm kiểm soát (A): refresh **luôn** fail closed và **luôn** kiểm được trạng thái account.

### 6.7 Logout — hai thao tác tách biệt

| Thao tác                 | Ai làm    | Ảnh hưởng                                                |
| ------------------------ | --------- | -------------------------------------------------------- |
| **Browser logout**       | `account` | Xoá browser session; user phải đăng nhập lại ở `account` |
| **Revoke grant / token** | `auth`    | Client không lấy được token mới theo grant đó            |

⚠️ Browser logout **không** tự thu hồi token đã cấp cho client khác. Đây là hành vi chuẩn và là điểm dễ hiểu sai nhất: user đăng xuất khỏi trình duyệt không có nghĩa app đã cấp token bị vô hiệu. Muốn thì phải vào **Connected applications** và thu hồi tường minh ([`../account/02-requirements.md`](../account/02-requirements.md) FR-012).

RP-initiated logout **đã bật** trong provider: route `end_session` tại `/session/end` (`PROVIDER_ROUTES`, `apps/auth/src/oidc/provider.ts`; `features.rpInitiatedLogout` bật). Back-channel logout vẫn là **quyết định chưa chốt** (§9) — không có endpoint nào trong source.

## 7. Vòng đời account — nhận và lan truyền

`db-auth` **không** giữ trạng thái account; nó giữ _projection_ để kiểm nhanh, và coi `account` là authority. Ngữ nghĩa nghiệp vụ của từng sự kiện → [`docs/domains/auth/domain-model.md`](../../domains/auth/domain-model.md) §4.6.

| Sự kiện từ `account`  | Xử lý trong `db-auth`                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Suspend**           | `token_revocations` cho toàn subject; đánh dấu grant `revoked`; refresh families bị thu hồi; chặn phát hành mới      |
| **Reactivate**        | Không hồi sinh grant; user phải consent lại                                                                          |
| **Credential change** | Audit event; grant hiện hành **không** tự thu hồi (password change ≠ authorization change)                           |
| **Delete**            | Grant `revoked`; token đã cấp không còn hợp lệ; `sub` giữ nguyên ở `db-auth` theo retention, **không** tái phát hành |

⚠️ **Hàng "Delete" cần đọc cùng §6.0.** "Token đã cấp không còn hợp lệ" ở đây là **ý định kiểm soát**, không phải hành vi tức thời: ở mô hình verify offline, token đã cấp vẫn được chấp nhận tới hết TTL. Hàng này ghi phía `auth` làm gì khi nhận event; phần _bảo đảm chặn token mới_ là việc của contract §6.0 và đó là bảo đảm duy nhất.

### 7.1 Cơ chế lan truyền — và giới hạn thật của nó

`account` ghi event vào **transactional outbox** trong `cùng transaction` với state đổi ([`01` A8](../../architecture/01-architecture.md)) — commit thành công là event tồn tại, không thể mất. Điều đó **không** bảo đảm `auth` nhận được.

| Vấn đề                                            | Xử lý bắt buộc                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Event mất** (relay chết, hết retry)             | Outbox item ở trạng thái chưa publish + reconciliation định kỳ phát lại; `auth` **không** tin "chưa nghe gì = vẫn active" |
| **Giao lặp** (at-least-once, `04` QU1)            | Consumer **idempotent** theo event id; thu hồi là set-union nên giao lặp vô hại                                           |
| **Trễ**                                           | Bị giới hạn bởi staleness tối đa chấp nhận được — chưa chốt ([`01` §10](../../architecture/01-architecture.md))           |
| **Partial failure** (outbox commit, publish fail) | Item giữ nguyên trong outbox; không đánh dấu published nếu chưa gửi thành công                                            |
| **Thứ tự**                                        | Không dựa vào thứ tự từ kênh ([`01` invariant 8](../../architecture/01-architecture.md))                                  |

⚠️ **Kiểm tra tại thời điểm phát hành là chốt chặn cuối, không phải tối ưu.** `auth` không cấp token cho `sub` mà nó biết là suspended/deleted, bất kể event đến hay chưa — và nó biết điều đó nhờ **contract đồng bộ** (§6.0), không nhờ event. ⚠️ **Nó vẫn không đóng được race in-flight** giữa lệnh đọc trạng thái và lệnh ghi token (§6.0 rule 2); đây là ranh giới của ranh giới service hiện tại, không phải thứ event có thể chữa. Best-effort là **giới hạn của thiết kế event-driven**, không phải lựa chọn thoải mái — nếu muốn thu hồi tức thời thật sự, phải dùng mô hình revocation check (§6) và trả giá một lần gọi cho mỗi lần dùng token.

## 8. Architectural invariants (ứng dụng)

1. `auth` chỉ đọc/ghi `db-auth`. Không đọc `db-account`, không cross-database query, không `postgres_fdw`/`dblink` ([`01` invariant 25](../../architecture/01-architecture.md)).
2. `auth` không có UI và không render login/consent. `account` không implement endpoint protocol ([`01` invariant 24](../../architecture/01-architecture.md)).
3. Không credential, session cookie hay trusted identity assertion nào đi qua query parameter; authorization code trong query param là hành vi chuẩn OAuth vì nó đi tới `redirect_uri` đã đăng ký. `account` **đẩy** kết quả xác thực qua back-channel, không phải `auth` kéo (§5.1, [`01` invariant 27](../../architecture/01-architecture.md)). `auth` **không bao giờ** dùng back-channel để xác minh phiên trình duyệt — lệnh gọi đó mang credential của Worker, không mang cookie trình duyệt (§5.1(a)).
4. `auth` bind consent vào `sub` + client + redirect_uri + scope + transaction của chính nó; `account` chỉ gửi quyết định, không gửi danh tính client hay scope ([`01` invariant 28](../../architecture/01-architecture.md)).
5. Authorization transaction, `state`, `nonce`, PKCE challenge, authorization code và **cả ba handle X/Y/Z** nằm trong `db-auth`, **single-use** qua compare-and-set, có TTL; không nằm ở KV, Queue hay Worker memory ([`01` invariant 26](../../architecture/01-architecture.md)).
6. **Transaction gắn với đúng trình duyệt đã bắt đầu nó, không chỉ với handle.** `auth` cấp cookie `__Host-auth-browser` khi trả `302` từ `/authorize`, lưu hash của nó trên transaction, và từ chối mọi `POST /internal/session/verified` cho tới khi `/authorize/confirm` xác nhận khớp. Đây là điều kiện tiên quyết của bước push, không phải kiểm tra tuỳ chọn (§5.1.0 điều kiện 2, §5.1.1, §5.3).
7. **Handle X/Y/Z là HMAC chứ không phải hash của `event_id`.** Cùng một khoá `K_auth` trong Worker Secrets, tách miền theo loại handle, có `key_version` ghi lại lúc cấp; `event_id` chỉ là khoá idempotency công khai và **không** đóng vai trò bí mật (§5.6).
8. `sub` không tái sử dụng, không tái phát hành.
9. Consent decision là **bằng chứng lịch sử**; grant là **quyền hiện hành**. Xoá consent **không** thu hồi grant, và thu hồi grant **không** xoá consent ([`docs/domains/auth/domain-model.md`](../../domains/auth/domain-model.md) §3.4).
10. Refresh token rotation với reuse detection thu hồi **toàn bộ family**.
11. Browser logout và token/grant revocation là hai thao tác riêng; không suy ra cái này từ cái kia (§6.7).
12. **Cả ba nhánh hoàn tất — grant sẵn có, consent được chấp thuận, consent bị từ chối — đều kết thúc ở `GET /authorize/complete`, và chỉ `auth` dựng OAuth success/error redirect.** `account` không dựng `redirect_uri`, `code`, `state` hay OAuth error; nó chỉ `302` browser theo `continue_url` do `auth` dựng (§5.1).
    12a. ⚠️ **`access_denied` là OAuth error redirect của `auth`, không phải outcome của contract back-channel.** `POST /internal/session/verified` có **ba** outcome — `consent_required`, `granted`, `already_processed` (FR-009i; bảng outcome ở §5.1.1, cả ba đều `200` kèm body) — và ba giá trị đó là toàn bộ. `invalid_request`/`invalid_grant` mà bảng state machine (§5.1.2 hàng 3 và 12) nêu là **kết quả từ chối**, mô hình riêng bằng `SessionVerifiedRejectionReason` ở bản canonical, **không** phải outcome thứ tư; ⚠️ chúng **không** được đọc thành outcome vì union canonical chỉ có ba giá trị và một route implement theo 12a bản cũ sẽ không typecheck. `access_denied` chỉ sinh ra ở `/authorize/complete` khi grant đã mất hiệu lực giữa bước 11 và bước 16 (hàng 14), lúc đó browser đang ở `auth` và `account` **không** có mặt. Hệ quả bắt buộc: **`account` không cần, và không được có, bất kỳ xử lý nào cho `access_denied`** — nếu nó xuất hiện trong response của contract thì đó là contract bug, không phải nhánh cần vẽ (§5.1.1, §5.1.2).
13. **Authorization hoàn tất đúng một lần.** Phát hành code đi qua CAS-consume continuation trong **cùng transaction `db-auth`** — retry, replay, hay hai completion đồng thời đều không cấp code thứ hai. Retry sau khi Z đã consume trả `invalid_grant`, và đường recovery là `/authorize` mới (§5.1.2 hàng 9, §5.1.5c).
14. **Trước khi cấp code, session phải còn thuộc đúng subject của transaction.** Kiểm ở bước 9 (`POST /internal/session/verified`) và lại ở bước 16 (`GET /authorize/complete`); bước 16 là chốt chặn cuối ngay trước khi code được cấp (§5.1.0 điều kiện 3, §5.5).
15. **Handle không phải bằng chứng danh tính** — cả X, Y và Z. Mỗi handle chỉ là **định danh một authorization request**; bằng chứng danh tính là session đã xác thực, kiểm ở bước 6 (cho X) và bước 9 + 11 (cho Y) (§5.3, §5.5).
16. **Ràng buộc của handle là _một cặp_, không phải _một số_.** Với Z, phát biểu đúng là: `Z` **cộng với** cookie `__Host-auth-browser` của trình duyệt đã mở `/authorize` là capability đủ để hoàn tất transaction. Vì vậy thiết kế **không** tuyên bố "biết Z không đủ để lấy code"; nó nói cái đúng: Z một mình không đủ, và thiếu cookie thì browser bắt đầu `/authorize` lại (§5.1.4).
17. **Consent handle `Y` không dựa vào bằng chứng nào do browser đưa.** Ràng buộc của Y là một bản ghi server-side gắn `account_session_ref` lúc `auth` bind danh tính; `account` phải lấy ASR từ **session của chính mình**, không forward ASR tuỳ ý do browser đưa; và ASR chỉ có tác dụng khi đi kèm cặp `(Y, sub, …)` khớp trong `db-auth` (§5.5, §5.7).
18. **Phát hành** token luôn hỏi được trạng thái account qua contract `auth → account` (§6.0) nên fail closed là bảo đảm **đối với trạng thái mà contract đọc trả về**; nó **không** loại bỏ race in-flight, và **resource server** verify offline thì **không** có bảo đảm đó. Trạng thái thu hồi unknown không được coi là active ở bất kỳ mức nào có mạch kiểm tra (§6.0 quy tắc 5, §6.1, §6.2).
19. Private signing key không lưu trong `db-auth`; chỉ lưu metadata (§3.4).
20. Audit event không chứa token, `code_verifier`, secret, handle, `account_session_ref` hay assertion; append-only; lâu hơn dữ liệu chức năng (§5.7).
21. Xoá `kid` khỏi JWKS chỉ chặn token **mới**; nó **không** vô hiệu token đã cấp tại resource server đang cache key. Khi key bị compromise phải làm cả hai việc (§6.5).

## 9. Chưa chốt

Ba quyết định dưới đây từng phải chốt trước endpoint protocol đầu tiên ([`01` §10](../../architecture/01-architecture.md)); **hai cái đầu đã có đáp án trong code**:

| Mục                                      | Trạng thái                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Library OAuth 2.0/OIDC**               | **Đã chốt**: `oidc-provider` 9.12.2, pin tại `apps/auth/package.json`, chạy trên Workers qua bridge `cloudflare:node` (`apps/auth/src/oidc/runtime.ts`). Provider cấp mọi bằng chứng protocol: authorization code + PKCE S256, refresh rotation + reuse detection, discovery, JWKS. Glue quanh provider là code riêng (`apps/auth/src/`) |
| **Access-token format + mô hình revoke** | **Đã chốt**: access token là JWT ES256 TTL 300 giây, verify offline bằng JWKS; **không** có `/introspect` (`features.introspection` tắt); revocation endpoint **bật** tại `/revocation` (RFC 7009) (`apps/auth/src/oidc/provider.ts`). Hệ quả: độ trễ thu hồi của token đã cấp = TTL 300 giây (§6.2)                                     |
| **Signing-key custody + rotation**       | Custody đã có hình dạng trong code: private key là **Worker Secret** `AUTH_SIGNING_KEY` (PKCS#8 PEM, `apps/auth/src/config.ts`), `db-auth` chỉ giữ metadata (`auth.signing_keys`, migration 0007). **Chưa chốt**: lịch xoay key và compromise response chi tiết                                                                          |

Đã chốt trong code, chưa phản chiếu hết vào bảng này là TTL cụ thể (`TTL` trong `apps/auth/src/oidc/provider.ts`): authorization code **60 giây**, access token **300 giây**, ID token **300 giây**, refresh token và session cookie **30 ngày tuyệt đối** (tính từ `iat`, rotate không gia hạn), Interaction **600 giây** — khớp trần TTL của `authorization_transactions` (10 phút).

Ngoài ra, chưa chốt và **giữ nguyên ở [`01` §10](../../architecture/01-architecture.md)** thay vì liệt kê lại:

- **Staleness tối đa** trạng thái account mà `auth` chấp nhận, và độ trễ thu hồi tối đa chấp nhận được.
- Lịch xoay signing key và compromise response chi tiết.
- Rate limit / anti-abuse số cụ thể.
- Retention cụ thể của audit/security event.
- Back-channel logout — RP-initiated logout đã bật (§6.7); browser logout không tương đương.
- Cơ chế relay outbox ([`01` §10](../../architecture/01-architecture.md)).
- **Cách chống ghi đè cookie `__Host-auth-browser` giữa hai authorization transaction cùng một trình duyệt** — cookie mang danh sách transaction đang sống, hay cookie per-transaction (§5.3).
