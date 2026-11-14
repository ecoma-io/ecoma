# Bổ nhiệm và thu hồi administrator

> **Feature area:** `internal-access/` · **Mô tả một dòng:** administrator tạo identity staff cho một Account hiện có, bổ nhiệm role `system-administrator`, và thu hồi assignment — với bảo vệ administrator cuối cùng.
>
> Đặc tả domain → [`domains/staff-access/`](../../domains/staff-access/README.md) · [ADR-0023](../../domains/staff-access/adr/0023-administrator-lifecycle-paths.md) · quy tắc viết → [`../README.md`](../README.md).

## 1. Problem

Sau bootstrap, tổ chức cần bổ nhiệm thêm administrator và cắt quyền khi cần. Không có đường bổ nhiệm thường, hệ thống chỉ còn một administrator duy nhất do bootstrap tạo ra: người đó không thể ủy quyền, và khi identity của họ mất dùng được thì không đường hợp lệ nào thêm lại administrator — chỉ còn emergency recovery hai-phím.

## 2. Outcome

Một administrator hiện hành bổ nhiệm role `system-administrator` qua một assignment cho identity staff hiện có, và thu hồi assignment đó — server-side enforcement, actor từ envelope đã xác thực, audit ghi cùng transaction với thay đổi.

- Bổ nhiệm tạo đúng một assignment cho role canonical `system-administrator`, `granted_by` = actor staff.
- Thu hồi assignment làm assignment mất hiệu lực; thu hồi lại trả xung đột.
- Bảo vệ administrator cuối cùng là **invariant mục tiêu**: không actor nào tự thu hồi assignment administrator cuối cùng của chính mình, và không đường nào làm số administrator hiệu lực rơi về 0 ([ADR-0021](../../domains/staff-access/adr/0021-first-admin-bootstrap-path.md) — đếm administrator **tại write time**). **Chưa hiện thực ở route** — guard hiện chỉ có ở thời điểm bootstrap (ADR-0022); hiện thực thuộc #44.
- Permission bổ nhiệm/thu hồi được enforce **trên server, tại `staff-access`, theo từng request** (SR-002/SR-003); principal lấy từ credential đã xác thực, không từ body (SR-001/T-10). **Enforce permission trên đường ghi chưa hiện thực** — literal chưa được seed; thuộc #44.
- Mỗi lần bổ nhiệm hay thu hồi thành công để lại một audit row `role_assignment.*` — **mutation không tồn tại nếu không có audit** ([SR-013]; cùng transaction).
- Identity đã `terminated` không bổ nhiệm được; role không `active` không gán được.

## 3. Scope

### Bao gồm

- Route ghi Staff Access: `POST /staff/:id/assignments` (bổ nhiệm) và `POST /assignments/revoke` (thu hồi), envelope HMAC nội bộ, actor từ envelope.
- Kiểm tra tiền đề khi bổ nhiệm: staff tồn tại và không `terminated`; role tồn tại và `active`.
- Kiểm tra khi thu hồi: assignment tồn tại; đã thu hồi trả 409.
- Audit `role_assignment.create` / `role_assignment.revoke` ghi **cùng transaction** với thay đổi, kèm actor và outcome.
- Bảo vệ administrator cuối cùng tại write time (đếm administrator hiệu lực, chặn self-revocation của administrator cuối cùng).
- Enforce permission server-side trên từng request ghi.

### Không bao gồm

- **Tạo identity staff chưa có route.** Identity staff hiện chỉ sinh qua bootstrap seed; không có route nào tạo staff từ một Account hiện có. Quyền sở hữu đường tạo identity thuộc quyết định của #44 — Feature này không mô tả nó như capability đã có.
- **Đường permission bổ nhiệm/thu hồi chưa hoàn chỉnh.** Route ghi hiện xác thực envelope và kiểm tra actor là staff `active`, nhưng chưa enforce literal permission nào trên đường ghi; literal `role.assign`/`role.revoke` chưa được seed vì catalog thay đổi cần ADR riêng ([ADR-0023](../../domains/staff-access/adr/0023-administrator-lifecycle-paths.md) Quyết định 2). Khoảng trống này là yêu cầu hiện thực của #44, không phải hành vi đã có.
- **Bảo vệ administrator cuối cùng chưa hiện thực ở route.** Guard hiện chỉ tồn tại ở thời điểm bootstrap (đo `admins_before`/`admins_ever`, ADR-0022); route thu hồi hiện chưa đếm administrator còn hiệu lực và chưa chặn self-revocation. Đó là yêu cầu hiện thực của #44 (xuất phát từ ADR-0021), không phải hành vi đã có.
- **Không có bề mặt operator.** Không route BFF backoffice nào gọi đường ghi, không trang UI quản trị administrator nào — hai hàm client ghi tồn tại nhưng không có call site. Bề mặt operator thuộc #191, chưa hiện thực; từ góc operator, workflow quản trị chỉ dùng được qua API nội bộ trực tiếp.
- **Không có custom role, custom permission management, approval workflow, recovery hay replacement identity.** Đó là capability M3; role duy nhất trong M1 là `system-administrator` seeded.
- **Không có thay đổi trạng thái staff qua route ghi này.** Suspend/terminate staff là bề mặt khác; ADR-0023 ghi khoảng trống "administrator cuối cùng bị terminated không khôi phục được" là giới hạn hiện tại.
- Emergency recovery hai-phím thuộc đường bootstrap/recovery riêng ([ADR-0003](../../domains/staff-access/adr/0003-bootstrap-first-admin-recovery.md), ADR-0023) — không thuộc Feature này.

