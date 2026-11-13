# Cung cấp model cho marketplace

> **Feature area:** `llm-marketplace/` · **Mô tả một dòng:** provider first-party (Dronie) của Ecoma-io đưa model vào marketplace qua một offer có giá, endpoint và credential — thiết lập bằng cấu hình triển khai và bootstrap, và gateway chỉ phục vụ khi mọi điều kiện đều hội.
>
> Đặc tả domain → [`domains/llm-marketplace/`](../../domains/llm-marketplace/README.md) · danh tính seller → [`domains/llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md`](../../domains/llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) · quy tắc viết → [`../README.md`](../README.md).

## 1. Problem

Ecoma-io vận hành một provider LLM first-party (Dronie) và muốn người dùng của mình gọi được model đó qua gateway của marketplace. Muốn vậy, marketplace phải trả lời được cho từng request: model này thuộc seller nào, gọi upstream ở đâu bằng credential nào, và tính tiền theo giá nào.

Seller ở đây không phải một bên ngoài tự đăng ký: đó là provider first-party do chính Ecoma-io vận hành, chịu trách nhiệm pháp lý và thuế của Ecoma-io, và không có nhu cầu rút thu nhập như một seller thương mại. Thiếu capability này, gateway không có offer nào để phục vụ: consumer không gọi được model first-party và toàn bộ chuỗi usage → charge → ledger không có gì để ghi.

## 2. Outcome

Người vận hành Ecoma-io (đóng vai seller first-party) đưa model của Dronie vào marketplace bằng cấu hình triển khai và chạy bootstrap; sau đó consumer thấy model trong catalog và gateway phục vụ được request thật.

