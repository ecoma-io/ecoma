# ADR-0020 — Hợp đồng bootstrap/seed liên service: chạy ngoài serving path, seed thuộc service sở hữu dữ liệu

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4). ADR này chốt **đường chạy** của bootstrap/seed trên toàn hệ thống và **tên tenant nội bộ canonical**; nó supersede-in-part [ADR-0003](./0003-bootstrap-first-admin-recovery.md) ở đúng hai điểm ghi ở §"Quan hệ với ADR-0003". Nội dung vận hành đầy đủ (thứ tự bước, bảng bước → database, idempotency, verify) nằm ở [`architecture/02-delivery.md`](../../../architecture/02-delivery.md) §3.2 — architecture sở hữu policy delivery; ADR này chỉ giữ **quyết định**.

> **Trạng thái:** Accepted · **Ngày:** 2026-11-09 · **Quyết định từ:** [`architecture/02-delivery.md`](../../../architecture/02-delivery.md) §0, §3.1 · [ADR-0003](./0003-bootstrap-first-admin-recovery.md) · [ADR-0010](./0010-permission-naming-and-read-catalog.md) · [ADR-0013](./0013-staff-access-ownership-transfer.md) · [ADR-0015](../../remote-cache/adr/0015-remote-cache-bounded-context.md) · **Issue:** #10

## Bối cảnh

Ba hiện trạng mâu thuẫn nhau trong cùng một cây code:

1. `deploys/remote-cache-deploy/index.ts` và `deploys/staff-access-deploy/index.ts` ghi "deploy unit cấm mọi code path bootstrap", trong khi [`architecture/02-delivery.md`](../../../architecture/02-delivery.md) §0 ghi **provisioning** là một đường thay đổi riêng do Pulumi project trong `deploys/` sở hữu.
2. `deploys/pact-broker-api-deploy/index.ts` và `deploys/auth-deploy/index.ts` **đang** seed dữ liệu trong deploy unit (tenant `local` + machine token; OAuth client `ecoma-backoffice-local`), nên câu "cấm mọi code path" đã bị chính repo phủ định.
3. Hai migration `0003_permission_catalog_seed.sql` insert dữ liệu permission, trong khi `02` §3 mô tả migration chỉ tạo schema.

Cùng lúc, ba tên khác nhau đang chỉ cùng một thứ: `ecoma-internal` (bootstrap script Pact Broker, consumer entitlement), `local` (seed deploy local), `Ecoma` (yêu cầu MVP). Không có ADR nào chốt tên nào là canonical, nên mỗi Issue Delivery sẽ tự chọn một tên.

Câu hỏi ADR này trả lời: bootstrap/seed chạy ở đâu, dữ liệu nào thuộc lớp đó, và tên tenant nội bộ canonical là gì.

## Phương án

| #   | Phương án cho đường chạy bootstrap                                                                                                                       | Đánh giá                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Bước một-lần trong provisioning lifecycle của deploy unit sở hữu dữ liệu, cộng CLI offline cùng service cho production và cho bước cần `ecoma_owner`** | Chấp nhận — chạy ngoài Worker, dùng credential migrator/owner không bao giờ vào Worker, không route, không flag, không phụ thuộc service đang serving; giữ được "deploy/readiness fail nếu bootstrap fail" bằng thứ tự phụ thuộc resource; cùng một đường dùng được cho local và environment thật |
| 2   | Framework bootstrap trung tâm (service/migration runner ôm mọi service)                                                                                  | Loại — service thứ hai ghi database của service khác, phá A9 và `AGENTS.md`; tạo distributed transaction chỉ để che một nhu cầu mà thứ tự bước đã giải quyết được                                                                                                                                 |
| 3   | Chạy bootstrap trong Worker (cron, route nội bộ, flag "nếu chưa có thì tạo")                                                                             | Loại — đúng hình dạng backdoor mà [ADR-0003](./0003-bootstrap-first-admin-recovery.md) và invariant 36 cấm; Worker không giữ được credential owner/migrator (invariant 1)                                                                                                                         |
| 4   | Chỉ manual SQL, không có entry point nào trong repo                                                                                                      | Loại cho mọi bước trừ first-admin — không kiểm được, không lặp lại được, và biến mỗi environment thành một lần gõ tay không idempotency                                                                                                                                                           |
| 5   | Đưa toàn bộ seed vào migration                                                                                                                           | Loại — dữ liệu biến thiên theo lane/environment (redirect URI, tenant, token) không thể nằm trong file migration; credential trong migration là chỗ credential không được phép xuất hiện                                                                                                          |

