# Domain Glossary

> **Phạm vi:** ngôn ngữ domain dùng chung xuyên bounded context. Mỗi thuật ngữ được định nghĩa theo **nghĩa Ecoma**, nêu context sở hữu nó và các khái niệm dễ nhầm.
>
> Glossary này **không** ép các context dùng chung một từ vựng: mỗi context giữ autonomy trong naming nội bộ; đây chỉ là bản đồ để các context nói chuyện được với nhau. Thuật ngữ chỉ có nghĩa trong một context thuộc `domain-model.md` của context đó.
>
> Không đưa runtime, database hay implementation terminology vào đây trừ khi nó mang nghĩa nghiệp vụ. Catalog bounded context → [`README.md`](./README.md); quan hệ → [`context-map.md`](./context-map.md).

## Account / Account ID / `sub`

**Owner:** `account`

- **Account** — bằng chứng đăng nhập của một người dùng. Gồm credential, MFA/passkey, browser session, profile, preference, privacy/legal consent. Không phải "user nghiệp vụ" của bất kỳ Application nào.
- **Account ID (`sub`)** — opaque identifier của account, không tái sử dụng, không tái phát hành. Là **tham chiếu** mà các context khác (staff member của `staff-access`, tenant membership của `pact-broker`, tenant của LLM) dùng để liên kết; **không** phải foreign key xuyên database và **không** phải quan hệ sở hữu (A21).
- **Dễ nhầm:** `sub` ≠ email (email là contact credential và login identifier, không phải OIDC `sub`); `sub` ≠ staff member (staff là khái niệm của `staff-access`, liên kết bằng `sub`).

## Authentication / Authorization

- **Authentication** — chứng minh người dùng đã xác thực. Thuộc `account`. `auth` **không** tự trả lời được câu hỏi này; nó nhận kết quả đã xác thực.
- **Authorization** — quyết định người dùng được làm gì trên tài nguyên của một Application. Nguồn sự thật: Application sở hữu tài nguyên đó, với permission catalog do `staff-access` định nghĩa. Token hợp lệ **không** tự động hàm ý quyền (A22, invariant 32).

## Staff / Role / Permission / Entitlement / OAuth scope

**Owner:** `staff-access` (trừ OAuth scope thuộc `auth`)

- **Staff** — người dùng được gán vai trò trong `staff-access`; liên kết account bằng `sub`. Trạng thái staff **không** phải trạng thái account (invariant 31).
- **Role** — tập permission gán cho staff (role built-in + custom role; custom role v1 **tắt** theo ADR-0004).
- **Permission** — capability theo hình `domain.action`, catalog do `staff-access` sở hữu; backend sở hữu tài nguyên tự enforce trên mọi protected request (A23).
- **Entitlement** — trả lời đúng một câu hỏi: "nhân sự X có được dùng sản phẩm P không" (product-level availability, nhị phân), do `staff-access` sở hữu. Entitlement **không** phải authorization: nó không trả lời allow/deny cho từng operation hay resource; sản phẩm tự authorize bằng dữ liệu của chính nó (ADR-0009). Ranh giới tường minh → [`staff-access/domain-model.md`](./staff-access/domain-model.md).
- **OAuth scope** — quyền truy cập protocol mà client yêu cầu trong luồng OAuth 2.0/OIDC. **Không** phải application-level permission, không mang trạng thái staff, không đủ granularity cho object-level check. `auth` không nhúng role/permission nghiệp vụ vào token (A22).

## Tenant / Membership / Workspace

