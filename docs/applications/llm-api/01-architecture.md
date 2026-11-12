# llm-api — 01 Architecture

> Phạm vi: service design của deploy unit `llm-api` (control plane + data plane), boundary, runtime, data, dependencies, composition mapping. Target architecture.
> Yêu cầu → [`02-requirements.md`](./02-requirements.md) · vận hành → [`03-operations.md`](./03-operations.md) · system-level → [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) · domain specs → [`docs/domains/llm-*`](../../domains/README.md).

---

## 1. Purpose & boundary

`llm-api` là **gateway suy luận LLM** công khai tại `api.ecoma.io/llm`. Nó là **quota authority và settlement authority** (A7, invariant 16): mọi `reserve` ghi bản ghi bền ngay khi giữ quota; `settle`/`release` quota idempotent theo quota `reservation_id`. PostgreSQL (`db-llm-gateway`) là nguồn sự thật duy nhất cho quota/usage/reservation/settlement.

**`llm-api` không sở hữu bất kỳ bounded context nào.** Nó host implementation của một số context bên trong deploy unit và tiêu thụ các context khác qua contract. Domain ownership luôn thuộc `docs/domains/*/domain-model.md`; `llm-api` chỉ triển khai runtime, persistence và enforcement, và pointer tới domain model khi cần business semantics.

**Sở hữu (runtime/persistence, không phải domain ownership):** API key, quota, usage, reservation, settlement, routing config, alias, pricing snapshot, provider endpoint pool (runtime view), execution journal, financial budget escrow/lease (theo `llm-financial`).

**Không sở hữu:** tenant/membership/workspace (→ `llm-consumer-tenant`), Seller tenant/ownership/membership/grant (→ `llm-seller-tenant`), restriction/appeal/verification/legal-tax profile/operational eligibility verdict (→ `llm-seller-governance`), seller offer/catalog/upstream endpoint canonical (→ `llm-marketplace`), ledger credit/payment (→ `payment`), payout workflow (→ `payout`), danh tính account (→ `account`).

---

## 2. Composition mapping — BC composed vs accessed via contract

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

---

## 3. Public API surfaces & planes

Hai plane trong cùng deploy unit:

```text
                    ┌─────────────────────────────┐
Client ──► public ──► │       Data Plane           │  (hot path, /llm/v1/...)
                    │  TS  high-perf runtime      │
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

---

## 4. Request lifecycle (Mermaid sequence)

```mermaid
sequenceDiagram
  participant C as Client
  participant DP as Data Plane (llm-api)
  participant PG as PostgreSQL
  participant PA as Provider Adapter
  participant P as Provider

  C->>DP: POST /v1/chat/completions (Bearer API key)
  DP->>DP: authenticate API key (cached + DB verify)
  DP->>DP: resolve alias/model + eligibility + strategy (routing snapshot)
  DP->>PG: reserve quota (durable, idempotent theo quota reservation_id)
  PG-->>DP: reservation OK
  alt lease-local admission (lease còn cover - ADR-0028 §5)
    DP->>DP: local atomic admission, giữ amount ước tính (decisioning - không DB call, không durable wallet hold)
  else lease hết cover
    DP->>PG: durable financial reserve, giữ amount ước tính (idempotent theo financial reservation_id - đường durable reserve)
    PG-->>DP: reserve OK
  end
  DP->>PG: persist attempt record + admission provenance (amount đã giữ, admission mode, lease_ref hoặc financial reservation identity - ngoại lệ ghi bền duy nhất trước dispatch, ADR-0028 §5)
  PG-->>DP: journal OK
  DP->>DP: create logical request record (snapshot bound)
  DP->>PA: dispatch attempt (endpoint selected)
  PA->>P: HTTP request
  alt streaming
    P-->>PA: SSE stream
    PA-->>DP: proxy stream
    DP-->>C: SSE stream (keepalive <=30s)
  else non-stream
    P-->>PA: response
    PA-->>DP: result + usage
    DP-->>C: response
  end
  DP->>PG: settle/release quota (once per quota reservation_id)
  DP->>PG: financial settle/capture (once per financial admission identity)
  DP->>PG: write usage (request-level + attempt-level)
