# LLM Marketplace — Domain Model

Bounded context `llm-marketplace`: model offer, capability, upstream endpoint, endpoint pool, provider credential, provider model name, normalized model identity và offer activation trong hệ sinh thái LLM. Seller tenant, ownership và membership thuộc `llm-seller-tenant`; restriction, verification và legal/tax profile thuộc `llm-seller-governance`; marketplace giữ `sellerTenantId` như tham chiếu và consume operational eligibility qua contract/projection.

## 1. Phạm vi và ranh giới

`llm-marketplace` sở hữu **model offer, capability, upstream endpoint, endpoint pool, provider credential, provider model name, normalized model identity và offer activation** trong hệ sinh thái LLM.

| Sở hữu                                                                                                                                                  | Không sở hữu                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model offer · capability · upstream endpoint · endpoint pool · provider credential · provider model name · normalized model identity · offer activation | Seller tenant/ownership/membership/grant/restriction/verification/legal-tax profile (`llm-seller-tenant` / `llm-seller-governance`) · Consumer tenant/workspace/membership/grant (`llm-consumer-tenant`) · quota/usage/reservation/settlement (`llm-api`) · ledger/charges/settlement (`llm-financial`); payment gateway/execution (`payment`) · danh tính account (`account`) · entitlement cross-context (`staff-access`) |

- `sellerTenantId` là **tham chiếu** tới Seller tenant do `llm-seller-tenant` sở hữu; `sub` là tham chiếu opaque khi cần actor.
- Quota authority vẫn ở `llm-api`; marketplace chỉ cung cấp offer/identity cho routing.

## 2. Ngôn ngữ dùng chung

| Khái niệm                 | Nghĩa                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| Seller offer              | Một seller cung cấp một model cho marketplace (lifecycle offer).            |
| Model alias               | Tên public/customer-visible của model (có thể map tới normalized identity). |
| Provider endpoint         | Endpoint upstream phục vụ model (URL/protocol/health).                      |
| Provider model            | Tên model theo provider (raw identity).                                     |
| Customer-visible model    | Model mà customer thấy và gọi (thường là alias/normalized identity).        |
| Normalized model identity | Identity chuẩn hoá xuyên provider, dùng để dedup/group.                     |

## 3. Business concepts

Mọi định danh opaque (`SellerActorId`, `SellerTenantId`, `ModelOfferId`, `UpstreamEndpointId`, `EndpointPoolId`, `ProviderCredentialId`) là chuỗi non-empty, không padding, ≤ 200 ký tự: giới hạn này chặn payload bất thường từ input mà không gán nghĩa nghiệp vụ cho nội dung id.

### 3.1 Aggregate root: ModelOffer

- `id`, `seller_tenant_id`, `normalized_model_id`, `status` (`draft` | `active` | `inactive` | `retired`), `public_alias` (optional), capabilities, timestamps.
- Lifecycle: `draft → active` (activation), `active ↔ inactive`, `* → retired` (terminal).
- `draft → inactive` không hợp lệ: offer chưa từng phục vụ thì không có nghĩa "đang tắt".
- Activation không idempotent: gọi lại khi đang `active` là lỗi domain, không phải thành công im lặng.
- `public_alias` chỉ gán/đổi khi còn `draft`; sau đó là bất biến. Đổi tên customer-visible sau khi offer đã phục vụ làm hỏng consumer đang gọi tên cũ.
- Alias là tên customer-visible: lowercase, bắt đầu bằng chữ số hoặc chữ cái, chỉ chứa chữ thường, chữ số, `.`, `_`, `-`, ≤ 200 ký tự.
- Alias phải chưa được offer khác dùng; unique trong phạm vi marketplace được kiểm ở biên ghi, không phải bất biến của một offer đơn lẻ.
- Activation yêu cầu đồng thời verdict operational eligibility hợp lệ của đúng Seller tenant **và** ít nhất một pool `healthy` của chính offer.
- `capabilities` được thay cả khi đang `active`: capability là dữ liệu filter, không phải cam kết hợp đồng; một capability bị gỡ không làm offer ngừng phục vụ các request không yêu cầu nó.

### 3.2 Value object: ProviderModelName

