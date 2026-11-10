# Account — Mô hình miền

> Phạm vi: tri thức nghiệp vụ của bounded context `account` — ranh giới, khái niệm, quy tắc, vòng đời, invariant và các điểm chưa chốt. Runtime, schema, contract và vận hành của component hiện thực context này → [`docs/applications/account/`](../../applications/account/README.md).
> Yêu cầu kỹ thuật của ứng dụng → [`../../applications/account/02-requirements.md`](../../applications/account/02-requirements.md) · vận hành → [`../../applications/account/03-operations.md`](../../applications/account/03-operations.md) · đối tác protocol `auth` → [`../auth/domain-model.md`](../auth/domain-model.md) và [`../../applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md).

---

## 1. Mục đích và ranh giới

`account` là bounded context giữ **bằng chứng đăng nhập** của người dùng và mọi giao diện liên quan tài khoản. Nó là nguồn sự thật duy nhất cho câu hỏi "người này đã xác thực chưa, bằng bằng chứng nào, và tài khoản này còn sống hay không".

| Sở hữu                                                                                                                                              | Không sở hữu                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Danh tính account · bằng chứng đăng nhập · browser session · credential · MFA/passkey · profile · preference · privacy request · trạng thái account | Endpoint protocol OAuth 2.0/OIDC · client registration · grant · token · signing key · staff directory · role · permission · staff-role assignment |

- **Ranh giới bằng chứng:** `account` là nguồn sự thật duy nhất cho "người này đã xác thực". `auth` **không** đọc dữ liệu credential hay session của `account`; nó nhận kết quả xác thực qua contract đã xác thực — [`../../applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md) §5.
- Ngược lại, `auth` là nguồn sự thật cho "người này đã ủy quyền app nào". `account` hiển thị trạng thái đó qua contract, không đọc dữ liệu của `auth`.
- **Ranh giới danh tính ↔ quyền nghiệp vụ:** `account` sở hữu **danh tính** (ai là ai), **không** sở hữu quyền nghiệp vụ của bất kỳ application nào. Ai là staff của `backoffice`, có role gì, được làm gì là dữ liệu của `backoffice`; `account` không lưu và không suy ra những điều đó. Account ID (`sub`) là **tham chiếu** mà `backoffice` dùng để liên kết staff member, không phải quan hệ sở hữu — [`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §2.2 (A21).
- Việc `account` phục vụ trên hostname riêng và tách cookie theo origin là điều kiện kỹ thuật của ranh giới này; cơ chế → [`../../applications/account/01-architecture.md`](../../applications/account/01-architecture.md) §4.

**Ranh giới nghiệp vụ, viết rõ để không bị hiểu thành "account quyết định mọi thứ về người dùng":**

| `account` không làm                                          | Vì sao                                                                                                                                                      | Ai làm thay thế                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Giữ timezone nghiệp vụ (timezone giao dịch)                  | Đó là quyết định nghiệp vụ, không phải thiết lập hiển thị                                                                                                   | Service sở hữu nghiệp vụ đó        |
| Quyết định timezone/locale hiển thị của business service     | `account` cung cấp preference; service khác tự render                                                                                                       | Service tiêu thụ                   |
| Giữ danh sách thiết bị push, subscription, delivery state    | `notification_preferences` chỉ ghi **ý định** của user                                                                                                      | `push-notification`                |
| Staff directory, staff membership, staff lifecycle           | Danh tính account không phải membership của một tổ chức; hai trục khác nhau — `active`/`suspended`/`terminated` của staff **không** phải trạng thái account | `backoffice` (A21); `staff-access` |
| Role, permission catalog, staff-role assignment              | Quyền nghiệp vụ thuộc application sở hữu nghiệp vụ đó; `account` không suy ra quyền từ trạng thái account                                                   | `backoffice` (A21); `staff-access` |
| Cấp/thu hồi quyền truy cập application từ trạng thái account | `account` cung cấp **sự kiện và trạng thái**; quyết định quyền là của application đó                                                                        | Application sở hữu quyền đó        |

## 2. Khái niệm nghiệp vụ

| Khái niệm               | Ý nghĩa nghiệp vụ                                                                         | Quy tắc bất biến                                                                                                                                           | Nhạy cảm                                        | Nhóm retention  |
| ----------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------- |
| **Subject** (`sub`)     | Danh tính opaque của account                                                              | UNIQUE, **không tái sử dụng, không tái phát hành**; account đã xoá giữ nguyên giá trị như tombstone để token cũ không resolve nhầm sang người khác         | Pseudonymous, nhưng là khoá nối mọi record khác | Nhóm (1)        |
| **Trạng thái account**  | `active` \| `suspended` \| `deleted`; tra cứu có thể trả thêm `not_found`                 | `deleted` là tombstone, không giải phóng `sub`; `not_found` và `deleted` đều nghĩa là không cấp token                                                      | Có                                              | Nhóm (1)        |
| **Hồ sơ** (profile)     | Tên hiển thị, avatar, thông tin do user chủ động nhập                                     | 1:1 với account; `displayName` chưa đặt là trạng thái hợp lệ, không suy ra từ email                                                                        | Có — personal data                              | Nhóm (2)        |
| **Địa chỉ email**       | Email liên lạc và đăng nhập, kèm trạng thái xác minh `pending` \| `verified` \| `revoked` | ≥ 1 địa chỉ `verified` mới đăng nhập được; một địa chỉ đã xác minh chỉ thuộc một account; email **không bao giờ** là `sub`                                 | Có — cao                                        | Nhóm (2)        |
| **Credential mật khẩu** | Bằng chứng đăng nhập bằng mật khẩu                                                        | Chỉ tồn tại khi password auth được bật; chỉ lưu hash chậm + salt, không lưu dạng đọc lại được                                                              | Có — cao                                        | Nhóm (2)        |
| **Authenticator**       | Passkey hoặc TOTP                                                                         | Mỗi loại một discriminator; passkey counter phải đơn điệu để phát hiện clone; TOTP secret chỉ tồn tại ở dạng được bảo vệ, không plaintext; thu hồi độc lập | Có — rất cao                                    | Nhóm (2)        |
| **Mã khôi phục**        | Mã dự phòng khi mất MFA                                                                   | Chỉ lưu hash; **single-use**; đếm số lần dùng                                                                                                              | Có — cao                                        | Nhóm (2)        |
| **Phiên trình duyệt**   | Bằng chứng của một lần đăng nhập trên một thiết bị                                        | Chỉ dẫn xuất của session identifier được lưu; có hạn và thu hồi được; mang `acr` + `authn_at` (mức và thời điểm xác thực)                                  | Có — cao                                        | Nhóm (2)        |
| **Preference**          | Thiết lập cá nhân `locale`, `timezone`, `color_mode`                                      | Miền giá trị đóng, validate khi ghi; **không trùng** với timezone nghiệp vụ của service khác                                                               | Không nhạy cảm                                  | Nhóm (2)        |
| **Login handoff**       | Quan hệ giữa handle do `auth` cấp và phiên trình duyệt đã trình nó                        | Chỉ một thao tác atomic tạo được binding; session đã bind không bị ghi đè; binding chuyển theo session rotation; TTL ngắn                                  | Có — cao                                        | Nhóm (2)        |
| **Ý định thông báo**    | Kênh nào user cho phép gửi thông báo                                                      | Chỉ ghi **ý định**; không phải danh sách thiết bị, subscription hay delivery state                                                                         | Có (hành vi)                                    | Nhóm (2)        |
| **Sự kiện bảo mật**     | Audit đăng nhập: thành công/thất bại, IP, user-agent, lý do                               | Append-only; không chứa password hay token; IP + user-agent là personal data                                                                               | Có                                              | Nhóm (3)        |
| **Yêu cầu privacy**     | Yêu cầu của data subject: `export`, `correct`, `delete`, `restrict`, `object`             | Subject là tham chiếu opaque, không phải quan hệ sở hữu; mỗi loại có deadline theo luật và deadline không được kéo dài                                     | Có — cao                                        | Nhóm (3)        |
| **Thông báo privacy**   | Version thông báo đã phát hành và xác nhận của user                                       | Xác nhận gắn đúng version; **khác** cơ sở pháp lý                                                                                                          | Có                                              | Theo chính sách |
| **Cơ sở pháp lý**       | Cơ sở pháp lý cụ thể cho một mục xử lý dữ liệu (điều khoản, dữ liệu nhạy cảm)             | Ghi `basis`, `policy_version`, `given_at`, `withdrawn_at`; **khác** OAuth consent                                                                          | Có                                              | Nhóm (3)        |
| **Event sang `auth`**   | Thay đổi trạng thái account cần lan sang `auth`                                           | Ghi cùng transaction với thay đổi trạng thái; idempotency key UNIQUE; không chứa personal data                                                             | Không                                           | Dọn sau publish |

⚠️ **Nhãn "Nhóm (1)/(2)/(3)" là nhãn của §7, không phải một cam kết thời hạn.** `Nhóm (1)` là tombstone tối thiểu và là thứ **duy nhất** được phép giữ lâu dài; `Nhóm (2)` bị xoá hoặc anonymize khi account bị xoá; `Nhóm (3)` có retention **riêng và còn mở** — chưa chốt, và việc giữ nó **chưa** được biện minh bằng nghĩa vụ cụ thể. Không khái niệm nào ngoài tombstone được ghi là "vĩnh viễn"; chi tiết và lý do → §7.

## 3. Quan hệ giữa các khái niệm

- Một account có đúng một hồ sơ và đúng một bộ preference; nhiều địa chỉ email; nhiều authenticator; nhiều phiên trình duyệt.
- Account có thể có một credential mật khẩu, chỉ khi password auth được bật; đây là điều kiện nghiệp vụ chưa chốt (§11).
- Mỗi login handoff trỏ tới đúng một phiên đã trình handle lần đầu; một phiên có thể đi qua nhiều handoff theo thời gian.
- Yêu cầu privacy và sự kiện bảo mật tham chiếu subject như một **giá trị opaque**, không phải quan hệ sở hữu — chúng phải còn đọc được sau khi account đã thành tombstone.
- Challenge OTP có thể được cấp cho một địa chỉ **chưa tồn tại** trong hệ thống. Đây là quy tắc nghiệp vụ chống enumeration: phản hồi phải giống nhau và việc ghi một challenge "ma" chính là cơ chế giới hạn tần suất, không phải lỗi.
- Ý định thông báo và cơ sở pháp lý là hai khái niệm tách biệt với OAuth consent; không có quan hệ sở hữu giữa chúng và chúng không được gộp vào một bản ghi.

## 4. Mô hình assurance — ACR

Mức xác thực của một phiên là **ACR URN** (`urn:ecoma:acr:*`), không phải một thang bậc tuyến tính.

| URN                                | Nghĩa                                                               | Quan hệ kéo theo                                                  |
| ---------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `urn:ecoma:acr:email-otp`          | Đã xác thực bằng email-OTP (phương thức đăng nhập duy nhất hiện có) | Không kéo theo gì — OTP một yếu tố **không** tự thành MFA         |
| `urn:ecoma:acr:mfa`                | OTP **cộng thêm** một yếu tố thứ hai (TOTP hoặc Passkey)            | Kéo theo `email-otp`                                              |
| `urn:ecoma:acr:phishing-resistant` | Yếu tố thứ hai là **Passkey/WebAuthn**                              | Kéo theo `mfa` (TOTP shareable-secret **không** kéo theo URN này) |

Kiểm tra "phiên đủ assurance cho hành động X" là phép **thuộc tập**: tập ACR của phiên phải **chứa** ACR yêu cầu. Không có rank, không suy diễn xuôi/ngược; tập được tính từ bằng chứng đã có, nơi gọi không tự ghép URN tay. Cơ chế ghi `acr` và truyền nó sang `auth` → [`../../applications/account/01-architecture.md`](../../applications/account/01-architecture.md) §6.

## 5. Session và bằng chứng xác thực

Các quy tắc nghiệp vụ dưới đây là điều `account` phải bảo đảm; cơ chế cookie, header và lưu trữ → [`../../applications/account/01-architecture.md`](../../applications/account/01-architecture.md) §4.

- **Rotation tại thời điểm xác thực:** phiên được cấp identifier mới ngay khi xác thực thành công, trước khi sinh bất kỳ bằng chứng nào. Không bao giờ thừa kế session id có sẵn, kể cả phiên anonymous.
- **Bằng chứng đủ mới:** hành động nhạy cảm cần `acr` và `authn_at` đủ mới, không suy ra từ tuổi session. Cookie sống lâu không đồng nghĩa bằng chứng đủ mới.
- **`account_session_ref` là định danh bằng chứng, không phải credential:** nó định danh **instance của phiên đã xác thực** để `auth` ràng buộc transaction vào đúng phiên, không dùng để đăng nhập và không bao giờ đi qua URL.
- **Không có cookie session dùng chung `.ecoma.io`:** mỗi hostname có cookie scope riêng; `account` không đọc được cookie của `auth` hay `home`, và ngược lại. Đây là điều kiện tách blast radius XSS.
- **Handle do `auth` cấp được ràng buộc với phiên đã trình nó trước khi xác thực**, và chỉ phiên đó được xác thực. Đây là **lớp thứ nhất**; nó chỉ chặn ghi đè, không chặn pre-binding — xem [`../../applications/account/01-architecture.md`](../../applications/account/01-architecture.md) §4.3.
- **Email là credential liên lạc + đăng nhập, không phải định danh:** chỉ địa chỉ đã xác minh mới nhận OTP đăng nhập; email không bao giờ trở thành `sub`.

## 6. Vòng đời account

`account` giữ **authoritative state**; thay đổi được ghi ở đây **ngay**, không đợi `auth`.

| Sự kiện               | Hành vi nghiệp vụ                                                                                                           | Lan sang `auth`                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Suspend**           | Trạng thái `suspended`; thu hồi **mọi** phiên; chặn đăng nhập mới                                                           | Outbox event, idempotent; `auth` cũng kiểm tra khi phát hành |
| **Reactivate**        | Trạng thái `active`; user phải đăng nhập lại                                                                                | Grant cũ **không** tự sống lại — phải consent lại            |
| **Credential change** | Ghi credential mới; thu hồi phiên khác; nếu đổi email/mật khẩu → yêu cầu reauthentication                                   | Outbox event (phát hiện bất thường)                          |
| **Delete**            | Soft delete → `sub` thành tombstone, **không** tái phát hành; thu hồi phiên; xoá/anonymize dữ liệu chức năng theo retention | Outbox event; `auth` thu hồi grant và token                  |
| **Identifier reuse**  | **Cấm** tuyệt đối                                                                                                           | `sub` tombstone giữ nguyên giá trị                           |

Cơ chế lan sang `auth` — transactional outbox, idempotency key, retry, reconciliation, partial failure → [`../../applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md) §7.

