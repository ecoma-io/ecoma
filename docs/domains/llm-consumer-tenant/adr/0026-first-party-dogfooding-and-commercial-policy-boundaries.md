# ADR-0026 — First-party dogfooding và ranh giới chính sách thương mại của tenant

**Trạng thái:** Accepted · **Superseded (in part) by [ADR-0027](../../llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md)** — đúng câu mở đầu §6 "Tên tenant nội bộ canonical vẫn là `ecoma` ở mọi sản phẩm có tenant, mọi environment": câu đó **không còn áp cho Seller tenant first-party của `llm-seller-tenant`** (tenant first-party mang tên riêng theo provider, `dronie` đầu tiên, không có Seller tenant tên `ecoma`); câu hỏi mở về `Dronie` cuối §6 đã được giải bởi ADR-0027 đúng cơ chế §6 chỉ định; toàn bộ phần còn lại của §6 và của ADR này giữ nguyên. · **Ngày:** 2026-11-11 · **Issue:** #82

> ADR này áp cho và ràng buộc **tất cả bốn domain có tenant** — `remote-cache`, `pact-broker`, `llm-consumer-tenant`, `llm-seller-tenant` — cùng kiểu với [ADR-0025](./0025-thin-shared-tenant-kernel.md). Nó tách **sáu trục** của tenancy (quan hệ tổ chức, commercial plan, funding, usage policy/quota, staff entitlement, membership + authorization) và chốt trục còn thiếu: **phân loại tenant `first_party`/`customer`**. Đặt tại đây vì `docs/AGENTS.md` §10 không cho phép một ADR directory toàn cục; `architecture/01-architecture.md` §8 (A26) trỏ về ADR này.

## Bối cảnh

Bốn domain chia sẻ các từ **tenant**, **plan**, **nội bộ** nhưng biểu diễn không nhất quán:

- `pact-broker` §2.6 dùng `plan` ba giá trị `free | paid | internal`; tenant nội bộ `ecoma` đứng ngoài bất invariant slot Free nhờ giá trị `internal`.
- `remote-cache` §2.9 dùng `plan` hai giá trị `free | paid` — **không có cách biểu diễn tenant first-party mà không tiêu slot Free**.
- Hai sản phẩm LLM **không có** khái niệm plan hay Free slot ([ADR-0025](./0025-thin-shared-tenant-kernel.md) §4).
- Câu hỏi "tenant nội bộ `Ecoma` là Free hay được miễn plan" — open decision (c) của #12 — chưa được trả lời ở bất kỳ đâu.
- Không có định nghĩa nào cho việc một tenant là "của Ecoma" hay "của khách hàng"; #14 (funding), #15 (seller eligibility), #16 (application catalog) đều bị chặn vì thiếu trục phân loại này.

Sáu trục phải giữ tách biệt — mỗi trục trả lời đúng một câu, mỗi trục có một chủ sở hữu:

| Trục                              | Trả lời câu hỏi                                         | Chủ sở hữu                                                    |
| --------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| Quan hệ tổ chức (tenant class)    | Tenant là của Ecoma hay của khách hàng?                 | từng sản phẩm — **chốt tại đây** (ADR-0026)                   |
| Commercial plan                   | Tenant đang ở gói thương mại nào của sản phẩm?          | từng sản phẩm (`remote-cache` §2.9, `pact-broker` §2.6)       |
| Funding                           | Nguồn lực tài chính và chủ thể chịu trách nhiệm là ai?  | `llm-financial` — quyết định thuộc #14                        |
| Usage policy / quota              | Tenant được dùng bao nhiêu?                             | `llm-consumer-tenant` (OB-1); PostgreSQL là authority (A7)    |
| Staff entitlement                 | Nhân sự này có được dùng sản phẩm không?                | `staff-access` — availability, không phải verdict per-request |
| Tenant membership + authorization | Account có quan hệ gì với tenant, request có được phép? | từng sản phẩm; enforce tại resource-owning backend (A23)      |

Trong cây hiện có, `Enterprise` chỉ xuất hiện là tên plan hạ tầng của Cloudflare (`architecture/04-platform-facts.md`) — không có offering, hạn mức hay capability sản phẩm nào.

## Phương án bị loại

