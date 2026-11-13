# Domain Model — Pact Broker

Bounded context `pact-broker`: hợp đồng consumer-driven contract testing (pact) cho hệ sinh thái Ecoma. Context sở hữu ngữ nghĩa nghiệp vụ của pact, verification, matrix, `can-i-deploy`, bản ghi environment/deployment, tenant/membership/role và machine credential của chính broker. Dogfooding: `llm-console`, `llm-seller`, `backoffice`… publish và verify pact qua broker này.

## 1. Mục đích và ranh giới

`pact-broker` lưu và phân phát **hợp đồng consumer-driven contract** (pact), kết quả verification, và trạng thái deploy (`can-i-deploy`) cho mọi dịch vụ Ecoma. Broker là nguồn sự thật cho tenant, membership và role **của riêng broker**: role membership `admin`/`member`/`viewer` của broker không suy ra từ role backoffice, Staff Access hay bất kỳ scope nào khác, và owner là thuộc tính của tenant — không phải role (§2.5).

| Sở hữu                                                                                                                                                                                                                                                                                                                   | Không sở hữu                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pacticipants · versions · branches/tags · pacts + content SHA · verifications · matrix/can-i-deploy · environments · deployed/undeployed versions · tenant + membership + role của broker (owner là thuộc tính tenant, không phải role) · classification, plan và chính sách Free slot (§2.6) · machine token của broker | danh tính người dùng (dùng `sub` từ access token của `auth`, tham chiếu opaque) · quyền nghiệp vụ scope khác · deployment thật (broker chỉ ghi nhận, không thực hiện) · subscription/billing (chỉ tiêu thụ tín hiệu subscription, không sở hữu nó) |

- `sub` là tham chiếu opaque, **không phải foreign key** xuyên database. `db-pact-broker` không đọc database nào khác, và không database nào khác đọc `db-pact-broker`.
- Broker **ghi nhận** deployment, **không thực hiện** deployment thật.
- Không có bounded context `Tenant` dùng chung; broker giữ role/lifecycle/machine token của riêng mình, tiêu thụ guard opaque ID (P1) của kernel ở persistence/bootstrap boundary và áp bất invariant owner §3 qua cột `owner_sub` NOT NULL + CHECK theo [ADR-0025](../llm-consumer-tenant/adr/0025-thin-shared-tenant-kernel.md), và không áp dụng model membership incarnation (membership incarnation là của từng sản phẩm). Owner là thuộc tính persistence của tenant, không phải role trên membership.
- Machine token là credential riêng cho Pact CLI/CI, không bao giờ chia sẻ với browser session.

## 2. Ngữ nghĩa nghiệp vụ

### 2.1 Pact

Pact là hợp đồng consumer-driven giữa consumer và provider. Một pact gắn liền với consumer version và provider, có content SHA-256. Content SHA bất biến theo version: publish pact cùng SHA → phản ánh kết quả (unchanged/changed), publish khác SHA → tạo bản mới.

### 2.2 Verification

Verification là kết quả kiểm tra provider có thoả pact hay không. Verification gắn với một pact và một provider version, có trường `success` boolean và `providerApplicationVersion` bắt buộc. Kết quả verification feeding vào matrix và `can-i-deploy`.

### 2.3 Matrix và `can-i-deploy`

Matrix trả về đầy đủ consumer/provider/version/verification, kết hợp thành trạng thái tri-state `deployable`:

- `true`: mọi verification đã pass.
- `false`: có verification fail.
- `null`: unknown — thiếu dữ liệu hoặc selector không khớp.

`can-i-deploy` trả lời "version này có thể deploy vào environment/tag/branch này không". **Unknown không hiểu là safe**: khi `deployable === null`, CLI phải exit fail với lý do rõ ràng ("unknown, not verified"). Đây là business-level deviation so với upstream (upstream để ma trận rỗng qua `deployable: true` — fail-open); Ecoma ép fail-closed cả hai tình huống rỗng (selector không khớp, hoặc version tồn tại nhưng chưa publish pact).

### 2.4 Version, environment, deployment record

- Version: phiên bản của một pacticipant được publish. `getOrCreateVersion` là backfill-only (không tự sinh version ngoài publish).
- Environment: môi trường deployment mà broker ghi nhận.
- Deployment record: `deployed/undeployed` version, `undeployed_at NULL` có nghĩa là đang deploy.

### 2.5 Tenant, membership, role của broker

Tenant là ranh giới cách ly dữ liệu của broker. **Mọi** dữ liệu domain thuộc đúng một tenant; một bản ghi "lệch tenant" là bất hợp lệ ở mức mô hình, không chỉ là lỗi truy vấn.

