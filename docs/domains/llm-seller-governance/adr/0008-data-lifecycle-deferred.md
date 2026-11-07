# ADR-0008 — Vòng đời pháp lý của dữ liệu Seller là deferred

**Trạng thái:** Accepted (deferred scope) · **Ngày:** 2026-11-06 · **Issue:** #549

## Bối cảnh

Thiết kế cũ có lifecycle `terminated` cho Seller tenant và ngụ ý archive/deletion. Chưa có quyết định nào về retention, legal hold, export, anonymization hay physical deletion, và các quyết định đó phụ thuộc tư vấn pháp lý chứ không phải thiết kế kỹ thuật.

[`llm-consumer-tenant/domain-model.md`](../../llm-consumer-tenant/domain-model.md) §8.1 đã chọn cách xử lý tương tự: giữ ba trục tách biệt và để vòng đời pháp lý ngoài domain. `llm-seller-tenant` và `llm-seller-governance` cần cùng mức kỷ luật, đặc biệt vì dữ liệu Seller gồm legal/tax profile và evidence — nhạy cảm hơn nhiều so với tenant metadata.

## Quyết định

- `llm-seller-tenant` và `llm-seller-governance` **không** có trạng thái `terminated`, `archived`, `deleted`, `deletedAt` hay `archivedAt`.
- Không có domain operation xoá Seller tenant, xoá membership, xoá grant, xoá restriction, xoá appeal, xoá verification, xoá profile version hay xoá evidence reference.
- Ba trục được giữ tách biệt và **cả ba đều chưa chốt** phần pháp lý:
  1. **Operational** — tenant có đang bị restriction chặn hay không (đã chốt, [ADR-0003](./0003-restriction-and-appeal-model.md)).
  2. **Data lifecycle** — archive/export/anonymization (chưa chốt).
  3. **Legal retention** — retention period, legal hold, physical deletion (chưa chốt).
- Retention của evidence và storage provider **chưa chốt** ([`domain-model.md`](../domain-model.md) §8.6). Domain chỉ giữ `storageRef`/`contentHash`; nó không quyết định khi nào tài liệu bị xoá.
- Khi các quyết định này được chốt, chúng đi vào domain như **operation mới** với ADR mới — không bằng cách thêm một cột `status`.

## Hệ quả

- Consumer không thể suy ra "tenant đã bị xoá" từ domain; muốn chặn hoàn toàn một Seller phải dùng restriction ([ADR-0003](./0003-restriction-and-appeal-model.md)).
- Persistence không được thêm soft-delete column để "chuẩn bị trước" — đó là quyết định trái ADR này.
- Dữ liệu lịch sử (revoked membership, revoked grant, lifted restriction, decided appeal, các version profile) là append-only và không có đường xoá ở tầng domain.

## Cross-reference

- [`domain-model.md`](../domain-model.md) §1, §8.1, §8.6
- [`llm-consumer-tenant/domain-model.md`](../../llm-consumer-tenant/domain-model.md) §8.1 — cùng cách xử lý
- [`staff-access/adr/0008`](../../staff-access/adr/0008-audit-retention.md) — retention audit là policy hệ thống, không phải quyết định của context