- **Tenant** — ranh giới cách ly dữ liệu của một tổ chức/customer. `pact-broker` sở hữu tenant/membership/role **của chính broker**; các context khác (`llm-consumer-tenant`, `llm-seller-tenant`) có khái niệm tenant riêng và **không** dùng chung tenant của broker. `remote-cache` cũng sở hữu tenant/membership **của chính nó** ([ADR-0015](./remote-cache/adr/0015-remote-cache-bounded-context.md)) — ba hệ tenant broker/remote-cache/LLM tách biệt, không suy ra nhau. Tenant của LLM có **đúng một owner**; owner authority không đi theo `sub` sang tenant khác.
- **Consumer tenant** vs **Seller tenant** — hai loại tenant **độc lập** trong LLM product: `llm-consumer-tenant` cho khách hàng dùng LLM API/console, `llm-seller-tenant` cho tổ chức bán offer. Không dùng context này thay context kia, không suy quyền giữa hai bên; Seller tenant là organization boundary và **không có Seller Workspace** ([ADR-0018](./llm-seller-governance/adr/0018-seller-bounded-context-split.md)).
- **Membership** — quan hệ giữa một account (`sub`) và một tenant. Quyền của member đến từ **grant trực tiếp theo scope**, không từ role gắn vào membership. Membership **không** được cấp tự động khi signup/login — kể cả tenant nội bộ `ecoma`; membership của nhân sự nội bộ chỉ được tạo bởi bước bootstrap/seed tường minh ([ADR-0020](./staff-access/adr/0020-bootstrap-seed-contract.md)). Một `sub` có thể là owner/member của nhiều tenant độc lập.
- **Tenant nội bộ canonical** — tên lưu trong database là `ecoma` ở mọi sản phẩm có tenant và mọi environment, **trừ Seller tenant first-party của `llm-seller-tenant`**: tenant first-party ở đó mang tên riêng theo provider (`dronie` đầu tiên), không có Seller tenant tên `ecoma` ([ADR-0027](./llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md)). `Ecoma` chỉ là nhãn hiển thị trong prose, **không** phải một tên khác; `local`/`staging`/`production` là nhãn environment, không bao giờ là tên tenant, và không có tenant song song `ecoma-internal`. Cùng chuỗi này ở `pact-broker`, `remote-cache` và LLM là các entity khác nhau của từng context — khác database, không FK, không suy quyền. **Dễ nhầm:** tên tenant không phải bằng chứng phân loại — classification xem [ADR-0026](./llm-consumer-tenant/adr/0026-first-party-dogfooding-and-commercial-policy-boundaries.md).
- **First-party provider identity** — danh tính công khai của một provider first-party trên marketplace (`Dronie` là provider đầu tiên), chính là **tên tenant first-party** của nó: unique, bất biến, không phải pháp nhân và không phải upstream API provider (khoá `provider` trên `ProviderModelName`/`ProviderCredential` vẫn là upstream) → [ADR-0027](./llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §7.
- **Legal principal (principal pháp lý)** — tổ chức chịu trách nhiệm pháp lý/thuế cho mọi provider first-party: **Ecoma-io**. Không phải một tenant, không phải bounded context dùng chung, không phải pháp nhân của `Dronie`; quan hệ tenant ↔ principal được ghi trong hồ sơ governance của từng tenant kèm evidence provenance trỏ về hồ sơ authoritative thật → [ADR-0027](./llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §3.
- **Phân loại tenant (`first_party` / `customer`)** — quan hệ tổ chức của tenant trong từng sản phẩm: `first_party` là tenant do tổ chức sở hữu sản phẩm vận hành cho nhu cầu riêng (dogfooding); `customer` là tenant của một tổ chức khách hàng bên ngoài. Thiết lập chỉ qua đường provisioning sản phẩm kiểm soát ([ADR-0020](./staff-access/adr/0020-bootstrap-seed-contract.md)); classification bất invariant sau khi thiết lập — không có thao tác đổi nào trong model MVP, một đường chuyển đổi đòi quyết định/ADR tương lai. **Dễ nhầm:** phân loại ≠ commercial plan; ≠ staff role (nhân sự nội bộ vẫn cần entitlement và membership như mọi principal); ≠ tên tenant; ≠ một aggregate tổ chức toàn cục (không có bounded context Organization dùng chung) → [ADR-0026](./llm-consumer-tenant/adr/0026-first-party-dogfooding-and-commercial-policy-boundaries.md).
- **Commercial plan** — gói thương mại mà một sản phẩm áp cho tenant **customer** (`free`/`paid` ở `remote-cache` và `pact-broker`); tenant `first_party` không có plan. Plan là dữ liệu của từng sản phẩm; hai sản phẩm LLM không có plan. Plan không thay entitlement và không đổi authorization.
- **Enterprise** — một commercial offering của một sản phẩm cụ thể. Hiện chưa sản phẩm nào định nghĩa offering Enterprise; không có "chế độ Enterprise" làm bypass, và Enterprise không đổi membership, entitlement hay authorization → [ADR-0026](./llm-consumer-tenant/adr/0026-first-party-dogfooding-and-commercial-policy-boundaries.md).
- **Superadmin** — Account đầu tiên, tạo bởi bootstrap với email canonical `superadmin@ecoma.io` (được ghi `verified` bởi thao tác offline được tin cậy, không phải bằng chứng OTP) và một assignment của system-defined administrator role; đăng nhập vẫn đi qua passwordless OTP như mọi Account ([ADR-0020](./staff-access/adr/0020-bootstrap-seed-contract.md), [ADR-0024](./staff-access/adr/0024-trusted-bootstrap-verified-address.md)). Không phải account type: là Account bình thường có staff identity và quyền quản trị; nhiều Superadmin được phép; một Superadmin không tự thu hồi quyền quản trị của mình.
- **Workspace** — không gian làm việc trong LLM (workspace, offer, catalog, thống kê), thuộc **đúng một Consumer tenant**. Không tồn tại workspace cho Seller tenant. Khác tenant của broker; không đồng nhất hai khái niệm.
- **Thin shared tenant kernel** — không phải một bounded context hay một loại tenant. Là project `libs/tenant-kernel-domain` theo [ADR-0025](./llm-consumer-tenant/adr/0025-thin-shared-tenant-kernel.md), chứa các nhóm primitive tiêu thụ độc lập với ngữ nghĩa **canonical** mà `llm-consumer-tenant` và `llm-seller-tenant` cùng tuân theo: tham chiếu opaque + tenant-scoping của collection, owned-tenant fact (tenant có đúng một owner là `sub` opaque, owner không phải role và không cần membership), và membership incarnation (mỗi lần cấp quyền một `id`). ADR-0025 **loại** role-based membership và tenant lifecycle khỏi kernel vì cùng nhãn không phải cùng ngữ nghĩa. Mọi khái niệm khác — role, grant, lifecycle, plan, quota, transfer, suspension, workspace — thuộc context sở hữu nó. Phạm vi và điều kiện đảo ngược → [ADR-0025](./llm-consumer-tenant/adr/0025-thin-shared-tenant-kernel.md).

## Payment / Credit / Ledger / Transaction / Payout

- **Payment** — context sở hữu ledger credit và payment transaction **của payment domain**, cùng fiat payment transaction/deposit initiation/confirmation. Seller payout **execution** (fiat disbursement) có thể dùng Payment làm gateway/execution adapter, nhưng business ownership của outbound payout workflow/state machine thuộc `payout`.
- **Credit (payment domain)** — đơn vị giá trị trong ledger của `payment`. Khác **LLM credit** (đơn vị giá trị trong ledger của `llm-financial`). Hai ledger độc lập; không đồng nhất.
- **Ledger (payment domain)** — sổ cái credit do `payment` sở hữu. Khác **LLM financial ledger** (wallet, balance, charge, payable, settlement) do `llm-financial` sở hữu.
- **Payment transaction** — giao dịch thanh toán do `payment` sở hữu.
- **Payout** — context sở hữu seller payout request, quote, beneficiary/destination, fiat disbursement, manual payout MVP, execution evidence, payout reconciliation. Monetary liability/settlement (EC, seller payable) thuộc `llm-financial`; `payment` có thể là execution adapter nhưng không sở hữu seller payable/settlement của LLM.
- **Settlement (quota)** — chốt usage vào quota authority của gateway (A7). Khác **settlement (financial)** — chốt usage vào ledger LLM bởi `llm-financial`. Hai quá trình riêng, cả hai idempotent theo `reservation_id`; không ngầm giả định 1:1.

## Quota / Usage / Reservation / Settlement

- **Quota** — giới hạn tài nguyên (token/request) mà gateway cấp cho một consumer/key; authority nằm ở PostgreSQL (A7, invariant 16). Quota **policy/limits** thuộc `llm-consumer-tenant`; cơ chế reserve/settle thuộc Application.
- **Usage** — lượng tài nguyên đã thực sự tiêu thụ, do `llm-usage` sở hữu.
- **Reservation** — bản ghi bền giữ quota tại thời điểm reserve; idempotent theo `reservation_id` (A7).
- **Settlement** — quá trình chốt usage đã phục vụ vào store bền; idempotent theo `reservation_id`. Settlement debt (usage đã phục vụ nhưng chưa ghi được bền) là correctness requirement chưa chốt → [`open-boundaries.md`](./open-boundaries.md).

## Provider

"Provider" mang **bốn nghĩa khác nhau** tuỳ context — phải phân biệt theo context đang nói:

| Context              | Provider nghĩa là                                                                                                                                         | Owner                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `payment`            | Payment provider (cổng thanh toán bên ngoài) — tài liệu kiến trúc đề cập, chi tiết chưa có                                                                | `payment`            |
| `transactional-mail` | Mail relay provider (Cloudflare Email Service mặc định v1) — delivery plane dùng                                                                          | `transactional-mail` |
| `push-notification`  | Push provider (`web-push`/`fcm`/`apns`) và provider credential                                                                                            | `push-notification`  |
| `llm-marketplace`    | Upstream API provider phía sau endpoint — khoá `provider` trên `ProviderModelName`/`ProviderCredential`; **không** phải danh tính seller trên marketplace | `llm-marketplace`    |

Không có "provider chung" xuyên các context; danh tính provider first-party (`Dronie`) là khái niệm của `llm-seller-tenant`, không phải nghĩa thứ năm của "provider" → [ADR-0027](./llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §7.

## Message / Notification / Delivery

- **Message** — một email giao dịch do `transactional-mail` sở hữu (template, message, outbox). Consumer tạo qua contract `POST /v1/messages`.
- **Notification** — một ý định thông báo do `push-notification` sở hữu (Push Notification → Routing → Push Delivery).
- **Delivery** — một lần gửi thực sự (Web Push / email) do delivery plane thực hiện, dưới sự điều khiển của control plane. Delivery **không** quyết định recipient/template/content — control plane materialize. Phân biệt **business delivery state** (thuộc domain) với **execution state** của job (thuộc Application).
- **Transport** vs **Provider** (push): Transport là kênh (`web`/`app`); Provider là nhà cung cấp (`web-push`/`fcm`/`apns`). Hai trục độc lập.

## Pact / Verification / Version / Environment / can-i-deploy

**Owner:** `pact-broker`

- **Pact** — hợp đồng consumer-driven giữa consumer và provider, do `pact-broker` lưu và phân phát.
- **Verification** — kết quả kiểm tra provider có thoả pact hay không.
- **Version** — phiên bản của một pacticipant (service) được publish.
- **Environment** — môi trường deployment mà broker ghi nhận (deployed/undeployed versions).
- **can-i-deploy** — truy vấn broker trả lời "version này có thể deploy vào environment này không", dựa trên verification và deployment record. Broker **ghi nhận** deployment, **không thực hiện** deployment thật.
- **Machine token** — credential riêng cho Pact CLI/CI; không chia sẻ với browser session.

## Bounded context / Application / Deploy unit

- **Bounded context** — ranh giới nghiệp vụ; sở hữu trách nhiệm và dữ liệu của một capability nghiệp vụ. Catalog → [`README.md`](./README.md).
- **Application** — thành phần phần mềm thực thi và composition của nó. Không đồng nghĩa bounded context, Nx project, deploy unit hay Pulumi deployment project. Index → [`applications/README.md`](../applications/README.md).
- **Deploy unit** — một Worker/runtime unit chạy request. Nhiều deploy unit có thể thuộc một bounded context (A10).
- **Quy tắc:** deploy unit hay Application **không** tạo bounded context mới. `pact-broker-api` và `pact-broker-app` cùng là `pact-broker`; `transactional-mailer-job` cùng là `transactional-mail`; `web-push-notification-job` cùng là `push-notification`. Ngược lại, `account` và `auth` là hai bounded context **riêng**, mỗi context một database riêng.
