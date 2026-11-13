# Gọi inference LLM bằng credential nội bộ được tài trợ

> **Feature area:** `llm-marketplace/` · **Mô tả một dòng:** hệ thống nội bộ Ecoma gọi inference qua gateway bằng API key cấp một lần, và mọi lần gọi bị đo usage, bị khống chế chi tiêu và được tài trợ từ sponsor nội bộ trên sổ ledger bền.
>
> Ranh giới first-party đã accept → [ADR-0026](../../domains/llm-consumer-tenant/adr/0026-first-party-dogfooding-and-commercial-policy-boundaries.md) · mô hình tài chính sponsor → [ADR-0028](../../domains/llm-financial/adr/0028-internal-sponsorship-funding-first-party-financial-model.md) · feature phía seller → issue [#176](https://github.com/ecoma-io/ecoma/issues/176).

## 1. Problem

Các hệ thống nội bộ của tổ chức cần gọi mô hình LLM. Khi capability này không tồn tại, mỗi hệ thống phải tự ký hợp đồng provider, tự giữ key và tự đối soát hoá đơn: không ai trả lời được "hệ thống X đã tiêu bao nhiêu token trong tháng cho model nào", không có giới hạn chi tiêu nào được thực thi trước khi tiền mất, và một hệ thống chạy sai có thể tiêu đốt ngân sách mà không có tín hiệu chặn.

Đưa key provider cho từng hệ thống còn làm secret lan rộng: key nằm rải rác ở nhiều nơi, không thu hồi tập trung được, và không phân biệt được request nào của ai.

## 2. Outcome

- Một hệ thống nội bộ gọi được inference qua một điểm vào duy nhất của tổ chức bằng API key được cấp đúng một lần; key chỉ lưu hash trong database, plaintext không bao giờ phát hành lại, và key đã revoke bị chặn ngay ở lần gọi đầu.
- Mọi request được phục vụ để lại bản ghi usage gắn tenant, key, model đã resolve, offer phục vụ, token counts và charge; settlement xảy ra đúng một lần; gửi lại cùng request id không tạo thêm attempt hay charge nào.
- Chi tiêu bị khống chế **trước khi** request được gửi đi cho provider: vượt trần token của tenant hoặc số dư không đủ giữ cận trên chi phí → 429, không dispatch, không attempt.
- Nguồn tiền là sponsor nội bộ: trần của sponsor và của authorization được kiểm ngay lúc cấp; escrow bảo toàn `available + held + charged = total`; số dư suy lại được từ ledger; ledger không nhất quán thì serving fail-closed thay vì phục vụ trên số liệu sai.
- Prompt/response body, key plaintext và credential plaintext không bao giờ xuất hiện trong log — chỉ metadata và outcome.

## 3. Scope

### Bao gồm

**Credential — cấp và lifecycle ở mức M1 (đã hiện thực):**

- Bootstrap cấp đúng một API key hash-only cho tenant `ecoma` (bước 9 theo [ADR-0020](../../domains/staff-access/adr/0020-bootstrap-seed-contract.md)); plaintext do runner sinh bằng CSPRNG và xuất hiện đúng một lần trên stdout máy đọc, database chỉ lưu SHA-256 hash.
- Chạy lại bootstrap khi key active còn tồn tại: không tạo key mới, không phát lại plaintext (`apiKey:"existing"`).
- Khi mọi key đã bị revoke ngoài bề mặt provisioning: bootstrap fail-closed, không cấp key mới.
- Trạng thái revoke trong database được enforcing fail-closed trên serving: revoked → 403 `api_key_revoked`.

**Inference (đã hiện thực, API-only):**

- `POST /v1/chat/completions` (kèm biến thể `/llm/v1/...`): chuỗi admission fail-closed → dispatch → settlement; `GET /v1/models` trả catalogue từ offer `active`, readiness-gated, fail-closed 503 khi database chưa sẵn sàng.
- Request tương thích OpenAI: `max_tokens` bắt buộc (422 khi thiếu); `stream:true` bị từ chối (400).
- Idempotency theo `x-request-id`: replay cùng payload → 409, cùng id khác payload → 409 `idempotency_conflict`; không side effect mới nào.
- Lỗi upstream map ổn định: provider 401 → 502 với evidence `confirmed_not_executed` và release cả hai reservation; provider 429 → 429 forward `retry-after`; provider 500/timeout → 502 với evidence `may_have_executed`, settle capped tại amount đã giữ, không blind retry.

**Usage attribution (đã hiện thực, ghi bền):**

- Mỗi logical request settled mang `tenant_id`, `api_key_id`, model đã resolve, offer, pricing snapshot, `input_tokens`/`output_tokens`, charge và evidence; attempt mang provenance routing.
- Usage `missing`/`malformed` được ghi bền kèm cảnh báo, không bao giờ âm thầm tính là 0; charge bị cap tại amount admission đã giữ.
- Settlement đúng một lần per request dù có nhiều attempt; charge luôn ≤ amount đã giữ.

**Expenditure control và funding visibility (đã hiện thực ở tầng bền):**

- Trần token cumulative per tenant: `settled + active reservation ≤ ceiling`, kiểm trong cùng transaction reserve; hai request song song với trần vừa đủ → đúng một được admit.
- Funding sponsor nội bộ: sponsor, billing account canonical của tenant `ecoma`, funding authorization và grant khởi tạo được seed ở bootstrap (B1–B4, [ADR-0028](../../domains/llm-financial/adr/0028-internal-sponsorship-funding-first-party-financial-model.md) §6); grant vượt trần sponsor hoặc trần authorization bị từ chối không post một phần.
- Wallet/ledger double-entry bền; escrow bảo toàn; balance suy từ ledger theo `posting_seq` (bất biến replay-order); ledger hỏng hình hay không nhất quán → serving fail-closed 503.
- Quan sát usage và funding trong M1 = bản ghi database bền truy vấn được bởi operator. Không có read API nào cho usage hay số dư — đây là giới hạn của bề mặt, không phải của dữ liệu.

**Ba quyết định phạm vi M1 (ghi tại đây theo [docs/AGENTS.md](../../AGENTS.md) §9 — tài liệu merge vào default branch là accepted):**

1. **Bề mặt consumer M1 là API-only.** Consumer M1 là hệ thống nội bộ gọi trực tiếp data plane `llm-api`; `llm-console` cùng sáu workflow consumer của nó (docs `applications/llm-console/01-architecture.md` §6) không thuộc capability này — app hiện là scaffold shell, chưa workflow nào có hiện thực hay test. Delivery kế nhiệm ghi exclusion `llm-console` ra khỏi MVP units thay vì huỷ issue.
2. **Entitlement consumer-side nằm ngoài M1, ghi tường minh kèm lý do.** Truy cập consumer M1 được enforce bằng cấu trúc provisioning — key chỉ tồn tại qua bootstrap cho đúng tenant canonical, restricted-by-construction ([ADR-0028](../../domains/llm-financial/adr/0028-internal-sponsorship-funding-first-party-financial-model.md) §3.2) — chứ không bằng entitlement flag; [ADR-0009](../../domains/staff-access/adr/0009-no-internal-authorization-result-contract.md)/OB-2 đã phân định entitlement là tín hiệu tính khả dụng sản phẩm, không phải verdict per-request, và metering/accounting cho first-party vẫn bắt buộc giữ ([ADR-0026](../../domains/llm-consumer-tenant/adr/0026-first-party-dogfooding-and-commercial-policy-boundaries.md) §4). Kênh thêm LLM vào `ENTITLEMENT_PRODUCTS` mà ADR-0026 §4 trỏ tới (issue #16) đã đóng `not planned` (2026-11-11) mà không có nơi re-home — quyết định re-home là mục mở của feature này, xem mục mở cuối mục này.
3. **Lifecycle credential M1 là bootstrap-only, không rotation.** M1 cấp đúng một key qua bootstrap; revoke được enforcing nhưng không có bề mặt create/list/revoke/rotate nào (control plane FR-20 của `llm-api` chưa dựng). Cơ chế rotation là mục mở, xem cuối mục này.

### Không bao gồm

- Quản lý key tự phục vụ (tạo/list/revoke/rotate qua UI hay admin API): control plane chưa dựng; đây là gap hiện thực, không phải non-goal nghiệp vụ.
- Streaming SSE: `stream:true` bị từ chối 400; hành vi streaming của target architecture chưa có trong serving path.
- `POST /v1/completions` và `POST /v1/embeddings`: docs target ghi hai endpoint này, serving path hiện chỉ có chat completions và models.
- Các workflow `llm-console` (API keys, alias/routing, balance, top-up, usage, workspace scope): quyết định 1 — ngoài M1.
- Entitlement gating qua `ENTITLEMENT_PRODUCTS`: quyết định 2 — ngoài M1.
- Top-up tự nạp, payment thật, provider cost: OB-1,OB-7 và phạm vi M3; giá nội bộ = giá seller cấu hình theo ADR-0028 §7.2.
- Read API/dashboard cho usage, charge hay số dư: dữ liệu nằm ở database bền; bề mặt đọc là việc của delivery sau.
- Các mục mở của domain không thuộc ba quyết định trên: U-1…U-5 của `llm-inference` (disconnect policy, `maxAttempts`, escalation), U-1…U-4 của `llm-usage`, OB-3 (settlement debt khi PG down), OB-6 (mapping `account` ↔ các context LLM còn lại), OB-8 (pricing granularity), §8 của `llm-consumer-tenant` (lifecycle pháp lý tenant, ownership transfer, permission catalog, suspension catalog) — không được giải quyết ngầm tại đây.

**Mục mở của feature này** (quyết định genuinely open, ghi theo [docs/AGENTS.md](../../AGENTS.md) §11):

- **Re-home quyết định entitlement LLM.** Options: (a) ADR mới dưới `staff-access` chốt `ENTITLEMENT_PRODUCTS` cho các product LLM; (b) cập nhật `llm-consumer-tenant/domain-model.md` §5 (auth boundary); (c) khẳng định tường minh "không cần cho API-only". Khuyến nghị: chốt cùng lúc với việc hiện thực bề mặt browser consumer (`llm-console`) — đó là lúc entitlement bắt đầu có đối tượng để gate; trước đó lựa chọn nào cũng chỉ là ký hiệu. Settler: Modelling/architecture unit kế nhiệm khi `llm-console` vào MVP.
- **Cơ chế rotation/re-issue key.** Options: (a) control-plane admin API theo FR-20 của `llm-api` — khuyến nghị, vì mutation đặc quyền append-only audit đã nằm trong thiết kế `llm-api`; (b) mở rộng bề mặt bootstrap — xung đột với hành vi fail-closed hiện hành (mọi key revoked ⇒ không cấp mới), phải kèm thay đổi quyết định đó. Settler: Delivery của control plane khi nhu cầu second key hay key compromise phát sinh.

## 4. Acceptance Scenarios

Các scenario dưới đây phản ánh hành vi hiện có của hệ thống, được kiểm chứng từ bên ngoài (HTTP response, stdout máy đọc của bootstrap, database bền).

```text
Cho  tenant `ecoma` chưa có API key nào trên một môi trường mới
Khi  chạy bootstrap consumer tenant
Thì  key plaintext xuất hiện đúng một dòng máy đọc trên stdout, database chỉ lưu SHA-256 hash, và id của key suy ra tất định từ hash
```

```text
Cho  tenant đã có key active
Khi  chạy lại bootstrap
Thì  không có key mới, không plaintext nào được phát hành lại
```

```text
Cho  mọi key của tenant đã bị revoke ngoài bề mặt provisioning
Khi  chạy lại bootstrap
Thì  fail-closed — không key mới được cấp
```

```text
Cho  caller gọi inference với Authorization thiếu, rỗng, sai định dạng hoặc key không tồn tại
Khi  POST /v1/chat/completions
Thì  nhận 401 `invalid_api_key` ổn định và không bảng journal, quota hay charge nào bị ghi
```

```text
Cho  một key đã bị revoke
Khi  gọi inference bằng key đó
Thì  nhận 403 `api_key_revoked` ở admission, không dispatch
```

```text
Cho  offer active với endpoint pool healthy
Khi  đọc GET /v1/models rồi POST /v1/chat/completions bằng key hợp lệ
Thì  catalogue trả đúng model của offer active (offer draft bị loại) và completion trả về kèm usage thật; `stream:true` → 400, thiếu `max_tokens` → 422
```

```text
Cho  một request đã phục vụ với `x-request-id` R
Khi  gửi lại cùng R với cùng payload
Thì  nhận 409, không attempt, không reservation, không charge mới
```

```text
Cho  provider trả lỗi (401, 429, 500 hoặc timeout)
Khi  gateway dispatch tới provider
Thì  response map ổn định theo evidence: `confirmed_not_executed` release cả hai reservation, 429 forward `retry-after`, `may_have_executed` settle capped — không blind retry
```

```text
Cho  một request đã settled
Khi  operator truy vấn database
Thì  thấy đúng một row logical request settled mang tenant, api key, model resolved, offer, token counts và charge, với charge ≤ amount admission đã giữ
```

```text
Cho  provider trả 200 với body malformed không đọc được usage
Khi  settlement chạy
Thì  usage_status `missing`/`malformed` được ghi bền, charge bị cap tại amount đã giữ, client nhận 502 — usage không bị âm thầm tính là 0
```

```text
Cho  tenant ở sát trần token cumulative
Khi  hai request gửi song song
Thì  đúng một được admit và settle; request kia nhận 429 `insufficient_quota`; tổng settled + active reservation không bao giờ vượt trần
```

```text
Cho  wallet của tenant không đủ giữ cận trên chi phí của attempt
Khi  request gửi tới
Thì  nhận 429 `insufficient_funds`, quota reservation đã reserve được release idempotent trong cùng transaction, không dispatch
```

```text
Cho  sponsor nội bộ với trần đã cấu hình
Khi  bootstrap seed funding B1–B4
Thì  grant được credit đúng amount vào wallet với escrow bảo toàn; grant vượt trần sponsor hoặc trần authorization bị từ chối không post một phần
```

```text
Cho  ledger đã ghi nhiều bút toán trong đó có các bút toán cùng mốc thời gian
Khi  hydrate lại state wallet từ ledger
Thì  balance suy đúng theo thứ tự cấp phát của database, không theo tie-break theo id; ledger không nhất quán → serving fail-closed 503
```

```text
Cho  một serving round đã hoàn tất với key và prompt thật
Khi  kiểm logs worker, logs upstream mock và gateway database
Thì  không nơi nào chứa key plaintext hay prompt/response body; database chỉ lưu hash
```

## 5. Domain & Application Mapping

| Domain / Application    | Vai trò trong Feature                                                                                                        | Canonical                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `llm-consumer-tenant`   | Tenant `ecoma` + membership là điều kiện phục vụ; tenant không tồn tại ⇒ fail-closed 403; suspension chặn kể cả owner        | `docs/domains/llm-consumer-tenant/README.md`   |
| `llm-marketplace`       | Offer/alias/endpoint/credential cấp nguồn cho routing và catalogue; tiêu thụ qua projection/contract, không đọc trực tiếp    | `docs/domains/llm-marketplace/README.md`       |
| `llm-consumer-routing`  | Resolve alias → model/offer, chọn endpoint healthy                                                                           | `docs/domains/llm-consumer-routing/README.md`  |
| `llm-inference`         | Lifecycle logical request/attempt, evidence, quyền retry/fallback                                                            | `docs/domains/llm-inference/README.md`         |
| `llm-usage`             | Usage measurement/normalization/aggregate; vocabulary `usage_status`                                                         | `docs/domains/llm-usage/README.md`             |
| `llm-seller-pricing`    | Pricing snapshot bind tại admission; không express được bằng VND ⇒ 503                                                       | `docs/domains/llm-seller-pricing/README.md`    |
| `llm-seller-governance` | Restriction verdict tiêu thụ như giá trị hợp đồng; restriction hiệu lực ⇒ 403                                                | `docs/domains/llm-seller-governance/README.md` |
| `llm-financial`         | Sponsor, billing account, wallet, ledger, reservation, charge — settlement authority                                         | `docs/domains/llm-financial/README.md`         |
| `apps/llm-api`          | Deploy unit duy nhất của capability; quota authority + settlement authority (A7); sở hữu `db-llm-gateway` và `db-llm-tenant` | `docs/applications/llm-api/README.md`          |

`llm-console` không tham gia capability này trong M1 (quyết định 1). Key API nằm trong `llm_gateway.api_keys` thuộc `db-llm-gateway` mà `apps/llm-api` sở hữu; tenant và membership nằm ở `db-llm-tenant` — hai database, hai bước bootstrap riêng, không transaction xuyên database.

## 6. Verification Mapping

Suite system cần lane local đang chạy thật (`system-test` với `-c local`, `dependsOn` local-up theo [06-testing.md](../../architecture/06-testing.md) §4); suite còn lại chạy qua target của project sở hữu.

| Scenario                                    | Test file / suite                                                                                                                           | Loại test                | Nx target                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------- |
| S1 cấp key show-once, chỉ lưu hash          | `apps/llm-api/tests/databases/bootstrap-consumer-tenant.spec.ts`; `system-tests/e2e/llm-inference-e2e/e2e/01-lane-bootstrap.spec.ts` (d)    | database + system        | `test-integration` + `system-test`          |
| S2 re-run không phát lại                    | như S1 (it "reruns as a no-op…", it "(d) seeds… exactly one active hash-only api key…")                                                     | database + system        | `test-integration` + `system-test`          |
| S3 mọi key revoked ⇒ fail-closed            | `apps/llm-api/tests/databases/bootstrap-consumer-tenant.spec.ts` (it "fails closed when every stored key was revoked…")                     | database                 | `test-integration`                          |
| S4 auth fail 401 ổn định, không ghi journal | `apps/llm-api/tests/integrations/chat-completions.spec.ts`; `system-tests/e2e/llm-inference-e2e/e2e/03-auth-failures.spec.ts`               | integration + system     | `test-integration` + `system-test`          |
| S5 revoked key → 403                        | `apps/llm-api/tests/integrations/chat-completions.spec.ts` (it "rejects a revoked key…")                                                    | integration              | `test-integration`                          |
| S6 catalogue + completion + validation      | `system-tests/e2e/llm-inference-e2e/e2e/02-serving-and-ledger.spec.ts` (e/f); `apps/llm-api/tests/integrations/chat-completions.spec.ts`    | system + integration     | `system-test` + `test-integration`          |
| S7 replay 409 không side effect             | `system-tests/e2e/llm-inference-e2e/e2e/02-serving-and-ledger.spec.ts` (h); `apps/llm-api/tests/integrations/chat-completions.spec.ts`      | system + integration     | `system-test` + `test-integration`          |
| S8 map lỗi upstream theo evidence           | `apps/llm-api/tests/integrations/chat-completions.spec.ts` (upstream 401/429/500/timeout/malformed 200)                                     | integration              | `test-integration`                          |
| S9 attribution đầy đủ, settle một lần       | `system-tests/e2e/llm-inference-e2e/e2e/02-serving-and-ledger.spec.ts` (g)                                                                  | system                   | `system-test`                               |
| S10 missing usage không silent-zero         | `apps/llm-api/tests/integrations/chat-completions.spec.ts` (it "treats a malformed 200 body…")                                              | integration              | `test-integration`                          |
| S11 trần token, một trong hai song song     | `apps/llm-api/tests/integrations/chat-completions.spec.ts` (it "admits exactly one of two concurrent…")                                     | integration              | `test-integration`                          |
| S12 insufficient funds → 429 + release      | đường serving có sẵn (`src/chat-completions.ts` bước 10, error factory có unit) — chưa có test full-path                                    | —                        | —                                           |
| S13 funding B1–B4 + trần sponsor            | `libs/llm-financial-domain/src/sponsor.spec.ts`; `apps/llm-api/tests/databases/bootstrap-financial.spec.ts`; lane (d)                       | unit + database + system | `test` + `test-integration` + `system-test` |
| S14 replay-order ledger, fail-closed        | `apps/llm-api/tests/databases/ledger-replay-order.spec.ts`                                                                                  | database                 | `test-integration`                          |
| S15 leak fences                             | `system-tests/e2e/llm-inference-e2e/e2e/04-leak-fences.spec.ts`; `apps/llm-api/tests/integrations/chat-completions.spec.ts` (metadata-only) | system + integration     | `system-test` + `test-integration`          |

Giới hạn phải nêu:

- **S12 chưa có test full-path.** Nhánh financial admission từ chối → release quota → 429 `insufficient_funds` chỉ được unit-test ở error factory; không suite nào đi trọn serving path cho nhánh này.
- **S5 revoked-key chưa có scenario system E2E** — suite auth-failures trên lane chỉ cover missing/malformed/unknown; revoked được verify ở tầng integration (trạng thái revoke pre-set trong database).
- **Quan sát usage/funding chỉ được verify ở tầng database**, thấp hơn tầng người dùng tương tác: capability không có read API nên mọi assertion về usage/funding đi qua truy vấn SQL của test — đúng giới hạn đã nêu ở Scope.
- Sự tồn tại của test file không phải bằng chứng test đã pass; kết luận `Verified` cần kết quả chạy thật của `test`, `test-integration` và `system-test` (-c local).
