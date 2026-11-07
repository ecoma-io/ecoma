# ADR-0007 — Ranh giới permission identifier giữa `llm-seller-tenant` và `staff-access`

**Trạng thái:** Accepted · **Ngày:** 2026-11-06 · **Issue:** #549

## Bối cảnh

[`staff-access/adr/0010`](../../staff-access/adr/0010-permission-naming-and-read-catalog.md) chốt permission đặt tên theo hình `domain.action` và **cấm phát minh permission từ tài liệu**; catalog nội dung thuộc `staff-access`. Đồng thời [`llm-financial/adr/0005`](../../llm-financial/adr/0005-ec-to-uc-conversion.md) yêu cầu EC→UC conversion có "payout permission ở Seller tenant", tức phải tồn tại một identifier cụ thể để authorize.

Không có quyết định này, hai lỗi đều dễ xảy ra: `llm-seller-tenant` tự định nghĩa một catalog riêng (trùng lặp, lệch governance), hoặc `llm-seller-tenant` không authorize được gì vì chờ catalog chưa chốt.

## Quyết định

- `llm-seller-tenant` giữ permission identifier như **domain value opaque** theo hình `domain.action`; domain validate hình dạng, không validate ngữ nghĩa, không có catalog, không wildcard.
- Domain **không** import `staff-access`, không đọc catalog lúc runtime, không tạo bảng permission riêng.
- **Ngoại lệ tối thiểu, có nguồn:** đúng một identifier được domain đặt tên hằng số — `payout.manage` — vì [ADR-0005](../../llm-financial/adr/0005-ec-to-uc-conversion.md) của `llm-financial` yêu cầu nó như một điều kiện của conversion. Hằng số này là **identifier**, không phải nội dung catalog; việc publish/description/threshold thuộc `staff-access`.
- Mọi permission khác được caller truyền vào dưới dạng `PermissionId`; domain không tự sinh.
- Ai sở hữu catalog, ai publish và cách đồng bộ **chưa chốt** ([`domain-model.md`](../domain-model.md) §8.2). Domain được thiết kế để không phải thay đổi khi câu trả lời xuất hiện: thêm permission mới là thêm dữ liệu, không phải sửa ladder authorization.

## Phương án bị loại

| Phương án                                               | Lý do loại                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `llm-seller-tenant` định nghĩa catalog permission riêng | Trùng nguồn sự thật với `staff-access`, vi phạm ADR-0010.                  |
| Không authorize payout cho tới khi catalog chốt         | Chặn một capability đã được yêu cầu bởi ADR-0005 của `llm-financial`.      |
| Import `staff-access` ở domain                          | Vi phạm purity và module boundary; domain không phụ thuộc Nx project khác. |
| Enum permission trong domain                            | Đóng cứng catalog trước khi governance chốt.                               |

## Hệ quả

- `payout.manage` là permission identifier duy nhất được đặt tên trong lib; mọi nơi khác dùng `PermissionId` do caller cấp.
- Cùng lý do, `authorizeSellerPayout` ghim **target** capability `payout` (`LLM_SELLER_PAYOUT_TARGET`) thay vì nhận target từ caller: nếu caller truyền target `tenant`, một restriction capability-scope dành riêng cho payout sẽ không nằm trong evaluation và bị bỏ qua. Đây là capability label opaque, cùng họ với permission `payout.manage`, không phải một catalog capability.
- Nếu `staff-access` sau này đặt tên khác cho payout permission, đổi hằng số là một thay đổi một điểm, không ảnh hưởng ladder authorization.
- Consumer (application layer) chịu trách nhiệm map permission từ catalog sang identifier trước khi gọi domain.

## Cross-reference

- [`domain-model.md`](../domain-model.md) §2, §3 · [`staff-access/adr/0010`](../../staff-access/adr/0010-permission-naming-and-read-catalog.md), [`llm-financial/adr/0005`](../../llm-financial/adr/0005-ec-to-uc-conversion.md)
