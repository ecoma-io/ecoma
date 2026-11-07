# Bounded context `llm-consumer-routing` — Domain Model

`llm-consumer-routing` là bounded context phân hệ routing phía Consumer: **model alias, routing policy, candidate selection (provider/endpoint), fallback config hai cấp** (offer-level và endpoint-level). Routing **chỉ** quyết định candidate nào được chọn và thứ tự fallback; không reserve quota, không dispatch, không settle.

> Quota/usage/settlement authority → `llm-api` (A7). Logical request lifecycle → `llm-inference`. Pricing → `llm-seller-pricing`. Tenant/membership/workspace → `llm-consumer-tenant`.

## 1. Domain entities và value objects

### Model alias

- Tên model logic mà client gọi; resolve sang một routing policy + tập candidate.
- `AliasStatus`: `'active'` | `'retired'`. Retired alias không còn eligible cho request mới.
- Alias có thể được tạo, cập nhật (đổi policy/candidate set) và retire.
- Alias resolution xảy ra trong admission, **trước** endpoint selection.
- Một alias đã resolve cho một logical request **không** bị đổi sau dispatch: snapshot bind tại admission là nguồn sự thật cho request đó.
- Retire alias: alias không còn eligible cho request mới; request đang in-flight giữ snapshot cũ.

### Routing policy

- Cấu hình xác định tập candidate eligible và strategy chọn candidate, kèm fallback config.
- Mỗi thay đổi tạo version mới (monotonic). Version là số nguyên dương, tăng strictly theo mỗi thay đổi alias/policy.
- Không cho phép downgrade/skip version để bypass audit.
- Snapshot gắn version tại build; immutable sau đó.

### Candidate

- Một provider/endpoint (hoặc offer) có thể phục vụ alias, kèm điều kiện eligibility.
- Candidate active (không disabled/retired).
- Capability khớp yêu cầu alias (model, streaming, …).
- Health trong ngưỡng (không `circuit_open`).
- Quota/policy của key cho phép candidate (chỉ kiểm tra read-only: quyền dùng candidate / policy tĩnh; không reserve/settle quota).
- Tenant/workspace scope cho phép (derive từ offer/tenant và principal, không từ client input).

### Candidate eligibility

- `eligible` hoặc `ineligible` kèm danh sách lý do từ chối (`denial_reason`).
- Đánh giá **trước** strategy selection. Chỉ candidate pass eligibility mới vào strategy.
- Candidate không pass bị loại khỏi tập strategy; không được chọn và không được fallback tới trừ khi policy cho phép re-evaluate ở attempt sau.

### Routing strategy

- Chỉ chọn trong tập eligible; nếu tập rỗng → no-candidate behavior.
- `priority`: chọn candidate có priority cao nhất (số nhỏ = ưu tiên cao hơn). Tie-break **chưa được quy định** (UNRESOLVED).
- `round_robin`: phân phối đều giữa các candidate eligible theo counter bền (không node-local state). Stateless; cursor truyền vào/trả ra.
- `lowest_price`: chọn candidate có customer price thấp nhất. Customer price là giá seller cấu hình, resolve từ pricing version dùng cho snapshot tại admission của request đó. Giá thiếu → không tham gia; giá bằng nhau → tie-break chưa quy định.
- `weighted`: **chưa được triển khai** (target functionality, chưa có algorithm/ràng buộc trọng số được chốt).

### Routing snapshot

- Bản chụp bất biến của routing policy + candidate set tại thời điểm bind với logical request.
- Bao gồm: alias, resolved model/capability, policy version, candidate set đã chọn/eligible, strategy, fallback config.
- Immutable; snapshot không bị mutate sau khi build.
- Snapshot được persist cùng logical request record để audit/replay (persistence nằm ngoài domain library).
- Version preservation: mỗi thay đổi policy tạo version mới (monotonic); không cho phép downgrade/skip version.
- Pricing change hay routing config change sau admission **không** làm thay đổi snapshot đã bind (parity với `llm-seller-pricing`: pricing change không alter admitted request price).

### Offer fallback (cấp 2)

- Chuyển sang offer khác khi endpoint trong cùng offer đã cạn.
- Theo policy (ordered list hoặc strategy re-run trên tập còn lại trong snapshot).
- Health status bị động **không** tự kích hoạt fallback.

### Endpoint fallback (cấp 1)

- Chuyển sang endpoint khác của cùng offer/candidate.
- Thứ tự: **endpoint fallback trước (cùng offer), rồi offer fallback (offer khác)**.