```

Financial admission fail ⇒ release quota reservation (idempotent), trả lỗi ngay, không dispatch — trình tự admission canonical và đường compensation đầy đủ nằm ở §11.

Terminal state: `completed` / `failed` / `cancelled`. Sau terminal không có attempt mới. Charge một lần per logical request.

---

## 5. Provider adapters

- Mỗi provider một adapter chuẩn hoá request shape, auth, streaming protocol, error mapping, và **execution evidence** classification.
- Adapter trả evidence cho mỗi attempt: `not_sent` / `may_have_executed` / `confirmed_completed` / `confirmed_not_executed`.
- Provider-specific usage format được chuẩn hoá ở `llm-usage` normalizer (versioned), không ở adapter.
- Adapter không log prompt/response body (privacy).

---

## 6. Model selection & endpoint selection

- **Alias resolution** trong admission: alias → model/capability. Không thay đổi sau dispatch.
- **Eligibility gate** trước strategy: active, capability match, health, quota/policy, tenant scope.
- **Strategy:** priority / round-robin / lowest customer price / weighted. Chỉ chọn trong tập eligible.
- **Endpoint selection:** availability, capability, health, policy. Không transparent switch giữa chừng request.

---

## 7. Routing strategies & fallback

```mermaid
flowchart TD
  A[Alias resolve] --> B[Eligibility gate]
  B -->|empty| NC[no_candidate error]
  B -->|eligible set| S[Strategy selection]
  S --> D[Dispatch attempt]
  D -->|success| OK[completed]
  D -->|fail + evidence allows| EF[Endpoint fallback]
  EF --> FAE[Financial admission attempt mới - identity request_id,attempt_id - snapshot giữ nguyên - ADR-0028 §7.4.7]
  FAE -->|ok| D
  FAE -->|rejected| FC[fail closed - no dispatch]
  D -->|endpoint exhausted| OF[Offer fallback]
  OF --> RA[Financial re-admission - snapshot mới cho offer thay thế - ADR-0028 §7.4]
  RA -->|ok| D
  RA -->|rejected| FC[fail closed - no dispatch]
  D -->|all exhausted| FE[fallback_exhausted]
  D -->|may_have_executed| STOP[no blind retry - escalate]