- **Tenant** — có danh tính ổn định và lifecycle `active`/`suspended`/`deleted`. Mỗi tenant có đúng một **owner** là tham chiếu `sub` opaque, lưu độc lập trên bản ghi tenant — không phải role hay grant trên membership, không ràng buộc bằng membership, và không tồn tại tenant ownerless. Tenant mặc định cho một `sub` được provision **tường minh** (deterministic từ `sub`), không tự động khi signup/login; provision lặp lại là idempotent và an toàn khi tranh chấp.
- **Membership** — quan hệ giữa một `sub` và một tenant, mang role theo thang tường minh `viewer` < `member` < `admin` (role `owner` đã bị loại khỏi từ điển role của membership; quyền sở hữu tenant nằm ở thuộc tính owner của tenant, không phải role). Một `sub` chỉ có tối đa một membership trong một tenant. Role của membership là dữ liệu sản phẩm dùng cho phân quyền nội bộ broker, không phải nguồn quyền sở hữu. Authority của owner độc lập với membership row: trên mọi hành vi, owner có toàn bộ quyền của `admin` bất kể row của mình ghi role gì ([ADR-0032](./adr/0032-developer-authorization-matrix-and-credential-policy.md) §7).
- **Machine credential** — token dành cho Pact CLI và CI, thuộc đúng một tenant, cấp trước một tập quyền cố định (`read`/`write`/`admin`). Token **không** đại diện cho một người: scope của token ≠ role của người tạo, và người tạo phải có role đủ cao để cấp scope đó. Credential mang `purpose` `developer`/`ci` — metadata validated lúc tạo (ràng buộc set scope được phép và role được phép tạo từng purpose), không bao giờ là input authorization runtime ([ADR-0032](./adr/0032-developer-authorization-matrix-and-credential-policy.md) §2).

Quy tắc nghiệp vụ bắt buộc:

- **Token là secret chỉ hiện một lần.** Plaintext chỉ trả về trong response của lệnh tạo; không đường đọc nào khác tồn tại. Hệ thống chỉ giữ dạng hash.
- **Revoke có hiệu lực ngay lập tức** và không phụ thuộc cache.
- **Không có token xuyên tenant.**
- **Không ghi nhận thời điểm dùng cuối** của token — biến nó thành điều kiện của mỗi lần phục vụ là biến observability thành serving-path dependency.
- Lỗi xác thực token **không phân biệt** "không tồn tại" với "đã revoke" trong phản hồi cho caller; chỉ audit được phân biệt.

Chi tiết schema, kiểu cột và ràng buộc composite → [`docs/applications/pact-broker/01-architecture.md`](../../applications/pact-broker/01-architecture.md) §3. Permission matrix đầy đủ (đường user theo role/owner, đường machine theo scope), creator-role→scope enforce và audit actor attribution → [ADR-0032](./adr/0032-developer-authorization-matrix-and-credential-policy.md).

### 2.6 Classification, plan và chính sách Free

**Classification tenant.** Mỗi tenant có đúng một **classification** là `first_party` hoặc `customer`, thuộc tính NOT NULL của bản ghi tenant trong broker. Classification là **quan hệ tổ chức** (tenant của Ecoma hay của khách hàng), không phải commercial plan — [ADR-0026](../llm-consumer-tenant/adr/0026-first-party-dogfooding-and-commercial-policy-boundaries.md). Nó chỉ được thiết lập qua đường provisioning sản phẩm kiểm soát (bootstrap/seed theo bề mặt của [ADR-0020](../staff-access/adr/0020-bootstrap-seed-contract.md)); mặc định khi tạo qua đường customer là `customer`; không suy ra từ owner, email domain, tên tenant, environment, plan hay membership role, và không có đường customer-facing nào tự gán `first_party`. Classification **bất invariant sau khi thiết lập** — không có thao tác đổi classification nào sau provisioning, customer-facing hay operator-facing; chuyển đổi classification nằm ngoài model MVP và đòi một quyết định/ADR tương lai — chi tiết cross-product → [ADR-0026](../llm-consumer-tenant/adr/0026-first-party-dogfooding-and-commercial-policy-boundaries.md) §1.

**Plan.** Tenant `customer` có đúng một **plan** là `free` hoặc `paid`; tenant `first_party` **không có plan** (plan không áp dụng — không có giá trị, không phải một giá trị thứ ba của enum). Plan có giá trị nếu và chỉ nếu classification là `customer`. Plan không đổi ngữ nghĩa của pact, verification và `can-i-deploy` (§2.1–§2.4); classification cũng vậy.