### Execution evidence

- `not_sent` / `may_have_executed` / `confirmed_completed` / `confirmed_not_executed`. Sở hữu bởi `llm-inference`.
- Execution evidence quyết định xem routing có được fallback hay không.

## 2. Domain operations

Tất cả hàm thuần (pure), không mutation input, không side-effect. Thời gian, cursor, randomness được caller truyền vào.

### Alias & policy

- `resolveAlias(alias, policies)` → `{ policy, version }` hoặc rejection (`alias_not_found`, `alias_retired`, `invalid_alias`).
- `createPolicy(candidates, strategy, fallbackConfig, version)` → policy với version mới.
- `retireAlias(alias)` → status chuyển thành `retired`.

### Eligibility

- `evaluateEligibility(candidate, facts)` → `eligible` | `ineligible` + `denial_reason[]`.
- Inputs (không truy vấn bên ngoài): active, capability match, health (không circuit-open), quota/policy read-only, tenant/workspace scope.

### Strategy

- `selectByPriority(eligibleCandidates)` → selected candidate. Số nhỏ = ưu tiên cao hơn. Tie-break **chưa được quy định**.
- `selectRoundRobin(eligibleCandidates, cursor)` → `{ selected, nextCursor }`. Stateless; cursor truyền vào/trả ra.
- `selectLowestPrice(eligibleCandidates, priceFacts)` → selected candidate. Giá thiếu → không tham gia; giá bằng nhau → tie-break chưa quy định.

### Fallback

- `decideFallback({ evidence, streamStarted, attemptCount, maxAttempts })` → `fallbackAllowed: true` hoặc `fallbackAllowed: false` với lý do (`fallback_not_allowed` | `fallback_exhausted`).
  - Chấp nhận: `not_sent`, `confirmed_not_executed` **và** còn budget attempt.
  - Chặn: `may_have_executed`, `confirmed_completed`, stream đã bắt đầu (`fallback_not_allowed`), hoặc `attemptCount >= maxAttempts` (`fallback_exhausted`).
  - Đây là quyết định **routing**: nó trả lời "còn candidate để fallback không". Nó **không** thay thế `evaluateRetryAdmissibility` của `llm-inference` — luật duy nhất quyết định execution có được tiếp tục hay không. Application phải kiểm tra cả hai.
  - `maxAttempts` ở đây là budget fallback của routing config, không phải execution policy của logical request. Hai giá trị có thể khác nhau; domain không đồng bộ chúng.

### Snapshot

- `buildSnapshot(alias, policyVersion, eligibleCandidates, strategy, fallbackConfig)` → `RoutingSnapshot` (immutable).

## 3. Business invariants

1. Eligibility gate chạy **trước** strategy; strategy chỉ chọn trong tập eligible.
2. Routing snapshot bind tại admission và immutable cho logical request.
3. Config change sau admission không ảnh hưởng request đã admit.
4. Fallback tuân evidence rule: không fallback sau `may_have_executed` / `confirmed_completed`.
5. Không transparent provider switch sau khi stream bytes.
6. Round-robin stateless, không node-local state; cursor truyền vào/trả ra.
7. Routing không reserve/settle quota; authority ở `llm-api`.

## 4. Semantics strategy

- **Priority:** chọn candidate có priority cao nhất (số nhỏ = ưu tiên cao hơn). Nếu nhiều candidate cùng priority → tie-break **chưa được quy định**.
- **Round-robin:** phân phối đều theo cursor bền; domain nhận cursor hiện tại, trả candidate được chọn + cursor kế tiếp. Không lưu counter ở module global/process memory/Worker.
- **Lowest customer price:** chọn customer price thấp nhất. Price facts nhận từ caller; không import/tính toán qua `llm-seller-pricing-domain`. Không so sánh currency/unit khác nhau. Missing price → không tham gia. Equal price → tie-break chưa quy định.
- **Weighted:** **chưa triển khai** (target functionality, chưa có algorithm/ràng buộc trọng số được chốt).

## 5. Semantics fallback hai cấp

Thứ tự: **endpoint fallback trước (cùng offer), rồi offer fallback (offer khác)**.

Mỗi fallback là quyết định tường minh, không transparent switch sau stream bytes. Fallback chỉ khi evidence cho phép (`not_sent` / `confirmed_not_executed`) và routing còn candidate; chặn khi `may_have_executed` / `confirmed_completed`.

