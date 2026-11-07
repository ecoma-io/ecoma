# <Tên Feature>

> **Product area:** `<area>/` · **Mô tả một dòng:** outcome ngắn gọn mà capability tạo ra.
>
> Tài liệu này mô tả **product capability**, không mô tả domain rule, API contract hay kế hoạch hiện thực. Quy tắc viết → [`../README.md`](../README.md).

## 1. Problem

Người dùng là ai, họ đang ở tình huống nào, và điều gì không làm được hoặc phải làm theo cách không tốt nếu capability này không tồn tại.

Chỉ mô tả vấn đề người dùng quan sát được. Không mô tả nguyên nhân kỹ thuật, không mô tả giải pháp.

## 2. Outcome

Hệ thống tạo ra kết quả gì cho người dùng, quan sát được từ bên ngoài. Viết bằng hành vi, không bằng khối lượng code hay tên endpoint.

Nêu rõ outcome **có** những thuộc tính nào mà người dùng phụ thuộc vào (ví dụ: dữ liệu cách ly theo tenant, secret chỉ hiện một lần, hành vi fail-closed), vì đó là một phần của outcome chứ không phải chi tiết hiện thực.

## 3. Scope

### Bao gồm

- Capability con mà Feature chịu trách nhiệm.
- Điều kiện tiên quyết người dùng phải có (ví dụ: đã đăng nhập, có permission).
- Hành vi biên quan trọng người dùng gặp phải (lỗi, từ chối, giới hạn tần suất) — chỉ khi nó quan sát được.

### Không bao gồm

- Capability lân cận thuộc Feature khác; trỏ tới Feature đó.
- Phần chưa hiện thực, chỉ là prototype, hoặc đang chạy bằng mock.
- Quyết định chưa chốt.

Mỗi mục trong phần này nêu **giới hạn**, không nêu việc cần làm. Không dùng phần này như backlog.

## 4. Acceptance Scenarios

Các scenario quan trọng nhất, viết theo dạng: bối cảnh → hành động → kết quả quan sát được. Mỗi scenario phải kiểm chứng được từ bên ngoài và không phụ thuộc vào chi tiết hiện thực.

Chỉ liệt kê scenario phản ánh hành vi thực tế của hệ thống. Scenario mong muốn nhưng chưa có hành vi tương ứng thuộc **Scope → Không bao gồm**, không thuộc phần này.

```text
Cho <bối cảnh>
Khi  <hành động>
Thì  <kết quả quan sát được>
```

## 5. Domain & Application Mapping

Bảng nối Feature với hai view còn lại. Mỗi dòng nêu phần **tham gia**, không nêu cách hiện thực.

| Domain / Application        | Vai trò trong Feature                  | Canonical                            |
| --------------------------- | -------------------------------------- | ------------------------------------ |
| `<bounded context>`         | Sở hữu dữ liệu/rule nào của capability | `docs/domains/<context>/README.md`   |
| `<application/deploy unit>` | Phục vụ bề mặt nào cho người dùng      | `docs/applications/<name>/README.md` |

Chỉ nêu domain/application **thực sự tham gia**. Không suy ra từ tên project; kiểm tra source và contract.

## 6. Verification Mapping

Bảng nối scenario với test thực tế. Nêu đúng **loại test** theo [`architecture/06-testing.md`](../architecture/06-testing.md) §3 — unit, integration app-owned, contract, database hoặc system test — vì tầng quyết định kết luận `Verified` được phép nói gì.

| Scenario | Test file / suite                             | Loại test   | Nx target          |
| -------- | --------------------------------------------- | ----------- | ------------------ |
| S1       | `path/to/spec.ts`                             | integration | `test-integration` |
| S2       | `system-tests/e2e/<suite>/e2e/<spec>.spec.ts` | system E2E  | `system-test`      |

Giới hạn phải nêu khi có:

- Scenario chưa có test tương ứng.
- Test tồn tại nhưng không chạy trong CI hoặc không chạy được trong môi trường hiện tại.
- Behavior chỉ được kiểm chứng gián tiếp, hoặc chỉ ở một tầng thấp hơn tầng người dùng tương tác.

Sự tồn tại của test file **không** phải bằng chứng test đã pass. Kết luận `Verified` cần kết quả chạy thực tế của target tương ứng; `Released` cần deployment record.