- Marketplace có đúng một Seller tenant first-party cho provider (`dronie`); principal pháp lý là Ecoma-io; eligibility đạt được qua đúng chuỗi verification với review thật — classification không tạo miễn trừ nào ([ADR-0027](../../domains/llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §1–§4).
- Bootstrap chỉ kích hoạt offer khi đủ hai điều kiện: endpoint upstream trả lời thành công một probe dùng chính credential được cấu hình, và verdict eligibility của seller tenant còn dùng được. Thiếu một điều kiện, offer ở `draft` và endpoint ở `degraded` — fail-closed.
- Sau bootstrap, catalog liệt kê offer `active`; gateway phục vụ request chỉ khi đồng thời: offer `active`, còn endpoint `healthy`, credential plaintext của serving khớp hash của credential `active` thuộc đúng seller tenant sở hữu offer và đúng provider upstream, và snapshot giá `active` biểu diễn được bằng VND. Thiếu một điều kiện, request bị từ chối trước khi dispatch và không có attempt nào được đánh dấu đã phục vụ.
- Credential plaintext chỉ sống trong cấu hình triển khai (Worker Secret); database chỉ giữ hash, không có đường đọc lại plaintext. Revoke và rotation có hiệu lực ngay và giữ nguyên dữ liệu audit. Rotation là một chiều: cấu hình quay lại key đã thu hồi bị từ chối — phải cấu hình key mới.
- Chạy lại bootstrap với cùng cấu hình là no-op; cấu hình lệch khỏi dữ liệu đã có (sở hữu offer, model, endpoint target, owner) bị từ chối thay vì được sửa ngầm.
- Giá bán cho consumer chính là giá seller cấu hình trên offer — không có khái niệm giá nội bộ thứ hai ([ADR-0028](../../domains/llm-financial/adr/0028-internal-sponsorship-funding-first-party-financial-model.md) §7.2). Seller first-party không có earnings, không accrue payable và không có payout ([ADR-0027](../../domains/llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §9); usage đo đầy đủ và kế toán kép vẫn chạy ([ADR-0026](../../domains/llm-consumer-tenant/adr/0026-first-party-dogfooding-and-commercial-policy-boundaries.md) §4).

## 3. Scope

### Bao gồm

- **Seller identity first-party**: tenant `dronie` (classification `first_party`, owner là `sub` Superadmin bootstrap), tên tenant chính là danh tính công khai của provider; principal pháp lý Ecoma-io là bản ghi authoritative trong `llm-seller-governance` (ADR-0027 §2, §3, §7).
- **Eligibility governance**: legal/tax profile versioned, verification case principal-scoped qua review thật có attribution reviewer, association tenant ↔ principal pin đúng cặp revision; verdict eligibility suy ra fail-closed từ durable state; thay đổi pháp lý material của principal làm mọi tenant first-party ineligible từ lần derive kế tiếp (ADR-0027 §4–§6).
- **Offer, endpoint, pool**: offer seed `draft` theo cấu hình (normalized model identity, capability `chat`), pool một endpoint mặc định `degraded`; health chỉ đổi qua operation tường minh sau probe thành công; activation yêu cầu đồng thời pool `healthy` của chính offer và verdict eligibility dùng được.
- **Provider credential**: hash-only, show-once, thuộc đúng một Seller tenant, scope theo provider upstream; rotation bằng đổi cấu hình và chạy lại bootstrap; credential của tenant khác và credential sai provider không dùng được cho serving (`credential_tenant_mismatch`, `credential_provider_mismatch`, `credential_revoked`).
- **Pricing serving**: một snapshot giá `active` theo normalized model, đơn vị VND minor, kèm bound token per request; serving resolve snapshot tại admission và fail-closed khi thiếu snapshot hoặc snapshot không express được bằng VND ([ADR-0028](../../domains/llm-financial/adr/0028-internal-sponsorship-funding-first-party-financial-model.md) §13.4).
- **Serving gate và kế toán**: restriction hiệu lực trên seller tenant chặn serving; usage được đo, charge bị bound bởi reservation, journal chỉ chứa metadata; seller first-party không accrue payable.

### Không bao gồm

- **Phía consumer** — API credential, gọi inference, quan sát usage và funding visibility → [consumer-usage](./consumer-usage.md).
- **Không có bề mặt seller tự phục vụ (bootstrap-only).** Không có UI hay HTTP API nào để tạo/sửa offer, endpoint, credential hay giá trong M1: mọi thao tác seller là cấu hình triển khai và chạy lại bootstrap. Portal seller (`llm-seller`) chưa hiện thực workflow nào; việc bổ sung bề mặt là mục tiêu tương lai, không thuộc capability này cho tới khi có hiện thực.
- **Không có đo health định kỳ.** Health endpoint chỉ được ghi khi bootstrap probe thành công; giữa hai lần chạy bootstrap, serving tin vào health đã ghi — endpoint hỏng sau bootstrap chỉ bộc lộ qua lỗi serving (503/502), và refresh health là chạy lại bootstrap. Job đo health định kỳ (`llm-health-check`) chưa tồn tại dưới dạng code hay deploy unit; đây là limitation được chấp nhận của M1, không phải hành vi hứa hẹn.
- **Không có entitlement sản phẩm cho seller.** Phân loại tenant không mang entitlement (ADR-0026 §4); không có đường đăng nhập seller hay permission product nào dành riêng cho portal seller trong M1 — bề mặt M1 là cấu hình triển khai, không phải ứng dụng đăng nhập.
- **Đổi giá không phải workflow M1.** Giá được seed tất định bởi migration; thay đổi giá là thay đổi dữ liệu có kiểm (snapshot mới + retire snapshot cũ qua migration), không có bề mặt operator trong M1.
- **Nghĩa vụ tài chính của seller ngoài** — earnings, payable, payout, settlement: seller first-party bị loại khỏi tất cả (ADR-0027 §9); cơ chế cho external seller thuộc `llm-financial` và nằm ngoài capability này.
- **Các mục chưa chốt giữ nguyên tại nơi canonical, tài liệu này không quyết**: public seller prefix và unique public alias xuyên seller ([`domains/llm-marketplace/domain-model.md`](../../domains/llm-marketplace/domain-model.md) §11), ownership và nguồn của provider cost ([`domains/open-boundaries.md`](../../domains/open-boundaries.md) OB-7), pricing granularity theo offer hay theo normalized model (OB-8).

## 4. Acceptance Scenarios

```text
Cho  cấu hình triển khai của provider first-party
Khi  chạy bootstrap governance
Thì  Seller tenant `dronie` tồn tại với principal pháp lý Ecoma-io, và verdict eligibility suy ra từ chính durable state là eligible
```

```text
Cho  verdict eligibility còn dùng được và upstream trả lời probe thành công
Khi  chạy bootstrap marketplace
Thì  offer `active`, endpoint `healthy`, database chỉ giữ credential hash, và catalog liệt kê model
```

```text
Cho  upstream không trả lời, trả lỗi, hoặc trả 401 cho credential đã cấu hình
Khi  chạy bootstrap marketplace
Thì  endpoint vẫn `degraded`, offer vẫn `draft`, và gateway không phục vụ model đó
```

```text
Cho  offer đang `active`
Khi  chạy lại bootstrap với cùng cấu hình
Thì  không có offer row hay credential row mới, và offer vẫn `active`
```

```text
Cho  key credential upstream đã đổi
Khi  chạy lại bootstrap với plaintext mới
Thì  credential mới `active`, credential cũ `revoked` với bản ghi còn nguyên; cấu hình quay lại plaintext cũ bị từ chối thay vì kích hoạt lại credential đã thu hồi
```

```text
Cho  request tới model có offer `active`
Khi  plaintext credential của serving không khớp hash của credential `active` nào trong tập của seller tenant sở hữu offer
Thì  request bị từ chối 503, không dispatch, không có attempt đã phục vụ
```

```text
Cho  offer `active`, endpoint `healthy`, credential khớp và snapshot giá `active` VND
Khi  consumer gọi gateway
Thì  gateway dispatch upstream, đo usage và settle đúng một lần; journal chỉ chứa metadata, không có prompt, response hay plaintext nào
```

```text
Cho  restriction hiệu lực trên seller tenant của offer
Khi  consumer gọi model đó
Thì  request bị từ chối 403 và không dispatch
```

```text
Cho  model không có snapshot giá `active` hoặc snapshot không express được bằng VND
Khi  consumer gọi model đó
Thì  request bị từ chối 503, không dispatch, không có charge
```

```text
Cho  usage của consumer đối với model first-party đã settle
Khi  đọc ledger
Thì  có customer charge với attribution đầy đủ, và không có seller payable nào accrue cho seller first-party
```

## 5. Domain & Application Mapping

| Domain / Application    | Vai trò trong Feature                                                                    | Canonical                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `llm-seller-tenant`     | Sở hữu Seller tenant `dronie`, ownership và membership; danh tính công khai provider     | [`docs/domains/llm-seller-tenant/`](../../domains/llm-seller-tenant/README.md)         |
| `llm-seller-governance` | Sở hữu principal pháp lý, verification, restriction; phát verdict eligibility            | [`docs/domains/llm-seller-governance/`](../../domains/llm-seller-governance/README.md) |
| `llm-marketplace`       | Sở hữu offer, endpoint, pool, provider credential, capability; health là event           | [`docs/domains/llm-marketplace/`](../../domains/llm-marketplace/README.md)             |
| `llm-seller-pricing`    | Sở hữu giá seller cấu hình và snapshot serving                                           | [`docs/domains/llm-seller-pricing/`](../../domains/llm-seller-pricing/README.md)       |
| `llm-financial`         | Sở hữu charge/ledger; payable không accrue cho seller liên kết principal (ADR-0028 §7.1) | [`docs/domains/llm-financial/`](../../domains/llm-financial/README.md)                 |
| `llm-api`               | Host bootstrap runner và serving gate; storage owner duy nhất của các database LLM       | [`docs/applications/llm-api/`](../../applications/llm-api/README.md)                   |

Bề mặt vận hành M1 của feature này là bootstrap runner của `llm-api` (bước 8a governance và 8b marketplace trong hợp đồng bootstrap [ADR-0020](../../domains/staff-access/adr/0020-bootstrap-seed-contract.md)), được deploy wiring gọi trong lane; không có application/deploy unit seller nào tham gia trong M1.

## 6. Verification Mapping

| Scenario | Test file / suite                                                                                                                                                     | Loại test               | Nx target                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------- |
| S1       | `apps/llm-api/tests/databases/bootstrap-governance.spec.ts`; `system-tests/e2e/llm-inference-e2e/e2e/01-lane-bootstrap.spec.ts`                                       | integration; system E2E | `test-integration`; `system-test` |
| S2       | `apps/llm-api/tests/databases/bootstrap-marketplace.spec.ts` (activation chain qua mock kiểm credential)                                                              | integration             | `test-integration`                |
| S3       | `bootstrap-marketplace.spec.ts` (dead upstream, upstream 401, timeout); `apps/llm-api/tests/integrations/chat-completions.spec.ts` (draft offer bị loại khỏi catalog) | integration             | `test-integration`                |
| S4       | `bootstrap-marketplace.spec.ts` (rerun là no-op)                                                                                                                      | integration             | `test-integration`                |
| S5       | `bootstrap-marketplace.spec.ts` (rotation: row mới active, row cũ revoked, không xoá; từ chối kích hoạt lại)                                                          | integration             | `test-integration`                |
| S6       | `chat-completions.spec.ts` (503 `upstream_credential_unavailable`); `bootstrap-marketplace.spec.ts` (credential tenant-scoped trên access path)                       | integration             | `test-integration`                |
| S7       | `chat-completions.spec.ts` (serve + settle); `system-tests/e2e/llm-inference-e2e/e2e/02-serving-and-ledger.spec.ts` (settle đúng một lần); `04-leak-fences.spec.ts`   | integration; system E2E | `test-integration`; `system-test` |
| S8       | `chat-completions.spec.ts` (403 `offer_restricted` khi restriction `chat` hiệu lực)                                                                                   | integration             | `test-integration`                |
| S9       | `apps/llm-api/src/api-errors.spec.ts` (shape 503 `pricing_unavailable`)                                                                                               | unit                    | `test`                            |
| S10      | `chat-completions.spec.ts` (settle chỉ ghi customer charge; `seller: null` tại serving call-site)                                                                     | integration             | `test-integration`                |

Giới hạn phải nêu:

- **S9 chỉ được kiểm ở tầng unit (shape lỗi).** Không có integration hay system test nào drive serving path vào nhánh thiếu snapshot giá hoặc snapshot không phải VND; hành vi fail-closed của nhánh này chưa được chứng minh ở tầng người dùng tương tác.
- **S10 không có test nào assert trực tiếp vắng seller payable.** Việc first-party không accrue payable được enforce tại serving call-site và chỉ được kiểm gián tiếp qua các assert ledger của customer charge; không có assert phủ định trên bảng payable.
- **S1–S7 ở tầng system chỉ chạy trên lane local** (`system-tests/e2e/llm-inference-e2e/`, target `system-test` sau `test-lane-up`); chúng không chạy trong CI pull-request.
- **Health giữa hai lần bootstrap không có test staleness riêng**: hành vi "endpoint hỏng sau bootstrap" chỉ được kiểm ở tầng integration qua mock upstream đóng băng, không có test mô phỏng suy giảm sau khi đã `healthy`.
