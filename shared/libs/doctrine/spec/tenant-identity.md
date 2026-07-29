---
title: "Ecoma Spec: Tenant & Identity"
status: design-end-state
lang: vi
---

# Ecoma Spec: Tenant & Identity

## 1. Principal — một schema danh tính cho mọi tác nhân

Mọi entry trong Event Log mang **principal identity**; taxonomy mở, các loại chuẩn:

| Loại | Danh tính | Đã định nghĩa ở | |---|---|---| | `user` — người trong tenant | **Pseudonymous stable id** (bất biến vĩnh viễn) + PII mapping tách riêng (§6); xác thực qua auth adapter (SSO = EE extension point) | Spec này | | `agent` | (model, version, config_hash) + lineage | Role §3 | | `rule` | (code, version) | Role §3 | | `node` | Device keypair + enrollment | RPA NS topology | | `external` — bên ngoài qua Channel | Channel identity → hợp nhất thành **Party** (§5) | Trigger §3 |

Đổi nhà cung cấp SSO = đổi auth adapter — **actor-id trong log không bao giờ đổi**.

## 2. Tenant — ranh giới cứng duy nhất

- **Cardinality ≥ 1**: mọi khái niệm namespace theo tenant (thư viện entity, calibration, cascade, lockfile, blob namespace, event log). Self-host = tenant đơn; Cloud = N tenant — **không nhánh code nào khác nhau** (đã chốt §8 North Star).
- Tenant là ranh giới của: sở hữu dữ liệu, học (invariant 4), mã hóa, dedup, egress mặc định.

## 2b. Vòng đời tenant — provision → active → suspended → export → purge

Tenant là entity, nên có vòng đời như mọi entity (không phải khái niệm vận hành của riêng SaaS — D5):

| Giai đoạn | Cơ chế | Ghi chú | |---|---|---| | `provision` | Là **một process ecoma** (North Star §8): tạo namespace log/blob, khóa gốc, workspace mặc định, user đầu tiên lấp Role quản trị | Self-host chạy đúng process đó với cardinality 1 | | `active` | Trạng thái thường | |
| `suspended` | Engine ép **trạng thái tồn tại**; lý do (quá hạn, lạm dụng, yêu cầu của tenant) là **policy** | Suspended = **đóng băng ghi**, không xóa: trigger từ chối tại biên, node từ chối claim, task đang chạy đi đường `escalate/halt` — **không bao giờ auto-pass hay tự hủy** (invariant 5). Đọc/export vẫn được theo policy | | `export` | **Task của Role có Gate**: audit export + BYO-export projection + blob theo classification (Working Data §4, Artifact Store §6) — egress chịu classification như mọi effect | Quyền mang dữ liệu đi là cơ chế, không phải thiện chí của nhà vận hành | | `purge` | Hủy **khóa gốc tenant** (crypto-shredding, Event Log §4 — gồm mọi bản escrow) → GC blob namespace theo tham chiếu → entry cuối cùng ghi vào log của **nhà vận hành**, không phải log đã chết | Không đảo ngược được; engine ép `export` hoàn tất hoặc khai từ bỏ tường minh trước khi cho purge |

- Mọi chuyển trạng thái là **event có actor** — không có đường đổi trạng thái tenant ngoài log.
- Nợ đã trả: đây là ô `sunset` (P1) và `delete` của entity-tenant (P2) trong checklist vòng đời.

## 2c. Cardinality theo hình thái — engine đa-tenant, cài đặt self-host đơn-tenant

