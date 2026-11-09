# ADR-0022 — Guard "chưa có administrator" đo được và race-safe cho bootstrap

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4). ADR này supersede-in-part [ADR-0003](./0003-bootstrap-first-admin-recovery.md) và [ADR-0020](./0020-bootstrap-seed-contract.md) — Quyết định 11 ở chỗ đặt phép kiểm, và Quyết định 6 ở chỗ "chạy lại là cơ chế phục hồi duy nhất". Nó không mở lại quyết định nào khác của hai ADR đó — đường tạo Account đầu tiên, email `pending`, bỏ hai-phím cho lần bootstrap đầu, và hai-phím cho recovery giữ nguyên ([ADR-0021](./0021-first-admin-bootstrap-path.md), [ADR-0023](./0023-administrator-lifecycle-paths.md)).

> **Trạng thái:** Accepted · **Ngày:** 2026-11-09 · **Quyết định từ:** [ADR-0003](./0003-bootstrap-first-admin-recovery.md) · [ADR-0020](./0020-bootstrap-seed-contract.md) Quyết định 6 và 11 · [ADR-0021](./0021-first-admin-bootstrap-path.md) Quyết định 7 · **Issue:** #11

## Bối cảnh

Hai ADR trước chốt hai điều không thể cùng đúng:

- **ADR-0003:** procedure **không** có logic tự phát hiện "đã có admin rồi"; không có nhánh "nếu đã có admin thì báo lỗi". Lý do lúc đó là procedure chỉ là SQL thủ công, nên không có chỗ đặt phép kiểm.
- **ADR-0020 Quyết định 11:** phép kiểm "chưa có assignment nào của administrator role" **thuộc entry point vận hành**, không thuộc procedure của `staff-access`.

Cách chia đó để lại hai lỗ, và cả hai đều là lỗ của một kiểm soát chứ không phải chi tiết kỹ thuật:

1. **Không race-safe.** Entry point đọc số administrator, rồi mới gọi bước ghi của `staff-access`. Hai lần chạy đồng thời cùng đọc `0`, cùng thấy hợp lệ, và cùng ghi. Phép kiểm nằm ngoài critical section của phép ghi thì không bảo vệ được phép ghi.
2. **Bỏ qua được.** Guard chỉ ở entry point nghĩa là ai gọi thẳng CLI của `staff-access` cũng không đi qua nó. Một kiểm soát mà đường tắt không phải là lỗ hổng cấu hình, mà là lỗ hổng thiết kế.

Yêu cầu đặt ra: sau khi environment đã có administrator, **không** đường bootstrap nào được tạo thêm administrator hay cấp lại quyền đã bị thu hồi; và phép kiểm phải đúng dưới chạy đồng thời.

## Phương án

| #   | Phương án                                                                                           | Đánh giá                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Giữ guard ở entry point, thêm advisory lock ở bước ghi**                                          | Không đủ — lock làm hai lần chạy tuần tự, nhưng lần thứ hai vẫn đã qua guard **trước** khi lấy lock, nên nó vẫn ghi. Lock không sửa được thứ tự đọc-rồi-quyết.                                                    |
| 2   | **Đưa guard vào critical section ghi của `staff-access`, đo bằng truy vấn, từ chối khi sai chế độ** | Chấp nhận — phép kiểm và phép ghi nằm trong cùng một transaction dưới cùng một lock; gọi thẳng CLI cũng đi qua guard; `mode` bị đối chiếu với số đo thay vì được tin.                                             |
| 3   | Chặn bằng unique index "một administrator duy nhất"                                                 | Loại — nhiều Superadmin là quyết định đã có (ADR-0020 Quyết định 11, ADR-0021 Quyết định 4); ràng buộc singleton biến việc bổ nhiệm administrator thứ hai thành lỗi ràng buộc và phá đường nghỉ việc bình thường. |
| 4   | Bỏ hẳn guard, dựa vào việc "entry point chỉ chạy một lần mỗi environment"                           | Loại — đó là quy ước vận hành, không phải kiểm soát; một lần chạy lại thủ công là đủ để cấp lại quyền đã thu hồi.                                                                                                 |

