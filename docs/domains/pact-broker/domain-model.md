# Domain Model — Pact Broker

Bounded context `pact-broker`: hợp đồng consumer-driven contract testing (pact) cho hệ sinh thái Ecoma. Context sở hữu ngữ nghĩa nghiệp vụ của pact, verification, matrix, `can-i-deploy`, bản ghi environment/deployment, tenant/membership/role và machine credential của chính broker. Dogfooding: `llm-console`, `llm-seller`, `backoffice`… publish và verify pact qua broker này.

## 1. Mục đích và ranh giới

`pact-broker` lưu và phân phát **hợp đồng consumer-driven contract** (pact), kết quả verification, và trạng thái deploy (`can-i-deploy`) cho mọi dịch vụ Ecoma. Broker là nguồn sự thật cho tenant membership/role **của riêng broker**: role Owner/Admin/Member/Viewer của một tenant pact broker không suy ra từ role backoffice hay bất kỳ scope nào khác.

| Sở hữu                                                                                                                                                                                                                                                             | Không sở hữu                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pacticipants · versions · branches/tags · pacts + content SHA · verifications · matrix/can-i-deploy · environments · deployed/undeployed versions · tenant + membership + role của broker (owner là thuộc tính tenant, không phải role) · machine token của broker | danh tính người dùng (dùng `sub` từ access token của `auth`, tham chiếu opaque) · quyền nghiệp vụ scope khác · deployment thật (broker chỉ ghi nhận, không thực hiện) |

- `sub` là tham chiếu opaque, **không phải foreign key** xuyên database. `db-pact-broker` không đọc database nào khác, và không database nào khác đọc `db-pact-broker`.
- Broker **ghi nhận** deployment, **không thực hiện** deployment thật.
- Không có bounded context `Tenant` dùng chung; broker giữ role/lifecycle/machine token của riêng mình, tiêu thụ primitive kernel P1–P5 theo [ADR-0025](../llm-consumer-tenant/adr/0025-thin-shared-tenant-kernel.md), và không áp dụng model membership incarnation (membership incarnation là của từng sản phẩm). Owner là thuộc tính persistence của tenant, không phải role trên membership.
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
- **Membership** — quan hệ giữa một `sub` và một tenant, mang role `admin`/`member`/`viewer` (role `owner` đã bị loại khỏi từ điển role của membership; quyền sở hữu tenant nằm ở thuộc tính owner của tenant, không phải role). Một `sub` chỉ có tối đa một membership trong một tenant. Role của membership là dữ liệu sản phẩm dùng cho phân quyền nội bộ broker, không phải nguồn quyền sở hữu.
- **Machine credential** — token dành cho Pact CLI và CI, thuộc đúng một tenant, cấp trước một tập quyền cố định (`read`/`write`/`admin`). Token **không** đại diện cho một người: scope của token ≠ role của người tạo, và người tạo phải có role đủ cao để cấp scope đó.

Quy tắc nghiệp vụ bắt buộc:

- **Token là secret chỉ hiện một lần.** Plaintext chỉ trả về trong response của lệnh tạo; không đường đọc nào khác tồn tại. Hệ thống chỉ giữ dạng hash.
- **Revoke có hiệu lực ngay lập tức** và không phụ thuộc cache.
- **Không có token xuyên tenant.**
- **Không ghi nhận thời điểm dùng cuối** của token — biến nó thành điều kiện của mỗi lần phục vụ là biến observability thành serving-path dependency.
- Lỗi xác thực token **không phân biệt** "không tồn tại" với "đã revoke" trong phản hồi cho caller; chỉ audit được phân biệt.

Chi tiết schema, kiểu cột và ràng buộc composite → [`docs/applications/pact-broker/01-architecture.md`](../../applications/pact-broker/01-architecture.md) §3.

### 2.6 Audit

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
