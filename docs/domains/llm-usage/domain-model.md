# Bounded context `llm-usage` — Domain Model

`llm-usage` là bounded context phân hệ đo lường usage: **provider-specific usage formats, normalization, token accounting (input/output/cached/reasoning), request-level và attempt-level usage, correction/reconciliation, missing/malformed provider usage, provenance và idempotency**.

> Usage **measurement** (đo lường tiêu thụ) khác **financial charge** (tính tiền). Usage là dữ liệu đo lường; charge là quyết định tài chính do authority/quota/settlement xử lý. Hai khái niệm không đồng nhất.

## 1. Domain entities và value objects

### Normalized usage

Usage đã chuẩn hóa sang schema chung:

```
NormalizedUsage {
  input_tokens: TokenCount,       // số hay null (unknown)
  output_tokens: TokenCount,
  cached_tokens: TokenCount,      // subset của input, không cộng vào tổng
  reasoning_tokens: TokenCount,   // subset của output, không cộng vào tổng
  request_count: TokenCount,      // 0/1 hay null
}
```

### TokenCount

- `number ≥ 0` hoặc `null` (unknown).
- Không có giá trị âm.
- `null` là unknown, khác `0` (không có dữ liệu ≠ không dùng token).
- So sánh bằng: hai `null` không được coi là bằng nhau cho mục đích tính tổng (tổng của unknown là unknown).

### Invariants (đánh giá chỉ khi tất cả liên quan đã biết, tức không null)

1. `cached_tokens ≤ input_tokens` khi cả hai không null.
2. `reasoning_tokens ≤ output_tokens` khi cả hai không null.
3. Tổng token normalized = `input + output` (cached là subset của input, không cộng thêm; reasoning là subset của output, không cộng thêm).
4. Nếu `input_tokens` hoặc `output_tokens` là `null` → tổng là `null` (unknown); `cached_tokens`/`reasoning_tokens` null không làm tổng input+output trở nên null (chúng là subset, không cộng vào tổng).

### UsageStatus

| Giá trị     | Nghĩa                                               |
| ----------- | --------------------------------------------------- |
| `known`     | Provider trả đủ dữ liệu để tính toán.               |
| `missing`   | Provider không trả usage.                           |
| `malformed` | Provider trả dữ liệu không parse được / sai schema. |
| `partial`   | Provider trả một phần (một số category null).       |

### Attempt-level usage

Usage của một provider attempt (normalized + raw reference + normalizer version). Dùng audit / reconciliation.

```
AttemptUsage {
  usage: NormalizedUsage,
  status: UsageStatus,            // known | missing | malformed | partial
  provenance: Provenance,
  raw_usage: unknown,             // reference giữ nguyên định dạng provider
}
```

### Request-level usage

Usage tổng hợp cho một logical request. Cơ sở cho settlement / charge (tính toán nằm ngoài domain).

```
RequestUsage {
  request_id: string,
  attempts: readonly AttemptUsage[],   // chỉ attempt có status `known` vào tổng
  aggregated: NormalizedUsage | null,  // null khi không đủ dữ liệu để tổng hợp
  status: UsageStatus,
}
```

### Provenance

```
Provenance {
  provider: string,
  model: string,
  attempt_id: string,
  request_id: string,
  normalizer_version: string,
  raw_usage_reference: string,
  timestamp: string,   // ISO 8601 UTC, do caller truyền vào
}
```

### Normalizer version

Phiên bản normalizer; dùng để quyết định determinism của kết quả chuẩn hóa.

## 2. Normalization operations và hành vi quyết định

### `normalizeUsage`

- Input: provider usage đã parse (parsed input model, không phải raw HTTP payload), normalizer version (string).
- Output: `NormalizedUsage`.
- Deterministic: cùng input + cùng version → cùng output.
- Versioned: thay đổi normalizer → bump version, ghi version vào record (phiên bản nằm ngoài domain, domain nhận version làm tham số).
- Không đọc đồng hồ; timestamp do caller cung cấp qua provenance.

### `computeTotalTokens`

- `input + output`; null nếu input hoặc output null. Không tính cached/reasoning.

### `validateUsageInvariants`

- `cached ≤ input` khi cả hai biết.

### `classifyUsage`

- known / missing / malformed / partial.

### `aggregateAttemptUsage`

- Chỉ attempt có status `known` vào tổng. Tổng theo sum (xem UNRESOLVED U-1).

### `isCorrectionValid`

- Không tạo giá trị âm; idempotency key không rỗng.