## Quyết định

1. **Bootstrap/seed là lớp dữ liệu thứ tư, không phải migration và không phải application release.** Nó chỉ chứa **dữ liệu khởi tạo do hệ thống sở hữu**: bản ghi mà sản phẩm cần để hoạt động và không do người dùng tạo ra — Account đầu tiên, staff/role assignment đầu tiên, tenant nội bộ + membership, machine credential cho CI, provider/offer đầu tiên. Dữ liệu do người dùng tạo lúc chạy (tenant của khách hàng, project, API key của khách) **không** thuộc lớp này và giữ nguyên đường tạo riêng của sản phẩm.
2. **Không có code path bootstrap nào trên serving path của Worker.** Cấm route HTTP, cấm flag runtime, cấm logic "nếu chưa có thì tạo" trong Worker bundle. Đây là nghĩa đúng của câu "deploy unit cấm mọi code path bootstrap" đang ghi trong `deploys/remote-cache-deploy` và `deploys/staff-access-deploy`: cấm **đường serving**, không cấm bước provisioning.
3. **Hai bề mặt thực thi, chọn đúng một cho mỗi bước:** (a) bước một-lần trong provisioning lifecycle của deploy unit sở hữu dữ liệu, chạy sau `migrate` và trước khi container serving khởi động — bề mặt của lane local; (b) CLI offline nằm trong chính app sở hữu dữ liệu, chạy bằng credential migrator/owner — bề mặt cho environment thật và cho bước cần `ecoma_owner`. Không bề mặt nào đọc/ghi database của service khác.
4. **Seed thuộc service sở hữu dữ liệu, ghi đúng một database.** Mỗi bước chỉ ghi database của chính service đó; bước cần nhiều database phải liệt kê tường minh cùng cơ chế hội tụ khi chạy lại. Không FK xuyên database, không transaction nguyên tử xuyên database, không dùng email làm subject của Account — `sub` là tham chiếu duy nhất đi xuyên service.
5. **Idempotent bằng natural key, không bằng state ngoài.** Mỗi bước có khoá tự nhiên trong domain (`sub`, `(product, tenant name)`, `(tenant, sub)`, `client_id`, `sha256(plaintext token)`, permission id); chạy lại là no-op trên bản ghi đã có và hội tụ về đúng trạng thái của một lần chạy sạch. Không file trạng thái, không bảng marker, không đọc log để quyết định bước kế tiếp.
6. **Không có compensating step nào; forward-fix theo invariant 11.** Mọi bước là insert-if-absent hoặc update trường không phải danh tính, nên trạng thái dở dang là một **tiền tố hợp lệ**, không phải trạng thái hỏng: chạy lại toàn bộ hợp đồng từ đầu là cơ chế phục hồi duy nhất. Tenant ở trạng thái `suspended`/`deleted` phải fail-closed, không được hồi sinh.
7. **Lỗi được cô lập theo service.** Bootstrap/verify của một unit thất bại chỉ làm unit đó không ready và không được coi là hoàn tất; các unit khác vẫn retry được. Phụ thuộc duy nhất giữa các unit là giá trị `sub` do bước Account sinh ra — một giá trị đầu ra, không phải một ràng buộc giao dịch.
8. **Mỗi bước có một kiểm tra đọc được, không dựa vào log.** Kiểm tra là một câu truy vấn/probe trả về đúng bản ghi kỳ vọng (hoặc đúng một `sub`), chạy được bằng chính bề mặt đã chạy bước đó. Bảng bước → database → kiểm tra là nội dung canonical của `02` §3.2.
9. **Tên tenant nội bộ canonical là `ecoma-internal`.** Đây là tên lưu trong database, ở mọi sản phẩm có tenant và mọi environment; `Ecoma` chỉ là nhãn hiển thị trong prose, `local` chỉ là nhãn lane và **không** phải tên tenant. Mỗi sản phẩm vẫn sở hữu tenant riêng của nó: cùng chuỗi `ecoma-internal` ở `pact-broker` và `remote-cache` là hai entity khác nhau, không FK, không suy quyền ([ADR-0015](../../remote-cache/adr/0015-remote-cache-bounded-context.md)).
10. **Migration được chứa đúng một lớp dữ liệu: catalog sealed.** Reference data có danh tính cố định lúc review, không biến thiên theo environment, không phải credential — permission catalog và mail template catalog — nằm trong migration của service sở hữu, insert idempotent, forward-only. Tenant, membership, staff/role assignment, machine token, OAuth client, và mọi credential **không** được nằm trong migration.