⚠️ **Truyền trạng thái sang `auth` là best-effort, nên kiểm tra tại thời điểm phát hành là chốt chặn cuối.** `auth` không được cấp token cho `sub` mà nó biết là suspended/deleted, bất kể đã nhận event hay chưa. ⚠️ **Bảo đảm này có điều kiện thời điểm**: một lần phát hành đã đọc `active` trước khi commit suspend/delete vẫn có thể phát hành sau commit đó. Kiến trúc hai database hiện tại **không** bảo đảm "không token nào thành công sau khi suspend commit"; ngữ nghĩa đầy đủ và decision gate còn mở nằm ở [`../../applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md) §6.0 rule 1–5. Số staleness tối đa chấp nhận được là quyết định chưa chốt ([`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §10).

## 7. Xoá account, anonymize và retention

⚠️ **"Giữ vĩnh viễn" không phải retention đã được biện minh.** Ba nhóm dữ liệu dưới đây có cơ sở giữ khác nhau, và chỉ một nhóm mới thật sự cần giữ lâu dài. Mọi khoảng thời gian cụ thể là **quyết định chưa chốt** — xem §6 và §11, và [`../../architecture/03-operations.md`](../../architecture/03-operations.md) §10.

### 7.1 Ba nhóm, ba cách xử lý