## Quyết định

1. **Guard nằm trong critical section ghi của `staff-access`, không ở entry point.** Bước Staff Access mở transaction, lấy advisory lock, **đo** số administrator, rồi mới quyết định ghi hay dừng. Không có cửa sổ giữa phép đọc và phép ghi.
2. **`admins_before` là số đo, không phải input.** Procedure tự tính bằng truy vấn canonical ở Quyết định 4, và ghi giá trị **nó đo được** vào `staff_access.authorization_audit.context`. Đó là bảng duy nhất mang được hai số đo: phép đo chạy trong critical section của `staff-access`, và `staff-access` không có `CONNECT` sang `db-account`, nên `account.security_events` không phải đích ghi được của nó — row `security_events` của lần chạy do A1 ghi **trước** khi đo, và không mang hai số đo (ADR-0021 Quyết định 6, runbook §2 Bước 3 và Bước 7). Giá trị do người chạy truyền vào không được dùng cho bất kỳ quyết định nào và không được ghi như thể là số đo.
3. **`mode` là lời khai của người chạy, và bị đối chiếu với số đo — hai số đo, không phải một.**
   - `admins_before = 0` **và** `admins_ever = 0` → chỉ chấp nhận `mode = 'bootstrap'`.
   - `admins_before > 0` **hoặc** `admins_ever > 0` → chỉ chấp nhận `mode = 'recovery'`, và chỉ khi authorization hai-phím của ADR-0003 đã được chứng minh ngoài hệ thống.
   - Mọi cặp **(`mode` khai, số đo)** không khớp một trong hai dòng trên → **từ chối**: exit khác 0, không ghi dữ liệu nghiệp vụ nào, và ghi **một** audit row `outcome = 'denied'` với lý do `mode_mismatch`. Từ chối phải để lại dấu vết, vì một lần từ chối lặp lại là tín hiệu có người đang thử cấp lại quyền. ⚠️ Row đó phải được **commit ngoài transaction bị abort** — `ROLLBACK` của transaction guard cuốn theo nó và lần từ chối mất dấu vết; quy tắc đầy đủ ở [ADR-0023](./0023-administrator-lifecycle-paths.md) Quyết định 6.

     Row `denied` đó ghi vào **`staff_access.authorization_audit`**, không phải `account.security_events`: bảng sau có `outcome CHECK ('success','failure')` và không có cột `correlation_id`, nên không biểu diễn được một quyết định bị từ chối gắn với lần chạy. Đây là tên bảng cho hành vi Quyết định 3 đã chốt, không phải một quyết định mới ([ADR-0023](./0023-administrator-lifecycle-paths.md) Quyết định 6 ghi cùng tên cho mọi lý do từ chối của ba đường).

   ⚠️ **`admins_before` một mình không đủ, và đây là lỗ hổng đã đo được, không phải phòng xa.** `admins_before` đếm assignment **còn hiệu lực**. Sau khi assignment administrator duy nhất bị `revoked_at`, số đó về **0** trong khi quyền vừa bị thu hồi — nên nếu chỉ so `admins_before`, một lần chạy `mode = 'bootstrap'` được **chấp nhận** và insert assignment mới, tức khôi phục đúng quyền vừa thu hồi mà không có hai-phím. Vì vậy guard đo thêm **`admins_ever`**: số assignment hàng của role canonical từng tồn tại, **không** lọc `revoked_at`, cửa sổ hiệu lực hay trạng thái staff. `admins_ever > 0` nghĩa là environment **đã từng** có administrator, nên mọi lần chạy sau đó — kể cả khi hiện không còn ai — là recovery, phải qua hai-phím. Bootstrap chỉ dành cho environment chưa từng có assignment administrator nào. Cái giá phải trả: một environment đã xoá sạch administrator không thể "bootstrap lại"; đó đúng là hành vi mong muốn, vì "bootstrap lại" chính là cấp lại quyền.

