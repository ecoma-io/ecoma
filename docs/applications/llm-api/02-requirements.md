# llm-api — 02 Requirements

> Functional/non-functional requirements và non-goals của deploy unit `llm-api`. Target architecture.

## 1. Functional requirements

### Admission & auth

- **FR-01:** Xác thực API key trước mọi xử lý; reject không hợp lệ với 401/403.
- **FR-02:** Resolve tenant/workspace từ authenticated principal, không từ client input.
- **FR-03:** Reserve quota durable theo `reservation_id` (idempotent) trước dispatch.
- **FR-04:** Admission fail (auth/quota) trả lỗi ngay, không dispatch, không tạo attempt.

### Alias / routing

- **FR-05:** Resolve alias → model/capability trong admission; không thay đổi sau dispatch.
- **FR-06:** Eligibility gate trước strategy; strategy chỉ chọn trong tập eligible.
- **FR-07:** No-candidate trả lỗi tường minh (`no_candidate` vs `fallback_exhausted`).
- **FR-08:** Routing snapshot bind tại admission, immutable cho logical request.

### Dispatch / provider

- **FR-09:** Dispatch tới provider đã chọn; ghi attempt record bền.
- **FR-10:** Provider adapter chuẩn hoá request/auth/streaming/error/evidence.
- **FR-11:** Streaming proxy provider→client; không transparent switch sau stream bytes.
- **FR-12:** Retry/fallback chỉ khi evidence cho phép; không blind retry sau `may_have_executed`.

### Usage & settlement

- **FR-13:** Ghi usage request-level và attempt-level (normalized + raw reference).
- **FR-14:** Settle/release quota một lần per `reservation_id`.
- **FR-15:** Logical request charged once dù nhiều attempt.
- **FR-16:** Missing/malformed provider usage ghi durable, không silently coi là 0.

### Financial

- **FR-17:** Budget escrow/lease admission không gọi DB/coordinator per request.
- **FR-18:** Financial reservation idempotent theo `reservation_id`.
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
