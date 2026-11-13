# ADR-0032 — Developer Portal M1: permission matrix, credential purpose, creator-role→scope, audit policy và role bootstrap

> **Trạng thái:** Proposed · **Ngày:** 2026-11-14 · **Quyết định từ:** Issue #205 (quyết định 5, 6, 7, 8, 9, 13, 15, 16) · **Hiện thực:** #206 (enforcement API-side, audit coverage), #207 (credential self-service, atomicity, UI)

## Bối cảnh

Authorization của Pact Broker hiện là scope-only: `tenant_members.role` được ghi nhưng không request path nào đọc; `tenants.owner_sub` không nằm trên đường authorization nào; `/admin/machine-tokens` chỉ chấp nhận machine token scope `admin` với `actor_sub` luôn null (`apps/pact-broker-api/src/routes/admin.ts:34-89`). Quy tắc "người tạo phải có role đủ cao để cấp scope đó" có trong [`domain-model.md`](../domain-model.md) §2.5 nhưng chưa được enforce ở đâu ([`01-architecture.md`](../../../applications/pact-broker/01-architecture.md) §3.1). Khi portal có user path ([ADR-0031](./0031-developer-portal-authentication-and-identity-propagation.md)), authorization phải chuyển sang role/owner trên đường user mà không đổi machine path của Pact CLI.

Các sự kiện đã xác minh trên source (audit 2026-11-13):

- Route guards hiện hành: domain reads scope `read`; domain writes (publish, verification POST, environments/webhooks CRUD) scope `write`; `GET verification-results/:id` lại đòi scope `write` (`apps/pact-broker-api/src/routes/verifications.ts:22-24`) — không quyết định nào ghi nhận; `/admin/machine-tokens` scope `admin`.
- Audit: rotate atomic với audit trong một transaction (`admin.ts:133-149`); create và revoke **không** atomic — audit chạy transaction riêng sau mutation (`admin.ts:84-101`, `:182-204`), comment sai tại `admin.ts:83`; comment sai đó thuộc #207 (issue duy nhất được viết code giữa #206/#207). Coverage bắt buộc bởi baseline [`domain-model.md`](../domain-model.md) §2.7; khoảng trống implementation còn lại: membership grant/revoke qua entitlement projection và environment delete chưa ghi audit.
- List credential trả `id, name, scopes, createdAt, revokedAt`, không trả `created_by_sub` dù cột có sẵn (`libs/pact-broker-api-infrastructure/src/repo/tenant-repo.ts:289-312`); migration `0001` khai `created_by_sub` nullable.
- Role bootstrap hiện hành: membership owner lúc bootstrap tenant `ecoma` ghi role `member` (script `db/bootstrap-tenant.mts`, source `bootstrap`); projection entitlement ghi role `member` (`libs/pact-broker-api-application/src/provision-entitlement-membership.ts:43` — `DEFAULT_MEMBER_ROLE = 'member'`).
- [ADR-0025](../../llm-consumer-tenant/adr/0025-thin-shared-tenant-kernel.md) §4 quy định membership sinh từ entitlement "chỉ bắt đầu ở role thấp nhất" **không gọi tên** role nào.
- BFF read-only có test chốt (`apps/pact-broker-app/tests/read-only-bff.spec.ts`) — #207 thêm write route thì test phải có disposition.
- Thang role của broker: `viewer`/`member`/`admin` (CHECK ở migration); owner là thuộc tính `tenants.owner_sub`, không phải role ([`domain-model.md`](../domain-model.md) §2.5).

Ràng buộc không được phá: purpose label không bao giờ là security boundary đứng một mình; browser session và machine token là hai danh tính riêng; portal không publish pact qua browser; thu hẹp audit coverage đòi thay đổi domain model + ADR riêng — không nằm trong quyền của quyết định này.

## Quyết định

### 1. Permission matrix (quyết định 5 của #205)