```

- **Endpoint fallback** (cấp 1) và **Offer fallback** (cấp 2). Thứ tự: endpoint trước, rồi offer.
- Fallback chỉ khi routing còn candidate **và** `llm-inference` cho phép execution tiếp tục; `may_have_executed` → không retry tự động.
- **Financial re-admission khi fallback đổi offer (ADR-0028 §7.4):** attempt thay thế resolve snapshot giá mới cho chính offer đó rồi financial admission lại; offer thay thế **không kế thừa** giá offer gốc; thiếu UC cho giá mới ⇒ fail closed — không dispatch, không tạo attempt thay thế; evidence của attempt gốc giữ nguyên giá trị đã ghi.
- **Financial admission per attempt — kể cả endpoint fallback (ADR-0028 §7.4.7):** attempt thay thế cùng offer vẫn mang financial admission identity mới từ `(request_id, attempt_id)` — lease-local re-check hoặc durable reserve; snapshot giữ nguyên vì bind theo request–offer; dispatch chỉ xảy ra sau khi attempt record của attempt đó ghi bền (§11, §13). Financial reservation của attempt hụt được release khi evidence chốt `not_sent`/`confirmed_not_executed`, và **release-xong-rồi-admit** là trình tự mặc định — không giữ hai hold song song cho cùng logical request (ADR-0028 §7.4.8).
- Không transparent provider switch sau khi đã stream bytes.

---

## 8. Pricing snapshots

- Pricing là versioned snapshot bound tại admission.
- Pricing change sau admission không alter admitted request price.
- Snapshot bind theo cặp request–offer: fallback đổi offer resolve snapshot mới cho offer thay thế (ADR-0028 §7.4); schedule change vẫn không alter giá đã admit.
- Customer price dùng cho strategy "lowest customer price" và charge calculation.
- Pricing snapshot persist cùng logical request record (audit/replay).

---

## 9. Retry/fallback classification

Bốn trạng thái evidence (sở hữu bởi `llm-inference` domain model):

| Evidence                 | Nghĩa                             | Retry?            |
| ------------------------ | --------------------------------- | ----------------- |
| `not_sent`               | Chưa gửi tới provider             | Có                |
| `may_have_executed`      | Có thể đã thực thi, chưa xác nhận | Không blind retry |
| `confirmed_completed`    | Provider xác nhận hoàn tất        | Không (đã xong)   |
| `confirmed_not_executed` | Provider xác nhận không thực thi  | Có                |

Adapter không chắc → `may_have_executed` (fail-safe). Timeout giữa dispatch và response → `may_have_executed` trừ khi provider trả xác nhận not-executed. HTTP status không phải evidence: chỉ semantics của provider mới chứng minh `confirmed_not_executed`.

Quyền retry do `llm-inference` quyết định qua một luật duy nhất; adapter và routing không được tự suy ra. Chi tiết và ma trận evidence → [`docs/domains/llm-inference/domain-model.md`](../../domains/llm-inference/domain-model.md) §4, §6.

---

## 10. Streaming semantics

- Proxy stream provider → client; không transparent switch sau khi stream bytes.
- SSE keepalive ≤ 30 s, không im lặng > 60 s (invariant 19).
- Client disconnect: logical request có thể tiếp tục hoặc cancel tuỳ policy; settlement theo provider result, không theo client connection. Disconnect là fact kết nối, không phải bằng chứng provider dừng và không phải cancellation; policy "tiếp tục hay cancel" chưa chốt (`docs/domains/llm-inference/domain-model.md` §12, U-2).
- Partial output không leak; stream kết thúc cleanly.

---

## 11. Quota admission (Mermaid)

**Trình tự admission canonical của request-flow** — mọi diagram khác của request lifecycle (§4, §7, §21, README) phản ánh cùng lifecycle này hoặc trỏ về đây:

```mermaid
flowchart TD
  R[Request] --> A[Auth API key]
  A -->|fail| E1[401/403]
  A -->|ok| RS[Resolve alias/model]
  RS --> EL[Eligibility + strategy + snapshot]
  EL --> Q[Reserve quota durable]
  Q -->|insufficient| E2[429 quota exceeded]
  Q -->|ok| FA[Financial admission - theo giá offer đã resolve]
  FA -->|insufficient| RQ[Release quota reservation - idempotent]
  RQ --> E3[Financial admission rejected - fail closed - không dispatch - HTTP mapping Delivery]
  FA -->|ok| AR[Persist attempt record + provenance - trước dispatch]
  AR --> LR[Create logical request + bind snapshot]
  LR --> D[Dispatch]
