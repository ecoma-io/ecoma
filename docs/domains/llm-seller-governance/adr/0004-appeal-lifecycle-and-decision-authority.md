# ADR-0004 — Appeal lifecycle và thẩm quyền quyết định

**Trạng thái:** Accepted · **Ngày:** 2026-11-06 · **Issue:** #549

## Bối cảnh

Restriction ([ADR-0003](./0003-restriction-and-appeal-model.md)) chỉ có giá trị nếu Seller có đường phản hồi có kỷ luật: biết hạn, biết trạng thái, và biết quyết định do ai ra. Không có appeal, restriction trở thành quyết định không thể kiểm chứng.

Điều cần chốt: appeal có phải một entity riêng không, nó có tự thay đổi restriction không, ai được quyết định, và deadline xử lý thế nào khi record không có deadline.

## Quyết định

- **Appeal là entity riêng**, trỏ đúng một `restrictionId`, có vòng đời tường minh:
  - `submitted → under_review → accepted | rejected`
  - `submitted | under_review → withdrawn`
  - `accepted`, `rejected`, `withdrawn` là terminal cho appeal đó.
- **Submit guard:** restriction phải tồn tại trong đúng tenant, đang hiệu lực và chưa lift; nếu record có `appealDeadline` thì `submittedAt <= appealDeadline` (biên inclusive). Actor phải là owner hoặc member active của tenant.
- **Quyết định không tự thay đổi restriction.** `accepted` chỉ ghi nhận quyết định; caller phải gọi `liftRestriction` riêng. Hai operation tách biệt để giữ audit và tránh quyết định ẩn ý.
- **Reviewer:** quyết định bắt buộc có actor đã xác thực (`decidedBy`) và lý do công khai (`publicDecisionReason`) khi reject. Domain **không** định nghĩa role reviewer hay catalog thẩm quyền — việc đó thuộc authorization của platform surface (§9.3). Domain từ chối quyết định thiếu actor, sai transition, hoặc thiếu lý do công khai.
- **Hai lớp lý do:** `decisionReason` (nội bộ) và `publicDecisionReason` (công bố); chỉ lớp công khai được ra public projection/contract.
- **Record không có `appealDeadline`:** domain **không** tự áp một deadline mặc định. Chính sách đó chưa chốt; áp ngầm sẽ tạo một luật không được duyệt.

## Phương án bị loại

| Phương án                                  | Lý do loại                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Appeal là "yêu cầu mở khoá" không có state | Không audit được, không phân biệt đang xét với đã quyết.                                             |
| `accepted` tự lift restriction             | Trộn hai quyết định vào một operation; không thể từ chối lift vì lý do khác (ví dụ còn record khác). |
| Deadline mặc định trong domain             | Là chính sách pháp lý/vận hành chưa chốt; hardcode là bịa luật.                                      |
| Reviewer không cần actor                   | Không truy vết được ai quyết định.                                                                   |

## Hệ quả

- Một restriction có thể có nhiều appeal theo thời gian. Số lần appeal lại sau reject **chưa chốt** ([`domain-model.md`](../domain-model.md) §8.4); domain không giới hạn số lượng, chỉ áp guard submit.
- Application layer phải authorize reviewer trước khi gọi `decideAppeal`; domain chỉ kiểm actor có mặt và transition hợp lệ.
- Public API trả `PublicAppeal` không chứa `decisionReason`.

## Cross-reference

- [`domain-model.md`](../domain-model.md) §3.2, §3.7, §5, §7 · §4