4. **Truy vấn đo phải đếm administrator, không đếm assignment.** `revoked_at IS NULL` một mình là sai: nó tính cả role không phải administrator và bỏ qua `effective_from`/`effective_until`, hai cột mà schema ghi rõ là read-time filter. Câu chuẩn:

   ```sql
   SELECT count(DISTINCT ra.staff_id)
   FROM staff_access.role_assignments ra
   JOIN staff_access.roles r ON r.id = ra.role_id
   JOIN staff_access.staff s ON s.id = ra.staff_id
   WHERE r.kind = 'system' AND r.name = <định danh canonical>
     AND r.status = 'active'
     AND s.status = 'active'
     AND ra.revoked_at IS NULL
     AND (ra.effective_from IS NULL OR ra.effective_from <= now())
     AND (ra.effective_until IS NULL OR ra.effective_until > now());
   ```

   Đếm theo `staff_id` chứ theo số hàng: một staff có hai assignment còn hiệu lực — trạng thái schema hiện cho phép — vẫn là **một** administrator.

   Phép đo thứ hai, không có điều kiện nào ngoài danh tính role — nó trả lời "environment này đã từng có administrator chưa", không phải "hiện có bao nhiêu":

   ```sql
   SELECT count(*)
   FROM staff_access.role_assignments ra
   JOIN staff_access.roles r ON r.id = ra.role_id
   WHERE r.kind = 'system' AND r.name = <định danh canonical>;
   ```

   Không join `staff`, không lọc `status`, `revoked_at` hay cửa sổ hiệu lực: mọi lý do khiến một assignment thôi có hiệu lực đều là lý do `admins_before` giảm, và chính những lý do đó không được phép biến environment trở lại trạng thái "chưa từng có administrator". `count(*)` ở đây đếm **hàng assignment**, không đếm staff: hai assignment của cùng một staff đã từng tồn tại đều chứng minh environment đã từng có administrator, và giá trị này chỉ dùng làm ngưỡng khác 0 chứ không bao giờ được so với `admins_before` hay báo cáo như số administrator. Nó chỉ đi vào quyết định và audit, không thay cho `admins_before`.

   ⚠️ **`roles.name` không có UNIQUE, nên phép đo phải fail-closed khi định danh canonical không phân giải được thành đúng một role.** Hai hàng `roles` cùng `(kind = 'system', name = <định danh canonical>)` đều hợp lệ ở mức database, và mỗi hàng có assignment riêng thì phép đếm ở trên trộn hai role khác nhau thành một con số. Vì vậy guard đọc role theo định danh canonical trước; khác đúng một hàng → **từ chối** (`denied`, lý do `role_identity_ambiguous`), không đoán. Seed role và ràng buộc UNIQUE `(kind, name)` là yêu cầu schema của #17 (ADR-0021 Quyết định 4).

