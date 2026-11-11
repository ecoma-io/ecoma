# llm-api — Application

`llm-api` là **deploy unit public** `api.ecoma.io/llm` — gateway suy luận LLM, sở hữu `db-llm-gateway` (PostgreSQL) và là **quota authority + settlement authority** (A7, invariant 16). Runtime: Cloudflare Worker, data plane hiệu năng cao (Rust/WASM) và control plane Rust.

> `llm-api` **không sở hữu** bất kỳ bounded context nào. Nó host implementation của một số context bên trong deploy unit, tiêu thụ một số context khác qua contract, và triển khai persistence riêng. Domain ownership luôn thuộc `docs/domains/*/domain-model.md`; `llm-api` chỉ pointer tới đó.

## Vai trò

- Public LLM inference API (chat/completion, streaming) dưới `/llm`.
- Admission: auth API key, resolve alias/model, chọn endpoint, reserve quota durable.
- Provider adapter, dispatch, streaming, retry/fallback theo execution evidence.
- Quota reservation, settlement, usage recording.
- Financial correctness (budget escrow/lease, customer charge, seller payable) — theo `llm-financial`, domain model tại [`docs/domains/llm-financial/domain-model.md`](../../domains/llm-financial/domain-model.md).

## Composition mapping — BC composed vs accessed via contract

`llm-api` **không** chứa toàn bộ 9 BC. Mapping:

| BC                      | Vai trò trong `llm-api`                                                                                                        | Access mode                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `llm-inference`         | Composed **inside** `llm-api` (lifecycle request, provider attempt, streaming, retry/fallback, execution evidence)             | internal module                                                  |
| `llm-consumer-routing`  | Composed **inside** `llm-api` (alias, candidate selection, fallback hai cấp, snapshot)                                         | internal module                                                  |
| `llm-usage`             | Composed **inside** `llm-api` (normalization, request/attempt usage, correction)                                               | internal module                                                  |
| `llm-seller-pricing`    | Composed **inside** `llm-api` (pricing snapshot bound at admission)                                                            | internal module                                                  |
| `llm-financial`         | Composed **inside** `llm-api` (budget escrow/lease, charge, payable, ledger view)                                              | internal module, nhưng reconciliation với `payment` qua contract |
| `llm-consumer-tenant`   | Composed **inside** `llm-api` (tenant, membership, workspace, grant, suspension); `llm-api` là storage owner `db-llm-tenant`   | internal module                                                  |
| `llm-marketplace`       | **Accessed via contract** — offer/normalized identity/endpoints là input cho routing; `llm-api` không đọc `db-llm-marketplace` | event projection (outbox)                                        |
| `llm-seller-governance` | **Accessed via contract** — eligibility/restriction verdict là giá trị hợp đồng; `llm-api` không đọc evidence pháp lý          | contract value                                                   |

**Quy tắc boundary:** `llm-consumer-tenant` là module trong cùng deploy unit — đọc/ghi `db-llm-tenant` qua module, không qua contract. `llm-marketplace` chỉ đọc projection đã đồng bộ (event-driven, idempotent consumer). Verdict của `llm-seller-governance` được tiêu thụ như giá trị hợp đồng, không import implementation. Không cross-database query. Quota/financial authority vẫn ở `llm-api` (A7) — không bị delegation.

**Extra service:** không đề xuất thêm service mới. Mọi BC trên đều là module trong cùng deploy unit `llm-api`. Chỉ tách thêm deploy unit khi có bằng chứng về scaling/ownership independence (chưa có). Ranh giới module-level enforce bằng Nx module-boundary + contract test.

## Business semantics pointers

Business semantics của các context được host/consumed bởi `llm-api` nằm tại các domain model sau; `llm-api` chỉ triển khai runtime và persistence, **không** định nghĩa lại business rule:

- Tenant/membership/workspace/grant/suspension → [`docs/domains/llm-consumer-tenant/domain-model.md`](../../domains/llm-consumer-tenant/domain-model.md)
- Model alias/routing policy/candidate selection/fallback → [`docs/domains/llm-consumer-routing/domain-model.md`](../../domains/llm-consumer-routing/domain-model.md)
- Billing account/wallet/ledger/reservation/charge/payable/settlement → [`docs/domains/llm-financial/domain-model.md`](../../domains/llm-financial/domain-model.md)
- Logical request lifecycle/provider attempt/retry/evidence → [`docs/domains/llm-inference/domain-model.md`](../../domains/llm-inference/domain-model.md)
- Usage measurement/normalization/correction → [`docs/domains/llm-usage/domain-model.md`](../../domains/llm-usage/domain-model.md)

## Public API surfaces & planes

Hai plane trong cùng deploy unit:

```text
                    ┌─────────────────────────────┐
Client ──► public ──► │       Data Plane           │  (hot path, /llm/v1/...)
                    │  Rust high-perf runtime     │
                    └──────────────┬──────────────┘
                                   │ internal call
                    ┌──────────────▼──────────────┐
Admin/BFF ──► │       Control Plane          │  (admin API, config, audit)
                    │  (private, Service Binding) │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │   PostgreSQL db-llm-gateway │  (Hyperdrive)
                    └─────────────────────────────┘
```