```

- Reserve durable ngay khi giữ quota (A7). Không fallback KV làm sai quota.
- **Hai định danh độc lập (ADR-0028 §5):** quota reservation (giữ tài nguyên, A7) và financial reservation (giữ tiền) là hai bản ghi của hai authority, **hai ID riêng** — không có `reservation_id` generic; correlation qua `request_id`, financial admission identity của mỗi attempt tất định từ `(request_id, attempt_id)` — identity tồn tại trên **cả hai đường admission**, còn financial `reservation_id` chỉ được tạo trên đường durable reserve (lease-local không tạo durable wallet hold per request); execution journal ghi cả hai.
- **Financial admission (ADR-0028 §5):** sau khi snapshot giá đã resolve, trước dispatch; giữ **amount trần trên** của attempt suy từ hai bound độc lập đều bắt buộc — `input_token_bound` và `output_token_bound` (`max_tokens` chỉ là bound output; công thức trần trên theo ADR-0028 §5) — với rate tối đa applicable theo snapshot của offer sẽ phục vụ; không amount thì không admission; budget lease còn cover ⇒ local atomic admission (không DB call cho decisioning trên đường lease-local, §12), không cover (ví dụ fallback sang offer đắt hơn) ⇒ durable financial reserve. Financial admission **không có partial admit**; capture ≤ amount đã giữ — usage vượt estimate ⇒ charge capped + alert + reconciliation (ADR-0028 §5).
- **Persist attempt record trước dispatch (ADR-0028 §5, §13):** attempt record mang financial admission provenance — `request_id`, `attempt_id`, admission mode (`lease-local`/`durable-reserve`), amount đã giữ, `lease_ref` khi lease-local, financial reservation identity khi durable reserve — ghi bền **trước dispatch**; đây là ngoại lệ ghi bền duy nhất của luật "không DB call" (luật đó áp cho admission decisioning, không áp cho bước persist này). Không attempt record bền ⇒ không dispatch.
- **Compensation bắt buộc:** financial admission từ chối ở bất kỳ lý do nào ⇒ **release quota reservation idempotent** (cùng quota `reservation_id`) trước khi trả lỗi — quota không bao giờ ở lại giữ mãi sau một request không được phục vụ; admission bị từ chối không tạo durable financial reservation nào. Trình tự đảm bảo dispatch chỉ xảy ra sau khi cả hai admission OK, nên tại thời điểm release chắc chắn chưa có attempt nào ⇒ release an toàn, không cần bằng chứng provider.
- **Compensation mode-specific (ADR-0028 §5):** durable reserve OK mà journal write hay dispatch preparation fail ⇒ không dispatch — release financial reservation theo financial reservation identity của nó và release quota theo quota `reservation_id`, cả hai idempotent; release fail ⇒ giữ hold theo retry/reconciliation hiện hành. Lease-local admission OK mà attempt journal persist fail ⇒ không dispatch, release quota reservation; **không có** durable wallet hold per request nào để release — allocation chỉ hoàn qua holder-local restore khi outcome chắc chắn (lease-local semantics hiện hành) hoặc fencing + reconciliation (§12), không bao giờ reclaim khi stale holder còn có thể tiêu.
- **Uncertain commit:** financial admission commit mà response mất ⇒ replay cùng financial admission identity trả kết quả gốc (idempotent, không double-reserve); nếu request bị bỏ ⇒ release cùng identity — ledger nhất quán ở cả hai nhánh.
- **Idempotency phân loại:** quota admission idempotent theo quota `reservation_id` — **suy tất định từ `request_id`**; client retry chỉ replay admission khi caller cấp lại cùng `request_id`, request không kèm cùng `request_id` là request mới (surface OpenAI-compatible không có idempotency key HTTP). Replay cùng `request_id` sau khi request đã terminal (`completed`/`failed`) **không mở reserve mới** — quota reservation đã settle/release; client phải dùng `request_id` mới cho request thật sự mới. Financial admission idempotent theo financial admission identity `(request_id, attempt_id)` — hai khoá độc lập, không đánh tráo.
- Admission fail ở bước nào (auth/quota/financial) → trả lỗi ngay, không dispatch, không tạo attempt.

---

## 12. Budget reservation & leases (financial)

Theo `llm-financial` domain model:

- **Budget escrow:** tiền earmark cho consumer trong khoảng thời gian.
- **Budget lease:** cấp consumer/key ngân sách liên tục (amount per window) với `epoch`/`fencing_token`. Admission financial dùng bounded escrow/leases + local atomic admission — **đường lease-local không gọi DB/coordinator per request cho admission decisioning**; đường durable reserve là một DB call tường minh per request thiếu lease coverage (§11). Ngoại lệ ghi bền duy nhất là attempt record + provenance ghi bền trước dispatch (§13) — bước pipeline riêng, không thuộc decisioning.
- **Lease-local là decisioning, không phải kế toán:** local admission không tạo bản ghi kế toán per request, không tạo durable wallet hold per request và không thay thế settlement — kế toán durable xảy ra tại settlement/capture với khoá tất định từ financial admission identity `(request_id, attempt_id)` của attempt được phục vụ; `lease_ref` giữ làm provenance/fencing (`llm-financial` §6); crash giữa admission và settlement ⇒ settlement debt (kế toán trễ, không mất); exposure bound bởi lease amount × window; lease chết chỉ hoàn unused về `available` sau fencing + reconciliation (`llm-financial` §6). Local admission không bao giờ được đọc thành "đã đủ accounting".
- **Reservation (financial):** giữ tiền trong wallet — durable wallet hold `available -= amount; held += amount` (khác budget escrow vốn earmark nguồn cấp lease). Idempotent theo financial `reservation_id` riêng — chỉ tồn tại trên đường durable reserve, khác quota `reservation_id`, correlation qua `request_id` (ADR-0028 §5).
- **Nguồn funding wallet:** deposit từ `payment` hoặc sponsor grant có funding authorization với trần sponsor + per-billing-account — kiểm tại thời điểm cấp trong `llm-financial` (ADR-0028 §4–§5); admission chỉ tiêu số dư `available`, không có bypass cho tenant `first_party`.
- **Phân biệt reservation ID:** quota reservation và financial reservation dùng **hai ID khác nhau** (quota `reservation_id` ≠ financial `reservation_id`); execution journal liên kết cả hai qua `request_id`. Không dùng một ID chung để đánh tráo hai loại reservation.
- **Capture** khi dùng: `held -= charge; charged += charge` với `charge ≤ amount admission đã giữ` (phần thừa `held → available`; usage vượt estimate ⇒ charge capped + alert — ADR-0028 §5). **Release** khi unused.
- Lease expiry không chứng minh gateway cũ dừng tiêu → cần fencing epoch/token + reconciliation trước reallocation.
- Escrow conservation: `available + held + charged = total` per wallet (total = tổng tiền đã nạp; release trả vào available, capture chuyển held → charged).

---

## 13. Execution journal

- Mỗi logical request và attempt được ghi bền: `request_id`, quota `reservation_id` + financial admission identity (hai định danh độc lập, §11), **admission mode** (`lease-local`/`durable-reserve`), **amount financial admission đã giữ**, financial reservation identity (khi đường durable reserve), alias, resolved model, routing snapshot version, endpoint, start/end time, evidence, usage.
- Mỗi attempt ghi thêm `offer_ref`, `seller_tenant_ref`, `pricing_snapshot_ref` của chính attempt đó (ADR-0028 §8) — điều kiện tái dựng giá và seller obligation per-attempt khi một logical request đi qua nhiều offer.
- Attempt record + attribution (gồm `lease_ref` khi admission qua lease) ghi bền **trước dispatch** — điều kiện dispatch; settlement-debt recovery tái dựng được định danh settlement tài chính từ `(request_id, attempt_id)` trong attempt record sau crash, và `lease_ref` cùng bản ghi cấp provenance/fencing cho lease reconciliation (ADR-0028 §5). Đây là ngoại lệ ghi bền duy nhất trước dispatch trên cả hai đường — luật "không DB call" của §12 áp cho admission decisioning, không áp cho bước persist này.
- Attempt-level usage phục vụ audit/reconciliation; không nhân lên charge.
- Journal là nguồn cho reconciliation, correction, và post-incident analysis.
- Không log prompt/response body.

---

## 14. Usage processing handoff

- Usage measurement (đo lường) ≠ financial charge (tính tiền). Usage là dữ liệu đo lường; charge là quyết định tài chính.
- Normalization deterministic + versioned (bump version khi thay normalizer).
- Token categories: `input_tokens`, `output_tokens`, `cached_tokens` (≤ input), `reasoning_tokens`.
- Missing/malformed provider usage → ghi `usage_status = missing/malformed`, không silently coi là 0; alert + reconcile.
- Request-level usage = cơ sở cho settlement/charge. Attempt-level = audit/reconciliation.
- Idempotent theo quota `reservation_id` (request-level — suy tất định từ `request_id`) và `(attempt_id, correction_id)` (attempt-level correction).

---

## 15. Financial correctness

- Double-entry ledger: mọi transaction debit = credit.
- Non-negative balance (trừ overdraft được cấp phép rõ ràng).
- Settlement idempotent theo định danh settlement tài chính: không duplicate charge (§11 — hai định danh reservation độc lập).
- Customer charge = f(usage, customer price, discount); khác provider cost (chi phí thực) và seller payable.
- Seller payable ≠ payout (payout có thể delay/adjustment).
- Seller payable chỉ accrue cho seller có nghĩa vụ settle thật — seller **không** liên kết `FirstPartyLegalPrincipal` Ecoma-io (bất kể trạng thái principal — trạng thái chỉ điều khiển serving eligibility, ADR-0027 §5); seller first-party không accrue payable, không EC, không payout (ADR-0028 §7.1).
- Reconciliation: đối soát `llm-financial` ledger, `payment` ledger, `llm` usage/reservation, provider invoice. Mismatch → alert + audit, không tự sửa số liệu.
- Customer charge tính từ customer price (seller-configured, `llm-seller-pricing`) trừ discount/fee; provider cost là đại lượng độc lập, ownership/source chưa chốt (`docs/domains/open-boundaries.md` OB-7).

---

## 16. Failure model

- **PostgreSQL down:** fail closed cho request mới (503 + Retry-After); stream đang chạy hoàn tất → settlement debt. Không circuit-breaker để phục vụ khi settlement không bền.
- **Financial admission fail sau khi quota reserved:** release quota reservation idempotent (§11), trả lỗi, không dispatch. Không rò rỉ quota.
- **Release quota reservation fail** (ví dụ PG down ngay sau financial rejection): quota reservation giữ trạng thái active; release được retry, và reconciliation sweep hoàn các quota reservation không có logical request ở trạng thái admitted — sweep áp cho **cả** financial reservation không có execution-journal record tương ứng (replay release theo financial admission identity), với tiền điều kiện age threshold + đối chiếu journal linkage — **journal linkage** nghĩa là bản ghi attempt/dispatch intent của attempt đó trong execution journal (§13); bản ghi quá trẻ chưa đủ căn cứ; sweep báo alert, không tự xoá bản ghi; không có provider uncertainty vì chưa từng dispatch. Gateway stall giữa financial-admission commit và logical-record write không phân biệt được với crash — mô hình Worker execution (request không sống lâu) + age threshold giữ cửa sổ sai lệch đó bounded.
- **Fail-closed kết thúc (financial rejected / fallback exhausted):** logical request vào terminal `failed`; mọi reservation của request được release theo bằng chứng chưa-executed — không có dispatch intent trong journal **hoặc** evidence `confirmed_not_executed` — không reservation nào sống sót qua terminal. MVP chưa có bề mặt cancel request (`cancelled` là terminal reserved); nếu tương lai thêm bề mặt đó, `cancelled` phải release mọi reservation theo cùng luật fail-closed này.
- **Release financial fail giữa chừng trên request vẫn chạy tới `completed`:** sweep không áp dụng (attempt đã có journal linkage); backstop là reconciliation alert (`01-architecture.md` §15) — hold còn lại bounded tại amount admission đã giữ, không mất tiền, xử lý theo quyết định tương lai (ADR-0028 §13).
- **Financial admission commit mà response mất:** replay cùng financial admission identity trả kết quả gốc; request bị bỏ ⇒ release cùng identity (§11).
- **Crash sau admission, trước dispatch:** recovery đọc execution journal — đường durable reserve: chưa có attempt ⇒ evidence `not_sent` ⇒ release cả hai reservation (financial reservation theo financial reservation identity của nó, quota theo quota `reservation_id`); đường lease-local: chỉ release quota reservation — không có durable financial reservation nào để release, allocation đã tiêu chỉ hoàn qua fencing + reconciliation (§12); an toàn vì dispatch chỉ xảy ra sau cả hai admission và attempt record bền.
- **Crash/uncertainty trên đường lease-local:** không attempt record ⇒ dispatch bị cấm bởi luật journal-before-dispatch — release quota, reclaim allocation theo fencing + reconciliation; attempt record có và evidence `not_sent`/`confirmed_not_executed` ⇒ release quota + reclaim allocation unused theo lease contract hiện hành; `may_have_executed` ⇒ không release dựa trên timeout hay process death — giữ bounded exposure theo evidence/reconciliation hiện hành; provider xác nhận thực thi ⇒ settlement capture theo định danh settlement tài chính (ADR-0028 §5 — compensation mode-specific).
- **Provider failure:** retry/fallback theo evidence; `may_have_executed` không blind retry.
- **Client disconnect:** settlement theo provider result.
- **Missing usage:** không block completion nếu policy cho phép; ghi durable + alert.
- **No-candidate:** trả lỗi tường minh, không dispatch, release reservation nếu đã reserve.

### Kịch bản thất bại của request lifecycle

| #   | Kịch bản                                      | Trạng thái sau sự kiện                                                                                                             | Kết quả kế toán                                                                                                                                                                                                                                                                                                                             | Idempotency                                                                                                 | Recovery                                                      |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| F1  | Quota reserved, financial admission từ chối   | Quota reservation active, chưa dispatch                                                                                            | Không charge; release quota reservation idempotent (§11)                                                                                                                                                                                                                                                                                    | Release theo quota `reservation_id`                                                                         | Release fail ⇒ sweep reconciliation (bullet trên)             |
| F2  | Financial admission commit, response mất      | Durable reserve đã commit                                                                                                          | Replay admission ⇒ kết quả gốc, không double-reserve; abort ⇒ release cùng identity                                                                                                                                                                                                                                                         | Financial admission identity `(request_id, attempt_id)`                                                     | Replay khi client retry; ledger nhất quán cả hai nhánh        |
| F3  | Quota release fail sau financial rejection    | Quota reservation active                                                                                                           | Không đổi; không rò rỉ — sweep reconciliation hoàn sau                                                                                                                                                                                                                                                                                      | Retry cùng quota `reservation_id`                                                                           | Sweep + alert                                                 |
| F4  | Dispatch không xảy ra sau cả hai admission OK | Đường durable reserve: hai reservation active; đường lease-local: quota reservation active, không có durable financial reservation | Đường durable reserve ⇒ release cả hai — bằng chứng `not_sent` đủ cho financial release; đường lease-local ⇒ chỉ release quota reservation, allocation đã tiêu hoàn qua fencing + reconciliation (§12)                                                                                                                                      | Same ids                                                                                                    | Chạy trên recovery                                            |
| F5  | Provider thực thi nhưng response mất          | `may_have_executed`                                                                                                                | Settle theo usage thật khi evidence chốt; usage không thu được ⇒ capture theo amount đã giữ + `usage_status = missing`, alert + reconcile; correction hạ khi usage xác định                                                                                                                                                                 | `settlement_id` tất định; không duplicate charge                                                            | Escalate, không blind retry, không attempt mới                |
| F6  | Crash sau lease-local admission               | Quota reservation durable; financial admission chỉ local (không durable wallet hold); lease allocation đã tiêu                     | Provider xác nhận thực thi ⇒ settlement debt, capture bền theo định danh settlement tài chính (ADR-0028 §5); `not_sent`/`confirmed_not_executed` (hoặc không attempt record) ⇒ release quota reservation — không settlement, không có durable financial reservation nào để release; `may_have_executed` ⇒ không release/reclaim, escalation | Capture tất định từ financial admission identity `(request_id, attempt_id)`; `lease_ref` provenance/fencing | Lease chết: fencing + reconciliation trước reallocation (§12) |
| F7  | Duplicate request/retry capture hoặc release  | —                                                                                                                                  | Một capture/release per định danh của nó — quota theo quota `reservation_id`, financial theo financial admission identity; dư thừa bị chặn                                                                                                                                                                                                  | Replay ⇒ kết quả gốc; khác payload ⇒ `idempotency_conflict`                                                 | —                                                             |
| F8  | Lease hết hạn còn dư allocation               | Lease `expired`; gateway cũ có thể còn tiêu với epoch cũ                                                                           | Unused **không** auto-return: fencing (`observedEpoch > lease.epoch`) + reconciliation, rồi `revokeLease`/`closeEscrow` mới hoàn `available`                                                                                                                                                                                                | Epoch fencing                                                                                               | Reallocation chỉ sau reconciliation (`llm-financial` §6)      |

---

## 17. Observability

- Correlation ID xuyên client → Worker → provider → DB.
- Metrics: cache hit/miss (n/a), auth failure, backend error, quota conservation violation (`settled + active_reservation > grant` — lỗi correctness), settlement backlog age, unsettled usage, 5xx ratio, stream keepalive.
- Không log prompt/response body; chỉ metadata (xoá sau 90 ngày).
- Telemetry không bao giờ là production dependency.
- Axiom dataset tách theo env; traceparent xuyên hop.

---

## 18. Runtime/deployment boundary

- **Runtime:** TypeScript (Hono + pg qua Hyperdrive) cho data plane; control plane chưa dựng, có thể Rust hoặc TypeScript. PostgreSQL authoritative; Hyperdrive cho Worker (query cache OFF).
- **VPS runtime (nếu có):** direct connection approved topology cho runtime ngoài Worker (không bắt buộc Hyperdrive); nhưng Worker path bắt buộc Hyperdrive. Một Cloudflare account mọi env.
- **Database:** `db-llm-gateway`, PostgreSQL, TimescaleDB nếu cần cho usage time-series. Migration expand → compatible rollout → contract.
- **Secrets:** native Worker Secrets theo env; không vào Git/PR/Preview.

---

## 19. Mermaid — provider fallback

```mermaid
sequenceDiagram
  participant DP as Data Plane
  participant EP as Endpoint 1
  participant EP2 as Endpoint 2 (fallback)
  participant P as Provider

  DP->>EP: attempt 1
  EP-->>DP: timeout (may_have_executed)
  DP->>DP: no blind retry (evidence blocks)
  Note over DP: escalate, no auto fallback

  DP->>EP: attempt (confirmed_not_executed)
  EP-->>DP: 5xx confirmed not executed
  DP->>EP2: endpoint fallback (explicit)
  EP2->>P: request
  P-->>EP2: response
  EP2-->>DP: result