### `reconcile`

- Kết quả: `match` / `mismatch` / `incomplete`.

### `correctionIdempotencyKey`

- Xây chuỗi idempotency key theo `(scope, id, correctionId)`.

## 3. Token category và unknown/null semantics

| Quy tắc                        | Nghĩa                                   |
| ------------------------------ | --------------------------------------- |
| `cached_tokens ≤ input_tokens` | Chỉ khi cả hai biết.                    |
| cached là subset của input     | Không cộng thêm vào tổng.               |
| reasoning là subset của output | Không cộng thêm vào tổng.               |
| Tổng = input + output          | Không tính cached/reasoning hai lần.    |
| Category null → unknown        | Không ép về 0.                          |
| Bất kỳ null → tổng null        | Tổng unknown nếu có thành phần unknown. |
| `request_count`                | 0, 1, hoặc null; không âm.              |

## 4. Attempt-level và request-level usage semantics

### Attempt-level

Mỗi provider attempt ghi: normalized usage + raw reference + normalizer version + provenance + status. Dùng cho audit / reconciliation, không nhân lên charge.

### Request-level

- Request-level usage tổng hợp từ các attempt của cùng logical request.
- **Chỉ attempt có status `known` vào tổng** (attempt thất bại hoặc retry chỉ phục vụ audit / reconciliation, không cộng vào request-level).
- Attempt failed / retry không vào tổng request-level.
- Request-level là cơ sở cho settlement / charge (tính charge nằm ngoài domain).

## 5. Missing, malformed và partial usage classification

| Điều kiện                                          | Status      | Hành vi domain                                              |
| -------------------------------------------------- | ----------- | ----------------------------------------------------------- |
| Provider không trả usage                           | `missing`   | Ghi status missing, không silently 0.                       |
| Provider trả dữ liệu sai schema / không parse được | `malformed` | Ghi status malformed, giữ raw evidence.                     |
| Provider trả một phần (category null)              | `partial`   | Tính toán với null, tổng null nếu component null ảnh hưởng. |
| Provider trả đủ                                    | `known`     | Chuẩn hóa bình thường.                                      |

- Không silently coi missing/malformed là 0.
- Không silently coi unknown là 0 trong tổng.

## 6. Correction model và correction semantics

### Correction

- Usage có thể được điều chỉnh sau (provider trả usage muộn, correction event).
- Correction idempotent theo `(reservation_id, correction_id)` (request-level) và `(attempt_id, correction_id)` (attempt-level).
- Correction có thể là measurement-only (chỉ sửa usage đo lường) hoặc charge-affecting (ảnh hưởng charge). Nếu charge-affecting, `llm-usage` yêu cầu idempotent adjustment từ `llm-financial` theo `(reservation_id, correction_id)`; domain không trực tiếp sửa ledger / balance.

### Correction validity

- Idempotency key phải được cung cấp và không rỗng.
- Correction không được tạo giá trị âm.
- Correction không được thay đổi charge đã settle trừ khi policy rõ ràng.

## 7. Reconciliation model và comparison outcomes

### Reconciliation

- So sánh request-level usage với tổng attempt-level usage và quota settlement.
- Mismatch → alert, không silently overwrite.
- Không overwrite dữ liệu thực bằng ước tính lặng.

### Comparison outcomes

| Kết quả      | Nghĩa                                                                           |
| ------------ | ------------------------------------------------------------------------------- |
| `match`      | Request-level == tổng attempt-level (so sánh exact, không có dung sai).         |
| `mismatch`   | Khác nhau (exact, bất kỳ sai số nào) → alert.                                   |
| `incomplete` | Không đủ dữ liệu để so sánh (usage missing / null) → không khẳng định mismatch. |

## 8. Provenance requirements

Mỗi normalized usage record mang provenance:

- `provider`: tên provider.
- `model`: model đã dùng.
- `attempt_id`: định danh attempt.
- `request_id`: định danh logical request.
- `normalizer_version`: phiên bản normalizer.
- `raw_usage_reference`: tham chiếu tới raw usage (attempt record bền).
- `timestamp`: ISO 8601 UTC, do caller truyền vào (domain không đọc đồng hồ).

Không log prompt / response body.

## 9. Idempotency

- Usage write idempotent theo `reservation_id` (request-level usage write thường) và `(reservation_id, correction_id)` (request-level correction) / `(attempt_id, correction_id)` (attempt/correction).
- Retry write không tạo duplicate usage row.
- Settlement idempotent theo `reservation_id` (A7).