- **Data plane (public):** endpoint OpenAI-compatible (`/v1/chat/completions`, `/v1/completions`, `/v1/models`, `/v1/embeddings`), streaming SSE. Stateless, không query admin config per request ngoài cached snapshot.
- **Control plane (internal):** admin API quản lý API key, quota policy, alias/routing, pricing, provider endpoint, audit. Truy cập qua Service Binding (không public Internet) — caller phải auth ở app layer + tắt `workers_dev`.
- **Boundary:** data plane không thực hiện mutation admin; control plane không nằm trên hot path inference.

## Application-specific execution state

`llm-api` duy trì **execution state** riêng của mình, khác domain state:

- **Execution journal**: mỗi logical request và attempt được ghi bền: `request_id`, `reservation_id`, alias, resolved model, routing snapshot version, endpoint, start/end time, evidence, usage, và ba tham chiếu attribution theo attempt `offer_ref`/`seller_tenant_ref`/`pricing_snapshot_ref` (ADR-0028 §8). Journal là nguồn cho reconciliation, correction, và post-incident analysis. Không log prompt/response body.
- **Durable dispatch intent record**: `request_id`, `tenant_id`, `reservation_id`, snapshots, attempt plan.
- **Attempt record**: `attempt_id`, `request_id`, endpoint, model, start time, evidence.
- **Routing config durable state** trong `db-llm-gateway`: alias, routing policy, candidate set (runtime view).

Execution state không tự động trở thành domain state chỉ vì được persist vào database. Domain state (ví dụ: `ExecutionEvidence`, `LogicalRequestStatus`) định nghĩa ở `llm-inference` domain model; `llm-api` chỉ persist và enforce.

## Persistence implementation

- Database `db-llm-gateway`, PostgreSQL, TimescaleDB nếu cần cho usage time-series. Migration expand → compatible rollout → contract.
- Database `db-llm-tenant`, PostgreSQL, schema `llm_tenant` (tên database/schema giữ nguyên lịch sử; bounded context là `llm-consumer-tenant`). Storage owner duy nhất là `llm-api`.
- Ba-role pattern `ecoma_owner` / `ecoma_llm_tenant_migrator` / `ecoma_llm_tenant_runtime`, chặn chéo `REVOKE CONNECT`, Hyperdrive riêng query cache OFF.
- Migration từ CI runner với advisory lock; Worker không DDL.
- Hyperdrive binding tới `db-llm-gateway` (Worker path bắt buộc Hyperdrive).

## Request lifecycle

Admission → auth API key → resolve alias/model → eligibility + strategy + snapshot → reserve quota durable → financial admission theo giá offer đã resolve (ADR-0028 §5) → create logical request record (snapshot bound) → dispatch provider attempt → streaming → settle/release quota → write usage → logical request completion (completed | failed | cancelled terminal).

- Reserve durable ngay khi giữ quota (A7). Không fallback KV làm sai quota.
- Admission fail (auth/quota) → trả lỗi ngay, không dispatch, không tạo attempt.
- Idempotent theo `reservation_id`.
- Logical request charged once, dù nhiều attempt.

## Retry/fallback classification

Bốn trạng thái evidence (sở hữu bởi `llm-inference` domain model):

| Evidence                 | Nghĩa                             | Retry?            |
| ------------------------ | --------------------------------- | ----------------- |
| `not_sent`               | Chưa gửi tới provider             | Có                |
| `may_have_executed`      | Có thể đã thực thi, chưa xác nhận | Không blind retry |
| `confirmed_completed`    | Provider xác nhận hoàn tất        | Không (đã xong)   |
| `confirmed_not_executed` | Provider xác nhận không thực thi  | Có                |

Quyền retry do `llm-inference` quyết định qua một luật duy nhất; adapter và routing không được tự suy ra. Chi tiết và ma trận evidence → [`docs/domains/llm-inference/domain-model.md`](../../domains/llm-inference/domain-model.md) §4, §6.

## Streaming semantics

- Proxy stream provider → client; không transparent switch sau khi stream bytes.
- SSE keepalive ≤ 30 s, không im lặng > 60 s (invariant 19).
- Client disconnect: logical request có thể tiếp tục hoặc cancel tuỳ policy; settlement theo provider result, không theo client connection. Disconnect là fact kết nối, không phải bằng chứng provider dừng và không phải cancellation; policy "tiếp tục hay cancel" chưa chốt (`docs/domains/llm-inference/domain-model.md` §12, U-2).
- Partial output không leak; stream kết thúc cleanly.

## Quota admission

Reserve durable ngay khi giữ quota (A7). Không fallback KV làm sai quota. Admission fail (auth/quota) → trả lỗi ngay, không dispatch, không tạo attempt. Idempotent theo `reservation_id`.

## Budget reservation & leases (financial)

Theo `llm-financial` domain model:

- **Budget escrow:** tiền earmark cho consumer trong khoảng thời gian.
- **Budget lease:** cấp consumer/key ngân sách liên tục (amount per window) với `epoch`/`fencing_token`. Admission financial dùng bounded escrow/leases + local atomic admission; **không** gọi DB/coordinator per inference request.
- **Reservation (financial):** giữ tiền trong wallet (escrow): `available -= amount; held += amount`. Idempotent theo `reservation_id`.
- **Phân biệt reservation ID:** quota reservation và financial reservation dùng **hai ID khác nhau** (quota `reservation_id` ≠ financial `reservation_id`); execution journal liên kết cả hai qua `request_id`. Không dùng một ID chung để đánh tráo hai loại reservation.
- **Capture** khi dùng: `held -= amount; charged += amount`. **Release** khi unused.
- Lease expiry không chứng minh gateway cũ dừng tiêu → cần fencing epoch/token + reconciliation trước reallocation.
- Escrow conservation: `available + held + charged = total` per wallet (total = tổng tiền đã nạp; release trả vào available, capture chuyển held → charged).

## Usage processing handoff

- Usage measurement (đo lường) ≠ financial charge (tính tiền). Usage là dữ liệu đo lường; charge là quyết định tài chính.
- Normalization deterministic + versioned (bump version khi thay normalizer).
- Token categories: `input_tokens`, `output_tokens`, `cached_tokens` (≤ input), `reasoning_tokens`.
- Missing/malformed provider usage → ghi `usage_status = missing/malformed`, không silently coi là 0; alert + reconcile.
- Request-level usage = cơ sở cho settlement/charge. Attempt-level = audit/reconciliation.
- Idempotent theo `reservation_id` (request-level) và `(attempt_id, correction_id)`.

## Financial correctness

- Double-entry ledger: mọi transaction debit = credit.
- Non-negative balance (trừ overdraft được cấp phép rõ ràng).
- Settlement idempotent theo `reservation_id`: không duplicate charge.
- Customer charge = f(usage, customer price, discount); khác provider cost (chi phí thực) và seller payable.
- Seller payable ≠ payout (payout có thể delay/adjustment).
- Reconciliation: đối soát `llm-financial` ledger, `payment` ledger, `llm` usage/reservation, provider invoice. Mismatch → alert + audit, không tự sửa số liệu.
- Customer charge tính từ customer price (seller-configured, `llm-seller-pricing`) trừ discount/fee; provider cost là đại lượng độc lập, ownership/source chưa chốt (`docs/domains/open-boundaries.md` OB-7).

## Failure model

- **PostgreSQL down:** fail closed cho request mới (503 + Retry-After); stream đang chạy hoàn tất → settlement debt. Không circuit-breaker để phục vụ khi settlement không bền.
- **Provider failure:** retry/fallback theo evidence; `may_have_executed` không blind retry.
- **Client disconnect:** settlement theo provider result.
- **Missing usage:** không block completion nếu policy cho phép; ghi durable + alert.
- **No-candidate:** trả lỗi tường minh, không dispatch, release reservation nếu đã reserve.

## Observability

- Correlation ID xuyên client → Worker → provider → DB.
- Metrics: auth failure, backend error, quota conservation violation (`settled + active_reservation > grant` — lỗi correctness), settlement backlog age, unsettled usage, 5xx ratio, stream keepalive.
- Không log prompt/response body; chỉ metadata.
- Telemetry không bao giờ là production dependency.

## Runtime/deployment boundary

- **Runtime:** Rust high-performance (WASM/Worker) cho data plane; control plane có thể Rust hoặc TypeScript. PostgreSQL authoritative; Hyperdrive cho Worker (query cache OFF).
- **Database:** `db-llm-gateway`, PostgreSQL, TimescaleDB nếu cần cho usage time-series. Migration expand → compatible rollout → contract.
- **Secrets:** native Worker Secrets theo env; không vào Git/PR/Preview.
- Một Cloudflare account mọi env; secrets use native Worker Secrets and deployment environment mechanisms.

## Documents

| Document                                     | Nội dung                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| [`README.md`](./README.md)                   | Ứng dụng `llm-api`, composition mapping, persistence, execution state, lifecycle |
| [`01-architecture.md`](./01-architecture.md) | Service design, boundary, runtime, data, dependencies, composition mapping       |
| [`02-requirements.md`](./02-requirements.md) | Functional/non-functional requirements và non-goals của deploy unit              |
| [`03-operations.md`](./03-operations.md)     | Deployment, configuration, monitoring, failure, recovery, runbook                |

## Cross-reference

- Domain specs composed/consumed: [`llm-inference`](../../domains/llm-inference/README.md), [`llm-consumer-routing`](../../domains/llm-consumer-routing/README.md), [`llm-usage`](../../domains/llm-usage/README.md), [`llm-seller-pricing`](../../domains/llm-seller-pricing/README.md), [`llm-financial`](../../domains/llm-financial/README.md), [`llm-consumer-tenant`](../../domains/llm-consumer-tenant/README.md), [`llm-marketplace`](../../domains/llm-marketplace/README.md), [`llm-seller-governance`](../../domains/llm-seller-governance/README.md).
- System-level boundary/data ownership → [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) §2, §4, §8 (A7, A9), §9 invariants 16, 19.
- Operations system-level → [`docs/architecture/03-operations.md`](../../architecture/03-operations.md).
