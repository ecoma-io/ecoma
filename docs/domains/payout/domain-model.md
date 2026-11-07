# Payout — Domain Model

Bounded context `payout`: seller payout request, payout quote, beneficiary/destination details, fiat disbursement, manual payout workflow (MVP), payout execution evidence, payout reconciliation.

> **Phạm vi:** chi trả cho seller. `payout` sở hữu payout request/quote/beneficiary/disbursement/evidence/reconciliation. `llm-financial` sở hữu EC và seller liability (accrued/settled/paid/adjusted). `payment` là gateway/execution adapter. Tài liệu này chứa **thuần business knowledge** của context — khái niệm, quy tắc nghiệp vụ, invariant, trạng thái và sự kiện domain. Nó không mô tả schema, HTTP endpoint, Worker hay chạy triển khai; những nội dung đó thuộc application layer (`docs/applications/`). ADR liên quan nằm ở [`adr/`](./adr/README.md).

## 1. Mục đích và ranh giới

| Sở hữu                                                                                                                                                                 | Không sở hữu                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payout request · payout quote · beneficiary/destination details · fiat disbursement · manual payout workflow (MVP) · payout execution evidence · payout reconciliation | EC/seller liability/ledger (→ `llm-financial`) · UC/EC balances · seller payable calculation/settlement · payment transaction canonical (→ `payment`) · tenant/membership (→ `llm-consumer-tenant`; Seller tenant/ownership/membership → `llm-seller-tenant`; restriction/verification và legal/tax profile → `llm-seller-governance`) |

- `payout` **không** trực tiếp chỉnh EC balance hay ledger entry. Mọi reservation/capture/release EC đi qua contract của `llm-financial`.
- `payment` là gateway/execution adapter cho fiat disbursement; `payout` orchestrate lifecycle và ghi evidence.
- **Non-goal của MVP:** không tích hợp automated payout provider — disbursement thực hiện thủ công (§4). Operator cũng không trực tiếp chỉnh EC balance để đánh dấu payout complete (§4).

## 2. Domain model

### 2.1 Aggregate root: PayoutRequest

- `id` (uuid), `seller_tenant_id`, `requested_by_sub`, `amount_minor`, `currency`, `status`, timestamps.
- Status: `requested → quoted → confirmed → reserved → executing → paid | failed_confirmed | execution_unknown | reconciliation_required | rejected | cancelled`.
- `reserved → cancelled` (cancel before execution; release EC reservation via `llm-financial`; only after confirmed release).
- Một request chuyển từ một Seller tenant sang một payout execution.
- `execution_unknown`: execution outcome chưa xác định (timeout/mất kết nối/provider không trả kết quả). **Không** release reservation chỉ vì timeout.
- `reconciliation_required`: cần reconciliation trước khi quyết định paid/failed.
- `failed_confirmed`: execution thất bại đã được xác nhận.
- `rejected`: request bị từ chối (authorization, hold, insufficient funds, invalid beneficiary).

### 2.2 Entity: PayoutQuote

- Immutable snapshot: amount, currency, FX rate + direction, spread policy/version, rounding policy, beneficiary snapshot/reference, creation time, expiry time, confirmation time, status.
- Server quote hard expiry: tối đa 5 phút từ thời điểm server tạo quote.
- Client confirmation window: 2 phút sau khi nhận quote (UX only; server clock authoritative).
- Expired quote **không** được sửa/extend ngầm; tạo quote mới và seller confirm lại.
- Khi seller confirm quote, backend **re-validate**: expiry, status, authorization, holds, available EC, idempotency và beneficiary.

### 2.2a Phân biệt PayoutRequest và PayoutQuote

- **PayoutRequest** quản lý lifecycle của yêu cầu payout (states ở §2.1).
- **PayoutQuote** quản lý một immutable quote revision (amount, currency, FX rate/direction, spread policy/version, rounding policy, beneficiary snapshot, created/expiry/confirmation timestamps, status).
- Quote hết hạn: chỉ PayoutQuote chuyển thành `expired`; PayoutRequest tiếp tục ở `quoted` và có thể tạo quote revision mới (seller phải confirm lại). Không có state `expired` trong PayoutRequest aggregate.

### 2.3 Entity: Beneficiary

- Destination details (bank account, recipient name, currency). Owned by `payout`; Seller context không sở hữu beneficiary và `llm-financial` chỉ tham chiếu như input. `seller_tenant_id` là tham chiếu tới Seller tenant do `llm-seller-tenant` sở hữu; legal/tax profile và restriction thuộc `llm-seller-governance`; payout không sở hữu Seller identity, legal/tax profile hay restriction.

### 2.4 State machines

