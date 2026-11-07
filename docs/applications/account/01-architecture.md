# Account — Kiến trúc (ứng dụng)

> Phạm vi: thành phần thực thi `account` — runtime, schema và migration của `db-account`, cơ chế cookie/session, envelope HMAC, Service Binding, contract surfaces và observability.
> Mô hình miền (khái niệm, quy tắc nghiệp vụ, vòng đời, invariant nghiệp vụ) → [`../../domains/account/domain-model.md`](../../domains/account/domain-model.md) · yêu cầu kỹ thuật → [`02-requirements.md`](./02-requirements.md) · vận hành → [`03-operations.md`](./03-operations.md) · đối tác protocol → [`../auth/01-architecture.md`](../auth/01-architecture.md).

---

## 1. Mục đích và ranh giới

Ứng dụng `account` phục vụ bounded context `account`: account UI, login UI, consent UI và BFF cho dữ liệu tài khoản. Nó **sở hữu** phần kỹ thuật của phạm vi đó:

| Sở hữu                                                                                                                                 | Không sở hữu                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account UI · BFF · **login UI** · **consent UI** · browser session · credential · MFA/passkey · profile · preference · privacy request | Endpoint protocol OAuth 2.0/OIDC · client registration · grant · token · signing key · staff directory · role · permission · staff-role assignment |