Thang role tường minh: **`viewer` < `member` < `admin`**. Owner là authority riêng bám `tenants.owner_sub`, không phải bậc thang: trên mọi hành vi, owner có **tất cả** quyền của `admin` bất kể role của membership row của mình (bootstrap ghi `member` — §7). Staff Access system role không tự map thành role nào của broker.

Ma trận đầy đủ cho **đường user** (session principal đã verify, [ADR-0031](./0031-developer-portal-authentication-and-identity-propagation.md)):

| Hành vi                                                                                                  | viewer                                 | member                  | admin       | owner (owner_sub)                                        |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------- | ----------- | -------------------------------------------------------- |
| Đọc portal: pacts/versions/tags, verification results, matrix, `can-i-deploy`, environments, deployments | ✔                                      | ✔                       | ✔           | ✔                                                        |
| Xem metadata machine credential                                                                          | ✗ (403)                                | chỉ credential mình tạo | toàn tenant | toàn tenant                                              |
| Tạo credential purpose `developer` (scopes ⊆ `read`,`write`)                                             | ✗                                      | ✔                       | ✔           | ✔                                                        |
| Tạo credential purpose `ci` (scopes ⊆ `read`,`write`,`admin`)                                            | ✗                                      | ✗                       | ✔           | ✔                                                        |
| Rotate/revoke credential mình tạo                                                                        | ✗ (không bao giờ có credential tự tạo) | ✔                       | ✔           | ✔                                                        |
| Rotate/revoke credential người khác tạo                                                                  | ✗                                      | ✗                       | ✔           | ✔                                                        |
| Publish pact / ghi verification / CRUD environment qua portal                                            | ✗                                      | ✗                       | ✗           | ✗ — write domain giữ nguyên đường machine token trong M1 |
| Đổi role membership (của mình hay người khác)                                                            | ✗                                      | ✗                       | ✗           | ✗ — không có route trong M1 (§7)                         |

Trả lời trực tiếp các câu con của quyết định 5:

- (a) member **tự tạo được** credential purpose `developer`, scopes ⊆ {`read`, `write`}.
- (b) member list **chỉ credential mình tạo** (filter `created_by_sub` = principal); admin/owner list toàn tenant.
- (c) member rotate/revoke **chỉ credential mình tạo**.
- (d) owner có thẩm quyền **độc lập với membership row** — owner floor bằng quyền `admin` trên mọi hàng của ma trận.
- (e) purpose `ci`: `admin` và owner.
- (f) scope `admin`: `admin` và owner (trên đường user); machine token scope `admin` giữ nguyên năng lực mint ≤ `admin` (§3).
- (g) thao tác destructive (rotate/revoke) đòi **confirmation tường minh ở UI**; **không đòi step-up re-auth ở M1** — deferred có trigger: khi portal phục vụ tenant classification `customer` (M2+), step-up phải qua Modelling riêng theo pattern [ADR-0005](../../staff-access/adr/0005-step-up-fresh-session.md) trước khi hiện thực.

**Đường machine token không đổi**: matrix trên chỉ áp cho principal user; Pact CLI/CI tiếp tục đi theo scope (`read`/`write`/`admin`) như hiện hành, không có role. Enforcement cuối cùng nằm ở **API side** trên cả hai đường; BFF mirror chỉ cho UX.

### 2. Credential purpose `developer`/`ci` (quyết định 6 của #205)