```

---

## 20. Mermaid — streaming

```mermaid
sequenceDiagram
  participant C as Client
  participant DP as Data Plane
  participant P as Provider

  C->>DP: POST (stream=true)
  DP->>P: request
  P-->>DP: SSE chunk 1
  DP-->>C: SSE chunk 1
  P-->>DP: SSE chunk 2
  DP-->>C: SSE chunk 2 (keepalive <=30s)
  P-->>DP: [DONE]
  DP-->>C: [DONE]
  Note over DP: settle quota once (per quota reservation_id) + financial settle/capture (một lần per financial admission identity)
```

---

## 21. Mermaid — quota admission

Cùng lifecycle với trình tự admission canonical ở §11 (kèm financial admission và đường release khi financial admission từ chối):

```mermaid
flowchart TD
  Start[Request] --> Auth{Auth OK?}
  Auth -- no --> R401[401/403]
  Auth -- yes --> Resolve[Resolve alias/model]
  Resolve --> Elig[Eligibility gate]
  Elig -- empty --> NoCand[no_candidate]
  Elig -- ok --> Strat[Strategy select]
  Strat --> Reserve{Reserve quota?}
  Reserve -- no --> R429[429]
  Reserve -- yes --> FA{Financial admission?}
  FA -- no --> RQ[Release quota reservation - idempotent]
  RQ --> R402[Financial admission rejected - fail closed]
  FA -- yes --> AR[Persist attempt record + provenance - trước dispatch]
  AR --> LR[Logical request + snapshot]
  LR --> Dispatch[Dispatch]
