# Domain Model — Auth

`auth` là **authorization server** OAuth 2.0 / OpenID Connect của Ecoma. Context này sở hữu ngữ nghĩa nghiệp vụ của việc cấp quyền: authorization transaction, consent, grant, authorization code và vòng đời token, cùng chính sách thu hồi. Nó **không có UI** — không Nuxt, không Vue, không trang login hay consent.

Thiết kế runtime, schema `db-auth`, giao thức login/consent, envelope nội bộ và cơ chế token → [`docs/applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md). Yêu cầu kiểm thử được → [`02-requirements.md`](../../applications/auth/02-requirements.md). Vận hành → [`03-operations.md`](../../applications/auth/03-operations.md).

## 1. Mục đích và ranh giới

| Sở hữu                                                                                                                        | Không sở hữu                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Endpoint protocol · client registration · authorization transaction/code · consent · grant · token · revocation · signing key | Bất kỳ UI nào · credential · password hash · browser session · role nghiệp vụ · permission ứng dụng |

- **Issuer: `https://auth.ecoma.io`** ([`01` §7](../../architecture/01-architecture.md)) — khớp `issuer` trong discovery và trong `id_token`. Mọi `iss` khác đều bị từ chối.
- **Ranh giới scope ↔ permission:** `auth` phát hành và thu hồi token, nhưng **không** sở hữu quyền nghiệp vụ của application nào. OAuth **scope** là quyền truy cập protocol mà client yêu cầu — nó **không** phải application-level permission, không mang trạng thái staff và không đủ granularity cho object-level check. `auth` **không** nhúng role hay permission nghiệp vụ vào token như một nguồn quyền, và một token hợp lệ **không** tự động hàm ý quyền trong application ([`01` A22](../../architecture/01-architecture.md) §8, [`01` invariant 32](../../architecture/01-architecture.md) §9). Ánh xạ scope → permission ứng dụng là một non-goal, không phải một phần việc còn thiếu.
- Tách khỏi `account` tạo **security boundary**: `auth` không chứa password verifier, nên lỗi ở đường xác thực không đồng nghĩa lỗi phát hành token. Blast radius tách ra là chủ đích, không phải phân tách cho vui.
- `auth` **không đọc `db-account`**. Nó không biết mật khẩu, không biết passkey, không biết session tồn tại hay không. "Người này đã đăng nhập" là câu hỏi nó **không tự trả lời được** ([`01` invariant 27](../../architecture/01-architecture.md)). ⚠️ Câu trả lời cho câu hỏi đó **không** đến từ một back-channel call của `auth` — vì lệnh gọi đó mang credential của chính Worker, không mang cookie trình duyệt. Nó đến từ việc **`account` đẩy kết quả** sang `auth`. Riêng **trạng thái account** thì `auth` hỏi được theo hướng `auth → account`, và hai việc đó là hai contract khác nhau.

### 1.1 Vì sao `account` đẩy, không phải `auth` kéo

Đây là hệ quả tất yếu, không phải lựa chọn thoải mái: sau khi trình duyệt đã xác thực, **chỉ `account` mới giữ session đã xác thực**. Nếu `auth` gọi ngược back-channel, lệnh gọi đó mang credential của chính Worker chứ không mang cookie trình duyệt — `auth` sẽ **không** phân biệt được trình duyệt của nạn nhân với trình duyệt của kẻ tấn công đang giữ handle. Vì vậy hướng là `account → auth`, và route nhận kết quả xác thực thuộc `auth` — nó **nhận** kết quả đã được kiểm chứng, không phải trả lời câu hỏi.

So sánh ba pattern handoff và lý do loại hai pattern còn lại là quyết định tích hợp giao thức, ghi ở [`docs/applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md) §4.2 — đó là nơi nó thuộc về, vì nó nói về hình dạng tích hợp chứ không nói về ngữ nghĩa miền.

## 2. Ngôn ngữ chung

| Thuật ngữ                     | Nghĩa trong `auth`                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Subject** (`sub`)           | Định danh opaque của người dùng, không chứa email hay tên. Tham chiếu **không có foreign key** sang `db-account`.                  |
| **Client**                    | Application đã đăng ký, thuộc `public` hoặc `confidential`. Client `public` **không có** secret.                                   |
| **Authorization transaction** | Đơn vị công việc của một lần `/authorize`: bind client, redirect URI, scope, `state`, `nonce`, PKCE challenge ngay từ request gốc. |
| **Authorization code**        | Bằng chứng đổi lấy token, single-use, TTL ngắn, chỉ lưu hash.                                                                      |
| **Consent decision**          | Quyết định của user tại một thời điểm (`approve`/`deny`) — **bằng chứng lịch sử**, không phải quyền hiện hành.                     |
| **Grant**                     | Quyền **đang có hiệu lực** của một client trên một subject, với một tập scope.                                                     |
| **Handle X / Y / Z**          | Ba capability opaque riêng biệt: X cho login handoff, Y cho consent, Z cho hoàn tất. Mỗi loại có TTL và single-use riêng.          |
| **Refresh token family**      | Nhóm refresh token của một grant, dùng để phát hiện tái sử dụng và thu hồi toàn bộ khi phát hiện.                                  |
| **Revocation**                | Trạng thái thu hồi append-only, ghi ở ba mức: toàn subject, theo client, theo token/grant.                                         |
| **Account status**            | `active` \| `suspended` \| `deleted` \| `not_found` — do `account` là authority; `auth` chỉ đọc qua contract lúc phát hành.        |

## 3. Quyết định chính sách OAuth 2.0 / OIDC

### 3.1 Secure defaults đã chốt

| Hạng mục           | Quyết định                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| Grant type         | **Authorization Code + PKCE**, `code_challenge_method=S256` bắt buộc                                          |
| Loại bỏ            | **Implicit** (`response_type=token` → token lọt vào URL) · **ROPC** (client phải giữ password của user)       |
| Client type        | `public` → PKCE bắt buộc, không có secret; `confidential` → PKCE **vẫn bắt buộc**, cộng client authentication |
| Redirect URI       | **Exact string match**. Cấm wildcard, prefix match, và so khớp chỉ theo scheme+host                           |
| `state`            | Sinh bởi **client**; `auth` echo **nguyên văn**; **client** tự so với bản nó lưu                              |
| `nonce`            | Bắt buộc khi trả `id_token`; `auth` bind vào transaction rồi đưa vào `id_token`                               |
| Authorization code | Single-use qua compare-and-set, TTL ngắn, lưu hash, không lưu plaintext                                       |
| Token trong URL    | Cấm tuyệt đối mọi token/secret/assertion trong response hoặc query param                                      |
| CORS               | `/authorize`, `/token` không bật CORS wildcard; JWKS và discovery là public read-only                         |
| Key compromise     | Xoá `kid` khỏi JWKS **trước** (chặn token **mới**), **và** ghi revocation mức toàn subject — xem §4.2, §4.3   |

Cơ chế compare-and-set và vị trí lưu authorization transaction nằm ở [`docs/applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md) §3.

### 3.2 Một completion protocol duy nhất

⚠️ **Toàn bộ luồng authorization đi qua _một_ completion protocol, và đó là điều bắt buộc.** Trước đây có hai đường hoàn tất khác nhau: nhánh đã có grant đi qua endpoint hoàn tất của `auth`, còn nhánh consent được chấp thuận thì `account` redirect thẳng. Hai đường đó có idempotency, cách phát hành code và cách recovery khác nhau, nên một số giả định chỉ đúng ở một nhánh. Bây giờ **cả ba nhánh — grant sẵn có, consent được chấp thuận, consent bị từ chối — đều kết thúc ở cùng một endpoint hoàn tất của `auth`**, và **chỉ `auth` dựng OAuth success/error redirect**.

Hệ quả ở mức miền:

- **`account` không dựng `redirect_uri`, `code`, `state` hay OAuth error.** Nó chỉ chuyển hướng browser tới URL mà `auth` cấp.
- **URL chuyển hướng chỉ được dựng từ origin đã cấu hình của `auth`** — không bao giờ từ `redirect_uri`, `Host`, `Origin` hay dữ liệu browser. Đây là điều kiện chống open redirect.
- **Nhánh `deny` không phải một đường riêng.** Người dùng từ chối vẫn đi qua endpoint hoàn tất và ở đó mới nhận OAuth error với `state` nguyên vẹn tới đúng `redirect_uri`.
- **`access_denied` là OAuth error redirect của `auth`, không phải outcome của contract back-channel.** Nó chỉ sinh ra khi grant đã mất hiệu lực giữa lúc đẩy kết quả xác thực và lúc hoàn tất; `account` không thấy nó và không được có xử lý nào cho nó.

Bốn điều kiện bắt buộc trước khi có thể phát hành code — áp dụng cho **mọi** nhánh — và toàn bộ máy trạng thái, thứ tự kiểm, cùng các bảng idempotency là đặc tả giao thức, nằm ở [`docs/applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md) §5.1.

### 3.3 Single-use là ngữ nghĩa, không phải một bước kiểm tra

Authorization code và mọi handle đều **single-use**, và single-use ở đây là **compare-and-set**, không phải "đọc rồi ghi". Hai request đồng thời dùng cùng một code: đúng một nhận được, request còn lại bị từ chối. Không có read-then-write nào, nên không có cửa sổ double-spend.

Cùng ngữ nghĩa này bảo vệ **quyết định consent**: `account` gửi quyết định, `auth` đánh dấu transaction đã consume **trong cùng transaction** với việc cấp quyền — không có đường nào cấp quyền mà không consume handle.

Hệ quả nghiệp vụ: **authorization hoàn tất đúng một lần**. Retry, replay hay hai lần hoàn tất đồng thời đều không sinh ra kết quả thứ hai. Đường recovery luôn là bắt đầu một `/authorize` mới, và việc đó **luôn khả dụng**, không phụ thuộc transaction cũ còn sống hay không.

### 3.4 Consent ≠ grant

Đây là cặp dễ nhầm nhất của OAuth, và nhầm nó sinh bug ở chính ngữ nghĩa thu hồi.

|                  | **Consent decision**                                | **Grant**                                                    |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| **Là gì**        | Bằng chứng user **đã từng đồng ý**, tại thời điểm T | **Quyền đang có hiệu lực**                                   |
| Owner            | `auth`                                              | `auth`                                                       |
| Gắn với          | `sub` + client + redirect URI + scope + transaction | `sub` + client + scope hiện hành                             |
| Dùng để          | Audit, chứng minh consent có thật                   | **Kiểm mỗi lần phát hành token**                             |
| Khi user thu hồi | Ghi thêm một decision `deny`/`revoke`               | **Grant bị thu hồi ngay** — nhưng token đã cấp không tự chết |
| Quan hệ          | Consent là **bằng chứng**, grant là **quyền**       | Grant **không tự tái sinh** khi consent cũ còn trong lịch sử |

⚠️ **Thu hồi consent không tự thu hồi grant, và ngược lại.** Một grant có thể sống mà consent record đã bị retention xoá; một consent record có thể tồn tại mà grant đã bị thu hồi. Xoá consent decision **không** được phép để dọn dữ liệu — nó là audit trail.

⚠️ **Reactivation không hồi sinh grant** ([`docs/applications/account/01-architecture.md`](../../applications/account/01-architecture.md) §6): consent gắn transaction + thời điểm, nên account từng bị suspend rồi active lại vẫn phải consent mới.

Tên bảng và ràng buộc lưu trữ của hai khái niệm này → [`docs/applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md) §3.2.

### 3.5 Handle X / Y / Z — ba capability, ba ràng buộc

- **Handle X, Y và Z là ba handle riêng, cả ba đều opaque, có TTL và single-use.** X cho login handoff, Y cho consent, Z cho hoàn tất. Chúng không thay thế nhau và không chia sẻ bất kỳ bằng chứng nào.
- **Handle không phải bằng chứng danh tính** — cả X, Y và Z. Mỗi handle chỉ là **định danh một authorization request**; bằng chứng danh tính là session đã xác thực.
- **`Y` không thừa hưởng ràng buộc của `X`.** X được bind với session trình duyệt _trước_ khi xác thực; Y được tạo _sau_ khi đã xác thực, nên không có bước "gắn vào session trình" nào để bê nguyên từ X. Ai hiểu sai bằng cách coi Y là "cùng một loại handle" sẽ chỉ cần biết URL Y là chiếm được quyền consent.
- **`Y` bind server-side** với subject + client + redirect URI + scope + transaction + reference tới session đang hoạt động. Toàn bộ ý nghĩa của Y nằm ở server, không nằm ở trình duyệt.
- **Sở hữu URL chứa `Y` không phải bằng chứng danh tính.** Người khác — kể cả đã đăng nhập bằng tài khoản của chính họ — vẫn bị từ chối, vì session của họ không khớp subject của transaction Y.
- **`Z` là một capability, nhưng là capability _có điều kiện_.** Phát biểu đúng là: **`Z` cộng với cookie trình duyệt của transaction đó là đủ để hoàn tất**, và nó chỉ mạnh trong đúng một browser trong đúng một transaction. Không được nói "biết Z không đủ để lấy code" — câu đó sai; và cũng không được nói Z một mình là đủ.
- **Handle được sinh bằng HMAC có khoá bí mật, không phải hash của `event_id`.** `event_id` là khoá idempotency **công khai**, nên hash của nó không tạo ra bí mật: biết `event_id` là biết trước kết quả. Cơ chế dẫn xuất, `key_version` và chính sách rotation → [`docs/applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md) §5.6.
- **Handle không bao giờ xuất hiện trong query string của URL nội bộ**, không vào log, audit, trace hay `Referer`. Chỉ hash của handle được lưu để verify.

### 3.6 Ràng buộc bắt buộc

- **Query param chỉ mang handle opaque do `auth` cấp.** Không password, không session cookie, không access token, không trusted identity assertion ([`01` invariant 27](../../architecture/01-architecture.md)).
- **URL chuyển hướng chỉ được dựng từ origin đã cấu hình của `auth`.** Không bao giờ từ `redirect_uri`, `Host`, `Origin` hay dữ liệu browser.
- **Consent do `auth` bind.** `account` gửi **quyết định** (`approve`/`deny`) cùng handle; `auth` tự gắn vào subject + client + redirect URI + scope + transaction của chính nó.
- **Exact redirect match, exact scope check.** `auth` không tin scope `account` hiển thị; nó kiểm scope trong transaction của nó.
- **Trước khi render consent, nhận quyết định, hoặc cấp code, session account phải thuộc đúng subject của transaction.** Biết hoặc sở hữu URL chứa Y hay Z **không** phải bằng chứng danh tính.
- **Transaction phải được xác nhận bởi đúng trình duyệt đã bắt đầu nó trước khi bind danh tính.** Không có ngoại lệ, và nhánh đã có grant cũng phải qua.
- **TTL trên cả bốn** handle/transaction; hết hạn → bắt đầu lại từ `/authorize`, không có đường gia hạn.
- **Audit** mọi authn outcome, token issuance, consent decision, revocation. Không ghi token, `code_verifier`, assertion, handle hay giá trị cookie.

Hai lớp ràng buộc trình duyệt (session binding ở `account`, cookie `__Host-auth-browser` ở `auth`) và bảng tấn công tương ứng → [`docs/applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md) §5.3.

### 3.7 Cross-service reference

Mọi `sub` trong `db-auth` là **tham chiếu opaque không có foreign key** tới `db-account`. `auth` không có bảng user và không được tạo một cái chỉ để chứa `sub` — nó sẽ biến thành projection của account mà không có ai chịu trách nhiệm đồng bộ. Toàn vẹn tham chiếu là **responsibility của contract**, phát hiện bằng reconciliation ([`03-operations.md`](../../applications/auth/03-operations.md)).

### 3.8 Signing key — custody là quyết định miền, không phải chi tiết lưu trữ

Private signing key **không được lưu trong `db-auth`**. Lý do: `db-auth` là database có thể bị restore từ backup vào máy mới, bị đọc qua bản sao, và lọt vào tay một operator có quyền đọc — đó không phải nơi giữ khóa ký. Database chỉ giữ **metadata** của key (`kid`, algorithm, status, thời hạn).

JWKS phục vụ **public key** cho client verify token. Xoá `kid` khỏi JWKS **trước** khi phát hành bản thay thế, để token ký bằng key đã lỗi không còn được chấp nhận cho các lần cấp mới.

## 4. Token, thu hồi và vòng đời

⚠️ **Câu trả lời trung thực về "token đã cấp còn hợp lệ không".**

Nếu access token là **JWT self-contained** và resource server verify **offline** bằng chữ ký, thì `auth` **không có mặt** ở thời điểm token được dùng. Resource server không biết account vừa bị suspend, không biết grant vừa bị thu hồi. Trong mô hình đó token đã cấp **vẫn hợp lệ tới khi hết hạn** — nói ngược lại là nói sai.

### 4.1 Hai điểm kiểm soát khác nhau — không gộp làm một

Đây là chỗ dễ sai nhất. **Phát hành** và **sử dụng** là hai enforcement point tách biệt, mỗi cái có giới hạn riêng:

|                                                   | **(A) Phát hành token**                                                                    | **(B) Resource server xác thực token**                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Ai kiểm soát                                      | `auth`                                                                                     | Resource server (dùng JWT offline, hoặc gọi introspection)                     |
| Luôn hỏi được trạng thái account?                 | **Có** — qua contract `auth → account`, không đọc DB                                       | **Không** nếu verify offline                                                   |
| Có thể chặn token **mới** của subject bị suspend? | **Có** — với điều kiện thời điểm đọc trạng thái sau commit; race in-flight vẫn tồn tại     | Chỉ khi còn mạch kiểm thu hồi                                                  |
| Khi hệ thống thu hồi hỏng                         | **Fail closed** — không cấp token mới                                                      | Phụ thuộc mô hình; xem [`01` §6.2](../../applications/auth/01-architecture.md) |
| Bảo đảm được                                      | Không có lần phát hành **mới** nào cho subject đã suspend, **trừ** race in-flight đã mô tả | **Không** bảo đảm gì nếu offline                                               |

⚠️ **Chỉ (A) mới có bảo đảm fail-closed — và bảo đảm đó không bao gồm việc loại bỏ race.** `auth` nằm trên đường phát hành nên nó luôn hỏi được trạng thái account qua contract đã xác thực; nhưng một request đã đọc trạng thái trước khi suspend commit vẫn cấp được token. Resource server verify offline thì **không** có bảo đảm nào, kể cả fail-closed, và không nên được mô tả như có.

⚠️ **Fail-closed chỉ có nghĩa ở mức introspection.** Ở mức offline, "không hỏi được trạng thái thu hồi" không dẫn tới từ chối — nó dẫn tới **không có gì để dựa vào**, và mô hình đó chấp nhận hậu quả là độ trễ thu hồi bằng TTL access token. Nói "fail closed" cho offline là tuyên bố sai.

Mô hình verify đã chốt và bảng so sánh ba mức → [`docs/applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md) §6.2.

### 4.2 Liên kết grant / token / subject — ba mức thu hồi

Revocation control plane là **một** nguồn sự thật duy nhất, ghi append-only, và hỗ trợ **ba mức thu hồi**:

| Mức                  | Phạm vi                         | Ví dụ kích hoạt                                   |
| -------------------- | ------------------------------- | ------------------------------------------------- |
| **Toàn subject**     | Mọi token của `sub`, mọi client | Account bị suspend hoặc xoá                       |
| **Theo client**      | `sub` + `client_id`             | User thu hồi một app trong Connected applications |
| **Theo token/grant** | Một grant hoặc token cụ thể     | Phát hiện refresh token lộ                        |

Mức thu hồi phải được kiểm ở **thời điểm phát hành** và — ở mức introspection — ở **mỗi lần xác thực**. Thu hồi mức nhỏ hơn không được xoá bản ghi mức lớn hơn.

⚠️ **Suspended/deleted subject** bị chặn tại thời điểm phát hành **khi lần phát hành đó đọc trạng thái sau commit**, bất kể đã nhận event hay chưa ([`docs/applications/account/01-architecture.md`](../../applications/account/01-architecture.md) §6) — đây là bảo đảm thuộc điểm kiểm soát (A), và nó **có điều kiện thời điểm**. Một request đã đọc `active` trước commit vẫn phát hành được sau commit; đó là race đã thừa nhận, không phải hành vi chưa định nghĩa.

### 4.3 Xoá `kid` khỏi JWKS không vô hiệu token đã cấp

⚠️ **Đây là tuyên bố sai nếu nói "xoá `kid` thu hồi được token".** Thực tế:

1. Resource server cache JWKS theo HTTP cache header của chính endpoint đó.
2. Sau khi `auth` xoá `kid`, resource server vẫn verify được token đã ký bằng key đó **cho tới khi cache của nó hết hạn**.
3. Với token **tự chứa** (`kid` nằm trong header), việc có kiểm `kid` còn trong JWKS hay không phụ thuộc có còn mạch introspection hay không — và nếu resource server không hỏi `auth`, nó **không** có cách nào biết `kid` đã bị xoá.

| Tuyên bố                                           | Đúng không                                           |
| -------------------------------------------------- | ---------------------------------------------------- |
| "Xoá `kid` ngăn token **mới** được ký bằng key đó" | ✅ Đúng                                              |
| "Xoá `kid` làm token **đã cấp** hết hiệu lực ngay" | ❌ **Sai** — phụ thuộc cache và cửa sổ introspection |

⚠️ **Thu hồi theo subject KHÔNG bao phủ token tự ký — và đây là lỗ hổng thật, không phải chi tiết vụn vặt.** Khi attacker giữ private key, hắn **không cần** đánh cắp refresh token hay giành session: hắn tự ký token bất kỳ với `sub` bất kỳ — kể cả một `sub` chưa từng tồn tại, hoặc một tài khoản mà hắn không hề biết. Thu hồi theo "các subject đã biết" không chạm tới những token đó, và ở mô hình verify offline không có cơ chế nào để chặn chúng ngoài việc thay key.

⚠️ **Vì vậy: ở mô hình verify offline, không thể tuyên bố sự cố đã được containment chỉ bằng việc xoá `kid` và ghi revocation.** Điều kiện để tuyên bố containment là **cả hai**: (i) key bị lộ không còn ký được token nào được bất kỳ verifier nào chấp nhận — tức mọi cache JWKS đã hết hạn hoặc bị purge chủ động; và (ii) các token đã cấp hợp lệ đã hết TTL hoặc bị chặn. Với (i) đúng là **cửa sổ theo cache**, không phải thời điểm bạn chọn. Toàn bộ quy trình và điều kiện tuyên bố → [`03-operations.md`](../../applications/auth/03-operations.md) §11.1.

### 4.4 Refresh token

- **Rotation**: mỗi lần dùng refresh token sinh token mới; token cũ đánh dấu đã dùng.
- **Reuse detection**: dùng lại token đã rotate là dấu hiệu lộ token → **thu hồi toàn bộ family**, buộc re-authenticate.
- Lưu hash, không lưu giá trị. Không refresh token nào vào URL, log hay audit.
- ⚠️ Vì refresh token **luôn** đi qua `auth`, nó thuộc điểm kiểm soát (A): refresh **luôn** fail closed và **luôn** kiểm được trạng thái account.

### 4.5 Logout — hai thao tác tách biệt

| Thao tác                 | Ai làm    | Ảnh hưởng                                                |
| ------------------------ | --------- | -------------------------------------------------------- |
| **Browser logout**       | `account` | Xoá browser session; user phải đăng nhập lại ở `account` |
| **Revoke grant / token** | `auth`    | Client không lấy được token mới theo grant đó            |

⚠️ Browser logout **không** tự thu hồi token đã cấp cho client khác. Đây là hành vi chuẩn và là điểm dễ hiểu sai nhất: user đăng xuất khỏi trình duyệt không có nghĩa app đã cấp token bị vô hiệu. Muốn thì phải vào **Connected applications** và thu hồi tường minh ([`docs/applications/account/02-requirements.md`](../../applications/account/02-requirements.md) FR-012).

RP-initiated logout **đã bật** trong provider. Back-channel logout vẫn là **quyết định chưa chốt** (§6) — không có endpoint nào trong source.

### 4.6 Vòng đời account — nhận và lan truyền

`db-auth` **không** giữ trạng thái account; nó giữ _projection_ để kiểm nhanh, và coi `account` là authority.

| Sự kiện từ `account`  | Xử lý phía `auth`                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| **Suspend**           | Revocation cho toàn subject; đánh dấu grant `revoked`; refresh families bị thu hồi; chặn phát hành mới   |
| **Reactivate**        | Không hồi sinh grant; user phải consent lại                                                              |
| **Credential change** | Audit event; grant hiện hành **không** tự thu hồi (password change ≠ authorization change)               |
| **Delete**            | Grant `revoked`; token đã cấp không còn hợp lệ; `sub` giữ nguyên theo retention, **không** tái phát hành |

⚠️ **Hàng "Delete" cần đọc cùng §4.1.** "Token đã cấp không còn hợp lệ" ở đây là **ý định kiểm soát**, không phải hành vi tức thời: ở mô hình verify offline, token đã cấp vẫn được chấp nhận tới hết TTL. Hàng này ghi phía `auth` làm gì khi nhận event; phần _bảo đảm chặn token mới_ là việc của contract kiểm tra trạng thái, và đó là bảo đảm duy nhất.

Cơ chế transactional outbox và giới hạn thật của nó (event mất, giao lặp, trễ, thứ tự) → [`docs/applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md) §7.1.

## 5. Invariant nghiệp vụ

1. `auth` không có UI và không render login/consent. `account` không implement endpoint protocol ([`01` invariant 24](../../architecture/01-architecture.md)).
2. Không credential, session cookie hay trusted identity assertion nào đi qua query parameter; authorization code trong query param là hành vi chuẩn OAuth vì nó đi tới `redirect_uri` đã đăng ký. `account` **đẩy** kết quả xác thực qua back-channel, không phải `auth` kéo ([`01` invariant 27](../../architecture/01-architecture.md)).
3. `auth` bind consent vào `sub` + client + redirect URI + scope + transaction của chính nó; `account` chỉ gửi quyết định, không gửi danh tính client hay scope ([`01` invariant 28](../../architecture/01-architecture.md)).
4. Consent decision là **bằng chứng lịch sử**; grant là **quyền hiện hành**. Xoá consent **không** thu hồi grant, và thu hồi grant **không** xoá consent (§3.4).
5. Refresh token rotation với reuse detection thu hồi **toàn bộ family**.
6. Browser logout và token/grant revocation là hai thao tác riêng; không suy ra cái này từ cái kia (§4.5).
7. **Cả ba nhánh hoàn tất — grant sẵn có, consent được chấp thuận, consent bị từ chối — đều kết thúc ở endpoint hoàn tất của `auth`, và chỉ `auth` dựng OAuth success/error redirect.** `account` không dựng `redirect_uri`, `code`, `state` hay OAuth error (§3.2).
8. **Authorization hoàn tất đúng một lần.** Retry, replay, hay hai completion đồng thời đều không sinh kết quả thứ hai; đường recovery là `/authorize` mới (§3.3).
9. **Handle không phải bằng chứng danh tính** — cả X, Y và Z. Bằng chứng danh tính là session đã xác thực (§3.5).
10. **Ràng buộc của handle là _một cặp_, không phải _một số_.** Với Z, capability là `Z` **cộng với** cookie trình duyệt của transaction; thiết kế **không** tuyên bố "biết Z không đủ để lấy code" (§3.5).
11. **Consent handle `Y` không dựa vào bằng chứng nào do browser đưa.** Ràng buộc của Y là bản ghi server-side gắn reference tới session đang hoạt động; reference đó đứng một mình không cấp quyền gì (§3.5).
12. **Phát hành** token luôn hỏi được trạng thái account qua contract `auth → account` nên fail closed là bảo đảm **đối với trạng thái mà contract đọc trả về**; nó **không** loại bỏ race in-flight, và **resource server** verify offline thì **không** có bảo đảm đó (§4.1).
13. Private signing key không lưu trong `db-auth`; chỉ lưu metadata (§3.8).
14. Audit event không chứa token, `code_verifier`, secret, handle, session reference hay assertion; append-only; lâu hơn dữ liệu chức năng.
15. Xoá `kid` khỏi JWKS chỉ chặn token **mới**; nó **không** vô hiệu token đã cấp tại resource server đang cache key. Khi key bị compromise phải làm cả hai việc (§4.3).

## 6. Chưa chốt

Các quyết định dưới đây **chưa** được chấp nhận; chúng không được đọc thành hành vi hiện có. Chi tiết kỹ thuật và trạng thái của từng mục → [`docs/applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md) §9; danh sách đầy đủ ở [`docs/applications/auth/02-requirements.md`](../../applications/auth/02-requirements.md) §9.

| Mục                                                                                 | Vì sao còn mở                                                                                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Lịch xoay signing key và compromise response chi tiết**                           | Custody đã chốt (Worker Secret); lịch xoay và quy trình compromise đầy đủ chưa chốt                                                   |
| **Staleness tối đa** của trạng thái account mà `auth` chấp nhận                     | Nó là con số phụ thuộc mô hình verify, độ trễ hạ tầng và hậu quả khi đọc sai — cả ba đều chưa có                                      |
| **Ngữ nghĩa mạnh hơn** "không token response nào thành công sau khi suspend commit" | Đòi serialize phát hành với ghi trạng thái — thỏa thuận nhất quán xuyên database mà ranh giới service hiện tại không cung cấp         |
| **Back-channel logout**                                                             | RP-initiated logout đã bật; back-channel logout chưa có endpoint nào trong source                                                     |
| **Ngưỡng rate limit / anti-abuse**                                                  | Chỉ đặt sau khi có baseline lưu lượng thật                                                                                            |
| **Retention cụ thể của audit/security event**                                       | Gắn với nghĩa vụ lưu giữ theo luật — xem [`docs/applications/auth/02-requirements.md`](../../applications/auth/02-requirements.md) §7 |
| **Cơ chế relay outbox**                                                             | Quyết định ở cấp hệ thống → [`01` §10](../../architecture/01-architecture.md)                                                         |
| **Cách chống ghi đè cookie trình duyệt giữa hai transaction**                       | Đổi hình dạng cookie; phải chốt cùng quyết định cookie per-transaction                                                                |
| **Cache JWKS có purge chủ động được không**                                         | Quyết định "đã containment" sớm hay muộn (§4.3)                                                                                       |