- Raw identity theo provider: `{ provider, model }`.
- `provider`: lowercase, bắt đầu bằng chữ cái, cho phép `-` và `_`, ≤ 64 ký tự.
- `model`: giữ nguyên spelling provider công bố (chữ hoa, dấu chấm), không whitespace, ≤ 200 ký tự. Raw identity không được chuẩn hoá: một raw name bị viết lại sẽ không còn so khớp được với payload provider trả về.
- Một `NormalizedModelIdentity` giữ danh sách `ProviderModelName`; cặp `(provider, model)` không trùng giữa các identity và không trùng trong cùng identity.
- Không có aggregate `ProviderModel` riêng: raw name là value object thuộc identity, không có lifecycle.

### 3.3 Value object: NormalizedModelIdentity

- Identity chuẩn hoá xuyên provider; lowercase, bắt đầu bằng chữ số hoặc chữ cái, cho phép `.`, `_`, `-`, ≤ 200 ký tự.
- Dùng để dedup/group offer; hai offer cùng identity nghĩa là cùng một model xét theo marketplace.
- Mapping `provider_model → normalized identity` là canonical trong marketplace; một raw name khớp nhiều identity là lỗi dữ liệu.

### 3.4 Entity: UpstreamEndpoint

- `id`, `endpoint_pool_id`, `url`, `protocol`, `health_status` (`healthy` | `degraded` | `down`), `weight`, timestamps.
- URL phải tuyệt đối: scheme `http`/`https` (HTTP được chấp nhận ở tầng domain vì endpoint nội bộ có thể dùng nó; bắt buộc HTTPS là policy của deployment), có host DNS hoặc IPv6 literal, port 1–65535 nếu có, không userinfo, không fragment, không whitespace, ≤ 2048 ký tự.
- `protocol` là **định danh mở** (`openai_chat`, ...): lowercase snake_case, ≤ 64 ký tự; lib validate hình dạng, tập protocol hợp lệ do adapter quyết định.
- Health status chỉ đổi qua operation tường minh; endpoint mới mặc định `degraded` để pool mới không mở được activation trước lần probe đầu tiên. Ghi lại đúng trạng thái cũ là `endpoint_health_unchanged`: health là sự kiện, không phải setter idempotent.
- Mọi cặp `(from, to)` khác nhau đều hợp lệ, kể cả `down → healthy` (hồi phục) và `healthy → down` (mất kết nối); không có trạng thái health terminal.
- Endpoint thuộc đúng một pool; `weight` 1–1000, tắt endpoint bằng health `down` chứ không bằng weight 0 (weight 0 vẫn nằm trong pool và vẫn tính vào health nhưng không bao giờ được chọn).

### 3.5 Entity: EndpointPool và fallback phía Seller

- `id`, `offer_id`, danh sách endpoint, timestamps. Pool scope derive từ offer, không từ client input.
- Pool rỗng là trạng thái hợp lệ và có health `down`.
- Health pool là **giá trị suy ra** từ health endpoint, không phải field lưu.
- Fallback cấu hình phía Seller (`SellerFallbackConfig`) là value object trên cùng offer: thứ tự pool và thứ tự endpoint ưu tiên. Đây **không** phải routing của consumer — priority/round-robin/lowest-price và chọn giữa các offer thuộc `llm-consumer-routing-domain`.

Health của pool:

| healthy | down | status     |
| ------- | ---- | ---------- |
| 0       | *    | `down`     |
| ≥ 1     | 0    | `healthy`  |
| ≥ 1     | ≥ 1  | `degraded` |

Health cấp offer: `healthy` khi có ít nhất một pool `healthy`; ngược lại `degraded` nếu còn pool phục vụ được; còn lại `down`.

### 3.6 Value object: SellerFallbackConfig

`{ offerId, poolPreference[], endpointPreferences[], allowCrossPoolFallback }` — **fallback phía Seller trong một offer**, không phải routing của consumer:

- `poolPreference`: thứ tự pool được thử; không rỗng, không trùng, mọi pool thuộc offer (closed-world so với `context.pools`).
- `endpointPreferences`: thứ tự endpoint ưu tiên trong từng pool; endpoint phải thuộc đúng pool đó.
- `allowCrossPoolFallback: false` giữ duy nhất pool đầu tiên còn ứng viên.
- `orderEndpointCandidates` chỉ **đọc** cấu hình thành danh sách ứng viên (loại endpoint `down`, rank 1-based); nó không chọn endpoint và không quyết định retry. Priority/round-robin/lowest-price thuộc `llm-consumer-routing-domain`.