5. **Advisory lock bọc cả phép đo lẫn phép ghi, trên **một** khoá cố định dùng chung cho mọi đường ghi canonical role.** Khoá là hằng trong code, ví dụ `pg_advisory_xact_lock(hashtext('staff_access.administrator_assignment'))` — **không** dẫn xuất từ tên bước hay tên database. Lý do: guard được ADR-0023 gọi là lớp chặn **chung** của ba đường, và bootstrap (S1/S2) với recovery (bước ghi duy nhất) là hai bước khác tên; nếu mỗi bước tự chọn khoá riêng thì chúng không loại trừ nhau và một lần bootstrap chạy song song với một lần recovery vẫn đo được cùng một trạng thái cũ. Lock nằm bên trong transaction và tự nhả khi commit/rollback. Hai lần chạy đồng thời tuần tự hoá: lần thứ hai đo được kết quả của lần thứ nhất và bị từ chối theo Quyết định 3. Cùng hình dạng với advisory lock mà migration runner đã dùng (`pg_advisory_lock(hashtext('db-<name>'))`) nhưng khoá theo đường ghi thay vì theo database — đây là một khoá mới, không phải khoá của migration runner.
6. **Guard chỉ từ chối, không bao giờ tạo.** Nó không thay thế, không rút gọn và không nhân bản bước S1/S2. Nhánh "nếu chưa có admin thì tạo" vẫn bị cấm (ADR-0020 Quyết định 2, ADR-0021 Quyết định 9): việc tạo staff và gán role là hai bước cố định, và guard chỉ quyết định chúng có được chạy hay không.
7. **Entry point giữ một lớp kiểm thứ hai, không phải lớp duy nhất.** Nó vẫn kiểm trước khi gọi bước ghi — để fail nhanh và để không mở transaction khi đã biết sai — nhưng lớp đó **không** thay lớp trong Quyết định 1, và tài liệu không được trình bày nó như lớp bảo vệ chính.
8. **Ba thao tác vẫn là ba thao tác.** Bootstrap (`admins_before = 0` và `admins_ever = 0`), recovery trên một identity còn sống (`admins_ever > 0`, `mode = 'recovery'` + hai-phím — [ADR-0023](./0023-administrator-lifecycle-paths.md) Quyết định 3), và bổ nhiệm thường (`admins_before > 0`, qua permission ghi chứ không qua procedure — ADR-0023 Quyết định 2) không gộp thành một đường. Guard làm cho việc gộp chúng **không còn im lặng được**, không làm chúng trở nên hợp lệ.
9. **Phát hiện:** alert phải bắt `mode = 'bootstrap'` với `admins_before > 0` **hoặc** `admins_ever > 0`. Nếu guard hoạt động, cặp đó không bao giờ ghi được dữ liệu — nó chỉ tồn tại dưới dạng `outcome = 'denied'`; thấy nó là thấy có người đang thử, thấy nó **kèm dữ liệu đã ghi** là thấy guard đã hỏng.
10. **Transaction phải chạy ở `READ COMMITTED`** (mức mặc định của PostgreSQL). Correctness của Quyết định 5 phụ thuộc việc transaction **sau** khi lấy được lock mới thấy row mà lần chạy thắng đã commit. Ở `REPEATABLE READ` snapshot được chốt ở statement đầu tiên — chính là câu lấy lock — nên lần chạy bị chặn vẫn đọc số cũ sau khi lần thắng commit, và hai lần chạy cùng ghi. Procedure phải đặt mức này tường minh, không dựa vào cấu hình session hay `ALTER DATABASE`.

## Quan hệ với ADR-0003 và ADR-0020