| Vế | Luật | Án văn | |---|---|---| | **Engine luôn tenant-aware** | Cây khoá root→tenant-DEK→subject · log per-tenant · RBAC scope · dedup chỉ trong tenant · metering per-tenant. **Tầng tenant tồn tại VẬT LÝ kể cả khi N=1** | Bỏ tầng tenant "cho gọn khi chỉ có một" biến mọi lần chuyển sang đa-tenant thành **migrate toàn bộ khoá** — và đó là loại migrate không có đường lùi | | **Self-host = đúng 1 tenant** | Không có workflow tạo tenant thứ hai, vì **workflow provisioning chỉ ship trong `cloud/`** | **Cap là BIÊN SẢN PHẨM, không phải license check.** North Star §7 cấm thẳng: _runtime không bao giờ kiểm entitlement, không license key, không phone-home_. Engine về kỹ thuật giữ được N tenant; đơn giản là không có gì ship ra để tạo cái thứ hai | | **Đa-tenant không cấp năng lực** | Hai tenant trên một cài đặt ≡ hai cài đặt riêng **về mọi mặt sản phẩm** | **Invariant 4** cấm học chéo tenant ⇒ không chung calibration/memory/knowledge. Khác biệt duy nhất là **một cụm hạ tầng thay vì hai** — tức tiết kiệm _vận hành_, đúng thứ một nhà cung cấp SaaS bán | | **Invariant 4 áp cả operator Cloud** | Operator **được** gộp metering xuyên tenant. Operator **KHÔNG BAO GIỜ** được định tuyến knowledge / memory / calibration xuyên tenant | Code thi hành nằm trong repo private mà người ngoài **không audit được** ⇒ ranh giới phải khai công khai và có litmus, nếu không nó chỉ là lời hứa |

**Hệ quả tốt, đáng ghi**: vì đa-tenant không thêm năng lực, **conformance suite chạy trên self-host là đủ để chứng minh engine đúng**; `cloud/` chỉ bọc thêm provisioning + billing + fleet. Phần private vì thế **nhỏ và tẻ nhạt** — đúng thứ ta muốn: cái đáng ngờ thì công khai, cái riêng thì nhàm. Nếu đa-tenant nằm ở Enterprise thì ngược lại: phần rủi ro nhất lại là phần bán đắt nhất và ít mắt nhìn nhất.

## 3. Workspace — phân vùng mềm trong tenant

- Workspace = **vách ngăn tổ chức** (agency: mỗi client một workspace): scope cho visibility/grant, và **một chiều trong calibration key** (trả nợ ledger: agency tách chất lượng theo client).
- **KHÔNG PHẢI BIÊN AN NINH — nói thẳng, ở đây và ở mọi trang bán hàng**. Workspace là biên **quản trị và hiển thị**. Trong cùng một tenant: artifact **dedup được phép** (chỉ cross-tenant mới cấm — Artifact Store §4), cùng **một** tenant DEK, cùng namespace log. Một agency phục vụ hai brand đối thủ mà nói _"dữ liệu hai bên cách ly"_ là **nói sai**. Câu đúng: _"dữ liệu của bạn không rời khỏi cài đặt của agency"_ — agency là bên kiểm soát dữ liệu, đúng như mọi quan hệ agency–client bình thường. Đường nâng cấp tự nhiên và có thật: **cần biên an ninh ⇒ cần tenant ⇒ cần cài đặt thứ hai hoặc Cloud.**
- **Không phải ranh giới cứng**: tenant vẫn là biên mã hóa/học; chia sẻ xuyên workspace = grant tường minh. Gộp hay tách learning xuyên workspace là **giá trị template** (engine ép chiều tồn tại — agency tự chọn pool chung hay riêng).
- n=1: một workspace mặc định, vô hình (K1).

## 4. Một hệ phân quyền duy nhất — quản trị cũng là lao động