### 3.7 Entity: ProviderCredential

- `id`, `provider`, `credential_hash` (hash-only), `created_by_sub`, `revoked_at` (NULL=active), timestamps.
- Plaintext hiện **một lần** khi tạo; không đường nào đọc lại. Show-once: plaintext chỉ tồn tại trong kết quả của lần tạo, không nằm trong bản ghi lưu và không đi ra bất kỳ read path hay contract/UI nào.
- `credential_hash` là giá trị opaque do caller tính: in được, không whitespace, ≤ 512 ký tự. Domain không kiểm entropy hay prefix thuật toán. Hash không bao giờ đi ra contract/UI: metadata credential được chiếu từng field sang dạng công bố, không spread bản ghi lưu.
- Revoke = set `revoked_at`, hiệu lực ngay lập tức và terminal; revoke lần hai là `credential_already_revoked`, không ghi đè dữ liệu audit.
- Domain không hash và không verify plaintext — thuật toán/salt/so khớp thuộc adapter. Vì vậy không có operation `verifyCredential` ở tầng domain.
- Kiểm credential thuộc đúng provider là **scope validation**, không phải authentication: credential của provider A không dùng được cho provider B (`credential_provider_mismatch`), credential đã revoke là `credential_revoked`. Kiểm provider trước revoke để không tiết lộ trạng thái revoke của credential thuộc provider khác.

### 3.8 Value object: Capability

- Tập capability của model/offer: text generation, vision, function calling, embedding, ... Dùng để filter/route offer.
- Một capability là **định danh mở** do caller cấp, không phải enum của lib: lowercase snake_case, bắt đầu bằng chữ cái, ≤ 64 ký tự; không nhận chuỗi rỗng, dấu cách hay ký tự hoa vì đây là khoá so khớp, không phải text hiển thị.
- Tập capability không rỗng, không trùng, sắp theo thứ tự canonical — hai tập cùng nội dung luôn bằng nhau khi so sánh, không phụ thuộc thứ tự caller truyền. Một offer không khai báo capability nào thì không filter được.

### 3.9 Verdict: SellerOperationalEligibility

`{ tenantId, eligible, blockers[], assessedAt }` — **khai báo tại biên**, tiêu thụ từ `llm-seller-governance`:

- `eligible: true` ⇒ `blockers` rỗng; `eligible: false` ⇒ `blockers` không rỗng. Verdict vi phạm là không nhất quán và bị từ chối.
- Verdict lệch `sellerTenantId` của offer bị từ chối nguyên khối (`eligibility_tenant_mismatch`), không "dùng tạm".
- Verdict có `assessedAt` sớm hơn baseline của offer là **stale** và không đủ cho activation.

Marketplace **tiêu thụ** verdict, không tính lại (ADR-0018 §3):

- Không đọc verification case, restriction record, legal/tax profile hay evidence.
- Không import `llm-seller-tenant-domain`, `llm-seller-governance-domain` hay `llm-financial-domain`.
- Verdict đi vào qua contract/projection và được khai báo lại tại biên.
- Marketplace không có quyền nói một Seller "eligible"; nó chỉ từ chối activation khi verdict không dùng được hoặc nói không eligible.

### 3.10 Public seller prefix (nếu chốt)