Domain **quyết định** xem còn fallback nào khả dụng; không dispatch/retry request và không phán quyết execution có được tiếp tục — việc đó thuộc `llm-inference` (`evaluateRetryAdmissibility`). Routing không thấy terminal state, deadline hay bất định chưa reconcile, nên `fallbackAllowed: true` ở đây là điều kiện **cần**, không phải điều kiện **đủ**.

No-candidate: phân biệt `no_candidate` (chưa có eligible candidate ban đầu) vs `fallback_exhausted` (đã thử hết fallback).

## 6. Semantics snapshot

- Immutable; bản build không bị mutate bởi thay đổi config/pricing sau đó.
- Bao gồm: alias, policy version, candidate set đã chọn/eligible, strategy, fallback config.
- Dùng để audit/replay; persistence nằm ngoài domain library.
- Version preservation: mỗi thay đổi policy tạo version mới (monotonic); không cho phép downgrade/skip version.

## 7. Domain errors

| Code                     | Điều kiện                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `invalid_alias`          | Alias rỗng hoặc sai shape.                                                           |
| `alias_not_found`        | Alias không tồn tại trong policy set.                                                |
| `alias_retired`          | Alias đã retire, không eligible cho request mới.                                     |
| `invalid_policy_version` | Version không phải số nguyên dương hoặc không monotonic.                             |
| `no_eligible_candidate`  | Không có candidate pass eligibility.                                                 |
| `fallback_not_allowed`   | Evidence chặn fallback (`may_have_executed`, `confirmed_completed`, stream started). |
| `fallback_exhausted`     | Đã thử hết fallback, không còn candidate.                                            |
| `invalid_strategy_input` | Strategy input sai shape hoặc strategy không được hỗ trợ.                            |

Message tiếng Anh (language policy của repo), không chứa secret/identifier tùy ý.

## 8. Quy tắc versioning

- Mỗi thay đổi alias/policy tạo version mới, monotonic (tăng strictly).
- Không cho phép downgrade/skip version để bypass audit.
- Snapshot gắn version tại build; immutable sau đó.

## 9. Test specifications

Xem `libs/llm-consumer-routing-domain/src/*.spec.ts`. Mọi test verify business behavior (không chỉ construction). Cover: alias/policy, eligibility, strategy, fallback, snapshot, domain errors, boundary/invalid input, determinism.

## 10. Exclusions và cross-context boundaries

- Không tính giá (pricing) — `llm-seller-pricing`.
- Không reserve/settle quota — `llm-api`.
- Không dispatch/provider execution — `llm-inference`.
- Không persistence — snapshot chỉ là model, không có repository.
- Không truy vấn authorization/health bên ngoài — nhận facts làm input.
- Không import Nx project khác (`type:domain`).

## 11. Quyết định chờ (UNRESOLVED)

1. **Priority tie-break:** khi nhiều candidate cùng priority, quy tắc hay trùm chưa chốt (ví dụ thứ tự khai báo chỉ là minh họa, không được coi là quy trình đã duyệt). Hiện tại dùng input order làm deterministic tie-break tạm thời, phải khớp lại khi có quyết định.
2. **Lowest price equal/missing:** hành vi khi giá bằng nhau hoặc thiếu giá chưa được quy định rõ. Hiện tại missing price loại khỏi tập, equal price dùng input order tạm thời.
3. **Weighted selection:** chưa có algorithm/ràng buộc trọng số; không triển khai trong PR này.

**Quy tắc:** không một quyết định nào ở trên được âm thầm chốt trong code.

## 12. Ranh giới với các context khác

| Context               | Ranh giới                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `llm-inference`       | Routing quyết định **which candidate**; inference quyết định **whether execution continues**. Hai domain không import lẫn nhau. |
| `llm-seller-pricing`  | Pricing calculation/catalog thuộc `llm-seller-pricing`; routing nhận price facts làm input, không tính toán.                    |
| `llm-consumer-tenant` | Tenant/workspace scope từ principal; routing không sở hữu membership/grant.                                                     |
| `llm-marketplace`     | Seller offer/model catalog/upstream endpoint thuộc `llm-marketplace`; routing tiêu thụ qua contract.                            |
| `llm-api`             | Quota/usage/settlement authority thuộc `llm-api`; routing không reserve/settle quota.                                           |

## 13. Tài liệu

| Document                               | Nội dung                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Domain model, operation signature, fallback semantics, business invariants, cross-context boundaries |
| [`README.md`](./README.md)             | Tóm tắt bounded context, scope, documents                                                            |