- **Không có "loại user admin"**: admin = người (hoặc về cơ chế, cả agent — đối xứng; template mặc định đòi human) **lấp một Role có capability quản trị**: `enroll_node`, `approve_code`, `manage_membership`, `grant_capability`, `manage_workspace`… — taxonomy capability mở sẵn có (Role §2) nay ôm luôn quản trị.
- **Process owner** = một Role khai trong Process definition (mặc định của Arbiter/terminal handler — trả nợ Handoff §4, Escalation §3); template cấp mặc định = người tạo definition.
- Hành động quản trị = **Task có Gate như mọi lao động** (duyệt enrollment, cấp quyền — có dấu vết, có duyệt, dogfooding trọn).
- **Duyệt-xem ngoài task** (trả nợ Knowledge §2, Artifact Store §6): quyền xem của một user = **hợp của các grant thuộc những Role mà user nằm trong pool** — không danh sách ACL thứ hai. Đọc nội dung theo mức mật sinh **read-event** (engine ép tham số ghi-đọc tồn tại theo mức; template cấp giá trị — `secret` mặc định ghi mọi lần đọc).
- Membership (user vào tenant/workspace/pool của Role) là event — thay đổi quyền có lịch sử đầy đủ.
- **Console vận hành của Cloud là BỀ MẶT trên chính hệ này, không phải hệ user thứ hai**. `cloud/` ôm quản trị nội bộ (tạo tenant, quản user, cấu hình SaaS) — nhưng nhân viên vận hành **lấp một Role có capability quản trị** y hệt mọi người khác, và mọi hành động của họ là **Task có Gate, có dấu vết**. Dựng một bảng user riêng cho operator là dựng **nguồn sự thật thứ hai về danh tính** (E5) và phá thẳng luật "không có loại user admin" ở ngay trên. Đây là ràng buộc trần đặt lên `cloud/`, không phải lựa chọn của `cloud/`.

## 5. Party — hợp nhất danh tính bên ngoài

- **Party** = một con người/tổ chức bên ngoài, hợp nhất nhiều channel identity (messenger id, email, số điện thoại). Party là **subject của Memory** và **data-subject** của erasure.
- **Merge là Task có Gate, không bao giờ tự động** — án văn: merge sai hai channel identity = rò memory của người này cho người kia (phạm cross-subject isolation, Memory §4). Hệ thống chỉ được _đề xuất_ merge; quyết là lao động có dấu vết. Merge/split có **lineage** — gỡ được khi phát hiện sai. **Ngoại lệ có án văn — self-assertion**: chủ thể tự chứng minh sở hữu identity kia bằng _xác thực_ (verify email/OTP khi signup từ kênh đã tương tác) → hợp nhất không cần Gate — bằng chứng là xác thực, không phải suy đoán; vẫn là event có provenance, vẫn gỡ được qua lineage (consumer đầu tiên: Website Charter §4).
- Calibration trên external party: cơ chế tồn tại, mặc định tắt (đã chốt Trigger §3) — nhắc lại vì đây là nhà của quyết định đó.

## 6. Data-subject & quyền được quên — audit sống, người được quên

- **Actor-id trong log là pseudonymous và vĩnh viễn** — không bao giờ shred (audit là sản phẩm). **PII mapping** (tên, email, avatar ↔ id) nằm bảng riêng, mã hóa theo khóa data-subject.
- Erasure (nhân viên nghỉ + GDPR, khách chat đòi quên) = **crypto-shredding khóa của party/user đó** (Event Log §4): mapping chết, payload cá nhân chết; cấu trúc lao động (ai-duyệt-gì dưới dạng pseudonym) sống nguyên. Hành động hủy khóa là một event.
- Ranh giới tường minh: **work product thuộc tenant** (artifact, judgment); _danh tính cá nhân_ thuộc data-subject. Hai thứ tách được nhờ pseudonym — không phải nhờ lời hứa.
- **Backup không phải vùng trắng của erasure**: khóa sống ngoài đường sao lưu dữ liệu, escrow chịu cùng lệnh shred — luật canonical tại **Event Log §4**.

## 7. Cộng tác bên ngoài — không có "guest user" hạng hai