| Nhóm                        | Ví dụ                                                                        | Xử lý khi user xoá account                        | Cơ sở giữ                                                        | Vì sao                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **(1) Tombstone tối thiểu** | Subject, trạng thái đã xoá, thời điểm xoá                                    | **Giữ lại**, chỉ giữ đúng những trường này        | Kỹ thuật, **không** phải lợi ích người dùng                      | Chống tái sử dụng `sub` và chống token cũ resolve nhầm sang người khác. Không chứa nội dung nào đọc được về con người |
| **(2) Dữ liệu chức năng**   | Hồ sơ, email, preference, ý định thông báo, phiên, authenticator, credential | **Xoá hoặc anonymize**                            | Không có                                                         | Vì mục đích đã hết; giữ lại không có lý do                                                                            |
| **(3) Audit và bảo mật**    | Sự kiện bảo mật, yêu cầu privacy, cơ sở pháp lý, xác nhận thông báo privacy  | **Theo retention riêng**, có thể giữ hơn nhóm (2) | Nghĩa vụ pháp lý và chống gian lận — **cần xác minh**, chưa chốt | Xoá sạch thì mất dấu vết truy vết; nhưng IP + user-agent là personal data nên không thể giữ mãi                       |

⚠️ **Nhóm (1) là nhóm duy nhất được giữ "vĩnh viễn", và chỉ vì lý do kỹ thuật.** Nó không phải lợi ích người dùng, không phải phân tích, không phải marketing. Nếu account giữ thêm trường nào nữa sau khi xoá, trường đó phải được biện minh riêng — mặc định là anonymize.

#### Tombstone là pseudonymous, không phải ẩn danh

⚠️ **`sub` không phải dữ liệu "không nhận diện được".** Nó là pseudonymous: bản thân nó không chứa tên hay email, nhưng vẫn là **khoá nối mọi record khác** của cùng một người (nhóm 2 và 3 ở trên). Giữ nó lâu dài nghĩa là **giữ khả năng nối lại** các bản ghi đó về một chủ thể duy nhất — kể cả sau khi dữ liệu chức năng đã bị xoá. Vì vậy:

| Câu hỏi                                               | Trả lời hiện tại                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ai được đọc tombstone?**                            | Chỉ các đường nội bộ cần nó để từ chối identifier tái sử dụng và để từ chối token cũ resolve. **Không** có đường đọc lấy hồ sơ; mọi đường đều trả về tối thiểu và audit lại theo `sub`                                                                                                                                                      |
| **Rủi ro tái liên kết là gì?**                        | Nếu sau này có thêm một bảng nào đó nối `sub` với dữ liệu đã anonymize, thì anonymize trở nên vô nghĩa — dữ liệu đã "không nhận diện" lại quay về nhận diện được qua `sub`. Đây là lý do `sub` phải là **mục tiêu tái liên kết duy nhất**, không phải một trong nhiều                                                                       |
| **Tái phát hành `sub` có xoá được rủi ro này không?** | ⚠️ **Không — và đây là điểm dễ hiểu sai nhất.** Cấp `sub` mới **không** xoá khả năng liên kết từ `sub` **cũ** tới bản ghi lịch sử hay dữ liệu còn giữ ở service khác; nó chỉ làm giá trị mới không nối được với giá trị cũ nữa. Nếu `sub` cũ vẫn xuất hiện trong dữ liệu của `auth`, audit hay bất kỳ kho nào khác, thì liên kết đó vẫn còn |

**Đánh đổi phải nói thẳng, không được gọi là đã giải quyết:** giữ `sub` trong tombstone ngăn `sub` cũ bị gán cho account mới — **nhưng** đó chính là điều duy trì khả năng nối các bản ghi mang `sub` đó. Hai mục tiêu này **không thể cùng đạt** bằng thiết kế hiện tại.

**Biện pháp giảm rủi ro tái liên kết** tập trung vào việc **loại bỏ mapping và record nhận diện không còn cần thiết**, quản lý các kho dữ liệu còn giữ `sub`, và giới hạn quyền truy cập — **không** tuyên bố đạt anonymization chỉ nhờ đổi identifier. Cụ thể:

| Việc                                              | Tác dụng                                               | Giới hạn                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Xoá/anonymize record nhận diện không còn mục đích | Đoạt liên kết giữa `sub` và dữ liệu chức năng còn lại  | Không chạm tới `sub` trong nhóm (3) hoặc ở `auth`                                             |
| Quản lý kho dữ liệu còn giữ `sub`                 | Biết **có bao nhiêu** kho còn giữ `sub` và ai được đọc | `auth` giữ `sub` vì contract, không vì lợi ích người dùng — không xoá được với lý do kỹ thuật |
| Hạn chế quyền truy cập theo `sub`                 | Thu hẹp vùng có thể tái liên kết                       | ⚠️ Không triệt tiêu rủi ro; chỉ làm nó khó hơn                                                |

⚠️ **Việc tái phát hành `sub` là một câu hỏi chính sách chưa giải quyết, và tài liệu này không tự quyết nó.** Tái phát hành `sub` **mâu thuẫn** với yêu cầu token cũ không resolve nhầm sang người khác (§7.5) — nếu `sub` cũ có thể resolve sang người mới thì một token cũ kia sẽ cấp quyền cho người đã bị xoá. Vì vậy nó **không được** coi là cách sửa mặc định và **không** được bật khi chưa quyết. Owner: DPO + Security. Trigger: trước khi `sub` được dùng làm khoá nối cho bất kỳ tính năng nào mới. Xem FR-012m.

⚠️ **Vì vậy ba câu trên là giới hạn đã biết của thiết kế tombstone, không phải kết luận pháp lý đã được xác minh.** Ở mức tối thiểu hiện tại, việc giữ tombstone **không** thu thập thêm dữ liệu cá nhân — nhưng nó **không** xoá được việc dữ liệu đã anonymize trước đó có thể bị nối lại. Không được mô tả `sub` hoặc tombstone là dữ liệu không nhận diện được.

### 7.2 Anonymize khác xoá như thế nào

| Cách              | Nghĩa                                           | Dùng khi                                                                                               |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Xoá**           | Bản ghi biến mất hoàn toàn                      | Dữ liệu không còn giá trị với bất kỳ mục đích nào                                                      |
| **Anonymize**     | Giữ cấu trúc và quan hệ, xoá nội dung nhận dạng | Cần giữ tham chiếu, đếm số lượng, hoặc chứng minh một sự kiện đã xảy ra mà không còn gắn với con người |
| **Giữ tombstone** | Giữ khoá định danh tối thiểu                    | Chỉ nhóm (1)                                                                                           |

⚠️ **Anonymize không mặc định là đủ.** Với IP và user-agent, anonymize có thể chỉ là cắt bớt — mức anonymize đủ để không còn là personal data là câu hỏi cần trả lời theo từng trường, và **chưa** có câu trả lời đã xác minh.

### 7.3 Điều không được coi là tự động biện minh

| Điều                                  | Vấn đề                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| "Giữ vĩnh viễn vì có thể cần sau này" | Không phải cơ sở. Cần nghĩa vụ hoặc mục đích đã nêu                             |
| "Audit thì phải giữ mãi"              | Audit là personal data khi còn gắn IP/user-agent. Có thời hạn, và hạn phải chốt |
| "Backup giữ lâu hơn nên xoá vô nghĩa" | Đúng — vì vậy cần quy trình riêng cho backup, xem §7.4                          |
| "Anonymize là xoá"                    | Hai việc khác nhau; xem §7.2                                                    |

### 7.4 Backup và restore — điểm hay bị bỏ sót

⚠️ **Xoá ở database chính KHÔNG xoá trong backup.** Đây là khoảng trống thường bị bỏ sót nhất, và nó có thể làm nghĩa vụ xoá dữ liệu trở nên không thực thi được:

1. Backup được chụp trước khi xoá vẫn chứa dữ liệu cá nhân.
2. Khi restore, dữ liệu đó quay lại.
3. Vì vậy cần: **retention của backup** biết được và có hạn; **quy trình restore** có bước đối chiếu với danh sách `sub` đã xoá; và **kết quả đối chiếu được ghi lại** — nếu không, không ai biết dữ liệu cá nhân nào đã quay lại từ backup.

**Dữ liệu quay lại từ backup không được mặc định coi là hợp lệ.** Sau restore, một account trở lại **không** đồng nghĩa với một account còn tồn tại. Nếu `sub` đó có trong tombstone thì nó phải bị xử lý như **tombstone đã quay lại cùng dữ liệu chức năng theo sau nó** — tức là phải xoá hoặc anonymize lại nhóm (2), không phải coi là account hoạt động.

Quy trình đối chiếu, tối thiểu:

| Bước | Việc                                                                                                              | Kết quả phải ghi lại                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1    | Đọc danh sách tombstone **từ nguồn đã được kiểm chứng là còn hiện hành** — không phải từ chính backup vừa restore | Số lượng tombstone dùng làm chuẩn đối chiếu, và nguồn của nó |
| 2    | So **mọi** `sub` có trong dữ liệu vừa restore với danh sách đó                                                    | Danh sách `sub` bị restore lại dù đã xoá                     |
| 3    | Xử lý từng bản ghi khớp: xoá hoặc anonymize nhóm (2); **không** mở lại account                                    | Số bản ghi đã xử lý, theo từng `sub`                         |
| 4    | Kiểm phía `auth` có bản ghi nào trỏ tới các `sub` đó                                                              | Kết quả reconcile với `auth`                                 |
| 5    | Ghi kết quả — kể cả khi **không** có dòng nào khớp                                                                | Bằng chứng đã đối chiếu, không chỉ "restore thành công"      |

⚠️ **Không được ghi "restore xong" mà bỏ qua bước đối chiếu.** Một restore thành công về mặt kỹ thuật có thể đã hồi sinh dữ liệu đã xoá; nếu không ghi kết quả đối chiếu thì không ai biết điều đó có xảy ra hay không. Bước 5 tồn tại để biến "không chắc" thành một câu trả lời có thể kiểm chứng.

Reconciliation sau restore → [`../../applications/account/03-operations.md`](../../applications/account/03-operations.md) §9.2.

### 7.5 Ràng buộc

