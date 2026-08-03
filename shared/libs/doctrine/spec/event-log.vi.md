---
title: "Subsystem: Event Log"
status: design-end-state
canonical-sha: 5b9d37680001
---

# Subsystem: Event Log

## 1. Bản chất

- **Append-only, immutable, per-tenant.** Entry = (id, **dòng nó thuộc về và vị trí của nó trong dòng đó**, thời điểm, loại, **schema-version của entry**, actor identity đầy đủ, tham chiếu entity@version, **`run_kind: production | test` + `test_run_id` khi là test**, payload) — engine upgrade không viết lại log cũ: reader tolerant theo schema-version, projection rebuild xuyên version. Payload nhỏ nằm inline; payload lớn = hash trỏ sang Artifact Store — log giữ _sự thật_, store giữ _bytes_ (nhất quán Artifact Store §1).
- Dòng (stream) và vị trí (position) là trường của entry chứ không phải thuộc tính của cách lưu, vì phần còn lại của tài liệu này đã đọc chúng rồi: thứ tự toàn phần ở §2 **chính là** vị trí trong một dòng, và bảng failure-mode phát hiện mất segment bằng "khoảng trống trong dãy position". Một khóa mà hai mục khác dựa vào thì phải nằm trong schema mà chúng dựa vào nó thông qua.
- Taxonomy loại entry **mở**: task-state, attempt, judgment, violation, conflict, escalation, effect, handoff, trigger-in, GC, config-change… Cơ chế "tự siết T_high phát event audit" (Checkpoint §4) có nhà chính thức tại đây — mọi thay đổi hành vi runtime của engine đều là một entry.

## 2. Ordering

- **Total order theo stream** (mỗi task/session/instance là một stream, single-writer — đúng cấu trúc đã có: node là single-writer của session, engine của task) — không đòi global clock.
- Quan hệ nhân quả xuyên stream đi qua tham chiếu provenance/handoff — logical ordering + timestamp, không phải đồng hồ toàn cục.

## 3. Projections — luật một nguồn sự thật

Mọi view đều là projection, **rebuild được từ log**, không được trở thành nguồn sự thật thứ hai.

**Luật `run_kind`**: entry mang `run_kind` (§1); **mọi projection phải khai tường minh lập trường của mình với nhãn này** — engine ép trường khai tồn tại, không có mặc định im lặng. Án văn: Test Harness §1 khai hệ quả cho 4 consumer (calibration / metering / DataTable / effect) nhưng nhãn không có nhà ⇒ hai kỹ sư sẽ lọc ở hai chỗ khác nhau, và một projection mới viết sau sẽ **quên lọc**. Lập trường mặc định của các projection đã biết:

| Projection                   | Lập trường với `run_kind: test`                                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metering / cost              | **Loại** khỏi số tính tiền; nhưng chi phí thật đã phát sinh (token, CPU sandbox) vẫn đo riêng — nó _có_ xảy ra                                                                                                   |
| Quota / mức tiêu thụ         | **Hai lập trường, không phải một**: bộ đếm kế hoạch **loại**, bộ đếm tài nguyên **tính đủ** — "không tính vào gói" và "không tốn gì" là hai câu khác nhau, chỉ câu đầu đúng với test run (Quota & Scheduling §4) |
| Calibration input            | **Loại tuyệt đối** (Calibration §2 — biên cứng của flywheel)                                                                                                                                                     |
| DataTable & Labor Analytics  | Tách theo nhãn; bảng production **không thấy** write của test run                                                                                                                                                |
| Audit export · Search        | **Gồm**, có nhãn — test run là sự thật lịch sử, không phải thứ cần che                                                                                                                                           |
| Notification feed            | **Loại** mặc định (khỏi làm ồn hàng đợi chú ý — invariant 3)                                                                                                                                                     |
| Kiểm kê runtime image        | **Gồm**, có nhãn — "ai hỏng nếu image này thôi resolve được"; test run đang pin nó cũng hỏng (Runtime Sandbox §7)                                                                                                |
| Phễu & lưu lượng clickstream | **Tách theo nhãn** — số phễu production không thấy sự kiện của test run; một lượt truy cập tổng hợp không phải một visitor, và số liệu ở đây vốn là ước lượng có lấy mẫu (Clickstream Ingest §8)                 |

**Kiểm bằng máy, không bằng cẩn thận**: **mọi projection đều mang một negative test** — chạy fixture có entry `run_kind: test`, khẳng định **số production không đổi**. Projection mới không kèm negative test = **fail suite phân xử nó = chặn merge về cấu trúc** (playbook giao hàng (không công bố) §3). Án văn: lập trường "khai tường minh" là một _lời dặn_ nếu không ai kiểm — và đây đúng là lớp lỗi **im lặng** (quên lọc thì không ai thấy), nên nó phải bị bắt ở CI, không ở production.

