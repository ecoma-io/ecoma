# ADR-0034 — Mô hình authorization human principal trên control plane `remote-cache`

> **Trạng thái:** Accepted · **Ngày:** 2026-11-14 · **Nguồn:** [#202](https://github.com/ecoma-io/ecoma/issues/202) (hiện thực, merge qua PR #226) · [#177](https://github.com/ecoma-io/ecoma/issues/177) (quyết định phạm vi Internal Developer Portal) · [`../../../applications/remote-cache/02-requirements.md`](../../../applications/remote-cache/02-requirements.md) R16/R17/R19/R20 · [`../../../applications/remote-cache/01-architecture.md`](../../../applications/remote-cache/01-architecture.md) §10 · **Issue:** [#272](https://github.com/ecoma-io/ecoma/issues/272)

> ⚠️ **Bản ghi hồi tố.** Hiện thực (#202, merge qua PR #226) đã vào `main` trước khi ADR này được viết — đây là đường implementation-first, không phải quy trình ADR-first. ADR này ghi nhận lại chính xác những gì code đang làm và các phương án đã cân nhắc; không đảo và không mở rộng quyết định nào. Mọi tuyên bố dưới đây về hành vi đều đã được đối chiếu với `apps/remote-cache-api/src/portal-auth.ts`, `src/portal-routes.ts` và migration `0008_portal_authorization.sql`.

## Bối cảnh

Quyết định phạm vi M1 của portal ([#177](https://github.com/ecoma-io/ecoma/issues/177)) yêu cầu một developer đã xác thực bằng Ecoma Account, là member của tenant sản phẩm, thực hiện được các thao tác control plane (tạo project, tạo thêm key, revoke key) **mà không cần sở hữu API key máy nào trước đó** (R18). Trước #202, principal duy nhất control plane nhận diện là API key — model chưa có đường này.

Các ràng buộc mà quyết định phải đáp ứng:

- **R16:** developer xác thực qua Ecoma Account (OIDC qua `auth.ecoma.io`); portal BFF giữ token server-side, session store owner là `account`. Control plane không tham gia phiên đăng nhập browser.
- **R17:** quyền resolve từ membership của tenant sản phẩm; người đã xác thực nhưng không có membership MUST bị từ chối mọi thao tác quản trị.
- **R19:** mọi mutation qua portal tạo audit entry ghi nhận người dùng khởi phát.
- **R20:** portal không cấp trusted CI credential cho developer trong M1.

Câu hỏi mở được ghi trong [`../domain-model.md`](../domain-model.md) §4: principal người dùng được đại diện thế nào khi gọi control plane qua BFF, role `member` được phép thao tác gì, và audit entry ghi actor bằng đại diện giá trị nào.

## Phương án

| #   | Phương án                                                                                                                      | Đánh giá                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Envelope HMAC nội bộ `ecoma-internal-v2` mang actor `sub` đã verify; control plane resolve membership từ DB** (đã hiện thực) | Chấp nhận — control plane tự verify danh tính bằng secret riêng (signature bao trùm actor header), rồi tự resolve quyền từ database (R17). Không thêm loại credential, không cache trạng thái, có replay guard bền                                                                                        |
| 2   | Control plane tin danh tính do browser/BFF chuyển tiếp (cookie, JWT, header tự khai) mà không verify                           | Loại — control plane không sở hữu session state (R16: owner là `account`) và không có secret để verify phiên browser; header tự khai là giả mạo được. Vi phạm nguyên tắc "không bao giờ tin danh tính browser cung cấp"                                                                                   |
| 3   | Token exchange: control plane cấp credential tạm thời cho BFF sau khi BFF xác thực                                             | Loại ở phạm vi M1 — thêm một vòng đời credential (cấp, refresh, thu hồi, storage) và một loại principal mới chỉ để gọi vài route quản trị; envelope HMAC stateless đã đáp ứng cùng yêu cầu bảo mật mà không cần state thêm ngoài kho nonce                                                                |
| 4   | Đại diện human principal bằng một hàng API key riêng cho từng developer                                                        | Loại — trộn hai phân lớp credential của domain model §2.4: key do portal cấp là developer credential phục vụ data plane, không phải đại diện danh tính trên control plane; audit actor sẽ trỏ vào key id thay vì người dùng, mất khả năng ghi nhận người khởi phát (R19)                                  |
| 5   | BFF tự resolve membership và chỉ gửi verdict; control plane tin mạng riêng (private service binding)                           | Loại — private binding chứng minh request đến từ BFF, không chứng minh actor là ai và không cho phép control plane tự kiểm quyền (R17 yêu cầu resolve từ membership của tenant trên đường dẫn). Mất một lớp defense-in-depth: mọi lỗ hổng BFF biến thành toàn quyền control plane                         |
| 6   | Phân quyền mutation theo role membership (owner/admin/member…)                                                                 | Loại ở phạm vi M1 — từ điển role hiện chỉ còn `member` (role `owner` đã bị loại, xem domain model §2.3). Code có đọc cột `role` khi resolve membership nhưng **không dùng nó** để phân biệt quyền; mọi member đều tạo project/key và revoke được. Nếu role được mở rộng, phân quyền theo role cần ADR mới |

## Quyết định

- **Principal representation:** envelope HMAC nội bộ `ecoma-internal-v2` (`@ecoma-io/internal-auth-contracts`) mang actor `sub` đã verify của developer Ecoma Account trong `x-ecoma-internal-actor-sub`. Header này nằm trong canonical string nên chữ ký bao trùm nó — control plane **không bao giờ** tin danh tính do browser cung cấp và không có đường nào nhận actor từ body. Portal BFF (#180) xác thực developer phía server rồi ký mọi call control plane bằng envelope này.
- **Chuỗi từ chối fail-closed:** thiếu cấu hình secret ⇒ 503; body vượt giới hạn ⇒ 413; envelope sai/hết hạn/replay ⇒ 401; envelope hợp lệ nhưng **không mang actor sub** ⇒ 401 (portal surface chỉ phục vụ human principal; caller máy chỉ dùng API-key routes). Sau verify, membership resolve **từ database trong request** tại `resolveTenantMembership` (`src/portal-routes.ts`) theo `(tenant_id, member_sub)` trên `remote_cache.tenant_members`: tenant không tồn tại ⇒ 404 (không reveal), tồn tại nhưng không phải member ⇒ 403.
- **Replay/skew protection:** claim nonce là chiếm-ghi nguyên tử (`DELETE` hết hạn + `INSERT ... ON CONFLICT DO NOTHING RETURNING`) trên `remote_cache.internal_nonces` (migration 0008), chạy ngay trong đường verify, prune theo lô trong cùng statement — không cần job riêng ở M1. TTL nonce neo vào timestamp của envelope + skew + buffer, nên nonce không sống quá cửa sổ replay. Trigger `internal_nonce_delete_guard` ở tầng database từ chối xoá nonce còn trong cửa sổ replay — credential runtime bị xâm hại không mở lại được cửa sổ replay. Pattern trùng `staff_access.internal_nonces`.
- **Role semantics trên M1 portal surface:** cột `role` được đọc khi resolve membership nhưng **không tham gia quyết định quyền**. Từ điển role hiện chỉ có `member`, nên mọi member của tenant đều thực hiện được cả sáu thao tác portal (list project, tạo project, xem chi tiết, tạo thêm key, list metadata, revoke). Không có phân quyền theo role trong M1.
- **Audit actor:** mutation do người dùng khởi phát ghi `actor = user:<sub>`; vocabulary mở rộng bởi migration 0008 với `project_created`, `api_key_created`, `api_key_revoked`. Audit insert nằm trong cùng transaction với mutation (không có mutation không có audit); attempt bị từ chối (lifecycle, trùng tên project, revoke key đã revoke) vẫn ghi `outcome = 'denied'`.
- **Trusted CI qua portal: KHÔNG** trong M1 (R20). Portal path chỉ cấp developer credential: `trusted_ci = false` cố định, scope `read` duy nhất (`PORTAL_API_KEY_SCOPES`), không có request nào chọn được `write` hay trusted. Migration 0008 thêm trigger `api_key_trust_class_guard` chặn mọi `UPDATE` đổi `trusted_ci` — phân lớp credential set lúc tạo, không đổi sau (domain model §2.4).
- **Mở lại khi:** role membership được mở rộng vượt `member`, hoặc portal cần cấp trusted CI credential — cả hai đều cần ADR mới, không thêm vào ngầm.

## Hệ quả

- [`../domain-model.md`](../domain-model.md) §4 không còn là mục mở; mô hình authorization human principal được định nghĩa bởi ADR này.
- [`../../../applications/remote-cache/01-architecture.md`](../../../applications/remote-cache/01-architecture.md) §10 không còn nêu đại diện canonical của human principal là quyết định còn mở.
- Control plane phụ thuộc `db-remote-cache` cho cả verify envelope (kho nonce) lẫn resolve membership — nhất quán với ADR-0017 (data plane cũng re-check DB mỗi request); không có đường phục vụ portal khi DB không tới được.
- **Hạn chế đã biết (chấp nhận):** wire shape và validator của portal surface hiện là app-local (`src/portal-contract.ts`) — contract public cho portal BFF (#180 tiêu thụ) chưa được công bố qua `libs/remote-cache-contracts`. Cho đến khi contract được publish, validation wire-shape bị phản chiếu hai nơi (app và tương lai là lib); việc viện contract là điều kiện tiên quyết của #180 và là follow-up của #202, không phải một quyết định mới.
- **Hạn chế đã biết (chấp nhận):** mọi member có toàn quyền mutation portal trong M1 (không phân quyền theo role). Đây là hệ quả trực tiếp của từ điển role chỉ còn `member`, không phải một lỗ hổng.
- Session của developer (cookie, OIDC, token) nằm hoàn toàn ở portal BFF và `account`; ADR này không thay đổi bất kỳ ranh giới session nào của R16.

## Cross-reference

- **System:** invariant 5/7 (một service sở hữu mỗi storage resource; không truy cập chéo database) · invariant 8 (consumer idempotent) — [`../../../architecture/01-architecture.md`](../../../architecture/01-architecture.md) §9.
- **Context:** [ADR-0015](./0015-remote-cache-bounded-context.md) (bounded context, storage) · [ADR-0017](./0017-lifecycle-enforcement.md) (lifecycle enforcement fail-closed — áp dụng cho cả portal mutation qua `checkMutationLifecycle`) · [`../domain-model.md`](../domain-model.md) §2.3, §2.4, §4.
- **Hiện thực:** #202 (merge qua PR #226 — `src/portal-auth.ts`, `src/portal-routes.ts`, `src/portal-contract.ts`, migration `0008_portal_authorization.sql`).
- **Index:** [`./README.md`](./README.md).