| #   | Phương án                                                                                                           | Ưu điểm                                | Nhược điểm — vì sao loại                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Enterprise làm plan nội bộ phổ quát** — mọi tenant nội bộ của mọi sản phẩm mang plan `enterprise`                 | Một nhãn duy nhất, đọc tên là hiểu     | Gán một nhãn thương mại cho quan hệ tổ chức; phát sinh kỳ nghỉ rằng "Enterprise" có capability/SLA riêng khi chưa sản phẩm nào định nghĩa offering đó; mở đường đọc "Enterprise ⇒ bypass". Plan thương mại trở thành kênh biểu diễn thứ hai của quan hệ tổ chức — hai nguồn sự thật cho một câu |
| 2   | **Giá trị plan `internal` riêng trong mỗi sản phẩm** — mở rộng model hiện có của `pact-broker` §2.6 ra bốn sản phẩm | Không phải đổi model đã accept của #13 | `remote-cache` phải thêm giá trị thứ ba (mâu thuẫn trực tiếp với quyết định #12 đã accept); hai sản phẩm LLM phải phát minh một enum plan mà chúng không có nhu cầu nghiệp vụ; giá trị "internal" trong một enum thương mại vẫn là trộn hai trục — cùng lỗi với phương án 1                     |
| 3   | **Bypass authorization toàn cục cho staff/admin** — nhân sự nội bộ được miễn membership/authorization               | Không cần cấp membership cho nhân sự   | Phá A23 (deny-by-default, enforce tại resource-owning backend), invariant 36 (không có bypass không được tài liệu hoá) và [ADR-0009](../../staff-access/adr/0009-no-internal-authorization-result-contract.md); một nhánh `if staff` là backdoor trên mọi sản phẩm                              |
| 4   | **Bounded context `Tenant`/`Organization` dùng chung** — một registry tổ chức trung tâm nối tenant bốn sản phẩm     | Đồng bộ "công ty nào" một lần          | Phá A25/[ADR-0025](./0025-thin-shared-tenant-kernel.md) (kernel đóng ở P1–P5; aggregate chung buộc bốn sản phẩm đổi cùng lúc) và A9 (một service sở hữu một database); tạo FK/coupling xuyên database                                                                                           |

Phương án **chấp nhận** là sự kết hợp: phân loại `first_party`/`customer` là một trục quan hệ tổ chức độc lập với commercial plan (Quyết định §1), giữ nguyên toàn bộ kernel và bypass là không tồn tại.

## Quyết định

### 1. Phân loại tenant là quan hệ tổ chức, không phải commercial plan

Mỗi tenant ở mỗi sản phẩm có đúng một **classification** là `first_party` hoặc `customer`:

- **`first_party`** — tenant do tổ chức sở hữu sản phẩm vận hành cho nhu cầu của chính tổ chức (dogfooding).
- **`customer`** — tenant do một tổ chức khách hàng bên ngoài vận hành.

Classification là **thuộc tính của từng tenant trong từng sản phẩm**, lưu và enforce bởi sản phẩm sở hữu tenant đó. Nó **không phải** một commercial offering: không thêm giá trị nào vào enum plan của sản phẩm nào, và hai sản phẩm LLM không có plan cũng không phải thêm.

Classification **không được suy ra** từ bất kỳ tín hiệu nào sau đây — mỗi quan hệ này đứng độc lập:

- `owner_sub` là Superadmin hay nhân sự nội bộ;
- email domain;
- tên tenant;
- environment/lane (`local`/`staging`/`production`);
- commercial plan;
- membership role hay staff role.