- `purpose` là **creation-time metadata + validation, không phải authorization runtime**: request time không bao giờ đọc `purpose` để quyết định allow/deny — scope và role quyết định. Purpose label không được coi là security boundary đứng một mình.
- Giá trị: `developer` | `ci`; nullable (`NULL` = không khai). Migration thêm cột `purpose` vào `machine_tokens` — **#207 sở hữu**, expand-only.
- Set scope được phép: purpose `developer` ⇒ scopes ⊆ {`read`, `write`}; purpose `ci` ⇒ scopes ⊆ {`read`, `write`, `admin`}. Validation chạy **lúc tạo**, cùng đường validate creator-role (§3).
- Ai tạo: `developer` — `member` trở lên; `ci` — `admin`/owner (§1e).
- Lifecycle **giống hệt nhau** cho hai purpose: create/show-once/rotate/revoke, không TTL, không `last_used_at` (non-goal giữ nguyên). Đường machine token tạo token không bắt buộc `purpose` (contract FR-008 của CLI không đổi); đường user (portal) **bắt buộc** chọn purpose khi tạo.
- Tên hiển thị: `name` vẫn caller-chọn; `purpose` là label enum cố định trong list metadata.

### 3. Creator-role → scope rule (quyết định 7 của #205)

- Đường user: authority của creator phải **chi phối** scope xin cấp — `member` mint tối đa {`read`, `write`} (và chỉ purpose `developer`); `admin`/owner mint tới `admin` (purpose `ci`). Không ai mint vượt authority của mình.
- Đường machine: **không đổi** — token scope `admin` mint được scope ngang hàng `admin` và thấp hơn; không tồn tại scope cao hơn `admin` để mint vượt.
- Enforce ở API side (`/admin/machine-tokens` mở đường authority theo user identity song song guard hiện có — đúng phạm vi #207 đã khai); BFF mirror để UI disable control trước khi gọi.

### 4. Audit policy: atomicity và actor attribution (quyết định 8 của #205)

- **Coverage giữ nguyên baseline** [`domain-model.md`](../domain-model.md) §2.7 (token create/rotate/revoke, membership change, environment change); thu hẹp coverage đòi domain-model + ADR riêng — không thuộc quyết định này. Implementation của membership grant/revoke + environment delete audit thuộc **#206** (đã nằm trong phạm vi khai của nó).
- **Atomicity: create và revoke chuyển về single-transaction như rotate** — audit insert fail ⇒ mutation rollback, không để lại trạng thái nửa vời (fail-closed). Phương án "chấp nhận limitation" bị **loại**: một mutation thành công mà mất audit row vi phạm trực tiếp baseline §2.7. Hệ quả ràng buộc chéo: DoD atomicity test của #207 **giữ nguyên**, không cập nhật theo limitation nào — hai text không mâu thuẫn. **#207 sở hữu** việc hiện thực hoá + sửa comment sai `admin.ts:83`.
- **Actor attribution**: đường user ghi `actor_sub` = sub đã verify của principal (`actor_token_id` null); đường machine giữ nguyên hiện trạng (`actor_sub` null, `actor_token_id` = token của caller); bootstrap giữ nguyên (`actor_sub` = subject được provision).

### 5. Disposition của bất biến read-only-BFF (quyết định 9 của #205)

Bất biến đọc-only của BFF bị **thu hẹp, không bỏ**: write domain (publish/verify/record-deployment/environment mutation) tiếp tục **không tồn tại** dưới `/api/broker/*` ở M1; write duy nhất được phép là credential management (create/rotate/revoke machine token) theo ma trận §1. `apps/pact-broker-app/tests/read-only-bff.spec.ts` được **#207 biến đổi** khi thêm mutation route: test mới ghim "không có route write domain; mọi mutation route đòi principal đã verify + role theo ma trận". Non-goal "không publish pact qua browser" giữ nguyên.

### 6. `GET verification-results/:id` đổi scope `write` → `read` (quyết định 13 của #205)

Đọc một verification result là hành vi đọc — guard scope `write` tại `apps/pact-broker-api/src/routes/verifications.ts:22-24` là lệch semantic, không phải lựa chọn CLI-compat có chủ đích. Đổi thành scope `read`: thay đổi **strictly permissive** (thứ tự bao hàm `read` ⊂ `write` ⊂ `admin` nên mọi caller hiện có — CLI publish/verify luôn mang token có `write` — không thể vỡ), mở đúng khả năng dùng token read-only cho việc đọc kết quả. **#206 sở hữu** guard change + cập nhật test assert liên quan. Trang verification của portal đi đường user (ma trận §1 — `viewer` trở lên đọc được), không phụ thuộc scope machine token.

### 7. Role bootstrap, owner authority và lệch ghi nhận so với ADR-0025 §4 (quyết định 15 của #205)

- Thang role: `viewer` < `member` < `admin` (§1) — `viewer` là role thấp nhất.
- **Bootstrap giữ nguyên giá trị code hiện hành**: membership của owner lúc bootstrap tenant `ecoma` ghi role `member`, source `bootstrap`; projection entitlement vào `ecoma` ghi role `member` (`DEFAULT_MEMBER_ROLE = 'member'`).
- **Lệch ghi nhận đã chấp nhận so với [ADR-0025](../../llm-consumer-tenant/adr/0025-thin-shared-tenant-kernel.md) §4**: rule "membership sinh từ entitlement chỉ bắt đầu ở role thấp nhất" nếu áp nguyên văn sẽ cho `viewer`, nhưng M1 không có bề mặt thăng hạng nào, mà purpose `developer` đòi `member` trở lên (§1a) — chốt projection `viewer` sẽ khoá chết mục tiêu dogfooding (nhân sự nội bộ không thể tự phục vụ credential). Deviation giới hạn ở projection first_party vào tenant `ecoma` (classification theo §2.6); membership tenant customer không đi qua projection này nên không bị ảnh hưởng. ADR-0025 giữ nguyên hiệu lực cho các sản phẩm khác; deviation này được ghi đúng một chỗ — ADR này — và [`domain-model.md`](../domain-model.md) §2.6 cập nhật con trỏ theo.
- **Owner authority xoá deadlock**: với (d) — authority owner độc lập khỏi membership row — owner của tenant mới tạo được credential đầu tiên ngay cả khi row của mình là `member`; không có tình huống "tenant mới không tạo được credential nào".
- **Tự thăng hạng**: M1 không có route đổi role; câu hỏi policy thăng/giảm hạng **không mở ở M1** — mọi bề mặt đổi role tương lai đòi Modelling riêng quyết định "ai được đổi role của ai" trước khi hiện thực. Đây là ràng buộc cho work tương lai, không phải open item.

### 8. Expose `created_by_sub` trong list metadata (quyết định 16 của #205)

**Expose** — list trả thêm `createdBy` = giá trị `created_by_sub` (tham chiếu opaque `sub`, không resolve tên hiển thị — ánh xạ sub → tên thuộc Account, nằm ngoài bounded context). Visibility đi theo ma trận §1 (member chỉ thấy row mình tạo nên chỉ thấy `createdBy` của mình; admin/owner thấy toàn tenant). `sub` vốn là tham chiếu opaque được lưu trên audit_events (§1) — expose trong metadata cho caller đã được authorize nhìn thấy không mở ranh giới danh tính mới. **#207 sở hữu** (repo SELECT + DoD UI "hiển thị creator/purpose/scopes/created/active-revoked").

## Hệ quả

- `/admin/machine-tokens` có hai đường authorize song song: machine-token scope `admin` (không đổi) và user principal theo ma trận. Ma trận này là **contract mà #206/#207 enforce** — không quyết định policy lại khi hiện thực.
- Viewer là role first-class: mọi control mutation của portal phải ẩn/vô hiệu với viewer, và API từ chối 403 — không dựa vào ẩn UI.
- Purpose là dữ liệu validated lúc tạo, hiển thị lúc đọc; không bao giờ là input authorization runtime.
- Create/revoke atomic hoá về cùng hình dạng transaction với rotate; audit hàng luôn tồn tại cho mutation thành công.
- Machine path của Pact CLI/CI không đổi gì — tương thích CLI giữ nguyên (§8 của [`01-architecture.md`](../../../applications/pact-broker/01-architecture.md)).
