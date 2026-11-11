# llm-api — 02 Requirements

> Functional/non-functional requirements và non-goals của deploy unit `llm-api`. Target architecture.

## 1. Functional requirements

### Admission & auth

- **FR-01:** Xác thực API key trước mọi xử lý; reject không hợp lệ với 401/403.
- **FR-02:** Resolve tenant/workspace từ authenticated principal, không từ client input.
- **FR-03:** Reserve quota durable theo quota `reservation_id` (idempotent) trước dispatch.
- **FR-04:** Admission fail (auth/quota/financial) trả lỗi ngay, không dispatch, không tạo attempt; financial admission fail kèm release quota reservation idempotent (ADR-0028 §5).

### Alias / routing

- **FR-05:** Resolve alias → model/capability trong admission; không thay đổi sau dispatch.
- **FR-06:** Eligibility gate trước strategy; strategy chỉ chọn trong tập eligible.
- **FR-07:** No-candidate trả lỗi tường minh (`no_candidate` vs `fallback_exhausted`).
- **FR-08:** Routing snapshot bind tại admission, immutable cho logical request; pricing snapshot bind theo cặp logical request–offer, fallback đổi offer resolve snapshot mới cho offer thay thế (ADR-0028 §7.4).

### Dispatch / provider

- **FR-09:** Dispatch tới provider đã chọn; ghi attempt record bền.
- **FR-10:** Provider adapter chuẩn hoá request/auth/streaming/error/evidence.
- **FR-11:** Streaming proxy provider→client; không transparent switch sau stream bytes.
- **FR-12:** Retry/fallback chỉ khi evidence cho phép; không blind retry sau `may_have_executed`.

### Usage & settlement

- **FR-13:** Ghi usage request-level và attempt-level (normalized + raw reference).
- **FR-14:** Settle/release quota một lần per quota `reservation_id`; financial settle/capture một lần per financial admission identity; capture ≤ amount admission đã giữ (ADR-0028 §5).
- **FR-15:** Logical request charged once dù nhiều attempt.
- **FR-16:** Missing/malformed provider usage ghi durable, không silently coi là 0.

### Financial

- **FR-17:** Financial admission là điều kiện dispatch (lease-local khi budget lease còn cover, durable reserve khi không), giữ amount ước tính tối đa của attempt (usage bound × applicable price); đường lease-local không gọi DB/coordinator per request.
- **FR-18:** Financial reservation idempotent theo financial `reservation_id` riêng — khác quota `reservation_id`, correlation qua `request_id` (ADR-0028 §5).
- **FR-19:** Reconciliation định kỳ + on-demand; mismatch alert + audit.

### Admin / control plane

- **FR-20:** Admin API quản lý API key, quota policy, alias/routing, pricing, provider endpoint, audit (qua Service Binding, không public).
- **FR-21:** Audit append-only cho mutation đặc quyền.

## 2. Non-functional requirements

- **NFR-01 (Performance):** Data plane Rust high-perf; streaming end-to-end không full-buffer.
- **NFR-02 (Availability):** Fail closed khi PG down; stream đang chạy hoàn tất.
- **NFR-03 (Consistency):** Quota conservation: `settled + active_reservation ≤ grant`.
- **NFR-04 (Privacy):** Không log prompt/response body.
- **NFR-05 (Compatibility):** Public API giữ OpenAI-compatible protocol; SSE keepalive ≤ 30 s.
- **NFR-06 (Idempotency):** `settle`/`release`/usage write idempotent.
- **NFR-07 (Observability):** Correlation ID xuyên hop; metrics quota/settlement/backlog.

## 3. Non-goals

- Không sở hữu tenant/membership/workspace (→ `llm-consumer-tenant`).
- Không sở hữu Seller tenant/ownership/membership/grant (→ `llm-seller-tenant`) hay eligibility/restriction verdict (→ `llm-seller-governance`).
- Không sở hữu seller offer/catalog/upstream endpoint canonical (→ `llm-marketplace`).
- Không sở hữu ledger credit/payment (→ `payment`) hay payout workflow (→ `payout`).
- Không implement authorization-result contract từ `staff-access` (catalog govern / backend enforce).
- Không transparent provider switch sau stream bytes.
- Không fallback KV làm sai quota.
- Không bootstrap credential chỉ sống trong failure domain.

## 4. Acceptance (high-level)

- Admission → dispatch → stream → settle round-trip với quota conservation invariant pass.
- Retry/fallback chỉ theo evidence; `may_have_executed` không blind retry.
- Missing usage không silent 0; alert fired.
- PG down → fail closed cho request mới; stream đang chạy hoàn tất.
- Reconciliation mismatch → alert + audit entry.