Classification chỉ được **thiết lập qua đường provisioning sản phẩm kiểm soát** — bề mặt bootstrap/seed đã chốt của [ADR-0020](../../staff-access/adr/0020-bootstrap-seed-contract.md) (Quyết định 3). Giá trị **mặc định khi tạo qua đường customer là `customer`**; không có đường customer-facing nào tự gán `first_party`, và không có flag runtime hay code path trên serving path nào ghi classification (Quyết định 2 của ADR-0020). Đường projection entitlement hiện có của `pact-broker` (`ensureTenant` trong entitlement consumer) **không phải** bề mặt thiết lập classification — việc đưa nó về bề mặt bootstrap là điều kiện của hiện thực classification ở `pact-broker` (#21), đúng nghĩa đã ghi ở Hệ quả của ADR-0020.

**Classification bất invariant sau khi thiết lập.** MVP không định nghĩa và không cho phép thao tác chuyển đổi classification nào sau provisioning — không đường customer-facing, không đường operator-facing, không projection hay đồng bộ nào ghi lại classification sau khi bản ghi tenant đã được tạo. Một tenant `customer` không thể trở thành `first_party` để thoát ràng buộc plan hay slot Free, và ngược lại: chuyển đổi classification nằm ngoài model hiện hành và đòi một quyết định/ADR tương lai tường minh, không phải một tuỳ chọn vận hành. Re-run idempotent của bootstrap là no-op trên bản ghi đã có ([ADR-0020](../../staff-access/adr/0020-bootstrap-seed-contract.md) Quyết định 5) — nó không phải một đường đổi classification. **Hệ quả được chấp nhận:** classification ghi sai tại thời điểm seed là trạng thái không có đường sửa trong model MVP — conversion không tồn tại, re-seed là no-op, xoá để seed lại bị chặn bởi rule fail-closed "không hồi sinh" với tên vẫn reserved (Quyết định 6); sửa một seed sai đòi một ADR tương lai, nên độ chính xác của bước ghi classification là trách nhiệm vận hành của delivery bootstrap tương ứng.

**Owner transfer của tenant `first_party`** cũng không có đường customer-facing: chỉ qua bề mặt offline có kiểm soát, auditable, và transfer không bao giờ tự đổi classification. **Xoá** tenant `first_party` đi theo đúng lifecycle của sản phẩm như mọi tenant (không có miễn trừ lifecycle); seed lại tenant nội bộ sau xoá/suspend chịu rule fail-closed "không hồi sinh" của ADR-0020 (Quyết định 6).

ADR này không giới hạn số lượng tenant `first_party` một sản phẩm có thể vận hành: mỗi tenant `first_party` đều phải **tự nó** được thiết lập qua đường provisioning có kiểm soát và mang đầy đủ semantics tại đây. Tên tenant là một hợp đồng riêng (§6).

### 2. Enterprise là commercial offering theo từng sản phẩm

- **Enterprise** là một commercial offering của **một sản phẩm cụ thể**, do sản phẩm đó tự định nghĩa như mọi gói thương mại khác.
- **Hiện không sản phẩm nào định nghĩa offering Enterprise.** ADR này không mô tả capability, hạn mức, giá hay SLA của nó; việc một sản phẩm sau này ra mắt offering Enterprise phải đi qua quyết định của sản phẩm đó.
- **Không có** enum Enterprise toàn cục, không có "chế độ Enterprise" thay đổi authorization, entitlement hay membership ở bất kỳ sản phẩm nào.
- **`first_party` không phải Enterprise, không phải Free, không phải Paid** — ba khái niệm thuộc ba trục khác nhau.

### 3. Bản đồ áp dụng bốn context

Mô hình đích dưới đây. Trừ nơi nêu rõ, semantics chưa hiện diện trong migration hiện có — hiện thực thuộc delivery issue tương ứng (§ Hệ quả).

| Context               | Tenant class               | Commercial plan                                         | Free slot         |
| --------------------- | -------------------------- | ------------------------------------------------------- | ----------------- |
| `remote-cache`        | `first_party` / `customer` | customer: `free`/`paid`; first_party: **không có plan** | customer only     |
| `pact-broker`         | `first_party` / `customer` | customer: `free`/`paid`; first_party: **không có plan** | customer only     |
| `llm-consumer-tenant` | `first_party` / `customer` | **không có plan** — không thêm                          | **không áp dụng** |
| `llm-seller-tenant`   | `first_party` / `customer` | **không có plan** — không thêm                          | **không áp dụng** |

Phát biểu kiểm được cho hai sản phẩm có slot: **bất invariant slot Free áp dụng duy nhất cho tenant `customer` mang plan `free`; tenant `first_party` không tiêu slot Free.** Điều kiện partial unique giữ nguyên nguyên văn — `UNIQUE(owner_sub) WHERE plan = 'free' AND status <> 'deleted'` — vì tenant `first_party` không có plan nên không bao giờ khớp `plan = 'free'`: không tiêu slot khi tạo, khi `suspended`, khi chờ xoá, và không được giải phóng cho ai khác.

Hai sản phẩm có slot phát biểu cùng một **hợp đồng plan dạng điều kiện**: `classification = 'customer' ⇒ plan IN ('free','paid')`; `classification = 'first_party' ⇒ plan không có giá trị (NULL)` — classification là cột NOT NULL với đúng hai giá trị, `plan` nullable ở mức contract model/storage, và điều kiện luôn giữ. Đây là yêu cầu schema cho delivery tương lai, không phải phát biểu về migration hay database hiện có.

Phát biểu kiểm được cho hai sản phẩm LLM: **`llm-consumer-tenant` và `llm-seller-tenant` không có plan và không có Free slot; việc biểu diễn `first_party` ở hai context này không được thêm khái niệm plan hay slot** ([ADR-0025](./0025-thin-shared-tenant-kernel.md) §4 giữ nguyên).

### 4. Miễn trừ thương mại và điều bắt buộc giữ

"Miễn trừ" của tenant `first_party` **chỉ** áp lên hai hạn chế mang bản chất thương mại. Mọi trục còn lại **bắt buộc giữ**, kèm nơi enforce:

| Concern                             | Tenant `first_party`           | Nơi enforce                                                                                           |
| ----------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Free slot                           | **Miễn trừ** — không tiêu slot | product database (partial unique giữ nguyên điều kiện)                                                |
| Commercial plan restriction         | **Miễn trừ** — không có plan   | product context                                                                                       |
| Usage metering                      | **Bắt buộc giữ**               | product usage authority; PostgreSQL quota authority (A7) đối với LLM                                  |
| Accounting / audit                  | **Bắt buộc giữ**               | owning product / financial context                                                                    |
| Operational limits                  | **Bắt buộc giữ**               | product API/gateway                                                                                   |
| Abuse protection                    | **Bắt buộc giữ**               | resource-owning backend                                                                               |
| Tenant isolation                    | **Bắt buộc giữ**               | resource-owning backend                                                                               |
| Membership                          | **Bắt buộc giữ**               | product tenant context                                                                                |
| Authorization                       | **Bắt buộc giữ**               | resource-owning backend (A23, deny-by-default)                                                        |
| Staff entitlement                   | **Bắt buộc giữ**               | `staff-access` ([ADR-0009](../../staff-access/adr/0009-no-internal-authorization-result-contract.md)) |
| Suspension / lifecycle              | **Bắt buộc giữ**               | product tenant context (suspend chặn kể cả owner; fail-closed)                                        |
| Verification / restriction (Seller) | **Bắt buộc giữ**               | `llm-seller-governance` (restriction đứng trước owner authority)                                      |

Phát biểu kiểm được kèm theo:

- **Abuse protection được enforce bằng cơ chế có sẵn của từng sản phẩm**: suspension record bên `llm-consumer-tenant`, restriction/appeal ladder bên `llm-seller-tenant`, lifecycle fail-closed mỗi request và từ chối credential không-active bên `remote-cache`/`pact-broker`. Không sản phẩm nào được thêm đường bỏ qua các cơ chế đó cho tenant `first_party`.
- **Miễn trừ thương mại không hàm nghĩa capacity vô hạn.** Không có hạn mức "vô hạn" nào đi kèm classification; quota/retention/operational limit của tenant `first_party` được cấu hình và đánh giá trong cùng cơ chế với mọi tenant. Ngữ nghĩa khi quota chưa được cấu hình là phần ngữ nghĩa quota của từng sản phẩm — ADR này không đổi nó và không suy ra một giới hạn nào từ miễn trừ. Quota policy/limits vẫn thuộc chủ sở hữu hiện tại (OB-1); ADR này không chốt phần còn mở của OB-1 và không đụng funding (#14).
- **Accounting giữ đúng ngữ nghĩa domain**: `remote-cache` vẫn giữ usage counter và audit append-only; LLM vẫn giữ usage measurement và kế toán kép `llm-financial` — không tạo abstraction wallet/credit vô hạn, không tắt double-entry, và không có phát biểu nào đọc được thành "usage nội bộ miễn phí" hay "first-party được âm trần số dư"; [ADR-0004](../../llm-financial/adr/0004-uc-ec-ledgers-vnd-double-entry.md) giữ nguyên. `pact-broker` **không có** kế toán tiền tệ và ADR này không phát minh nó.
- **Miễn trừ không được làm trạng thái hệ thống khó tái dựng từ durable storage**: usage vẫn được ghi, plan/plan-N/A vẫn là dữ liệu bền, audit vẫn append-only — ai đọc database vẫn tái dựng được state hiện tại.
- **Classification không mang entitlement.** Nhân sự nội bộ dùng sản phẩm qua tenant `first_party` vẫn cần entitlement sản phẩm và membership như mọi principal khác; LLM chưa có trong `ENTITLEMENT_PRODUCTS` và việc thêm thuộc #16.

### 5. Sở hữu, provisioning và kernel

- **Mỗi sản phẩm tự sở hữu, tự seed, tự persist và tự enforce classification của tenant mình** trong database của chính nó — không có service bootstrap trung tâm, không có shared organization ID/FK nối tenant bốn sản phẩm, không có registry toàn cục. Cùng chuỗi `ecoma` ở các sản phẩm vẫn là các entity khác nhau, không FK, không suy quyền ([ADR-0020](../../staff-access/adr/0020-bootstrap-seed-contract.md) Quyết định 9).
- **Bề mặt bootstrap/seed của ADR-0020 giữ nguyên hiệu lực** và là đường thiết lập classification duy nhất; hợp đồng idempotency/fail-closed của nó áp dụng cho bước ghi classification.
- **Thin shared tenant kernel giữ nguyên:** classification **không** được thêm vào danh sách đóng P1–P5 của [ADR-0025](./0025-thin-shared-tenant-kernel.md); nó là khái niệm nghiệp vụ thuộc từng sản phẩm, giống plan, quota, suspension — các khái niệm ADR-0025 đã loại khỏi kernel.

### 6. Tên tenant độc lập với classification

Tên tenant nội bộ canonical vẫn là `ecoma` ở mọi sản phẩm có tenant, mọi environment; không có tenant song song `ecoma-internal` ([ADR-0020](../../staff-access/adr/0020-bootstrap-seed-contract.md) Quyết định 9, [glossary](../../glossary.md)). **Tên không phải bằng chứng phân loại** — classification được ghi tường minh, không suy ra từ tên.

Issue #15 đang mô hình seller first-party và dùng `Dronie` làm danh tính của Seller tenant đó: body của issue nói "`Dronie` là Seller tenant kiểu gì", "Chủ sở hữu Seller tenant `Dronie` là `sub` nào", và phân biệt Seller Tenant ≠ Legal Subject — không có phát biểu nào của issue cho `Dronie` nghĩa là nhãn hiển thị hay danh tính nghiệp vụ tách khỏi tên tenant. ADR này **không** giải quyết và không diễn giải lại `Dronie`: nếu #15 chốt `Dronie` làm tên lưu trong database thì mâu thuẫn với Quyết định 9 và phải supersede-in-part Quyết định 9 qua ADR; nếu `Dronie` là nhãn hiển thị trên tên persisted `ecoma` thì #15 phải phát biểu rõ điều đó. Cho tới lúc đó, tên của Seller tenant first-party là một quyết định mở thuộc #15 — quyết định của ADR này không phụ thuộc nó và không tuyên bố nó đã được giải. Mọi thay đổi đối với hợp đồng đặt tên phải qua cơ chế supersede-in-part của ADR đối với Quyết định 9, không qua outcome âm thầm của một issue.

### 7. Phạm vi supersede và các quyết định giữ nguyên

**Supersede-in-part — quyết định đã accept của Issue #13** (ghi trong `pact-broker/domain-model.md` §2.6, được chấp nhận qua PR #79):

- **Bị supersede:** giá trị `internal` trong enum plan ba giá trị `free | paid | internal`, và câu "Plan của nó là `internal`" cho tenant `ecoma`.
- **Giữ nguyên hiệu lực:** plan `free`/`paid` cho tenant customer; toàn bộ cơ chế slot Free (chủ thể `owner_sub`, trạng thái và slot, xoá và thay thế, subscription, owner transfer, enforcement schema); tên canonical `ecoma`; provisioning qua internal bootstrap; owner là subject Superadmin canonical; Staff Access system role không tự map thành membership role và membership projection khởi đầu ở role thấp nhất ([ADR-0025](./0025-thin-shared-tenant-kernel.md) §4); "plan không thay entitlement" và provenance của membership.

**Delta lên — quyết định đã accept của Issue #12** (ghi trong `remote-cache/domain-model.md` §2.9): thêm trục classification và biểu diễn tenant `first_party` mà không tiêu slot Free. Điều này **giải luôn** open decision (c) của #12 ("tenant nội bộ là Free hay được miễn plan") — đáp án: tenant nội bộ là `first_party`, không có plan, không tiêu slot. Phần còn lại của §2.9 giữ nguyên hiệu lực.

**Không ADR hiện có nào bị supersede.** #12 và #13 không có ADR riêng (băng ADR của `remote-cache` chỉ gồm 0015/0017; `pact-broker` không có thư mục `adr/`), nên cơ chế ba nơi của partial supersession áp dụng cho ADR không phát sinh — phần supersede được ghi tại đây cộng sửa trực tiếp hai domain model trong cùng thay đổi. [ADR-0025](./0025-thin-shared-tenant-kernel.md) và A25 giữ nguyên toàn vẹn: hàng "Plan Free/Paid, slot, deletion policy" §4 vẫn đúng vì quyền sở hữu plan không đổi, chỉ có biểu diễn được thu hẹp. [ADR-0020](../../staff-access/adr/0020-bootstrap-seed-contract.md) giữ nguyên toàn vẹn: classification không đổi đường chạy bootstrap, danh tính canonical hay bảng sở hữu seed — nó là dữ liệu khởi tạo system-owned theo đúng Quyết định 1 và 13 của ADR-0020.

**Điều kiện kiểm được — bốn non-goal:**

1. Không có bypass Enterprise toàn cục, và không có "chế độ Enterprise" thay đổi authorization/entitlement/membership ở bất kỳ sản phẩm nào.
2. Không có kernel tổ chức/tenant dùng chung — kernel giữ P1–P5, classification không vào kernel.
3. Không có bypass authorization nội bộ toàn cục — nhân sự nội bộ đi qua membership với quyền thấp nhất như mọi account khác (A23, [ADR-0009](../../staff-access/adr/0009-no-internal-authorization-result-contract.md)).
4. Không có abstraction wallet/credit vô hạn — miễn trừ thương mại không tạo wallet âm-trần, không tắt double-entry, không đổi [ADR-0004](../../llm-financial/adr/0004-uc-ec-ledgers-vnd-double-entry.md).

## Hệ quả

- Bốn domain model được cập nhật trong cùng thay đổi để không mâu thuẫn với quyết định: `remote-cache` §2.9 và `pact-broker` §2.6 nhận trục classification + plan chỉ áp cho customer; hai domain model LLM nhận định nghĩa classification mà không có plan/slot.
- **Hiện thực thuộc delivery, đúng phần đã chỉ định:** #20 — cột classification và bootstrap tenant `first_party` của `remote-cache`; #21 — classification, rút giá trị `internal`, và đưa `ensureTenant` về bề mặt bootstrap ở `pact-broker`; #23/#24/#25 — tenant/quota/composition của LLM theo phạm vi hiện có. Mọi yêu cầu schema được phát biểu dưới dạng kiểm được; migration và SQL thuộc delivery.
- **Các issue bị chặn giờ chỉ hiện thực, không chọn lại trục:** #14 (funding — quyết định cơ chế và bản ghi durable; classification và bảng miễn trừ đã chốt), #15 (seller identity và eligibility — trục phân loại đã chốt; câu hỏi tên `Dronie` §6), #16 (application catalog và `ENTITLEMENT_PRODUCTS` — classification không suy ra danh mục).
- Không sản phẩm nào cần làm gì cho Enterprise: chưa có offering nào tồn tại để hiện thực, và ADR này cấm phát minh nó.
- Không có thay đổi code, migration, route hay flag trong quyết định này; quyết định là tài liệu và các domain model là bản ghi canonical duy nhất của nó.

## Liên quan

- Issue #82 — quyết định này; #12, #13 — hai quyết định bị supersede-in-part/delta, giữ nguyên trạng thái closed.
- #14, #15, #16 — funding, seller identity/eligibility, application catalog: được mở khoá trục phân loại. #20, #21, #23, #24, #25 — hiện thực bootstrap/tenant/quota/composition của từng sản phẩm.
- [ADR-0025](./0025-thin-shared-tenant-kernel.md) — kernel và phân chia sở hữu bốn domain; giữ nguyên. [ADR-0019](./0019-llm-scope-ownership-and-dependency-matrix.md) — ba scope LLM; không đổi.
- [ADR-0020](../../staff-access/adr/0020-bootstrap-seed-contract.md) — hợp đồng bootstrap/seed, tên `ecoma`, bề mặt provisioning; giữ nguyên. [ADR-0009](../../staff-access/adr/0009-no-internal-authorization-result-contract.md) — entitlement không phải authorization; giữ nguyên.
- [ADR-0004](../../llm-financial/adr/0004-uc-ec-ledgers-vnd-double-entry.md) — kế toán kép, không âm trần tuỳ ý; giữ nguyên. [ADR-0002](../../llm-seller-tenant/adr/0002-tenant-existence-separate-from-eligibility.md) — tenant tồn tại tách khỏi eligibility; giữ nguyên.
- [Glossary](../../glossary.md) — định nghĩa dùng chung `first_party`/`customer`, commercial plan, Enterprise.