## Quan hệ với ADR-0003

Hai điểm bị supersede, phần còn lại giữ nguyên hiệu lực:

- **Bị supersede:** câu "Không có route/flag/code-path nào thực hiện bootstrap hay recovery" được đọc lại thành **"không có route/flag/code path nào trên serving path của Worker"** theo Quyết định 2 và 3 ở trên. Một bước provisioning hoặc CLI offline không phải code path của application.
- **Bị supersede:** tên database trong ADR-0003 (`db-backoffice`) đọc theo [ADR-0013](./0013-staff-access-ownership-transfer.md) là `db-staff-access` — đây là cách đọc đã được ADR-0013 tuyên bố cho ADR-0002…0012, ghi lại ở đây để ADR-0003 không còn bị trích dẫn như một mâu thuẫn.
- **Giữ nguyên hiệu lực:** first-admin là procedure có hai-phím, có audit trail, không có nút UI; `sub` phải tồn tại ở `db-account` trước khi tạo staff; procedure không được tự phát hiện "đã có admin rồi" để rẽ nhánh. Idempotent theo natural key (Quyết định 5) **không** phải logic phát hiện đó: nó hội tụ trên cùng bản ghi, không đọc trạng thái để quyết định có chạy hay không.
- **Giữ nguyên hiệu lực:** emergency recovery dùng lại đúng procedure đó.

## Hệ quả

- `deploys/pact-broker-api-deploy` và `deploys/auth-deploy` không còn là ngoại lệ chưa được giải thích: chúng là bề mặt (a) của hợp đồng, và phải tuân Quyết định 5 (token plaintext ổn định theo environment, không sinh mới mỗi lần chạy).
- Tenant `local` trong seed Pact Broker bị thay bằng `ecoma-internal`; đây là thay đổi hành vi của lane local, thực hiện ở Issue Delivery #21 — ADR này chỉ chốt tên.
- `apps/pact-broker-api/db/bootstrap-internal-tenant.mts` trở thành ứng viên cho bề mặt (b) của `pact-broker`, nối vào đúng đường ở #21, không phải ở ADR này.
- Hai migration catalog giữ nguyên vị trí. Chênh lệch 3-vs-4 permission giữa `db-backoffice` và `db-staff-access` **không** được giải quyết bằng cách sửa migration đã apply: catalog canonical là `staff_access.permissions` (ADR-0013), và `audit.read` nếu được chấp nhận phải đi qua một seed migration mới theo [ADR-0010](./0010-permission-naming-and-read-catalog.md). Việc chốt permission thứ tư thuộc #11.
- Mọi Issue Delivery có bước bootstrap phải đọc `02` §3.2 thay vì tự chọn thứ tự, bề mặt thực thi hoặc tên tenant.
- Không có framework, service hay abstraction mới: hợp đồng là một bảng bước trong tài liệu delivery, thi hành bằng code có sẵn của từng deploy unit.

## Cross-reference

- **System:** [`architecture/02-delivery.md`](../../../architecture/02-delivery.md) §0 (bốn đường thay đổi), §3 (migration), §3.2 (hợp đồng bootstrap/seed), §8 (không rollback dữ liệu) · invariant 7, 10, 11, 36.
- **Context:** [ADR-0003](./0003-bootstrap-first-admin-recovery.md) (procedure first-admin) · [ADR-0010](./0010-permission-naming-and-read-catalog.md) (catalog permission) · [ADR-0013](./0013-staff-access-ownership-transfer.md) (ownership `db-staff-access`) · [ADR-0015](../../remote-cache/adr/0015-remote-cache-bounded-context.md) (tenant riêng của `remote-cache`).
- **Hiện thực:** #17 (Account + staff đầu tiên) · #20 (tenant Remote Cache) · #21 (Pact Broker) · #22/#23/#24 (LLM) · #25 (entry point nội bộ) · #11 (permission thứ tư của catalog).
- **Index:** [`./README.md`](./README.md).