Client của agency duyệt deliverable, ứng viên xác nhận lịch, đối tác ký nháy — **tất cả là external filler lấp một Role qua Channel** (portal/magic-link cũng chỉ là một channel): reply = task output, đi qua Gate, có provenance. Không tài khoản tenant, không hệ guest riêng — văn phạm external-participant (Trigger §3) đã phủ trọn, spec này chỉ đóng đinh: **mời người ngoài tham gia = gán họ vào Role, không phải cấp account.**

## 8. EE extension points (engine khai báo, EE cấp implementation)

`authn_provider` (SSO/SAML/OIDC), `scim_provisioning` (đồng bộ membership — mỗi thay đổi vẫn là event), `audit_packaging`, `pii_vault_backend` (khóa data-subject do tenant tự quản), `calibration_visibility_policy` (ai xem được calibration về người — dữ liệu đánh giá lao động nhạy cảm, mặc định template: chỉ Role có capability `view_calibration` trong scope).

## 9. Zero-config (K1)

n=1 không thấy gì trong spec này: tenant=1, workspace=1 vô hình, user đầu tiên lấp mọi Role quản trị theo template, party sinh tự nhiên từ channel. Mọi khái niệm chỉ _hiện ra_ khi tổ chức lớn lên — không rewrite (đúng luận điểm tăng trưởng North Star §2).

## 10. Non-goals

- Không hệ ACL/RBAC thứ hai ngoài Role+capability+grant; không "guest account".
- Không auto-merge party trong mọi cấu hình mặc định.
- Không shred actor-id/cấu trúc lao động — chỉ shred PII payload + mapping.
- Không tự xây IdP — authn là adapter.

## 11. Litmus

1. n=1 zero-config: mọi khái niệm spec này vô hình?
2. Nhân viên nghỉ + đòi quên: audit trail nguyên vẹn dạng pseudonym, PII chết bằng một lệnh hủy khóa?
3. Có đường nào merge hai channel identity mà không qua Gate?
4. Client agency duyệt deliverable không cần tài khoản tenant?
5. **Falsifiable**: chỉ ra một quyền không biểu diễn được bằng Role + capability + grant?
6. Đổi SSO provider — actor-id trong log bất biến?
7. Tenant bị suspend giữa 50 task đang chạy: không task nào auto-pass, không dữ liệu nào bị xóa, export vẫn chạy được?
8. Cài đặt self-host: có **đường nào** tạo tenant thứ hai không — và nếu không, engine từ chối vì **thiếu workflow** hay vì **kiểm entitlement**? (bắt buộc: thiếu workflow; kiểm entitlement là vi phạm §7 của trần)
9. Trên Cloud: operator có đường nào khiến knowledge/memory/calibration của tenant A ảnh hưởng tenant B — kể cả gián tiếp qua một model "tối ưu chung"? Và console vận hành có **bảng user riêng** không, hay nhân viên vận hành cũng chỉ là người lấp một Role?
10. Cài đặt N=1: **tầng tenant còn tồn tại vật lý trong cây khoá** không, hay nó đã bị gộp đi "cho gọn"?

## 12. Nhật ký quyết định

| Vấn đề | Chốt | |---|---| | Hệ phân quyền | Một và duy nhất: Role + capability + grant; admin/process-owner = Role được lấp; quản trị = lao động có Gate | | Workspace | Vách mềm: scope grant + chiều calibration; tenant mới là biên cứng; pool learning xuyên workspace là template value | | Party | Merge qua Gate có lineage — án văn: merge sai = rò memory chéo người | | Quyền được quên | Pseudonymous actor-id vĩnh viễn + PII mapping shreddable — audit sống, người được quên | | Người ngoài | External filler lấp Role qua Channel — không guest account | | Duyệt-xem ngoài task | Hợp grant của các Role trong pool + read-event theo mức mật | | SSO/SCIM | Adapter/extension point EE; membership change vẫn là event; actor-id độc lập IdP | | Vòng đời tenant | provision(process) → suspended(đóng băng ghi, không auto-hủy) → export(Task có Gate) → purge(hủy khóa gốc + GC) — §2b |