- PayoutRequest: `requested → quoted → confirmed → reserved → executing → paid | failed_confirmed | execution_unknown | reconciliation_required | rejected | cancelled`.
- Quote: `active → confirmed | expired | cancelled`.

Allowed transitions (high-level):

- `requested → quoted` (create immutable quote).
- `quoted → confirmed` (seller confirms valid quote).
- `quoted → expired | cancelled`.
- `confirmed → reserved` (EC reservation acquired from `llm-financial`).
- `reserved → executing` (fiat disbursement started).
- `reserved → cancelled` (cancel before execution; idempotent release EC reservation via `llm-financial`; only after confirmed release; no concurrent disbursement).
- `executing → paid` (only after execution evidence recorded).
- `executing → failed_confirmed` (confirmed failure → release reservation).
- `executing → execution_unknown` (timeout/lost connection/ambiguous provider result).
- `execution_unknown → reconciliation_required` (always).
- `reconciliation_required → paid | failed_confirmed | cancelled` (only after reconciliation evidence).
- `requested → rejected` (authorization/hold/insufficient/invalid beneficiary).
- `requested|quoted|confirmed → cancelled` (seller/system cancel before reservation capture).

Actor/permission: seller requests/confirms; accounting staff approves/executes/reconciles; `llm-financial` owns reservation capture/release. Idempotency by payout request id + quote id + idempotency key. Retry/re-execution allowed only for `execution_unknown`/`reconciliation_required` with reconciliation evidence; never duplicate disbursement without idempotency. Reservation released only on `failed_confirmed` or reconciliation-resolved failure; never solely on timeout. `paid` requires execution evidence.

## 3. Integration lifecycle

1. Seller requests payout.
2. Payout requests/creates an immutable quote.
3. Seller confirms the quote.
4. Payout requests an EC reservation from `llm-financial`.
5. `llm-financial` atomically reserves eligible amount.
6. Payout executes fiat disbursement (manual in MVP).
7. On confirmed success, `llm-financial` captures reservation.
8. On confirmed failure, `llm-financial` releases reservation.
9. Unknown outcome remains in reconciliation; **không** release funds chỉ vì timeout.

### 3.1 Cancellation after reservation

1. Payout đã reserve EC.
2. Seller/accounting yêu cầu hủy trước khi bắt đầu disbursement.
3. Payout gửi idempotent release command cho `llm-financial`.
4. Chỉ sau khi release được xác nhận mới chuyển PayoutRequest sang `cancelled`.
5. Nếu release outcome chưa xác định, chuyển sang trạng thái reconciliation/pending phù hợp (`execution_unknown` → `reconciliation_required`).
6. Không cho phép disbursement đồng thời với cancellation đang xử lý (mutex/lock theo payout request).
7. Không release hai lần hoặc tạo duplicate ledger mutation (idempotency by payout request id + reservation id).

Durable idempotency, outbox/inbox, correlation IDs, state transitions và recovery bắt buộc.

## 4. MVP manual disbursement

Backoffice workflow cho accounting staff:

- Inspect payout requests.
- Verify beneficiary and quote.
- Approve/reject.
- Execute bank transfer manually.
- Record bank reference and evidence/receipt.
- Mark paid **chỉ sau khi evidence có**.
- Reconcile payout against `llm-financial` reservation.

Maker/checker dual control là **bắt buộc** cho thao tác tài chính rủi ro cao. Operator **không** trực tiếp chỉnh EC balance để đánh dấu payout complete.

## 5. Invariants

1. `payout` không chỉnh EC balance/ledger entry trực tiếp.
2. Quote immutable sau khi tạo; expired quote không sửa.
3. Capture/release EC chỉ qua `llm-financial`.
4. Unknown outcome → reconciliation, không release vì timeout.
5. Cancellation after reservation chỉ chuyển `cancelled` sau khi release được `llm-financial` xác nhận; không release hai lần.
6. Audit append-only cho mọi thao tác đặc quyền (actor, reason, before/after).
7. No secrets/sensitive payment details in logs.

## 6. Failure / correction

- Disbursement failure confirmed → release reservation.
- Unknown outcome → hold in reconciliation; manual resolution với evidence.
- Quote expired → tạo quote mới, seller confirm lại.
- Manual-disbursement deadline sau confirm: nếu vượt approved validity window → quote mới + seller reconfirm; không silently đổi amount/rate.

## 7. Cross-references

- `llm-financial` boundary → [`docs/domains/llm-financial/README.md`](../llm-financial/README.md).
- Payment boundary → [`docs/domains/payment/README.md`](../payment/README.md).
- Domain map → [`docs/domains/README.md`](../README.md).