- **ADR-0003 — supersede-in-part:** câu "bootstrap nghĩa là không có logic tự động phát hiện 'đã có admin rồi'" và "không có lối 'nếu đã có admin thì báo lỗi' trong procedure" **không còn hiệu lực** cho procedure ngày nay. Lý do của câu đó là procedure chỉ là SQL thủ công; nó không còn đúng khi procedure là CLI có transaction. Các phần còn lại của ADR-0003 — audit trail, cấm nút UI, `sub` phải tồn tại trước, hai-phím cho **emergency recovery**, không bypass flag — giữ nguyên.
- **ADR-0020 — supersede-in-part Quyết định 11:** cụm "kiểm tra đó thuộc entry point vận hành — không phải … trong procedure của `staff-access`" **không còn hiệu lực**. Phép kiểm thuộc critical section ghi của `staff-access`; entry point giữ một lớp kiểm phụ. Mọi phần khác của Quyết định 11 giữ nguyên, gồm cả việc **nhiều Superadmin được phép** và Superadmin thứ hai được tạo bằng role administration thông thường — ⚠️ đường đó **chưa tồn tại** (ADR-0023 Quyết định 2; #44 cho permission/enforcement/wiring, #48 cho đường tạo Account), nên hiện tại "nhiều Superadmin được phép" là điều kiện hợp lệ chưa có bề mặt thực hiện. **Ngoài Quyết định 11, ADR này còn thu hẹp Quyết định 6** — xem bullet tiếp theo.
- **ADR-0020 Quyết định 6 — supersede-in-part:** cụm "chạy lại toàn bộ procedure từ bước 1 là **cơ chế phục hồi duy nhất**" hết đúng tuyệt đối. Nó vẫn đúng cho **tiền tố hợp lệ** — trạng thái mà bước trước đã commit và bước sau chưa — nhưng ba trạng thái fail-closed (địa chỉ bootstrap bị Account khác giữ `pending`, assignment hết hạn nhưng chưa `revoked_at`, staff không `active`) không hội tụ bằng chạy lại, và một environment **đã từng** có administrator không quay lại được `mode = 'bootstrap'`. ADR-0021 Quyết định 5 và runbook ghi rõ ba trạng thái đó; ADR này thêm điều kiện `admins_ever`. Phần còn lại của Quyết định 6 — không distributed transaction, failure isolation, không xoá dữ liệu đã tạo hợp lệ — giữ nguyên.
- **ADR-0021:** Quyết định 7 trỏ về ADR này cho cơ chế guard; phần ghi `mode`/`admins_before`, alert và các câu hỏi recovery còn mở vẫn thuộc ADR-0021.

## Hệ quả

- **Chưa có gì trong số này tồn tại.** Không có CLI bootstrap, không có guard, không có advisory lock nào cho đường này, và không có alert. Toàn bộ là **yêu cầu hiện thực cho #17**.
- Guard **không** giải quyết được khoảng trống recovery trên identity đã `verified`: nó chỉ bảo đảm một lần chạy sai chế độ bị từ chối. Đường recovery đó là [ADR-0023](./0023-administrator-lifecycle-paths.md) Quyết định 3, hiện thực ở #46.
- Guard **không** thay bằng chứng về con người: `operator_ref` vẫn là tự khai; hợp đồng bằng chứng cho hai-phím là ADR-0023 Quyết định 5, và **chưa cơ chế nào được cấu hình** (#45).
- Guard **không** bảo vệ database thứ hai. Advisory lock của `staff-access` không xuyên sang `db-account`; vế Account được tuần tự hoá riêng trong transaction của nó (ADR-0021 Quyết định 2).
- ⚠️ **Guard là kiểm soát trong ứng dụng, không phải trong database.** Ai có credential owner/migrator và chạy `INSERT` thô vào `staff_access.role_assignments` sẽ **không** đi qua guard — nó không phải một trigger, và PR này không thêm trigger nào. Đường đó bị chặn bởi custody credential, không bởi ADR này: `AGENTS.md` cấm credential owner/migrator trở thành Worker secret, và runbook §5 invariant 11 cấm dùng credential database trong phiên tương tác (ADR-0021 Quyết định 5). Vì vậy "guard không bypass được" đúng cho **mọi đường chạy được phép** (entry point `tools/`, CLI của service, route quản trị), không đúng cho một người giữ owner credential cố tình ghi tắt — và câu đó không được trình bày rộng hơn thực tế. Trigger chặn ghi tắt cho **riêng** bảng assignment administrator là một lựa chọn chưa được quyết; nó không thuộc phạm vi #11.

## Cross-reference

- **SR/T-**: SR-009, SR-016 · T-11 · AC-016 ([`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md)).
- **Thiết kế:** [`domain-model.md`](../domain-model.md) §6, §8 invariant 6/9, §9 · [`applications/staff-access/03-operations.md`](../../../applications/staff-access/03-operations.md) §2–§3.
- **System:** [`architecture/02-delivery.md`](../../../architecture/02-delivery.md) §3.2 · [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) invariant 36.
- **Hiện thực:** #17 (Account đầu tiên + staff đầu tiên) · #44 (bổ nhiệm thường) · #46 (recovery trên identity đã `verified`).
- **Index:** [`./README.md`](./README.md).