1. `sub` không tái sử dụng, không tái phát hành; xoá account không giải phóng nó (§10 invariant 6).
2. Xoá account **không** được xoá tombstone `sub`.
3. Nhóm (2) phải xoá hoặc anonymize theo retention đã chốt — **không** có mặc định "giữ".
4. Nhóm (3) giữ theo retention riêng đã chốt; retention này **chưa** được biện minh bằng nghĩa vụ cụ thể.
5. Sau khi xoá, `auth` thu hồi grant và token; phía `auth` giữ tham chiếu `sub` tombstone theo retention của nó ([`../../applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md) §6).
6. Mỗi service khác tự xoá dữ liệu của mình theo contract; `account` không xoá được dữ liệu ngoài phạm vi của mình (FR-013a).
7. Backup restore phải có bước đối chiếu `sub` đã xoá, và kết quả phải được ghi lại (§7.4).
8. Dữ liệu quay lại từ backup **không** được coi là hợp lệ chỉ vì nó đã vào database; bản ghi có `sub` nằm trong tombstone phải được xử lý lại như sau khi xoá (§7.4).

## 8. Privacy và compliance

⚠️ **Phần này tách hai việc khác nhau, và chỉ một việc còn mở.**

**(1) Những gì tài liệu này khẳng định** — kiểm soát kỹ thuật, ranh giới vai trò, phạm vi dữ liệu, việc tách ba loại consent. Chúng **không** phụ thuộc vào việc đọc được văn bản luật, nên được viết thành yêu cầu kiểm thử được ngay bây giờ.

**(2) Những gì cần kết luận pháp lý** — phạm vi áp dụng, cơ sở pháp lý, deadline, nghĩa vụ báo cáo. Đây là những mục **duy nhất** còn mở, và chúng được giữ ở §8.1 với owner và điều kiện kích hoạt.

Nguồn pháp lý chính thức **không truy cập được từ môi trường viết tài liệu này**, và việc này đã được thử lại độc lập: EUR-Lex trả nội dung rỗng, iso.org và leginfo.legislature.ca.gov trả HTTP 403, cổng văn bản pháp luật Việt Nam trả tài liệu không liên quan cho các mã văn bản dự đoán, và tìm kiếm không trả nội dung kết quả. Vì vậy tài liệu này **không** ghi số hiệu văn bản, ngày hiệu lực hay điều khoản cụ thể nào khi chưa đối chiếu được nguồn gốc.

Đây là hạn chế có chủ đích: một trích dẫn sai đặt vào đặc tả là tệ hơn một khoảng trống được ghi nhận rõ, vì tài liệu này sẽ được đọc như một nguồn đáng tin. Việc đóng các mục ở §8.1 cần người có quyền truy cập nguồn pháp lý chính thức — hoặc tư vấn pháp lý có thẩm quyền — chứ không chỉ cần mạng thông thường, vì nhiều cổng chính thức chặn truy cập tự động.

### 8.1 Mở — cần kết luận pháp lý

Đây là **phần duy nhất** của tài liệu này phụ thuộc nguồn pháp lý. Những mục dưới đây **không** ghi đoán; chúng ghi loại kết luận cần có, và mốc nào phải đạt trước khi mục đó được đóng.

| Mở                                                   | Cần kết luận gì                                                                                                         | Phân loại                | Ảnh hưởng `account`                                                                         | Owner         | Kích hoạt khi                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------- |
| Phạm vi áp dụng của luật Việt Nam về dữ liệu cá nhân | Văn bản nào chi phối, ngày hiệu lực, và điều kiện áp dụng cho Ecoma; nghĩa vụ đồng ý và cơ chế báo cáo sự cố            | **Bắt buộc nếu áp dụng** | Quyết định deadline của yêu cầu privacy (FR-014) và có phải báo cáo cơ quan chức năng không | Legal counsel | Có quyết định về nơi cư trú và thị trường của Ecoma      |
| Phạm vi áp dụng của luật an toàn thông tin mạng      | Yêu cầu lưu giữ và bảo mật dữ liệu tại chỗ, và phạm vi với dữ liệu cá nhân                                              | **Bắt buộc nếu áp dụng** | Ràng buộc lưu trữ và encryption tại chỗ                                                     | Legal counsel | Có kết luận về phạm vi vận hành tại Việt Nam             |
| Phạm vi **territorial** của GDPR / UK GDPR           | Ecoma có thuộc phạm vi không; nếu có thì cơ sở pháp lý và quyền data subject nào áp dụng, thời hạn báo cáo sự cố ra sao | **Tùy điều kiện**        | Quyết định có phải xây vòng đời privacy request theo GDPR hay không                         | Legal counsel | Có quyết định về thị trường và thể chế pháp lý của Ecoma |
| Ngưỡng áp dụng của CCPA/CPRA                         | Ecoma có vượt ngưỡng không; nếu có thì quyền consumer nào và sensitive personal information nào liên quan               | **Tùy điều kiện**        | Quyết định có phải hỗ trợ opt-out / deletion request hay không                              | Legal counsel | Có số liệu doanh thu và số người tiêu dùng               |
| Cơ sở pháp lý cho **từng** mục inventory §8.3        | Chọn cơ sở pháp lý cụ thể cho mỗi mục dữ liệu; không để trống, không dùng "vì lợi ích người dùng" làm cơ sở chung       | **Bắt buộc nếu áp dụng** | Quyết định dữ liệu nào cần consent, dữ liệu nào không                                       | DPO + Legal   | §8.1 ba dòng đầu đã có kết luận                          |
| Retention của audit và bảo mật (FR-012g)             | Nghĩa vụ lưu giữ cụ thể có tồn tại không                                                                                | **Tùy điều kiện**        | Quyết định có giữ dữ liệu audit vĩnh viễn hay không                                         | DPO + Legal   | Có quyết định về nghĩa vụ lưu giữ theo lĩnh vực          |

⚠️ **Không mặc định luật nào tự động áp dụng, không coi consent là cơ sở pháp lý duy nhất, và không mặc định mọi dữ liệu phải nằm trong lãnh thổ Việt Nam.** Cả ba đều là quyết định cần đánh giá theo tình huống thực tế của Ecoma, không phải mặc định.

**Những gì đã khẳng định, không nằm trong bảng trên:**

- **ISO/IEC 27001:2022, ISO/IEC 27701:2025, NIST CSF 2.0, NIST Privacy Framework** là **khung đối chiếu kiểm soát**, không phải căn cứ tuân thủ. Chúng dùng được ngay để đối chiếu thiết kế mà không cần kết luận pháp lý nào.
- **Ranh giới vai trò** (§8.2), **inventory dữ liệu** (§8.3) và **việc tách ba loại consent** là quyết định kiến trúc, không phụ thuộc luật nào.
- **Hành vi kỹ thuật kiểm thử được** — không log secret, phân quyền theo service, audit mỗi lần đọc, deadline không bị kéo dài — là yêu cầu của tài liệu này, không phụ thuộc nguồn pháp lý.

### 8.2 Ranh giới vai trò

⚠️ **`account` KHÔNG phải chủ sở hữu toàn bộ personal data của Ecoma.** `account` **orchestrate** privacy request; từng service sở hữu dữ liệu **tự export, correct hoặc delete** record của mình theo contract định nghĩa (FR-013a).

`account` chỉ sở hữu dữ liệu **về chính account**: subject, profile, email, credential, authenticator, session, preference, security event, privacy request của chính nó. Một yêu cầu xoá dữ liệu phải đi tới service sở hữu giao dịch, không phải tới `account`.

### 8.3 Inventory dữ liệu và cơ sở pháp lý

Mỗi mục phải ghi **mục đích xử lý** và **cơ sở pháp lý cụ thể** — không để trống, và không dùng "vì lợi ích người dùng" làm cơ sở chung. **Mục đích** và **phạm vi dữ liệu** là quyết định của `account` và đã chốt ở đây; **cơ sở pháp lý** là kết luận còn mở ở §8.1 và được đánh dấu rõ:

| Dữ liệu                           | Mục đích (chốt tại đây)                   | Cơ sở pháp lý                                    | Ghi chú bắt buộc                          |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------ | ----------------------------------------- |
| `sub`, trạng thái account         | Nhận diện và phục vụ account              | **Mở** — xem §8.1                                | Pseudonymous nhưng là khoá nối mọi record |
| Email                             | Đăng nhập, khôi phục, thông báo           | **Mở** — mỗi mục đích một cơ sở                  | Không gộp ba mục đích vào một cơ sở       |
| Password hash                     | Xác thực                                  | **Mở** — không phải vì lợi ích người dùng        | Không thể hiện ra ngoài dạng hash         |
| TOTP secret, passkey              | Xác thực bước hai                         | **Mở**                                           | Rủi ro cao nhất trong hệ thống            |
| Phiên trình duyệt                 | Duy trì phiên đăng nhập                   | **Mở**                                           | TTL ngắn, thu hồi được                    |
| IP + user-agent (sự kiện bảo mật) | Chống gian lận, điều tra                  | **Mở** — cần chốt rõ, có thể là lợi ích hợp pháp | Là personal data; retention riêng         |
| Preference                        | Cá nhân hoá trải nghiệm                   | **Mở**                                           | Không nhạy cảm                            |
| Yêu cầu privacy                   | Thực hiện nghĩa vụ bảo vệ dữ liệu         | Theo kết luận ở §8.1                             | Có deadline                               |
| Cơ sở pháp lý                     | Chứng minh cơ sở pháp lý tại thời điểm đó | Theo kết luận ở §8.1                             | **KHÁC** OAuth consent                    |

⚠️ **Việc đánh dấu "Mở" không phải là trống.** Nó là một tuyên bố đã xác minh được: mục đích xử lý và phạm vi dữ liệu **đã** quyết định và đã kiểm thử được; riêng cơ sở pháp lý thì chưa, và đang chờ kết luận ở §8.1 với owner cụ thể.

⚠️ **Cơ sở pháp lý, OAuth consent (ủy quyền app) và ý định nhận thông báo là ba khái niệm riêng biệt** (FR-013b). Gộp chúng là nguồn lỗi phổ biến: một bản ghi không thể vừa là bằng chứng pháp lý vừa là quyền truy cập ứng dụng.

### 8.4 Yêu cầu privacy

| ID     | Yêu cầu                                                                                                  | Kiểm chứng                               |
| ------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| CR-001 | Hỗ trợ `export`, `correct`, `delete`, `restrict`, `object` với trạng thái và deadline ghi được           | Test tạo và theo dõi từng loại           |
| CR-002 | **Không service nào khác đọc dữ liệu account** để trả lời privacy request                                | Kiểm tra contract từng service           |
| CR-003 | Mỗi service sở hữu dữ liệu **tự** xử lý phần của mình theo contract định nghĩa                           | Test end-to-end có xác minh từng service |
| CR-004 | Mỗi loại request có deadline theo luật; request hỏng **không** được kéo dài deadline                     | Test                                     |
| CR-005 | Thông báo privacy ghi **version** đã phát hành và xác nhận của user gắn đúng version                     | Test: ACK gắn đúng version               |
| CR-006 | Access/correction phải phân biệt **tự xác thực** (đã đăng nhập) với qua support (cần bằng chứng bổ sung) | Test cả hai đường                        |
| CR-007 | Dữ liệu của trẻ em và dữ liệu nhạy cảm: chưa có định nghĩa tuổi và chưa chốt chính sách                  | Chưa chốt — §11                          |

### 8.5 Sự cố rò dữ liệu

Quy trình quyết định có báo cáo cơ quan chức năng **không**, và trong bao lâu, **không** được hardcode ở đây — nó phụ thuộc vào §8.1:

1. Phát hiện (alert, sự kiện bảo mật, audit) → 2. Xác minh có phải personal data breach → 3. Đánh giá mức độ và rủi ro cho data subject → 4. Quyết định có nghĩa vụ thông báo và trong deadline nào → 5. Thực hiện và lưu hồ sơ quyết định → 6. Post-mortem.

⚠️ **Bước 4 phải ghi lại lý do**, kể cả khi kết luận là "không có nghĩa vụ thông báo". Một quyết định không thông báo không có hồ sơ là không chứng minh được.

⚠️ **Quy trình này chạy được ngay.** Các bước 1–3, 5, 6 là kiểm soát kỹ thuật và vận hành, không phụ thuộc luật; chỉ **bước 4** — ngưỡng phải báo cáo và deadline — chờ kết luận ở §8.1. Runbook vận hành tương ứng → [`../../applications/account/03-operations.md`](../../applications/account/03-operations.md) §10.

## 9. Yêu cầu chức năng nghiệp vụ

Các yêu cầu dưới đây là **quy tắc nghiệp vụ** phải giữ, với ID giữ nguyên để cross-reference. Yêu cầu giao thức, payload và envelope của component hiện thực → [`../../applications/account/02-requirements.md`](../../applications/account/02-requirements.md).

### 9.1 Account và định danh

| ID      | Yêu cầu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Kiểm chứng                                                                                                                                                                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-001  | Cấp `sub` **opaque, không tái sử dụng, không tái phát hành**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Tạo → xoá → tạo lại: `sub` mới khác cũ; cấp lại `sub` đã tombstone bị từ chối                                                                                                                                                                        |
| FR-002  | ≥ 1 email `verified` mới đăng nhập được bằng email. Email **không** là khoá chính và **không** bao giờ là OIDC `sub`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Đăng nhập bằng email chưa verify → từ chối; assert `sub` ≠ email                                                                                                                                                                                     |
| FR-002a | Account tạo ngoài luồng đăng nhập (bootstrap first-administrator — [`staff-access` ADR-0021](../staff-access/adr/0021-first-admin-bootstrap-path.md), [ADR-0024](../staff-access/adr/0024-trusted-bootstrap-verified-address.md)) có email canonical `superadmin@ecoma.io` ở `verified` ngay khi tạo, do một **thao tác offline được tin cậy** khai rằng hộp thư đã thuộc tổ chức trước khi bootstrap; đó là trusted provisioning assertion, **không** phải bằng chứng OTP. Kiểm soát hộp thư chỉ được chứng minh ở lần đăng nhập passwordless OTP đầu tiên, và cấu hình một chuỗi email **không** phải bằng chứng kiểm soát | Chỉ hằng canonical được ghi `verified`; không có endpoint sessionless nào đổi trạng thái email; bootstrap không phát session/token; đăng nhập vẫn đi qua OTP `login`; địa chỉ người dùng tự thêm vẫn `pending`; đổi email về sau **không** đổi `sub` |
| FR-003  | Credential mật khẩu chỉ tồn tại **khi** password auth được bật; chỉ lưu hash chậm + salt, **không** lưu reversible                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Bật/tắt password auth → credential tương ứng tồn tại/không; không có plaintext                                                                                                                                                                       |

### 9.2 Xác thực, authenticator, session

| ID      | Yêu cầu                                                                                                                              | Kiểm chứng                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| FR-004  | Đăng nhập sinh phiên gắn với trình duyệt; chỉ **dẫn xuất** của session identifier được lưu, không lưu giá trị dùng được để đăng nhập | Đọc trạng thái sau đăng nhập không thấy giá trị dùng được làm credential    |
| FR-004a | Session identifier **rotate tại thời điểm xác thực**, trước khi sinh bất kỳ bằng chứng nào                                           | Id trước/sau xác thực khác nhau; anonymous session id không bao giờ thừa kế |
| FR-004b | Mỗi phiên lưu `acr` + `authn_at`; hành động nhạy cảm cần bằng chứng **đủ mới**, không suy ra từ tuổi session                         | `authn_at` cũ → hành động nhạy cảm bị từ chối dù cookie còn sống            |
| FR-005  | Authenticator gộp passkey và TOTP bằng discriminator. TOTP secret chỉ tồn tại ở dạng được bảo vệ; passkey counter đơn điệu           | Không có secret plaintext; counter lùi → phát hiện clone và chặn            |
| FR-005a | Mã khôi phục chỉ lưu hash, **single-use**, đếm số lần dùng                                                                           | Dùng lại mã đã dùng → từ chối                                               |

### 9.3 Preference

| ID      | Yêu cầu                                                                                                                 | Kiểm chứng                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| FR-008  | Preference của account gồm `locale`, `timezone`, `color_mode`; mỗi trường có miền giá trị đóng và được validate khi ghi | Mỗi trường là một giá trị độc lập, không phải túi key tự do              |
| FR-008a | `locale` chỉ nhận giá trị trong allowlist và **reject** giá trị lạ — **không** fallback im lặng                         | Ghi `locale` ngoài allowlist → bị từ chối, giá trị cũ giữ nguyên         |
| FR-008b | `timezone` validate theo IANA tz database; tên không hợp lệ bị reject                                                   | Ghi `timezone` không có trong IANA tz database → bị từ chối              |
| FR-008c | Default áp dụng **một lần** lúc tạo account, không recompute mỗi lần đọc                                                | Đọc preference hai lần ở hai thời điểm → kết quả giống nhau              |
| FR-008f | Preference là **tài sản của `account`**; không trùng với timezone nghiệp vụ của service khác                            | Không có trường kiểu "timezone giao dịch"; service khác tự lưu bản riêng |

Default, chốt tại [`../../applications/account/01-architecture.md`](../../applications/account/01-architecture.md) §3.3:

| Trường       | Default                                                      | Hành vi                                               |
| ------------ | ------------------------------------------------------------ | ----------------------------------------------------- |
| `locale`     | Theo `Accept-Language` lúc tạo account, hợp lệ với allowlist | Tạo account với `Accept-Language: vi` → `locale = vi` |
| `timezone`   | `Asia/Ho_Chi_Minh`                                           | Account mới → `Asia/Ho_Chi_Minh`                      |
| `color_mode` | `system`                                                     | Account mới → `system`                                |

### 9.4 Vòng đời account

| ID      | Yêu cầu                                                                                                                               | Kiểm chứng                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| FR-012  | **Suspend**: trạng thái `suspended`, thu hồi **mọi** phiên, chặn đăng nhập mới                                                        | Sau suspend: phiên cũ bị từ chối, luồng đăng nhập mới bị từ chối |
| FR-012a | **Reactivate**: trạng thái `active`, user phải đăng nhập lại; grant cũ **không** tự sống lại                                          | Sau reactivation, `auth` vẫn yêu cầu consent mới                 |
| FR-012b | **Credential change**: ghi credential mới, thu hồi phiên khác, yêu cầu reauthentication nếu đổi email/mật khẩu                        | Đổi mật khẩu → phiên khác hết hiệu lực                           |
| FR-012c | **Delete**: soft delete thành **tombstone**, `sub` không tái phát hành, thu hồi phiên, xoá/anonymize dữ liệu chức năng theo retention | Sau xoá, không `sub` nào khác nhận được giá trị `sub` đó         |
| FR-012d | Identifier reuse **cấm tuyệt đối**                                                                                                    | Cấp lại `sub` đã tombstone → bị từ chối                          |

#### Retention theo ba nhóm dữ liệu

Áp dụng §7 — **ba nhóm tách biệt, không gộp làm một**:

| ID      | Yêu cầu                                                                                                                                                                                 | Kiểm chứng                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| FR-012e | **Tombstone** giữ **tối thiểu**: `sub`, trạng thái đã xoá, thời điểm xoá. **Không** giữ tên, email, profile hay bất kỳ dữ liệu chức năng nào                                            | Quét tombstone không thấy trường nhận diện                                                         |
| FR-012f | Dữ liệu chức năng (email, profile, preferences, session, connected apps) bị **xoá hoặc anonymize** theo §7.2; mặc định xoá                                                              | Xoá account → truy vấn dữ liệu chức năng trả về rỗng                                               |
| FR-012g | Dữ liệu **audit và bảo mật** có retention **riêng**, và việc giữ nó **chưa** được chứng minh là cần thiết — không phải kết luận pháp lý                                                 | Review: retention của audit được ghi là **mở**, kèm owner và nguồn nghĩa vụ                        |
| FR-012h | "Giữ vĩnh viễn phòng khi cần sau này" **không** phải cơ sở hợp lệ cho retention                                                                                                         | Review: không câu nào trong §7 dùng lý do này                                                      |
| FR-012i | **Backup restore làm dữ liệu đã xoá quay lại.** Phải có cơ chế đối chiếu `sub` sau restore, và dữ liệu phục hồi từ backup **không** được coi là hợp lệ chỉ vì nó tồn tại                | Manual: restore từ backup có account đã xoá → phát hiện sai lệch và escalate                       |
| FR-012j | Tombstone là **pseudonymous, không phải ẩn danh**: `sub` là khoá nối nhóm (2) và (3), nên tài liệu **không được** mô tả nó là dữ liệu không nhận diện được                              | Review: không câu nào gọi `sub`/tombstone là non-identifiable hay anonymised                       |
| FR-012k | Quyền đọc tombstone giới hạn ở các đường kỹ thuật chống tái sử dụng `sub` và chống token cũ resolve; **không** có đường đọc hồ sơ, và mọi lần đọc đều audit theo `sub`                  | Review: đường đọc tombstone trả tối thiểu và ghi audit; không đường nào trả hồ sơ                  |
| FR-012l | `sub` là **mục tiêu tái liên kết duy nhất**. Nếu sau này có bảng nối `sub` với dữ liệu đã anonymize, anonymize đó bị vô hiệu hoá về mặt thực tế — rủi ro đã biết, **chưa** được loại bỏ | Review: thiết kế không dựa vào `sub` làm cơ chế ẩn danh; rủi ro tái liên kết được ghi mở kèm owner |
| FR-012m | Việc loại bỏ rủi ro tái liên kết bằng cách tái phát hành `sub` **mâu thuẫn** với yêu cầu token cũ không resolve nhầm sang người khác — **quyết định này chưa chốt**                     | Review: ghi là quyết định mở, kèm owner và trigger trước khi dùng `sub` làm khoá nối tính năng mới |

### 9.5 Privacy request

| ID      | Yêu cầu                                                                                                                                 | Kiểm chứng                                                                        |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| FR-013  | Tiếp nhận `export`, `correct`, `delete`, `restrict`, `object`; lưu subject opaque, trạng thái và deadline                               | Mỗi loại request tạo được và có deadline gắn với loại request                     |
| FR-013a | `account` **orchestrate** privacy request; service sở hữu dữ liệu **tự** export/correct/delete record của mình theo contract định nghĩa | Contract nêu rõ service nào phụ trách record nào                                  |
| FR-013b | **Legal consent, OAuth consent và notification preference là ba khái niệm riêng biệt** — không dùng chung bản ghi                       | Assert ba khái niệm tách biệt, không có quan hệ sở hữu chéo                       |
| FR-014  | Mỗi loại privacy request có **deadline** theo luật; request hỏng **không** được kéo dài deadline                                        | Test: request vượt deadline được đánh dấu vi phạm và escalate                     |
| FR-015  | Privacy request phải **hoàn thành hoặc báo lỗi tới data subject**; trạng thái hỏng phải nhìn thấy được và có người chịu trách nhiệm     | Test: request ở trạng thái lỗi vẫn hiện trong danh sách với lý do, không biến mất |

## 10. Invariant nghiệp vụ

1. `account` chỉ đọc/ghi dữ liệu của chính nó. Không đọc dữ liệu của `auth`, không cross-database query ([`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §9 invariant 25).
2. Credential verifier và browser session **chỉ** tồn tại trong phạm vi `account`. Không trusted identity assertion nào đi qua query parameter (invariant 27).
3. Session identifier chỉ được lưu dạng dẫn xuất; không có giá trị đọc lại được dùng làm credential.
4. Session identifier **rotate tại thời điểm xác thực**, không bao giờ thừa kế session id có sẵn.
5. Trạng thái account được ghi **trước**, lan sang `auth` **sau**; không đợi `auth` để ghi.
6. `sub` không tái sử dụng, không tái phát hành; xoá account không giải phóng nó, và tombstone tối thiểu là thứ duy nhất được phép giữ vĩnh viễn (§7).
7. Audit event **append-only**, không lưu secret. Retention riêng, lâu hơn dữ liệu chức năng, **nhưng có hạn** — không phải giữ vĩnh viễn (§7.1).
8. `account` không implement endpoint protocol OAuth 2.0/OIDC; nó chỉ render UI lấy dữ liệu qua contract.
9. Handle do `auth` cấp được `account` gắn với phiên trình duyệt **trước** khi xác thực, và chỉ phiên đó được xác thực ([`../../applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md) §5.3).
10. Tombstone là dữ liệu **pseudonymous**: nó giữ khả năng nối lại các bản ghi đã anonymize. Vì vậy nó **không** được mô tả là dữ liệu không nhận diện được, và anonymize **không** được coi là đã loại bỏ rủi ro tái liên kết (§7.1).

Cơ chế runtime bảo vệ các invariant trên → [`../../applications/account/01-architecture.md`](../../applications/account/01-architecture.md) §4, §7, §8, §10.

## 11. Chưa chốt

| Mục                                                                                                                                 | Kích hoạt                                           | Ảnh hưởng                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Password auth có bật hay không** — quyết định credential mật khẩu và mã khôi phục có tồn tại hay không, và cả luồng quên mật khẩu | Trước schema `db-account`                           | Hai khái niệm và toàn bộ email flow                                                                                                     |
| **MFA bắt buộc hay tuỳ chọn**, và có bật passkey trước TOTP không                                                                   | Trước khi bật login thật                            | UX đăng nhập, `acr`                                                                                                                     |
| **Staleness tối đa** của trạng thái account mà `auth` chấp nhận                                                                     | Trước tính năng suspend                             | [`../../applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md) §9                                           |
| **Cơ chế relay outbox**                                                                                                             | Trước tích hợp đầu tiên                             | Event sang `auth`                                                                                                                       |
| **Rate limit / anti-brute-force** số cụ thể                                                                                         | Trước khi bật login thật                            | [`../../applications/account/02-requirements.md`](../../applications/account/02-requirements.md) §6                                     |
| **Retention cụ thể** của audit và sự kiện bảo mật. Việc _có cần giữ_ đã là câu hỏi pháp lý mở, không phải mặc định giữ (§7.3)       | Trước production                                    | §8.1 (owner + kích hoạt)                                                                                                                |
| **Cơ sở pháp lý** cho từng mục inventory, và phạm vi áp dụng của từng bộ luật                                                       | Trước production                                    | §8.1 (owner + kích hoạt)                                                                                                                |
| **Có tái phát hành `sub`** cho cùng một người để cắt rủi ro tái liên kết không                                                      | Trước khi dùng `sub` làm khoá nối cho tính năng mới | Nếu **có**: token cũ có thể resolve nhầm sang người khác. Nếu **không**: giữ rủi ro tái liên kết (§7.1) — FR-012m; owner DPO + Security |
| **Cân bằng controller/processor, đánh giá chuyển dữ liệu quốc tế, mức độ áp dụng luật**                                             | Trước khi xử lý dữ liệu cá nhân ở quy mô thương mại | Phạm vi nghĩa vụ, điều khoản và hợp đồng áp dụng (§8)                                                                                   |

Unresolved system-wide liên quan service → tham chiếu, không liệt kê lại: [`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §10 · [`../../architecture/03-operations.md`](../../architecture/03-operations.md) §10. Quyết định kỹ thuật còn mở của component → [`../../applications/account/01-architecture.md`](../../applications/account/01-architecture.md) §12 và [`../../applications/account/02-requirements.md`](../../applications/account/02-requirements.md) §9.