**Slot Free theo owner.** Chủ thể của slot là `owner_sub` trên bản ghi tenant (§2.5) — không phải membership. Mỗi owner sở hữu tối đa **một** tenant `free` concurrent trong `pact-broker`. Slot là bất invariant của từng sản phẩm: một user có thể cùng lúc sở hữu một tenant Free `pact-broker` và một tenant Free `remote-cache`, vì tenant của hai context không dùng chung. Membership ở tenant khác — bất kể role — không tiêu slot. Chỉ tenant có plan `free` tiêu slot: tenant `paid` và tenant `first_party` (không có plan) đều không tiêu slot Free — hạn mức một-free-của-mỗi-owner chỉ tính tenant `free` chưa `deleted`.

**Trạng thái và slot.** Tenant Free bị `suspended` vẫn tiêu slot. Chờ xoá không phải trạng thái lifecycle: lifecycle giữ nguyên `active`/`suspended`/`deleted` (§2.5), không có giá trị thứ tư. Tình trạng chờ xoá — yêu cầu xoá đã nhận nhưng logical deletion chưa commit — được biểu diễn bằng state xoá do `pact-broker` sở hữu: một deletion request/metadata tách khỏi `status` (lưu ở cột hay bảng riêng là chi tiết delivery; đường record này chưa hiện diện trong migration hiện có). Trong cửa sổ chờ xoá đó tenant Free vẫn tiêu slot. Slot chỉ được giải phóng khi logical deletion commit thành công và `status` thành `deleted`; retention/purge physical data sau đó không giữ slot.

**Xoá và thay thế.** Xoá tenant Free cho phép tạo tenant thay thế không giới hạn lần. Mỗi tenant thay thế có tenant ID mới và tên chưa từng dùng — tenant đã xoá không bao giờ được resurrect hay reuse, và tên của nó tiếp tục bị giữ vĩnh viễn dưới semantics unique của `name` hiện có. Tên default deterministic suy từ `sub` (§2.5) chỉ phục vụ provision tenant mặc định lần đầu; nó không cho phép tái sử dụng tên của tenant đã xoá khi provision tenant thay thế.

**Subscription và tenant trả phí.** Mỗi owner có tối đa một tenant `free` đang tồn tại — chưa `deleted` — trong `pact-broker` (**Slot Free theo owner** ở trên). Quy tắc này áp cho tenant `customer`: sở hữu tenant `first_party` không chiếm slot Free và không chặn owner tạo tenant `free` customer. Khi tenant `free` đó còn tồn tại, tenant thêm của cùng owner phải được tạo là tenant `paid` và đòi subscription hợp lệ; khi tenant `free` đã bị logical deletion, việc tạo tenant Free thay thế không bị giới hạn số lần (**Xoá và thay thế** ở trên). Subscription không phải là plan: subscription hết hạn không tự đổi plan của tenant — không có silent downgrade từ `paid` về `free`; quyền truy cập tenant khi subscription hết hạn do chính `pact-broker` enforce, không thuộc kernel hay bounded context dùng chung.

**Owner transfer.** Transfer ownership kiểm tra slot Free của owner mới trong cùng transaction với việc đổi owner: transfer khiến owner mới vượt quá một tenant Free concurrent bị từ chối, trừ khi tenant được convert sang `paid` với subscription hợp lệ. Slot của owner cũ chỉ được giải phóng sau khi transfer commit thành công.

**Tenant nội bộ `ecoma`.** Tên canonical của tenant nội bộ là `ecoma` ([glossary](../glossary.md); [ADR-0020](../staff-access/adr/0020-bootstrap-seed-contract.md)); không có tenant song song `ecoma-internal`. Classification của nó là `first_party` — không phải `customer` — nên không có plan (`free`/`paid` không áp dụng) và không tham gia bất invariant slot Free. Tenant này được provision duy nhất qua internal bootstrap có kiểm soát (ADR-0020), không qua đường tạo tenant customer; owner của nó là subject Superadmin canonical. System role của Staff Access không tự map thành membership role của broker; membership projection cho nhân sự nội bộ, nếu được tạo, khởi đầu ở role `member` — lệch áp dụng đã chấp nhận so với nguyên văn "role thấp nhất" của [ADR-0025](../llm-consumer-tenant/adr/0025-thin-shared-tenant-kernel.md) §4, giới hạn ở projection first_party vào tenant `ecoma` và được ghi trong [ADR-0032](./adr/0032-developer-authorization-matrix-and-credential-policy.md) §7; ownership là fact riêng không đổi theo membership đó.

**Plan và classification không thay entitlement.** Product entitlement của `staff-access` trả lời tính khả dụng sản phẩm của một nhân sự, không phải plan hay classification của tenant; ba khái niệm không thay thế nhau. Provenance của membership (`source` ∈ `entitlement`/`bootstrap`/`admin`) giữ nguyên ngữ nghĩa hiện có, và plan lẫn classification không đổi provenance của membership nào: thu hồi entitlement không xoá membership khách hàng tự quản (`source = 'admin'`) hay machine credential.