**Nghĩa vụ đi theo projection, không đi theo ◆G0.** Gate đó đóng băng schema entry và các hợp đồng storage-port, và scope suite của nó đóng kín với mọi thứ khác (ADR-0008 §4.2) — projection không nằm trong cái nào, nên đặt kiểm tra ở đó là đặt một kiểm tra không ai thêm được. Nó đáp xuống thứ vốn đã phân xử chính projection ấy: suite read-API của **◆G4** với projection mà gate đó phơi ra, còn lại là arbiter riêng của projection, đúng khuôn mẫu ADR-0008 §4.3 đặt cho hành vi không gate nào đóng băng. Nghĩa vụ không đổi — chỉ vật mang đổi, và giờ là vật mang giữ nổi nó.

| Projection                      | Là gì                                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Metering / cost**             | Tổng hợp cost function theo (role, filler, task) — chính là "metering là cơ chế" của North Star §8; pricing là policy đặt trên projection này |
| **Audit export**                | Đóng gói log theo chuẩn compliance — nội dung EE là _bao bì_, dữ liệu là core                                                                 |
| **Search / query index**        | Tìm instance, artifact, judgment — index dựng từ log, hỏng thì rebuild                                                                        |
| **Notification feed**           | Escalation §8 đã chốt "notification chỉ là surface rendering" — render từ entry escalation, không hệ song song                                |
| **Calibration input**           | Lớp C đọc judgment/outcome/conflict từ log — một lõi ML ăn từ một nguồn                                                                       |
| **DataTable & Labor Analytics** | Bảng ghi được (mỗi write = event) và metric lao động — Working Data spec; time-travel theo log-position                                       |

## 4. Retention & quyền được quên

- **Entry metadata: vĩnh viễn** (đó là lịch sử). Payload lớn theo retention của Artifact Store ("hash vĩnh viễn, bytes theo policy").
- Nghĩa vụ xóa pháp lý (GDPR-erasure) hòa giải với append-only bằng **crypto-shredding**: payload nhạy cảm mã hóa theo khóa data-subject; xóa = hủy khóa — log không bị đục, dữ liệu không đọc được nữa, và chính hành động hủy khóa cũng là một entry. (Danh tính data-subject: Tenant & Identity §6.)
- **Khóa nằm NGOÀI đường sao lưu dữ liệu** — đóng lỗ giao thoa `backup/restore × erasure`: key store là subsystem tách biệt (Vault tầng 1 — ledger), **backup của log / blob / projection không bao giờ chứa khóa data-subject**. Khôi phục một bản sao lưu cũ hơn thời điểm shred **không** hồi sinh khả năng đọc, vì khóa đã chết ở nơi khác. Escrow khóa (nếu tenant bật) là **opt-in tường minh có án văn**, và một lệnh shred **bắt buộc áp cùng lượt lên mọi bản escrow** — không tồn tại bản khóa nào ngoài tầm shred. **Luật loại bản sao**: cấm-mọi-_nơi_ chưa đủ, phải cấm cả một _loại_ bản sao — mọi bản sao key material chỉ được là **replica tiến-lên-trước** (lệnh `destroy` replicate được tới nó); **snapshot / rewind point-in-time của key store bị cấm**, vì khôi phục snapshot về trước thời điểm shred hồi sinh đúng khóa đã hủy — mở lại lỗ này ở một cửa khác. Chiều ngược cũng là cơ chế, không phải vận hành: **root key và tenant DEK bắt buộc có đường DR tách biệt**, nếu không "khôi phục backup" là lời hứa suông (canonical: Vault §3). Mọi thao tác tạo / xoay / escrow / hủy khóa là entry. Hệ quả cần nói thẳng: _quyền được quên là thuộc tính của **vòng đời khóa**, không phải của bản sao dữ liệu_ — hệ nào đặt khóa cạnh dữ liệu thì mọi lời hứa xóa đều là lời hứa suông.

## 5. Durable execution & timer

- Durable execution là hệ quả của log: trạng thái dựng lại bằng replay stream. **Timer/SLA/lease-TTL đăng ký như entry** — engine restart thì phát lại từ log, không có timer sống trong RAM ai đó quên.

## 6. Truy cập

- Đọc theo quyền ngữ cảnh (tham gia process, capability); không endpoint công khai. Xuất log ra ngoài = external effect, chịu egress theo classification.

## 7. Non-goals