- Prefix công khai cho seller/offer — quyết định **chưa chốt**. Nếu chốt: unique, immutable sau activation. Hiện code không mô hình hoá prefix.
- **Riêng provider first-party**, danh tính công khai đã chốt: là **tên Seller tenant first-party** của offer (`dronie` đầu tiên), unique và bất biến theo contract tên tenant do `llm-seller-tenant` sở hữu; `sellerTenantId` trên offer vẫn là tham chiếu opaque duy nhất mà marketplace cần. Khoá `provider` trên `ProviderModelName`/`ProviderCredential` **không đổi**: nó là upstream API provider, không phải danh tính seller — không ghi danh tính provider first-party vào đó trừ khi tenant first-party thực sự tự vận hành upstream đó → [ADR-0027](../llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §7, §8.

## 4. Lifecycle & state transitions

- **ModelOffer**: `draft → active ↔ inactive → retired`.
- **UpstreamEndpoint**: `healthy ↔ degraded ↔ down` (health-driven).
- **ProviderCredential**: `active → revoked` (terminal).

Offer chỉ phục vụ customer (serve traffic) khi ở trạng thái `active` và endpoint pool healthy; activation (`draft → active`) yêu cầu endpoint pool healthy.

### Operation thay đổi state và precondition

Không có operation nào tự sửa scope hay tự chuẩn hoá input lệch: dữ liệu sai bị từ chối thay vì được "đoán" giúp caller.

| Operation                    | Thay đổi                              | Precondition                                                                             |
| ---------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `createModelOffer`           | tạo offer `draft`                     | id chưa tồn tại; alias (nếu có) hợp lệ                                                   |
| `assignPublicAlias`          | gán alias                             | offer còn `draft`; alias hợp lệ và chưa được offer khác dùng                             |
| `replaceCapabilities`        | thay tập capability                   | offer chưa `retired`; tập mới hợp lệ                                                     |
| `activateModelOffer`         | `draft`/`inactive` → `active`         | verdict eligibility hợp lệ và đúng tenant; ít nhất một pool `healthy` thuộc đúng offer   |
| `deactivateModelOffer`       | `active` → `inactive`                 | offer đang `active`; từ `draft` là `invalid_offer_transition`                            |
| `retireModelOffer`           | `*` → `retired`                       | offer chưa `retired`; sau đó mọi transition bị từ chối                                   |
| `createUpstreamEndpoint`     | tạo endpoint                          | url/protocol/health/weight hợp lệ; endpoint mới mặc định `degraded`                      |
| `recordEndpointHealth`       | health endpoint                       | trạng thái mới khác trạng thái cũ; thời gian không lùi                                   |
| `createEndpointPool`         | tạo pool thuộc offer                  | id chưa tồn tại; pool rỗng hợp lệ                                                        |
| `addEndpointToPool`          | thêm endpoint vào pool                | `endpoint.endpointPoolId === pool.id`; endpoint chưa có trong pool                       |
| `replaceEndpointInPool`      | thay endpoint bằng bản mới            | endpoint phải đã thuộc pool; không dùng để thêm mới                                      |
| `removeEndpointFromPool`     | bỏ endpoint khỏi pool                 | endpoint đang thuộc pool; endpoint cuối cùng được phép bỏ                                |
| `createSellerFallbackConfig` | cấu hình fallback trong offer         | `poolPreference` không rỗng, không trùng, mọi pool thuộc offer; endpoint thuộc đúng pool |
| `createProviderCredential`   | tạo credential, trả plaintext một lần | provider key, hash và plaintext hợp lệ; id chưa tồn tại                                  |
| `revokeProviderCredential`   | `active` → `revoked`                  | credential chưa revoke; thời gian không lùi                                              |
| `assertCredentialProvider`   | không mutation (scope check)          | credential đúng provider và chưa revoke                                                  |

Các view thuần chỉ đọc, không thay đổi state: `deriveEndpointPoolHealth`, `evaluateOfferEndpointHealth`, `evaluateActivationEligibility`, `assertEligibilityForTenant`, `orderEndpointCandidates`, `isModelOfferServing`, `mapProviderModelToNormalizedIdentity`.

## 5. Invariants

1. Normalized model identity là nguồn chuẩn cho dedup/group; provider model name là raw.
2. Offer chỉ phục vụ customer khi `status = active` **và** còn endpoint pool phục vụ được.
3. Activation yêu cầu đồng thời verdict eligibility hợp lệ đúng tenant và pool `healthy`; thiếu một điều kiện là từ chối.
4. Public alias chỉ đổi khi `draft`; mọi offer khác không được dùng lại alias đã có.
5. Endpoint thuộc đúng một pool; pool thuộc đúng một offer; không tự sửa scope khi input lệch.
6. Health của endpoint chỉ đổi qua operation tường minh và không lùi thời gian; health pool là giá trị suy ra.
7. Provider credential hash-only, plaintext show-once, revoke terminal và hiệu lực ngay.
8. Normalized model identity là nguồn chuẩn cho dedup/group; raw provider model name giữ nguyên spelling.
9. Verdict eligibility lệch tenant hoặc không nhất quán bị từ chối, không được đọc là eligible.
10. Mọi timestamp sự kiện không lùi và không vượt quá `updatedAt` của bản ghi.

## 6. Auth boundary

- `sellerTenantId` do `llm-seller-tenant` cấp; marketplace không xác minh danh tính Seller và không tự quyết định Seller eligibility.
- Authorization: deny-by-default, enforce ở resource-owning backend. Composition chỉ làm UI visibility; permission catalog cấp sản phẩm từ `staff-access` (nếu seller là staff), còn quyền trong Seller tenant do `llm-seller-tenant` quyết định. Composition không tự cấp permission.
- Seller tenant resolution lấy từ authenticated principal + selector đã verify, không từ client input.
- Seller identity liên kết bằng `sub` opaque; không FK xuyên database.

## 7. Data ownership

- Database `db-llm-marketplace`, PostgreSQL, schema `llm_marketplace`.
- Runtime host: deploy unit `llm-api` (composition, không có deploy unit riêng cho `llm-marketplace`); `llm-api` là storage owner duy nhất của `db-llm-marketplace`. `llm-seller-tenant` / `llm-seller-governance` / `llm-console` / `llm-health-check` không chạm DB, đi qua contract/API của `llm-api`.

## 8. Integration

- `llm-seller-tenant` / `llm-seller-governance`: `sellerTenantId` trên offer và operational eligibility/verification outcome qua contract/projection; marketplace không sở hữu Seller lifecycle.
- `llm-consumer-tenant`: consumer workspace/tenant scope cho offer/catalog.
- `llm-api`: offer/identity cho routing; runtime host của marketplace DB. Quota **authority** (reserve/settle) và usage/reservation/settlement tại gateway → `llm-api`; quota **policy/limits** → `llm-consumer-tenant`; financial monetary state → `llm-financial`.
- `payment`: gateway/execution adapter cho payment & payout; seller payable/settlement do `llm-financial` sở hữu.
- `account`/`auth`: `sub` opaque cho actor.

## 9. Failure / correction

- Endpoint `down`: offer có thể deactivate hoặc failover sang pool khác.
- Credential revoke: hiệu lực ngay lập tức.
- Migration: forward-fix only, expand → compatible rollout → contract.
- Correction: prefer forward-fix over data rollback.

## 10. Quan hệ với routing và financial

- **Routing** (`llm-consumer-routing-domain`): chọn offer, alias công khai, priority/round-robin/lowest-price, fallback **giữa các offer**, retry — thuộc routing. Marketplace chỉ cung cấp offer/identity/endpoint đã chuẩn hoá và fallback **trong một offer**.
- **Financial** (`llm-financial-domain`): ledger, customer charge, seller payable, settlement — không thuộc marketplace và không có API nào ở đây chốt chúng. **Provider cost** không thuộc marketplace và cũng chưa được gán cho context nào ([`docs/domains/open-boundaries.md`](../open-boundaries.md) OB-7). Customer price thuộc `llm-seller-pricing`, không thuộc library này.
- **Quota** (`llm-api`): quota authority vẫn ở `llm-api`; marketplace không giữ reservation hay usage.

## 11. Quyết định chưa chốt

Các mục sau **không** được chốt trong code; mọi API hiện tại không phụ thuộc câu trả lời:

1. **Public seller prefix** — có prefix công khai cho seller/offer hay không, và nếu có thì format/ownership. Code hiện không mô hình hoá prefix. Riêng provider first-party không còn mở: danh tính công khai là tên tenant first-party → [ADR-0027](../llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §7.
2. **Unique public alias xuyên seller** — alias hiện unique trong phạm vi marketplace được kiểm ở biên ghi; việc có cho phép hai seller dùng cùng alias trong namespace khác nhau hay không chưa chốt.
3. **Retention/xoá credential** — thời hạn giữ credential đã revoke và cách xoá dữ liệu audit liên quan chưa chốt.
4. **Chiến lược chọn endpoint trong pool** — trọng số đã có trên endpoint nhưng thuật toán chọn (weighted/round-robin/...) và retry thuộc routing, chưa chốt tại marketplace.
5. **Provider cost** — thuộc `llm-financial-domain`; marketplace chưa và không nên gán ownership.

## 12. Tài liệu

| Document          | Nội dung                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `domain-model.md` | Business model, aggregate/entity/value object, lifecycle, invariants, auth boundary, data ownership |