**Enforcement schema.** Các bất invariant classification/plan/slot Free được enforce ở database, không chỉ qua application check: cột classification NOT NULL trên tenant với đúng hai giá trị `first_party`/`customer`; `plan` nullable ở mức contract model/storage, với điều kiện bất invariant `classification = 'customer' ⇒ plan IN ('free','paid')` và `classification = 'first_party' ⇒ plan không có giá trị (NULL)` — hai vế luôn giữ, plan chỉ tồn tại khi tenant là customer; cộng một partial unique index tên `tenants_one_free_per_owner_key` trên cột (`owner_sub`) của bảng tenant với điều kiện `plan = 'free'` AND `status <> 'deleted'` — `UNIQUE(owner_sub) WHERE plan = 'free' AND status <> 'deleted'` (tenant `first_party` không có plan nên không bao giờ khớp điều kiện); tên index theo quy ước `<table>_<descriptor>_key` của các unique index hiện có. Hai request tạo tenant Free concurrent cùng owner: đúng một commit thành công, request kia bị constraint từ chối — application check đơn thuần không đủ.

_Ghi chú delta:_ giá trị plan `internal` được rút khỏi enum plan theo [ADR-0026](../llm-consumer-tenant/adr/0026-first-party-dogfooding-and-commercial-policy-boundaries.md) §7 — delta lên quyết định đã accept của #13 (đóng); phần còn lại của §2.6 giữ nguyên hiệu lực.

### 2.7 Audit

Mọi thay đổi quản trị — tạo/revoke token, thay đổi membership, thay đổi environment — tạo một bản ghi audit **append-only**. Bản ghi audit không bao giờ bị sửa hay xoá bởi đường ứng dụng.

Broker không xử lý payload người dùng cuối nào ngoài nội dung pact; nội dung pact là artifact test và được lưu theo đúng nghiệp vụ. Không ghi log secret, token hay credential.

## 3. Invariant nghiệp vụ

1. Mọi dữ liệu domain thuộc đúng một tenant; không tồn tại bản ghi không có tenant.
2. Tenant isolation được bảo đảm ở tầng lưu trữ, không chỉ ở truy vấn.
3. Token chỉ tồn tại dưới dạng hash; plaintext hiện đúng một lần; revoke hiệu lực tức thời.
4. `can-i-deploy` unknown ≠ safe (fail-closed tri-state).
5. Audit append-only.
6. Không log secret, token, credential.
7. Không down-migration; expand → compatible rollout → contract.
8. Bootstrap/build/test/migrate không phụ thuộc dịch vụ nào đang sống.
9. Mỗi owner tối đa một tenant `free` concurrent, enforce ở database bằng partial unique trên `owner_sub` với điều kiện plan và lifecycle (§2.6; tenant `first_party` không có plan nên không bao giờ khớp điều kiện); suspended và pending-deletion vẫn tiêu slot; slot chỉ giải phóng khi logical deletion commit.
10. Tenant đã xoá không được resurrect hay reuse: replacement có tenant ID mới và tên mới, tên đã xoá vẫn reserved (§2.6).
11. Plan không tự đổi theo subscription — không silent downgrade; subscription hết hạn do chính `pact-broker` enforce (§2.6).
12. Classification `first_party`/`customer` là quan hệ tổ chức, không suy ra từ owner/email/tên/environment/plan/role: chỉ thiết lập qua đường provisioning sản phẩm kiểm soát và bất invariant sau khi thiết lập — không có thao tác đổi classification trong model MVP; plan có giá trị khi và chỉ khi classification là `customer` (§2.6).

## 4. Quyết định không mang sang từ upstream

- Một credential dùng chung cho mọi caller → từ chối (không multi-tenant; lộ một credential là mất hết).
- Đọc công khai mặc định → từ chối (pact nội bộ Ecoma).
- CORS mở cho mọi origin → từ chối (chỉ origin dashboard đã cấu hình).
- Lưu trữ nhúng trong Durable Object với migration trong constructor → từ chối (không còn Durable Object; lưu trữ quan hệ riêng, migration từ CI runner).
- Webhook fire bất đồng bộ kèm retry trên production path → từ chối cho đến khi có SSRF guard chứng minh được.
- Badge SVG đọc công khai → từ chối (mâu thuẫn với yêu cầu credential mọi endpoint domain).
- Rate limit per-IP dựa trên Durable Object/KV → bỏ (không có KV binding trong phạm vi).

## 5. Open boundary

Không có open boundary nghiệp vụ còn mở trong phạm vi context này.