- Không phải message bus tổng quát cho ứng dụng ngoài; không phải kho analytics thay thế (analytics = projection).
- Không có nguồn sự thật thứ hai — bảng trạng thái nào "tự ghi" ngoài log là vi phạm thiết kế.
- **Không phải đường ghi duy nhất, và không phải đường mà clickstream đi.** Lưu lượng web ghi vào tier clickstream ingest — một dòng riêng, có TTL, không hứa đầy đủ cũng không hứa vĩnh viễn (Clickstream Ingest §1). Đó không phải nguồn sự thật thứ hai: chủ thể của nó là lưu lượng chứ không phải lao động, không quyết định lao động nào được đọc nó, và cửa băng qua duy nhất là conversion — vào đây như một entry trigger thông thường, không lấy mẫu (Clickstream Ingest §2).

## 8. Nhật ký quyết định

| Vấn đề                             | Chốt                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vai trò                            | Nguồn sự thật duy nhất; mọi view là projection rebuild được                                                                                                                                                                                                                                                                                                                     |
| **Đường ghi thứ hai**              | Clickstream là một dòng riêng chứ không phải một nhãn kiểu `run_kind` ở đây: nó lệch ở vòng đời, ở loại sự thật, và ở việc ai định khối lượng. Nhà canonical: Clickstream Ingest §1                                                                                                                                                                                             |
| Ordering                           | Total order theo stream single-writer + nhân quả qua tham chiếu; không global clock                                                                                                                                                                                                                                                                                             |
| Metering/audit/search/notification | Đều là projection — bốn khái niệm lơ lửng có nhà trong một quyết định                                                                                                                                                                                                                                                                                                           |
| Backup × quyền được quên           | Khóa sống ngoài đường backup dữ liệu; escrow opt-in nhưng chịu cùng lệnh shred — restore không phải vùng trắng                                                                                                                                                                                                                                                                  |
| **Loại bản sao khóa**              | Chỉ replica tiến-lên-trước; **cấm snapshot point-in-time key store**; root/tenant-DEK bắt buộc có DR. Án văn: cấm-mọi-nơi không đủ nếu một _loại_ bản sao rewind được                                                                                                                                                                                                           |
| Append-only vs quyền được quên     | Crypto-shredding: hủy khóa, không đục log; hành động hủy cũng là entry                                                                                                                                                                                                                                                                                                          |
| Timer                              | Là entry, replay được — không timer ngoài log                                                                                                                                                                                                                                                                                                                                   |
| **Nhãn `run_kind`**                | Nhà canonical ở đây (entry §1 + luật projection §3); mọi projection **khai lập trường**, không có mặc định im lặng, **và chịu negative test bắt buộc trong suite phân xử chính projection đó** — suite read-API của ◆G4, hoặc arbiter riêng của projection (§3). Án văn: nhãn không có nhà ⇒ projection viết sau sẽ quên lọc; khai mà không kiểm ⇒ vẫn quên, chỉ là quên có chữ |

## Litmus (spec-level, theo L5)

1. Mọi projection (metering/search/notification/table/calibration-input) rebuild từ log ra kết quả tương đương?
2. Restart giữa chừng — mọi timer/SLA/lease phát lại đúng qua replay?
3. Crypto-shredding vô hiệu hóa đọc PII mà không đục một entry nào?
4. Khôi phục một backup **cũ hơn** lệnh shred — dữ liệu của data-subject đó vẫn không đọc được (kể cả bản escrow)?
5. Viết một projection **mới** và cố tình quên khai lập trường với `run_kind`: conformance suite phân xử projection đó **chặn merge** — hay nó chỉ lộ ra khi số production đã sai trên tenant thật?

## FMEA (theo F8)

| Hỏng                             | Phát hiện                                  | Phục hồi                                                                                                                         |
| -------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Segment log mất/corrupt          | Checksum + gap ở position                  | Restore backup **+ root key từ đường DR (Vault §3(b))** → replay; projection rebuild                                             |
| **Mất toàn bộ máy (đĩa chết)**   | Không unwrap được DEK nào sau restore      | Chỉ khôi phục được nếu **root key có đường DR** — không có = mất vĩnh viễn, và đó là **thiết kế đã khai**, không phải sự cố ngầm |
| Projection drift                 | Checksum đối chiếu log-position            | Rebuild từ log + event cảnh báo                                                                                                  |
| Timer bị miss sau restart        | Replay quét entry đến hạn                  | Phát lại — timer là entry, không sống trong RAM                                                                                  |
| Ghi trùng (at-least-once)        | Event-id dedup                             | Idempotent, bỏ bản trùng                                                                                                         |
| Restore backup cũ hơn lệnh shred | Key store tách biệt: khóa đã hủy vĩnh viễn | Dữ liệu vẫn không đọc được; entry hủy khóa còn nguyên trong log                                                                  |