## 10. Domain errors

`DomainError { code: string; message: string }` — message tiếng Anh (runtime string theo language policy của repo).

Mã lỗi: `invalid_usage`, `invalid_token_count`, `invalid_correction`, `unknown_normalizer_version`, `usage_missing`, `usage_malformed`.

- Domain errors là value objects (không throw mặc định; factory có thể ném TypeError khi mã không hợp lệ).
- Message tiếng Anh (runtime string theo language policy).
- Không chứa secret / token / identifier nhạy cảm trong message.
- Type guard `isDomainError` để phân biệt domain error với object thuần.

## 11. State và immutability semantics

- Tất cả value object là readonly / immutable.
- Operations không biến đổi input (không mutate object đầu vào).
- Không có global mutable state, singleton, cache ẩn.
- Timestamp / randomness / env phải là tham số caller truyền vào.

## 12. Test specification

Mọi public operation phải có unit test:

- Valid / invalid usage values.
- Zero, boundary, invalid numeric values.
- Unknown vs zero semantics.
- Cached / reasoning subset invariant.
- Total token không double-count.
- Deterministic normalization + version behavior.
- Missing / malformed / partial provider usage.
- Attempt / request aggregation edge cases.
- Correction validity và conflict.
- Reconciliation match / mismatch / incomplete.
- Input immutability.
- Không có hành vi tài chính / persistence ngầm.

Test title viết English; test hành vi, không chi tiết implementation.

## 13. Explicit exclusions và unresolved decisions

### 13.1 Explicit exclusions

- Quota / reservation / settlement / credit / balance / ledger.
- Charge / crediting / payment.
- Persistence, durable idempotency, alerting, event dispatch.
- Provider SDK / HTTP client / DB driver / ORM.
- Cross-BC implementation imports.
- Application use cases / infrastructure adapters.

### 13.2 Unresolved decisions

| ID  | Quyết định còn mở                                             | Ảnh hưởng                 | Nếu không chốt                                                                        |
| --- | ------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------- |
| U-1 | Nhiều attempt completed: tổng hợp sum hay last-wins?          | Request-level aggregation | Domain hiện tại sum completed attempts; nếu business chọn khác, aggregation phải sửa. |
| U-2 | Thứ tự correction, replacement vs merge, conflict trùng khóa. | Correction logic          | Chỉ kiểm validity cơ bản; không implement ordering / replacement.                     |
| U-3 | Mối quan hệ correction request-level vs attempt-level.        | Correction keys           | Cả hai khóa được hỗ trợ độc lập; mối quan hệ chưa định.                               |
| U-4 | Ngưỡng so sánh reconciliation (tolerance).                    | Reconciliation            | So sánh exact; mismatch nếu khác nhau bất kỳ sai số nào.                              |

**Quy tắc:** Không một quyết định nào ở trên được âm thầm chốt trong code.

### 13.3 Decisions đã chốt (không mở lại)

- Chỉ attempt completed vào request-level.
- Unknown ≠ 0; null category → tổng null.
- `cached ≤ input`; tổng = input + output.
- Correction idempotent theo `(reservation_id, correction_id)` và `(attempt_id, correction_id)`.
- Reconciliation mismatch → alert, không overwrite.
- Provenance đầy đủ.
- Idempotent theo `reservation_id` / correction keys.

## 14. Ranh giới với các context khác

| Context                | Ranh giới với `llm-usage`                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `llm-api`              | `llm-api` sở hữu usage durable state trong `db-llm-gateway`; domain lib này không sở hữu bảng hay persistence. |
| `llm-financial`        | Charge/crediting/payment thuộc `llm-financial`; usage ≠ financial charge.                                      |
| `llm-inference`        | Logical request lifecycle / charged once thuộc `llm-inference`.                                                |
| `payment`              | Payment/crediting với `payment` là open boundary.                                                              |
| `llm-consumer-tenant`  | Tenant/membership/workspace thuộc `llm-consumer-tenant`.                                                       |
| `llm-marketplace`      | Seller offer/model catalog/upstream endpoint thuộc `llm-marketplace`.                                          |
| `llm-consumer-routing` | Routing candidate selection thuộc `llm-consumer-routing`.                                                      |

## 15. Tài liệu

| Document                               | Nội dung                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Domain model, value objects, normalization, token accounting, correction/reconciliation, provenance |
| [`README.md`](./README.md)             | Tóm tắt bounded context, boundary, documents                                                        |