```

---

## 22. Mermaid — financial reservation/settlement

```mermaid
sequenceDiagram
  participant DP as Data Plane
  participant W as Wallet (DB)
  participant L as Ledger

  DP->>W: reserve amount (idempotent theo financial reservation_id)
  W->>W: available -= amount, held += amount
  W-->>DP: reserved
  Note over DP: dispatch + stream (amount = ước tính tối đa đã giữ - ADR-0028 §5)
  DP->>W: settle usage
  W->>W: held -= charge, charged += charge (charge <= amount đã giữ, phần thừa held → available)
  W->>L: post charge entry (debit=credit)
  L-->>W: posted
  W-->>DP: settled (once per financial admission identity)
  Note over DP,W: unused financial reservation ⇒ release (held → available) chỉ khi có bằng chứng provider chưa thực thi, không release vì timeout
```

---

## 23. Invariants (service-level)

1. Quota/settlement authority ở PostgreSQL; không fallback KV (A7, invariant 16).
2. Logical request charged once, dù nhiều attempt.
3. No blind retry after possible execution.
4. No transparent provider switch after stream bytes.
5. Routing snapshot immutable per logical request.
6. Eligibility gate trước strategy.
7. SSE keepalive ≤ 30 s, no silence > 60 s.
8. Escrow conservation: `available + held + charged = total`.
9. Settlement idempotent theo định danh settlement tài chính — tất định từ financial admission identity `(request_id, attempt_id)` của attempt được phục vụ; quota settle/release idempotent theo quota `reservation_id` — hai định danh độc lập (§11).
10. Tenant/workspace id từ principal, không từ client input.

---

## 24. Tài liệu

| Document                                     | Nội dung                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| [`README.md`](./README.md)                   | Ứng dụng `llm-api`, composition mapping, persistence, execution state, lifecycle |
| [`01-architecture.md`](./01-architecture.md) | Service design, boundary, runtime, data, dependencies, composition mapping (này) |
| [`02-requirements.md`](./02-requirements.md) | Functional/non-functional requirements và non-goals của deploy unit              |
| [`03-operations.md`](./03-operations.md)     | Deployment, configuration, monitoring, failure, recovery, runbook                |