- `account.ecoma.io` là **hostname riêng** — không phục vụ dưới path của `ecoma.io`. Lý do là shared-origin: XSS ở một app không được đọc cookie của app khác ([`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §7).
- **Ranh giới bằng chứng:** `account` là nguồn sự thật duy nhất cho "người này đã xác thực". `auth` **không** đọc `db-account`, không đọc credential, không đọc session; nó nhận kết quả xác thực qua contract đã xác thực ([`../auth/01-architecture.md`](../auth/01-architecture.md) §5).
- Ngược lại, `auth` là nguồn sự thật cho "người này đã ủy quyền app nào". `account` hiển thị trạng thái đó qua contract, không đọc `db-auth`.
- Ngữ nghĩa nghiệp vụ của từng khái niệm, kể cả ranh giới danh tính ↔ quyền nghiệp vụ, thuộc [`../../domains/account/domain-model.md`](../../domains/account/domain-model.md) §1 — không lặp ở đây.

## 2. Runtime

```text
account.ecoma.io  (Cloudflare Worker, Nuxt 4 + Nitro preset cloudflare_module)
├── Hyperdrive binding → db-account      (query cache OFF)
├── Service Binding  → auth              (chỉ khi luồng login/consent cần)
└── Worker Secrets                       (không có provider credential — gửi mail qua transactional-mail)
```

- Worker identity lâu dài là `ecoma-account`, không có suffix môi trường; staging là `stg-ecoma-account`. PR không tạo Worker mới ([`../../architecture/02-delivery.md`](../../architecture/02-delivery.md) §5.1).
- `nodejs_compat` là **bắt buộc**: Nitro đọc config này để bật `cloudflare.nodeCompat`, và nó quyết định build có polyfill Node cho runtime bundle hay không. Bỏ flag ⇒ runtime lỗi trong khi `wrangler deploy --dry-run` **vẫn báo pass**. `auth` thì ngược lại — `auth` mang `runtime:edge` nên **không** bật flag này.
- Không có provider credential trong Worker Secrets — mail đi qua `transactional-mail`, không tự gọi provider.
- Observability enabled ở cấp deployment; chi tiết vận hành → [`03-operations.md`](./03-operations.md) §2.

⚠️ **`Service Binding` từ Preview gọi production** (platform fact `PW4`, [`../../architecture/04-platform-facts.md`](../../architecture/04-platform-facts.md)). Worker production giữ Hyperdrive production → một Preview gọi binding là đang **ghi vào database production qua một Worker production**. Vì vậy login/consent E2E trong Preview **không** dùng dependency mode A ([`../../architecture/02-delivery.md`](../../architecture/02-delivery.md) §5.3).

## 3. Mô hình dữ liệu — `db-account`

Greenfield: **không có** schema hay migration history chung nào để kế thừa ([`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §4). Dưới đây là **logical specification** — định nghĩa ý nghĩa, ràng buộc, vòng đời; **không** phải DDL, không chốt kiểu cột vật lý hay index cụ thể.

Quy ước: `sub` là **opaque, không tái sử dụng, không tái phát hành**; mọi cột thời gian là UTC. Kiểu vật lý và index chốt ở migration, mỗi index phải gắn với một truy vấn hoặc ràng buộc cụ thể — không thêm index "cho chắc".

### 3.1 Sơ đồ quan hệ

```text
users 1───1 user_profiles
  │ 1
  ├───* email_addresses          (nhiều email; ≥1 verified để đăng nhập được; tra cứu theo address_hash)
  ├───1 password_credentials     (điều kiện — chỉ khi password auth được bật)
  ├───* authenticators           (passkey | totp — một bảng, discriminator)
  ├───* account_sessions         (mỗi device/mỗi lần đăng nhập)
  ├───* login_handoffs           (handle X ↔ session nào đã trình nó; §3.6)
  ├───1 user_preferences
  ├───1 notification_preferences
  ├───* privacy_requests         (export | correct | delete | restrict | object)
  └───* account_outbox_events    (event sang auth)

email_addresses        (chủ sở hữu dữ liệu email; §3.7)
otp_challenges         (kho challenge OTP, không FK tới email_addresses; §3.7)
security_events        (audit, ghi append-only, không FK tới users để giữ được sau tombstone)
privacy_notices        (version + nội dung đã phát hành)
privacy_acknowledgements  (user đã nhận version nào)
legal_consents         (cơ sở pháp lý cụ thể, KHÁC oauth consent)
account.internal_nonces (kho nonce chống replay của envelope; §8.2)
```

### 3.2 Entity

| Entity                                         | Mục đích và trạng thái                                                                                                                   | Ràng buộc chính                                                                                                                                                                                                                                       | Dữ liệu nhạy cảm                                        | Vòng đời                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| `users`                                        | Subject và trạng thái account: `active` \| `suspended` \| `deleted`                                                                      | `sub` UNIQUE, không tái phát hành; `deleted` là **tombstone**, giữ `sub` để token cũ không resolve nhầm sang người khác                                                                                                                               | `sub` (pseudonymous, nhưng là khóa nối mọi record khác) | Nhóm (1) tombstone — duy nhất giữ lâu dài, xem §7.1 |
| `user_profiles`                                | Tên hiển thị, avatar, thông tin hồ sơ do user chủ động nhập                                                                              | 1:1 `users`                                                                                                                                                                                                                                           | Có — tên/ảnh là personal data                           | Theo account                                        |
| `user_emails` / `email_addresses`              | Email + trạng thái xác minh: `pending` \| `verified` \| `revoked`                                                                        | ≥1 `verified` mới đăng nhập được bằng email; UNIQUE trên email đã verify. Tên bảng vật lý là `email_addresses` (migration 0005), tra cứu theo `address_hash`, **không** theo địa chỉ trần (§3.7)                                                      | Có — high                                               | Theo account                                        |
| `password_credentials`                         | Hash mật khẩu                                                                                                                            | **Chỉ tồn tại khi password auth bật**; hash chậm + salt; **không** lưu reversible                                                                                                                                                                     | Có — cao                                                | Theo account                                        |
| `authenticators`                               | Passkey credential và TOTP. Passkey: credential id public, counter, kỳ thọ. TOTP: **secret mã hoá ở tầng ứng dụng**, không lưu plaintext | Mỗi loại một discriminator; passkey credential id UNIQUE; counter phải đơn điệu để phát hiện clone                                                                                                                                                    | Có — rất cao (TOTP secret là bearer tới MFA)            | Có thể thu hồi độc lập                              |
| `recovery_codes`                               | Mã dự phòng khi mất MFA                                                                                                                  | Hash; **single-use**; đếm số lần dùng                                                                                                                                                                                                                 | Có — cao                                                | Bị consume khi dùng                                 |
| `account_sessions`                             | Phiên cookie trình duyệt                                                                                                                 | **Chỉ lưu hash session identifier**, không lưu giá trị cookie; `expires_at`; `revoked_at`; `acr` + `authn_at` (mức xác thực và thời điểm xác thực, để đo tuổi bằng chứng); `session_ref` (định danh instance session, dùng cho `account_session_ref`) | Có — cao                                                | TTL + thu hồi                                       |
| `user_preferences`                             | Preference cá nhân: `locale`, `timezone`, `color_mode`                                                                                   | Typed columns, **không** JSONB — đây là contract ổn định đọc bởi nhiều service (§3.3)                                                                                                                                                                 | Không nhạy cảm                                          | Theo account — nhóm (2)                             |
| `login_handoffs`                               | Ràng buộc giữa handle X do `auth` cấp và `account_session` nào đã trình nó: state + session đã bind + thời điểm bind                     | `handle_hash` (hash của X, **không** lưu X) UNIQUE; tạo bằng thao tác **atomic**; session đã bind **không** đổi, không session khác ghi đè; `expires_at`; chuyển binding khi session rotate (§3.6)                                                    | Có — cao (định danh một authorization request)          | TTL ngắn, xoá hẳn — nhóm (2)                        |
| `notification_preferences`                     | Kênh nào được phép gửi cho user                                                                                                          | Ranh giới với `push-notification` (§3.4)                                                                                                                                                                                                              | Có (hành vi)                                            | Theo account — nhóm (2)                             |
| `security_events`                              | Audit đăng nhập: thành công/thất bại, IP, user-agent, lý do                                                                              | **Append-only**; không lưu password/token; IP + user-agent là personal data                                                                                                                                                                           | Có                                                      | Nhóm (3) — retention **mở**, xem §7.1               |
| `privacy_requests`                             | Yêu cầu data subject: `export` \| `correct` \| `delete` \| `restrict` \| `object`; trạng thái + deadline                                 | Có `subject_sub` (opaque, **không FK logic** — đây là chính nó); deadline theo luật                                                                                                                                                                   | Có — cao                                                | Nhóm (3) — theo quy trình, xem §7.1                 |
| `privacy_notices` / `privacy_acknowledgements` | Version notice đã phát hành và user đã nhận                                                                                              | ACK gắn version; **KHÁC** `legal_consents`                                                                                                                                                                                                            | Có                                                      | Theo chính sách — xem §7.1                          |
| `legal_consents`                               | Cơ sở pháp lý cụ thể (vd. điều khoản, xử lý dữ liệu nhạy cảm)                                                                            | Ghi `basis`, `policy_version`, `given_at`, `withdrawn_at`; **KHÁC** OAuth consent (`db-auth`)                                                                                                                                                         | Có                                                      | Nhóm (3) — retention **mở**, xem §7.1               |
| `account_outbox_events`                        | Event sang `auth`, ghi **cùng transaction** với state đổi                                                                                | Idempotency key UNIQUE; `published_at`, `attempts`                                                                                                                                                                                                    | Không                                                   | Dọn sau publish + retention                         |

⚠️ **Cột "Vòng đời" ở trên dùng nhãn nhóm retention, không phải một cam kết thời hạn.** Ý nghĩa ba nhóm, lý do và ràng buộc → [`../../domains/account/domain-model.md`](../../domains/account/domain-model.md) §7.

### 3.3 `user_preferences` — vì sao typed column, không phải JSONB

Ba trường này được đọc bởi **nhiều** service qua contract, và chúng là **contract ổn định**: frontend khác locale, `llm-*`, `backoffice` đều dựa vào chúng. JSONB với key tự do biến một typo thành lỗi runtime im lặng ở tầng consumer và biến schema thành hợp đồng không kiểm soát được. Typed column ép validate ở tầng ghi và cho index được.

| Trường       | Kiểu logic                         | Validate                                                             | Default                                                      | Ảnh hưởng khi đổi                         |
| ------------ | ---------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------- |
| `locale`     | enum `en` \| `vi`                  | Chỉ nhận giá trị trong allowlist; **reject**, không fallback im lặng | Theo `Accept-Language` lúc tạo account, hợp lệ với allowlist | Đổi ngôn ngữ hiển thị; không đụng dữ liệu |
| `timezone`   | IANA TZ name (`Asia/Ho_Chi_Minh`)  | Validate theo tz database; reject tên không có                       | `Asia/Ho_Chi_Minh`                                           | Đổi cách hiển thị thời gian               |
| `color_mode` | enum `system` \| `light` \| `dark` | Enum đóng                                                            | `system`                                                     | Đổi theme                                 |

⚠️ **Không trùng với timezone nghiệp vụ.** `user_preferences.timezone` là thiết lập cá nhân của account (timezone máy người dùng đang ở). Một trường kiểu "timezone giao dịch" của business thuộc service sở hữu nghiệp vụ đó, **không** đọc từ `db-account` — nó là quyết định nghiệp vụ, không phải thiết lập hiển thị. Service nghiệp vụ nhận `timezone` qua contract nếu user muốn dùng làm mặc định, và tự lưu bản riêng.

Contract (`GET`/`PATCH /account/preferences`) → [`02-requirements.md`](./02-requirements.md) §1.3.

### 3.4 Ranh giới với `notification_preferences`

`notification_preferences` chỉ ghi **ý định của user** (kênh nào được phép gửi, tần suất mong muốn). Nó **không** phải danh sách thiết bị, subscription hay delivery state — những thứ đó thuộc `push` (D1) và `web-push-notification-job` ([`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §4). `account` không đọc D1 của service khác và không ghi vào đó; intent được đưa sang qua event/contract.

### 3.5 Cross-service reference

`db-auth` lưu `sub` của user. Đó là **tham chiếu opaque không có foreign key** — `account` không giữ FK trỏ sang `db-auth` (không tồn tại), và không FK trỏ tới bảng "user" của `db-auth` vì nó không có bảng đó. Toàn vẹn tham chiếu chéo là **responsibility của contract**, phát hiện bằng reconciliation ([`../auth/03-operations.md`](../auth/03-operations.md)).

### 3.6 `login_handoffs` — vì sao cần state bền vững, và vì sao nó không đủ một mình

⚠️ **Bản trước không có entity nào giữ quan hệ "handle X ↔ session nào đã trình nó".** Ràng buộc đó được mô tả bằng lời trong §5.1 mà không có nơi lưu, nên nó không hiện thực được: hai request cùng trình X sẽ không có gì để so sánh, và "first-binding-wins" không có nghĩa gì khi không có "first". `login_handoffs` là nơi duy nhất quan hệ đó tồn tại.

**Định nghĩa logic** (không phải DDL — kiểu cột vật lý và index chốt ở migration):

| Trường        | Ý nghĩa                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `handle_hash` | Hash của handle X. **Không lưu X dạng rõ** — X đến từ query string và có thể lọt vào log của tầng trung gian |
| `session_ref` | `account_session_ref` của session **đã trình X lần đầu**                                                     |
| `bound_at`    | Thời điểm binding được tạo — dùng để trả lời "ai đã bind trước" khi có tranh chấp                            |
| `state`       | `bound` → `consumed` \| `session_rotated` \| `expired` (§3.6.2)                                              |
| `expires_at`  | TTL ngắn, bằng TTL transaction phía `auth`                                                                   |

⚠️ **`session_ref` ở đây là con trỏ tới một session, không phải credential.** Nó không được dùng để xác thực ai cả; nó chỉ để so khớp "session đang xử lý X có phải đúng session đã bind X không" (§4).

#### 3.6.1 First-binding-wins phải atomic, và nó là chốt chặn chống **ghi đè**

| Tình huống                               | Kết quả bắt buộc                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Session S1 trình X, chưa có binding      | Tạo binding `X → S1`                                                                                                 |
| **Hai session trình X lần đầu cùng lúc** | **Đúng một** binding thắng; request kia thua và nhận định danh của session đã bind — **không** có request nào ghi đè |
| Session S1 trình X lại (retry)           | Idempotent: trả về binding của S1, không tạo bản ghi thứ hai                                                         |
| Session S2 trình X khi đã bind S1        | Từ chối; **không** ghi đè S1                                                                                         |
| X hết TTL / đã consume                   | `invalid_request`; **không** có đường gia hạn âm thầm                                                                |

⚠️ **"First-binding-wins" chỉ là một thuộc tính của ràng buộc UNIQUE, không phải một quy tắc kiểm tra.** Điều kiện cần giữ là: **chỉ một thao tác atomic duy nhất tạo được bản ghi**; mọi thao tác sau đó là so khớp, không phải ghi. Nếu implementation đọc-rồi-ghi thay vì insert có điều kiện, hai request song song sẽ cùng thấy "chưa có" và cùng ghi — và toàn bộ tính chất trên biến mất.

#### 3.6.2 Session rotation phải chuyển binding, không được làm rơi

Đăng nhập thành công thường **rotate session** (`session_ref` cũ bị thu hồi, `session_ref` mới được cấp) — đúng để chống session fixation. Nhưng X đã bind vào session _trước xác thực_.

⚠️ **Nếu không chuyển binding, login sẽ hỏng: X bị bind vào session đã bị thu hồi, và bước xác thực sẽ không khớp với bản ghi nào.** Nếu chuyển _không kiểm soát_, session thứ ba có thể thừa kế X. Vì vậy chuyển binding là **một thao tác atomic duy nhất**, trong đúng transaction xoay session:

1. Ghi state `session_rotated`, trỏ `session_ref` sang session mới.
2. Session cũ bị thu hồi bởi chính transaction xoay đó.
3. Session mới **kế thừa** binding; không có đường nào để session khác chiếm X giữa hai bước này.

Sau khi xác thực thành công và handoff được dùng, state chuyển `consumed` và bản ghi hết hiệu lực.

#### 3.6.3 ⚠️ First-binding-wins **không** chống được pre-binding — và đó là ranh giới của nó

⚠️ **Đây là điểm mà bản trước im lặng và cần nói rõ.** `login_handoffs` chỉ chặn việc **ghi đè** binding. Nó **không** chứng minh được rằng session đầu tiên bind là session của người dùng hợp lệ:

> Attacker lấy X **trước** (qua referrer, log, history, shoulder-surfing), mở nó bằng **session của chính hắn**, bind thành công vì chưa có ai bind. Các request sau đó của nạn nhân — kể cả nạn nhân — đều bị từ chối vì binding đã thuộc session khác. First-binding-wins **chạy đúng như thiết kế** và vẫn thất bại.

Vì vậy `login_handoffs` là **lớp bảo vệ thứ nhất, không phải lớp duy nhất**, và nó **không đủ một mình**. Lớp thứ hai nằm ở `auth`: transaction gắn với cookie `__Host-auth-browser` mà chính `auth` cấp cho trình duyệt đã nhận `302` từ `/authorize`, và `POST /internal/session/verified` bị từ chối nếu transaction chưa `browser_confirmed` ([`../auth/01-architecture.md`](../auth/01-architecture.md) §5.3). Attacker có X **và** session riêng vẫn không có cookie đó.

**Hai lớp phải cùng tồn tại.** Thiết kế chỉ còn `login_handoffs` thì hở pre-binding; chỉ còn lớp của `auth` thì vẫn để một session bất kỳ đẩy kết quả xác thực cho một transaction nó không khởi tạo.

### 3.7 Đăng nhập email-OTP — hai entity và các ràng buộc đã chốt trong migration

Luồng đăng nhập phương thức duy nhất hiện có là **email-OTP** (`apps/account/server/api/auth/{challenge,verify,session,logout}`). Hai bảng dưới đây có migration thật (`0005`, `0006`) và được integration test phủ; mô tả dưới đây phản chiếu ràng buộc đã chốt trong migration, không phải ý định.

**`email_addresses` (0005) — chủ sở hữu dữ liệu email.** Email là **credential liên lạc + đăng nhập**, không bao giờ là OIDC `sub` (FR-002). Điểm khác so với entity `user_emails` ở bảng trên: bảng giữ thêm `address_hash` (SHA-256 hex của địa chỉ đã normalize) làm **khoá tra cứu** của luồng OTP — index không chứa địa chỉ trần. Chỉ `status = verified` mới nhận OTP đăng nhập. ⚠️ Route BFF thêm/verify email của chính chủ (`POST /api/emails`, `POST /api/emails/:id/verify`) **đã có**, nhưng UI **chưa có ô nhập mã xác minh**; từ góc người dùng, luồng OTP hiện chỉ đăng nhập được địa chỉ đã xác minh sẵn (seed hoặc qua API).

**`otp_challenges` (0006) — kho challenge, không lưu mã OTP.** Bảng chỉ giữ `HMAC-SHA256(key, purpose || ':' || code)` (digest hex 64), key là Worker Secret `NUXT_OTP_HMAC_SECRET` — cùng hình dạng "chỉ lưu dẫn xuất" với `account_sessions.id_hash`. Các ràng buộc đáng chú ý:

| Ràng buộc                                                                   | Hiện thực                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Một challenge active cho mỗi `(address, purpose)`                           | Partial UNIQUE index `(address_hash, purpose) WHERE consumed_at IS NULL`; resend phải consume challenge cũ trong cùng transaction                                                                                                                                                                                                                                                         |
| Challenge cấp được cả cho địa chỉ **chưa tồn tại** trong DB                 | Không FK sang `email_addresses` — anti-enumeration trả lời như nhau và vẫn ghi challenge ma cho địa chỉ lạ (đó chính là rate-limit)                                                                                                                                                                                                                                                       |
| Rate limit đếm từ chính bảng này                                            | 3/15 phút và 10/giờ per `address_hash` — reconstructible từ durable state, không bảng rate-limit riêng, không bộ nhớ cục bộ Worker                                                                                                                                                                                                                                                        |
| Challenge hết hạn bị **khoá nguyên tử**, không để "ở trạng thái active mãi" | `expireChallengeIfExpired` — một `UPDATE ... SET consumed_at WHERE consumed_at IS NULL AND expires_at <= $now` đơn câu; route `verify` gọi ở nhánh hết hạn. Mốc thời gian do caller truyền (không phải `now()` DB) để hai đồng hồ Worker/DB lệch nhau không đổi kết quả của TTL. Chi tiết vòng đời → `apps/account/server/lib/otp.ts`                                                     |
| Trần số lần thử tăng **và khoá trong cùng một câu SQL**                     | `recordFailedAttemptAndLock` là `SET attempts = attempts + 1, consumed_at = CASE WHEN attempts + 1 >= MAX THEN now() END WHERE consumed_at IS NULL` — không read-then-write ở phép cộng, và **khoá nằm trong chính câu tăng** (nếu khoá là UPDATE riêng chạy sau ở route, lần thử `MAX + 1` chen được vào khoảng giữa hai câu — test concurrency đo được trần chạy lên 10 trước khi gộp). |
| Verify là CAS                                                               | `consumeChallenge` chỉ khớp khi `consumed_at IS NULL` — replay một mã đã dùng không tạo session thứ hai                                                                                                                                                                                                                                                                                   |

Tham số OTP (TTL 600 giây, resend cooldown 60 giây, tối đa 5 lần thử, mã 8 chữ số) nằm ở `apps/account/server/lib/otp.ts`; giới hạn gửi mail qua `transactional-mail` tại `apps/account/server/lib/mail.ts` (`POST /v1/messages`, timeout 3 giây, chưa provision service thật).

### 3.8 Migration `db-account`

Migration nằm ở `apps/account/db/migrations/`, idempotent (runner chạy lại toàn bộ mỗi lần apply), forward-only; integration test áp mọi file hai lần (`apps/account/tests/databases/migrations.spec.ts`).

| Migration | Nội dung                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| `0001`    | Core: `users`, `account_sessions`, `login_handoffs`, `security_events`, `account_outbox_events`               |
| `0002`    | Roles và grants                                                                                               |
| `0003`    | `account.internal_nonces` — kho nonce chống replay của envelope (§8.2)                                        |
| `0004`    | Đổi tên `account_sessions.authn_level` → `acr` (đồng bộ với `0012` của `db-auth`)                             |
| `0005`    | `email_addresses`                                                                                             |
| `0006`    | `otp_challenges`                                                                                              |
| `0007`    | Role pruner riêng `ecoma_account_nonce_pruner` cho cron Worker dọn nonce (song sinh với `0014` của `db-auth`) |
| `0008`    | `user_profiles`, `user_preferences`, `notification_preferences`                                               |
| `0009`    | Purpose `verify_email`                                                                                        |
| `0010`    | `privacy_requests`                                                                                            |

Chi tiết vận hành role, provisioning và thứ tự rollout → [`03-operations.md`](./03-operations.md) §3.

## 4. Session, cookie và ràng buộc handle

### 4.1 Thuộc tính cookie

| Thuộc tính            | Giá trị                                                                                                                                             | Vì sao                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Tên cookie            | `__Host-` prefix (`__Host-account-session`)                                                                                                         | Browser chỉ chấp nhận khi `Secure`, `Path=/`, **không** `Domain` → không thể bị subdomain khác ghi đè                                       |
| `Secure`              | bắt buộc                                                                                                                                            | `__Host-` bắt buộc; chặn gửi qua HTTP thường                                                                                                |
| `HttpOnly`            | bắt buộc                                                                                                                                            | Chặn đọc bằng JS → giảm tác động của XSS                                                                                                    |
| `SameSite`            | `Lax`                                                                                                                                               | Đủ cho top-level GET redirect từ `auth`. `None` mở CSRF cross-site — không dùng                                                             |
| CSRF                  | Token gắn với session cho **mọi** request đổi state; kiểm ở BFF                                                                                     | `SameSite=Lax` **không** bảo vệ được POST cross-site trong mọi trường hợp                                                                   |
| Giá trị cookie        | **random ≥ 256 bit**, chỉ hash được lưu                                                                                                             | Không lưu giá trị → mất `db-account` không tạo session giả                                                                                  |
| Rotation              | **Tại thời điểm xác thực thành công**, trước khi sinh bất kỳ bằng chứng nào                                                                         | Chống session fixation: không bao giờ thừa kế session id có sẵn, kể cả anonymous                                                            |
| `account_session_ref` | Opaque, `account` sinh tại thời điểm xác thực, định danh **instance của session đã xác thực**; **không** phải cookie và **không** dùng để đăng nhập | Cho `auth` ràng buộc toàn bộ transaction vào **đúng** session đã xác thực — [`../auth/01-architecture.md`](../auth/01-architecture.md) §5.3 |

⚠️ **Không có cookie session dùng chung `.ecoma.io`.** Mỗi hostname có cookie scope riêng. `account` không đọc được cookie của `auth` hay `home`, và ngược lại — đây là điều kiện để tách blast radius XSS.

### 4.2 CSRF ở BFF

BFF dùng cơ chế double-submit: cookie `__Host-account-csrf` cùng một giá trị gửi kèm header trên request đổi state. Token gắn với session đang hoạt động; thiếu hoặc lệch thì từ chối `403` **dù cookie session hợp lệ**. Kiểm tra nằm ở tầng BFF, không ở UI.

### 4.3 Hai lớp ràng buộc authorization transaction

Lớp thứ nhất là `login_handoffs` của `account` (§3.6), lớp thứ hai là `browser_confirmed` ở `auth` (cookie `__Host-auth-browser`). Hai lớp độc lập và **phải cùng tồn tại** — [`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §9 invariant 29.

⚠️ **`account` không được tuyên bố chống được pre-binding một mình** (§3.6.3). Bất kỳ mô tả nào về `login_handoffs` phải nói rõ nó là lớp 1.

## 5. Contract surfaces

`account` là **provider** của hai contract (trong đó một cái là BFF cho browser), và **consumer** của ba contract.

⚠️ **Hướng gọi đọc là `consumer → provider`.** Service gọi là consumer; service sở hữu route và xử lý là provider.

| Contract                          | Consumer     | Provider  | Nội dung                                                                                   | Ghi chú                                                                                                                                                                                                   |
| --------------------------------- | ------------ | --------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BFF account API                   | Browser      | `account` | Account, profile, email, preferences, session list/revoke, connected apps, privacy request | Không phải public API — không có versioning `oasdiff`                                                                                                                                                     |
| `POST /internal/session/verified` | `account`    | `auth`    | Kết quả xác thực session + danh tính lấy từ session của `account`                          | Back-channel **đẩy** sang `auth`, đã xác thực — [`../auth/01-architecture.md`](../auth/01-architecture.md) §5.1                                                                                           |
| `GET /authorize/confirm`          | Browser      | `auth`    | Xác nhận browser là bên khởi tạo transaction, bằng cookie `__Host-auth-browser`            | **Không** phải contract của `account` — `account` chỉ `302` browser tới đó; cookie thuộc origin `auth`, không trộn với cookie `account` ([`../auth/01-architecture.md`](../auth/01-architecture.md) §5.3) |
| `GET /authorize/complete`         | Browser      | `auth`    | Hoàn tất authorization → success hoặc OAuth error tới `redirect_uri` đã đăng ký            | **Không** phải contract của `account` — `account` chỉ `302` browser tới `continue_url` mà `auth` cấp ([`../auth/01-architecture.md`](../auth/01-architecture.md) §5.1.4)                                  |
| `POST /internal/consent/context`  | `account`    | `auth`    | Client name, scope đã yêu cầu, mức rủi ro                                                  | `account` **render** từ đây, không đọc `db-auth`; payload có cấu trúc nên là `POST`, không phải `GET` — [`../auth/01-architecture.md`](../auth/01-architecture.md) §5.7                                   |
| `POST /internal/consent/decide`   | `account`    | `auth`    | Quyết định approve/deny + session ref đã xác minh                                          | `auth` tự bind vào transaction của nó — [`../auth/01-architecture.md`](../auth/01-architecture.md) §5.5                                                                                                   |
| `GET /internal/account/status`    | `auth`       | `account` | Trạng thái account tối thiểu                                                               | Đọc authority trong `db-account`; `auth` hỏi lúc phát hành — §5.3                                                                                                                                         |
| `GET /internal/account/profiles`  | `backoffice` | `account` | `displayName` theo batch cho một tập `sub` được hỏi                                        | Chỉ trả `sub` được hỏi; `displayName: null` = chưa đặt tên; trần 100 `sub`/request — §5.2                                                                                                                 |

⚠️ **`account` là provider của contract status, không phải consumer.** Route `/internal/account/status` thuộc `account` vì `account` là bên sở hữu trạng thái; `auth` là bên gọi. Đây là hướng ngược lại với ba contract back-channel mà `account` đẩy đi.

### 5.1 Hai loại contract — không trộn

|              | **BFF (browser-facing)**                      | **Internal (service-to-service)**                                 |
| ------------ | --------------------------------------------- | ----------------------------------------------------------------- |
| Ai gọi       | Browser qua cookie `account.ecoma.io`         | Service khác qua Service Binding                                  |
| Xác thực     | Cookie + CSRF token                           | **Envelope HMAC** — signature + timestamp + nonce, không cookie   |
| Xác thị thần | Session của browser                           | `sub` truyền trong request, phải được ràng buộc                   |
| Trả gì       | Preference của **chính người đang đăng nhập** | Preference của `sub` được chỉ định                                |
| Endpoint     | `GET`/`PATCH /account/preferences`            | `GET /internal/account/preferences?sub=`                          |
| Rủi ro chính | CSRF, session hijack                          | **Đọc chéo user** — service nào cũng hỏi được về bất kỳ `sub` nào |

⚠️ **Internal contract dùng envelope HMAC, không dựa vào Service Binding.** Đối chiếu tài liệu Cloudflare: **không có** header, request property hay cơ chế nào cho Worker phân biệt request qua Service Binding với request từ internet; mô hình chính thức là **isolation, không phải verification** — giữ Worker đích không reachable từ internet. `account` không áp dụng được mô hình đó vì phải phục vụ BFF công khai trên chính Worker đó. Cloudflare cũng nói rõ không được coi lời gọi downstream là đã xác thực bởi Access context của caller. Bằng chứng và hệ quả → §7.

Envelope ký trên `method + path + timestamp + nonce + body-hash`, kiểm bằng so sánh thời gian hằng, có cửa sổ skew và chống replay trong cửa sổ đó bằng một nonce chiếm vào kho bền vững; thiếu header → `401`, kho nonce không gọi được → `503`. Định dạng, quy tắc canonical, retention và taxonomy lỗi có **một** nguồn sự thật: [`../auth/01-architecture.md`](../auth/01-architecture.md) §5.1.8, cài đặt ở `libs/internal-auth-contracts`. Service Binding vẫn là **đường đi được khuyến nghị** (không cần public route, không tốn egress), nhưng nó là tối ưu hóa đường đi chứ **không phải** cơ chế xác thực — không có Service Binding nào thay được signature.

⚠️ **Đây là hai contract tách biệt, không phải một.** Endpoint BFF phải **bỏ qua** mọi tham số `sub` do client gửi và luôn đọc subject từ session — nếu không, attacker chỉ cần thêm `?sub=<của người khác>` là đọc được preference người khác. Endpoint internal thì ngược lại: **không** nhận cookie, và phải kiểm caller được phép hỏi `sub` đó.

| Yêu cầu                  | BFF                                                           | Internal                             |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------ |
| Subject lấy từ đâu       | Session (bỏ qua mọi `sub` trong request)                      | Tham số `sub`, đã xác thực là caller |
| Chống đọc chéo user      | Bỏ qua `sub` trong query/body                                 | Allowlist service được hỏi `sub` đó  |
| Chống đọc theo enum      | Rate limit + audit                                            | Audit mọi lần đọc theo `sub`         |
| Trả về khi không tồn tại | `404` cho session, không tiết lộ `sub` khác tồn tại hay không | `404`                                |

⚠️ **Internal contract là điểm nhạy cảm nhất của cả hệ thống:** nó cho phép một service hỏi preference của bất kỳ `sub` nào. Vì vậy nó **không** được là public endpoint, phải có envelope HMAC hợp lệ, và mọi lần đọc phải audit. Không có service nào được hỏi bằng internal contract rồi tự phục vụ browser — browser luôn đi qua BFF.

Ba ràng buộc cấu trúc của các contract `account` gọi sang `auth` (chi tiết kiểm chứng ở [`02-requirements.md`](./02-requirements.md) FR-006o, FR-006h2, FR-006h3, FR-006k2):

- **`account` chỉ relay `continue_url`, không dựng nó.** Nó nhận URL tuyệt đối do `auth` cấp trong response và `302` browser tới đó — không tự ghép chuỗi, không thêm tham số, không render nội dung của nó. Đây là điều kiện chống open redirect: `auth` là bên duy nhất dựng URL từ origin đã cấu hình.
- **`account` không gửi `client_id`, `redirect_uri` hay `scope`** trong payload hoàn tất. Bỏ chúng khỏi payload làm transaction substitution bất khả thi **về mặt cấu trúc**, mạnh hơn là kiểm tra thêm sau khi nhận ([`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §9 invariant 28). Cùng nguyên tắc, `account_session_ref` luôn lấy từ session của chính `account` và phải so khớp `sub` trong `db-account` trước khi gửi — không nhận từ request của browser rồi forward nguyên xi.
- **Payload có cấu trúc phải đi bằng `POST`.** `POST /internal/consent/context` là ví dụ rõ nhất: continuation handle và session reference **không được nằm trong URL** — chúng lọt vào access log, `Referer` và lịch sử proxy. Không contract nào trong bảng trên được phép trở thành public endpoint hay để browser gọi trực tiếp.

### 5.2 `GET /internal/account/profiles` — batch displayName cho `backoffice`

Contract nội bộ thứ hai mà `account` phục vụ: consumer là `backoffice`, cần tên hiển thị cho sổ staff. Khác với `status`, response **có** mang dữ liệu hồ sơ — nhưng chỉ đúng dữ liệu đó, với các ràng buộc sau:

- **Chỉ trả `sub` được hỏi.** Request mang `?subs=<sub1,sub2,...>`; response không bao giờ chứa `sub` nằm ngoài danh sách, nên không có đường "tải tất cả profile".
- **Trần 100 `sub` mỗi request (sau dedupe).** Vượt trần hoặc có một `sub` sai định dạng → `400` — lỗi của caller, không phải dữ liệu không tìm thấy.
- **`displayName: null` là giá trị hợp lệ** ("chưa đặt tên"), không phân biệt "không có row profile" với "row có display_name NULL" — với consumer hai thứ đó như nhau.
- **Chỉ có `sub` + `displayName` trong mỗi entry.** Consumer validate response bằng `validateAccountProfilesResponse` (`libs/account-contracts`); một entry mang `email`/`avatar_url` là payload vượt contract và bị từ chối ngay phía consumer.
- **Envelope HMAC như mọi internal contract** (`/internal/**` qua `internal-auth.ts`), `Cache-Control: no-store`, audit log theo tinh thần T-14h ([`02-requirements.md`](./02-requirements.md) §4.3).

⚠️ **Vì sao đây là endpoint riêng, không mở rộng `status`:** `status` có hợp đồng "chỉ một trường" được thiết kế để không thể rò hồ sơ (FR-011b); gắn thêm `displayName` vào đó là phá bất biến đó. Contract mới có bề mặt dữ liệu khác → là contract khác, với validator riêng.

⚠️ **Không có fallback từ email.** Email không phải định danh hiển thị (`backoffice` cấm cột email trong UI), và suy ra tên từ địa chỉ email là dữ liệu bịa — `displayName` chưa đặt thì hiển thị "chưa đặt", không đoán.

### 5.3 `GET /internal/account/status` — tham số canonical là `sub`

✅ **Đã đóng ở cả hai phía (issue #208, PR #252).** Tên tham số trên wire là **`sub`**: route của `account` đọc `query.sub` rồi kiểm định dạng bằng `isSubject` (`apps/account/server/routes/internal/account/status.get.ts`), và consumer ở `auth` (`AccountClient.checkStatus`) gửi `?sub=`.

⚠️ **Trước đó hai phía dùng hai tên khác nhau và đường kiểm tra trạng thái lúc phát hành không chạy được.** `auth` gọi `?account_id=`; `account` trả `400` vì thiếu `sub` — kể cả khi request được ký đúng. Đây là lệch hợp đồng về **tham số**, không phải về envelope: cả hai phía vẫn ký và verify đúng một giao thức canonical, nonce store vẫn bền ở cả hai bên, taxonomy `401`/`413`/`503` không đổi. Triệu chứng vì thế không lộ ra như một lỗi contract: `400` là một nhánh fail-closed hợp lệ, nên nó đọc thành "không phát hành được token".

**Quyết định: giữ `sub` làm tên canonical, sửa phía `auth`.** Lý do không phải "provider đã viết trước":

- `sub` là **định danh thật** ở cả hai phía. `account.users.sub` là PRIMARY KEY mà `selectAccountStatus` tra cứu (`SELECT status FROM account.users WHERE sub = $1`), và phía `auth` đặt thẳng `claims.sub = params.accountId` khi phát access token (`libs/auth-application/src/authorization-service.ts`).
- `accountId` trong tầng application của `auth` **chỉ là tên nội bộ** cho chính subject đó — giữ nguyên tên đó là giữ một cái tên khớp với port của application layer; đổi nó thành `sub` là một lần đổi tên không mang thêm thông tin, còn đổi **tham số URL** mới là thay đổi hợp đồng.
- FR-011a và [`../auth/01-architecture.md`](../auth/01-architecture.md) đã mô tả contract bằng `sub`, nên sửa consumer đưa code về khớp tài liệu thay vì sửa tài liệu cho khớp code.

⚠️ **`account` không nhận alias `account_id`.** Hai tên cho một hợp đồng là hai đường để chúng lệch nhau lần nữa, và lần lệch tới sẽ lại chỉ lộ ra dưới dạng "không phát hành được token". Provider đọc **đúng một** tham số.

_Bất biến này được giữ bằng test, không chỉ bằng quy ước:_

| Bất biến                                                            | Test giữ nó                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Consumer gửi đúng path canonical `?sub=`, và ký đúng request nó gửi | `apps/auth/src/account-client.spec.ts` — bắt `Request` thật mà binding nhận, verify bằng `verifyRequest` canonical             |
| Provider phục vụ `?sub=` và **từ chối** `?account_id=` bằng `400`   | `apps/account/tests/integrations/status-route-e2e.spec.ts` — h3 app thật + middleware internal-auth thật + PostgreSQL thật     |
| Hai phía dùng **cùng một** tên tham số                              | Test conformance trong `account-client.spec.ts`: đo URL consumer dựng ra lúc chạy, so với tên provider đọc từ source của route |

⚠️ **Test conformance ở dòng cuối không tự nó chứng minh provider hành xử đúng như source nó nói** — nó chỉ so tên hai phía. Ranh giới `type:composition` của Nx cấm app này import app kia, nên không có test nào chạy được cả hai phía trong một process; phần "provider thật sự phục vụ `sub`" do integration test ở `apps/account` chứng minh. Ghép hai thứ lại mới thành bằng chứng tương thích.

## 6. Mô hình assurance — ACR

Mức xác thực của session được ghi dưới dạng **ACR URN** (`urn:ecoma:acr:*`), không phải thang bậc tuyến tính `authn_level` (migration `0004` đổi tên cột `account_sessions.authn_level` → `acr`). Code chỉ giữ hằng và phép kiểm tập (`libs/account-domain/src/acr.ts`); ngữ nghĩa ba URN và quan hệ kéo theo thuộc [`../../domains/account/domain-model.md`](../../domains/account/domain-model.md) §4.

Cơ chế: tập ACR của session được tính từ bằng chứng bằng `acrSetFor`; phép kiểm "đủ assurance" là `acrSatisfies` (thuộc tập, không có rank). ACR của session đi vào payload `POST /internal/session/verified` (`libs/auth-contracts/src/session-verified.ts`) và được `auth` bind vào transaction rồi đưa vào ID token dưới claim `acr`.

## 7. Runtime security — Service Binding không phải cơ chế xác thực

### 7.1 Quyết định chặn

⚠️ **Các tài liệu khác trong bộ này mô tả internal contract là "chỉ sau Service Binding, đã xác thực" ([`02-requirements.md`](./02-requirements.md) FR-008g, FR-011c; AC-008i, AC-020b). Trên Cloudflare, tiền đề đó không đúng.**

Đối chiếu tài liệu chính thức của Cloudflare:

| Điều Cloudflare nói                                                                                                           | Hệ quả                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Không** có header, request property hay cơ chế nào cho Worker phân biệt request qua Service Binding với request từ internet | Ràng buộc bằng "chỉ gọi được qua binding" không kiểm chứng được bằng cách kiểm tra request     |
| Mô hình chính thức là **isolation, không phải verification**: giữ Worker đích không reachable từ internet                     | `account` **không** áp dụng được mô hình đó vì phải phục vụ BFF công khai trên chính Worker đó |
| "Do not treat the downstream invocation as authenticated by the caller's Access context"                                      | Nền tảng không cung cấp assertion nào về caller để truyền qua binding                          |

⚠️ **`CF-Connecting-IP` không phải tín hiệu.** Request công cộng có IP thật; request qua binding thì không có — nhưng **thiếu header ở cả hai trường hợp**, nên sự vắng mặt của nó không chứng minh điều gì. Và nếu sau này Cloudflare thêm header đó, một kiểm tra "có header thì cho qua" trở thành giả mạo được ngay khi bất kỳ tầng nào phía trên chèn được header.

**Hệ quả cho thiết kế:** internal contract trên một Worker có public hostname phải có **authenticator ở tầng ứng dụng**, không dựa vào transport. Xem §5.1.

### 7.2 Hệ quả áp dụng

- Mọi route `/internal/**` đi qua `apps/account/server/middleware/internal-auth.ts`, kiểm envelope trước khi vào handler. Không có handler nội bộ nào tự kiểm riêng.
- Service Binding vẫn được khai báo và dùng làm đường đi — nhưng **không** có nhánh code nào cho phép bỏ qua envelope vì request "đến từ binding".
- Không có dual-accept, không có transport-based trust dự phòng. Envelope là cơ chế duy nhất.
- Yêu cầu kiểm thử được → [`02-requirements.md`](./02-requirements.md) SR-010, SR-011.

## 8. Envelope HMAC — khoá, kho nonce và ranh giới import

Giao thức canonical (canonical string, header, taxonomy lỗi) có một nguồn sự thật: [`../auth/01-architecture.md`](../auth/01-architecture.md) §5.1.8 và cài đặt `libs/internal-auth-contracts`. Dưới đây là phần **thuộc ứng dụng `account`**: cấu hình khoá, kho nonce và các ràng buộc triển khai.

### 8.1 Khoá và cấu hình

| Mục       | Giá trị                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `auth`    | Worker Secret `AUTH_INTERNAL_SECRET` (bắt buộc)                                                                                 |
| `account` | Worker Secret `NUXT_INTERNAL_HMAC_SECRET` (`nuxt.config.ts` map thành `internalHmacSecret`)                                     |
| Skew      | `NUXT_INTERNAL_AUTH_SKEW_SECONDS` (chuỗi chữ số thập phân, MIN=1, MAX=3600); bỏ trống dùng `DEFAULT_SKEW_SECONDS` (300) của lib |

Hai Worker phải giữ **cùng** giá trị secret. Không có giá trị mặc định, không có fallback. `kid` (`/^[0-9a-f]{8,16}$/u`) đi ở header riêng `x-ecoma-internal-kid` và **không** nằm trong canonical string; nó là chỉ dẫn chọn khoá cho giai đoạn overlap khi xoay. Runbook xoay → [`03-operations.md`](./03-operations.md) §3.2.

### 8.2 Kho nonce

✅ **Đã đóng ở cả hai phía.** Mỗi service sở hữu bảng nonce của mình trong database của mình — `account.internal_nonces` (`apps/account/db/migrations/0003_internal_nonces.sql`) và `auth.internal_nonces` (`apps/auth/migrations/0010_internal_nonces.sql`). Phần serving dùng chúng qua `recordNonce` trong `server/utils/db.ts` + `makeNonceGuard` trong `server/middleware/internal-auth.ts` (phía `account`), và `makeNonceGuard` trong `apps/auth/src/account-client.ts` (phía `auth`).

⚠️ **Hai bảng, không phải một bảng dùng chung.** Nonce đã chiếm ở `db-account` **không** bảo vệ được request đến `auth`, và ngược lại: nonce là duy nhất theo **từng service nhận**. Gộp thành một kho là vi phạm `one service owns each database` — service này với sang database của service kia.

⚠️ **Cơ chế replay guard của `verifyRequest` là callback `claimNonce`, không có giá trị mặc định.** Đó là khoảng trống thật giữa contract và database: replay guard không có nơi lưu nonce đã thấy thì không chống được replay. Tên cũ `seenNonce` đã đổi thành `claimNonce` để mọi consumer viết theo tài liệu cũ **hỏng lúc typecheck** thay vì chạy sai lúc runtime: hợp đồng là "chiếm-ghi nguyên tử", một `SELECT` thuần không còn gán được.

| Vấn đề                                                                                      | Cách đóng                                                                                                                                             |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verifyRequest` bắt buộc `claimNonce` là callback của **caller**, không có giá trị mặc định | `makeNonceGuard` cấp callback dạng check-and-record; middleware từ chối 401 khi thiếu Hyperdrive vì không có kho nonce thì không xác minh được replay |
| `migrations/0001` không tạo bảng nào cho nonce                                              | Được khắc phục bằng `migrations/0003_internal_nonces.sql` — bảng riêng, **không** trộn vào `security_events`                                          |
| `auth` không có kho nonce nào                                                               | `apps/auth/migrations/0010_internal_nonces.sql` — cùng cấu trúc, cùng bộ grant, cùng lý do không dùng `security_events`                               |

⚠️ **Vì sao không dùng `security_events` làm ledger.** Nó là audit append-only với retention **riêng và còn mở** (nhóm (3), [`../../domains/account/domain-model.md`](../../domains/account/domain-model.md) §7.1) — retention đó theo nghĩa vụ pháp lý và chống gian lận, không phải theo tuổi của nonce. Trộn hai vòng đời khiến việc dọn nonce hết hạn phải đi theo retention audit, và index theo nonce sẽ không phục vụ truy vấn nào.

Ba ràng buộc của `0003` được giữ bằng test, không chỉ bằng quy ước:

- **`expires_at` không có `DEFAULT`.** Nó là `timestamp của envelope + skew`, tức dữ liệu người gọi kiểm soát; database tự điền thì nonce sống mãi và replay guard vô hiệu hoá. `internal-nonces.spec.ts` assert **cấu trúc cột** qua `pg_attribute` — assert hành vi sẽ xanh vì mọi test đều truyền giá trị tường minh.
- **Không grant `UPDATE`.** Nới `expires_at` của nonce đã ghi là nới cửa sổ replay. Prune dùng `DELETE` theo `expires_at`.
- **`claimNonce` phải là "chiếm và ghi", không phải "kiểm tra".** Cài bằng `SELECT` rồi `INSERT` ở câu khác sẽ mất tính nguyên tử dưới tải đồng thời; `internal-nonces.spec.ts` chạy hai connection thật với `pg_sleep` làm barrier để chứng minh đúng một cái thắng.

### 8.3 Ranh giới import giữa Worker và script migration

⚠️ **`server/middleware/internal-auth.ts` không import bất kỳ thứ gì từ `apps/account/db/`.** Thư mục `db/` là script Node đọc `node:fs` để liệt kê file migration; import nó từ Worker kéo `node:fs` vào bundle của `/internal/**` và `nuxt build` đỏ với `RollupError: db/migrate.mts (71:44): Expected ',', got ':'`. Hằng giao thức thì ngược lại — nó **được** import thẳng từ `@ecoma-io/internal-auth-contracts` (`runtime:universal`, nên cả Worker lẫn Nitro đều nạp được), và đó là nguồn sự thật duy nhất. `db/migrate.mts` giữ bản lặp lại **cố ý** vì nó không import được lib đó, và `internal-nonces.spec.ts` canh bản lặp ấy bằng cách đọc nguồn.

⚠️ **`INTERNAL_SKEW_SECONDS` trong `apps/account/db/migrate.mts` là bản lặp lại của `DEFAULT_SKEW_SECONDS` trong `libs/internal-auth-contracts`.** Vitest config của app không resolve được `@ecoma-io/*`, nên import lib ở integration test sẽ hỏng trước khi test kịp chạy. `internal-nonces.spec.ts` đọc nguồn của lib và assert hai ngang nhau để lệch đó không thể xảy ra âm thầm. Phần serving không dùng bản lặp lại đó — nó lấy skew từ `config.internalAuthSkewSeconds` (mặc định `DEFAULT_SKEW_SECONDS` của lib), tức **đúng** con số mà `verifyRequest` dùng ở chính lệnh gọi đó, và truyền cùng số ấy cho `makeNonceGuard`.

## 9. Observability

- **Không log** password, session cookie, `account_session_ref`, `code_verifier`, token hay assertion. Log chỉ chứa whitelisted fields (event, route, method, status, `sub`, `session_id` đã hash, error code) ([`../../architecture/03-operations.md`](../../architecture/03-operations.md) §4).
- **Không** phải serving-path dependency: Observability trả `503` vẫn phục vụ request bình thường ([`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §6).
- Một lần từ chối envelope chỉ ghi `reason` (`missing_header`, `bad_timestamp`, `weak_nonce`, `replayed_nonce`, `bad_signature`, …) — không ghi giá trị header.
- Metric, ngưỡng alert và hành vi khi hỏng → [`03-operations.md`](./03-operations.md) §6, §7.

## 10. Invariant kiến trúc (ứng dụng)

1. `account` chỉ đọc/ghi `db-account`. Không đọc `db-auth`, không D1 của service khác, không cross-database query ([`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §9 invariant 25).
2. Credential verifier và browser session **chỉ** tồn tại trong `db-account`. Không trusted identity assertion nào đi qua query parameter (invariant 27).
3. Session identifier chỉ được lưu dạng hash; cookie không có giá trị đọc lại được.
4. Session identifier **rotate tại thời điểm xác thực**, không bao giờ thừa kế session id có sẵn.
5. Mọi request đổi state của BFF kiểm CSRF token gắn với session.
6. Trạng thái account được ghi vào `db-account` **trước**, lan sang `auth` **sau**; không đợi `auth` để ghi.
7. `sub` không tái sử dụng, không tái phát hành; xoá account không giải phóng nó, và tombstone tối thiểu là thứ duy nhất được phép giữ vĩnh viễn ([`../../domains/account/domain-model.md`](../../domains/account/domain-model.md) §7).
8. Audit event **append-only**, không lưu secret; retention riêng nhưng **có hạn** — không phải giữ vĩnh viễn.
9. Không log password, session cookie, `account_session_ref`, `code_verifier`, token hay assertion.
10. `account` không implement endpoint protocol OAuth 2.0/OIDC; nó chỉ render UI lấy dữ liệu qua contract.
11. Handle do `auth` cấp được `account` gắn với session trình duyệt **trước** khi xác thực, và chỉ session đó được xác thực ([`../auth/01-architecture.md`](../auth/01-architecture.md) §5.3).
12. **Service Binding là đường đi, không phải xác thực.** Mọi route `/internal/**` yêu cầu envelope HMAC hợp lệ; không có nhánh nào bỏ qua envelope dựa trên vị trí mạng (§7).
13. Query cache **OFF** trên Hyperdrive config `db-account` (platform fact `HD3`/`HD4`).
14. Không advisory lock / `LISTEN`/`NOTIFY` / SQL-level `PREPARE` (platform fact `HD6`).
15. Không cross-database FK, `postgres_fdw`, `dblink`.
16. Không có trạng thái ứng dụng cục bộ (node-local) làm hỏng recovery hoặc thay đổi topology.
17. Không lưu secret vào Git, PR build hay Preview runtime từ môi trường production.

## 11. Hiện trạng triển khai

| Phần                                                                                              | Trạng thái                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/account-domain`                                                                             | ✅ Có — subject, lifecycle status, session policy, domain errors; **mô hình ACR** (`src/acr.ts`, URN `urn:ecoma:acr:*` thay thang bậc `authn_level` đã xoá)                                                                                                                                                                                                                                                                                                                      |
| `libs/account-contracts` + `libs/auth-contracts`                                                  | ✅ Có — contract internal + envelope HMAC dùng chung cho caller và callee; payload `POST /internal/session/verified` canonical sáu trường với `acr` (`src/session-verified.ts` ở `libs/auth-contracts`)                                                                                                                                                                                                                                                                          |
| `libs/auth-{application,domain,infrastructure}`                                                   | ✅ Có — tầng domain/contracts/application/infrastructure của phía `auth`, bounded context `auth` (tag `scope:auth`)                                                                                                                                                                                                                                                                                                                                                              |
| Migration `db-account`                                                                            | ✅ `0001`–`0010`; integration test trên PostgreSQL 17 thật (testcontainers). Danh mục từng migration → §3.8                                                                                                                                                                                                                                                                                                                                                                      |
| App wiring (`nuxt.config` alias, Hyperdrive binding, config validation, logger, `health`/`ready`) | ✅ Có — `GET /ready` kiểm `db-account`, fail closed                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /internal/account/status`                                                                    | ✅ Có — contract `account` **phục vụ**, `auth` là consumer (FR-011a); tham số canonical `sub` (§5.3)                                                                                                                                                                                                                                                                                                                                                                             |
| Luồng đăng nhập email-OTP                                                                         | ✅ Có — `POST /api/auth/challenge` (204 anti-enumeration, ghi challenge ma), `POST /api/auth/verify`, `GET /api/auth/session`, `POST /api/auth/logout`; thư viện `server/lib/{otp,session,mail}.ts`; session cookie `__Host-account-session` chỉ lưu hash, ACR `urn:ecoma:acr:email-otp`                                                                                                                                                                                         |
| Login / consent UI                                                                                | ✅ Có — `/login`, `/login/continue`, `/consent` (`apps/account/app/pages/`); adapter thật `apps/account/app/account-data/real-adapter.ts` nối BFF của chính app (`POST /api/auth/{challenge,verify,handoff}`, `POST /api/consent/{context,decide}`; cookie `__Host-account-session` + `__Host-account-csrf` double-submit); test phủ hành vi render + hành vi adapter (`apps/account/app/pages/login/index.spec.ts`, `apps/account/app/pages/login/continue.spec.ts`)            |
| BFF account/profile/preferences                                                                   | ⚠️ Phần lớn đã có — BFF `auth`/`consent` và BFF dữ liệu tài khoản (`profile`, `emails` kèm verify/resend, `notifications`, `preferences`, `privacy-requests`, `sessions`, `applications`) đều ở `apps/account/server/api/`; adapter thật nối các route này trong `apps/account/app/account-data/real-adapter.ts`. **Chưa có**: `security` (MFA/passkey — UI render qua adapter mock và các điều khiển `disabled`), fulfillment cho privacy request, và UI nhập mã xác minh email |
| Password · MFA · passkey                                                                          | ❌ Chưa — password auth còn chưa chốt ([`../../domains/account/domain-model.md`](../../domains/account/domain-model.md) §11)                                                                                                                                                                                                                                                                                                                                                     |
| OAuth flow đầy đủ                                                                                 | ✅ Thuộc `auth`, đã có tại `apps/auth` (provider `oidc-provider` 9.12.2 + glue internal) — mô tả ở [`../auth/01-architecture.md`](../auth/01-architecture.md)                                                                                                                                                                                                                                                                                                                    |
| `POST /internal/session/verified`                                                                 | ✅ Có — handler phía `auth` (`apps/auth/src/session-verified-handler.ts`); **phía caller của `account` cũng đã có**: `POST /api/auth/handoff` (`apps/account/server/api/auth/handoff.post.ts`) push `POST /internal/session/verified` (envelope HMAC) qua Service Binding `AUTH_SERVICE` — `event_id` bất biến theo `session_ref` nên retry idempotent; integration test `apps/account/tests/integrations/bff-routes-e2e.spec.ts`                                                |
| Contract `POST /internal/consent/{context,decide}`                                                | ✅ Có — phía `auth` (`apps/auth/src/consent-handler.ts`); phía `account` đã có caller: `POST /api/consent/context` và `POST /api/consent/decide` (`apps/account/server/api/consent/`) proxy qua Service Binding, ký envelope HMAC; scope được map ở **server**, không map ở UI                                                                                                                                                                                                   |

⚠️ **`db-account` chưa provision.** Migration và code đã có, nhưng database và Hyperdrive origin chưa tồn tại — các phần deployment/provisioning/restore là kế hoạch cho khi provision ([`03-operations.md`](./03-operations.md) §2, §3.2).

## 12. Chưa chốt

| Mục                                                                                                                                     | Kích hoạt                 | Ảnh hưởng                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------- |
| **Password auth có bật hay không** — quyết định `password_credentials` và `recovery_codes` tồn tại hay không, và cả luồng quên mật khẩu | Trước schema `db-account` | Hai entity và toàn bộ email flow                              |
| **MFA bắt buộc hay tuỳ chọn**, và có bật passkey trước TOTP không                                                                       | Trước khi bật login thật  | UX đăng nhập, `acr`                                           |
| **Staleness tối đa** của trạng thái account mà `auth` chấp nhận                                                                         | Trước tính năng suspend   | [`../auth/01-architecture.md`](../auth/01-architecture.md) §9 |
| **Primitive mã hoá TOTP secret** ở tầng ứng dụng, và nơi giữ key                                                                        | Trước khi lưu TOTP secret | Đây là secret của người dùng, không phải secret hạ tầng       |
| **Cơ chế relay outbox**                                                                                                                 | Trước tích hợp đầu tiên   | Event sang `auth`                                             |
| **Rate limit / anti-brute-force** số cụ thể                                                                                             | Trước khi bật login thật  | [`02-requirements.md`](./02-requirements.md) §6               |
| **Lịch xoay `kid`** của envelope (cơ chế overlap đã có, nhịp chưa chốt)                                                                 | Trước production          | [`03-operations.md`](./03-operations.md) §3.2                 |

Mục mở về retention, cơ sở pháp lý và phạm vi áp dụng luật → [`02-requirements.md`](./02-requirements.md) §7.1. Quyết định nghiệp vụ còn mở → [`../../domains/account/domain-model.md`](../../domains/account/domain-model.md) §11.