## 4. Acceptance Scenarios

```text
Cho  một Account hiện có và actor được phép bổ nhiệm
Khi  tạo identity staff cho Account đó rồi gán role `system-administrator`
Thì  một assignment được tạo với `granted_by` = actor, và một audit row `role_assignment.create` được ghi cùng transaction
```

```text
Cho  staff đang ở trạng thái `terminated`, hoặc role không `active`
Khi  bổ nhiệm
Thì  bị từ chối với lỗi domain tương ứng, không assignment nào được tạo
```

```text
Cho  một assignment đang hiệu lực
Khi  thu hồi assignment đó
Thì  assignment mất hiệu lực, và một audit row `role_assignment.revoke` được ghi cùng transaction
```

```text
Cho  một assignment đã bị thu hồi
Khi  thu hồi lần nữa
Thì  nhận xung đột — thao tác không lặp được
```

```text
Cho  administrator cuối cùng đang hiệu lực (invariant mục tiêu — chưa hiện thực ở route, thuộc #44)
Khi  actor tự thu hồi assignment của chính mình, hoặc thu hồi làm số administrator hiệu lực rơi về 0
Thì  bị chặn — assignment vẫn còn hiệu lực
```

```text
Cho  request ghi không kèm credential đã xác thực, hoặc principal khai trong body
Khi  route xử lý
Thì  bị từ chối — actor chỉ lấy từ envelope nội bộ đã xác thực
```

```text
Cho  một lần bổ nhiệm hay thu hồi
Khi  đọc bảng audit
Thì  có hàng `role_assignment.*` kèm actorStaffId/actorSub và outcome; mutation thành công không bao giờ thiếu audit row
```

## 5. Domain & Application Mapping

| Domain / Application             | Vai trò trong Feature                                                                       | Canonical                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `staff-access` (bounded context) | Sở hữu staff identity, role catalog, assignment, audit và invariant administrator cuối cùng | [`domains/staff-access/`](../../domains/staff-access/README.md)                                      |
| `account` (bounded context)      | Cung cấp Account là điều kiện tiên quyết của identity staff (kênh lời mời/bootstrap)        | [`domains/account/`](../../domains/account/README.md)                                                |
| `apps/staff-access`              | Worker nội bộ phục vụ route ghi assignment qua envelope HMAC                                | [`applications/staff-access/01-architecture.md`](../../applications/staff-access/01-architecture.md) |
| `apps/backoffice`                | Chưa tham gia — không có route BFF ghi hay UI quản trị (#191)                               | [`applications/backoffice/README.md`](../../applications/backoffice/README.md)                       |

Bề mặt contract dùng chung: `libs/staff-access-contracts` (publish qua PR #276) là thư viện verdict contract được cả `apps/staff-access` và `apps/backoffice` tiêu thụ.

## 6. Verification Mapping

| Scenario                                                                                   | Test file / suite                                                    | Loại test   | Nx target          |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------- | ------------------ |
| Audit `role_assignment.create`/`.revoke` ghi cùng transaction, correlationId từ request    | `apps/staff-access/src/routes.spec.ts`                               | unit        | `test`             |
| Thu hồi: body thiếu `id` trả 400 trước khi chạm database                                   | `apps/staff-access/src/routes.spec.ts`                               | unit        | `test`             |
| Xác thực envelope nội bộ: thiếu/sai bị từ chối                                             | `apps/staff-access/tests/integrations/internal-auth.spec.ts`         | integration | `test-integration` |
| Verdict permission cho đường đọc và `invitation.create`                                    | `apps/staff-access/tests/integrations/authorization-verdict.spec.ts` | integration | `test-integration` |
| Bootstrap first-admin: measured guard `admins_before`/`admins_ever`, mode_mismatch bị chặn | `apps/staff-access/tests/integrations/bootstrap-superadmin.spec.ts`  | integration | `test-integration` |
| Schema assignment, composite-FK tenant, migration idempotent                               | `apps/staff-access/tests/databases/migrations.spec.ts`               | database    | `test-integration` |

**Giới hạn của verification hiện tại:**

- **Chưa có test hành vi cho các tiền đề bổ nhiệm** (staff `terminated`, role không `active`), **xung đột thu hồi 409**, và **audit-in-transaction qua request thật** ở tầng integration — các spec hiện chỉ phủ unit (repository giả) và envelope. Test của chúng thuộc điều kiện hoàn thành #44.
- **Chưa có test cho bảo vệ administrator cuối cùng ở route** — hành vi đó chưa hiện thực (khoảng trống đã nêu ở §3); test của nó thuộc #44.
- **Chưa có test enforce permission trên đường ghi** — literal chưa được seed; test của nó thuộc #44.
- **Trigger `role_assignment_no_self_elevation` không có test nào chạy** — chỉ xuất hiện trong SQL migration; chưa được assert ở tầng nào.
- **Không có test nào ở tầng browser hay system cho đường ghi** — không có UI, không có system suite nào chạm Staff Access ghi.
- Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass. Kết luận `Verified` cần kết quả chạy của `test` và `test-integration`.
