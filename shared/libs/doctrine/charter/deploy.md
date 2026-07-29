---
title: "Ecoma — Deploy & Operations Charter (System Charter)"
status: design-end-state
lang: vi
---

# Ecoma — Deploy & Operations Charter (System Charter)

## 1. Ranh giới — ba phân vùng, ba nhà, cấm trộn

| Nhà | Nội dung | Ship cho self-host? | License | |---|---|---|---| | **`deploy/`** | Thứ một self-hoster **nhận và chạy**: compose, Helm chart, systemd unit, installer, migration runner, mẫu cấu hình edge router | ✅ | SUL | | **`cloud/`** | IaC + control plane của **nhà vận hành Cloud**: fleet, billing, quota ops, provisioning tự động | ❌ | Proprietary, không public | | **`shared/tools/`** | Tooling của **người phát triển**: dev-cli, lint rules, repo-care | ❌ (không phải artifact sản phẩm) | SUL | | **`<area>/enterprise/`** | Tính năng cấp doanh nghiệp cho **self-host**: SSO, audit export, retention sâu, RBAC nâng cao — **không** chứa đa-tenant | ✅ (cần license) | Enterprise, tag `license:ee` |

**Single-tenant là thuộc tính của HÌNH THÁI, không phải giới hạn kỹ thuật của engine**: mọi cài đặt self-host (SUL lẫn Enterprise) chạy **đúng một tenant**, vì workflow tạo tenant thứ hai chỉ ship trong `cloud/` — **không** vì runtime kiểm quyền (North Star §7 cấm). Engine vẫn giữ nguyên tầng tenant trong cây khoá kể cả khi N=1 (Tenant §2c). Charter này vì thế **không** khai gì về provisioning đa tenant — đó là việc của `cloud/`.

**Luật một câu — litmus của chính ranh giới này**: _mọi file trong `deploy/` phải hữu dụng với một người tự cài; file nào chỉ **chúng ta** cần là đang đặt sai chỗ._

**Án văn**: phân vùng sai theo hướng này (IaC nội bộ lọt vào `deploy/`) là **trao hạ tầng vận hành cho đối thủ**; sai theo hướng kia (thứ self-hoster cần nằm trong `cloud/`) là **fair-code trên giấy** — người tự cài không dựng nổi hệ. Đây là lý do ranh giới phải là _ba_, không phải hai: tooling của đội từng là chỗ trú ẩn của cả hai loại nhầm.

## 2. Hình thái cài đặt — lời khai quy mô, không phải công tắc

Hai hình thái (ADR-0002), mỗi hình thái ship một bộ khác nhau:

| Hình thái | Storage default | Ship gì | |---|---|---| | **Small-stack** — một binary / một container | SQLite + DuckDB, vault file-based | Binary/imagem, unit file, mẫu cấu hình, migration runner | | **Production** — compose / Helm | Postgres (+pgvector, +Timescale), vault backend ngoài | Chart/compose, mẫu secret, migration runner, mẫu edge router |

- **Hình thái là lời khai quy mô của người cài**, không phải một cờ đổi lúc chạy. Đổi hình thái = **grow-path = replay log sang port mới**, một thao tác có chủ đích, **không bao giờ tự động**.
- Charter **không** khai contract của storage port — đó là ADR-0002 + Working Data.

## 3. Artifact ship và cách chúng đi cùng nhau

- **Server** · **node runtime headless** · **lớp UI attended** (ADR-0005) · **mẫu cấu hình edge router** (mount `/`, `/hub`, `/app`, `/design` + 3 điều kiện an ninh khi dùng chung domain — web charter §3b).
- **Tất cả mang cùng một `train_version`** (Release & Compat §1). Installer **từ chối** cài một bộ lệch train.
- Trên máy attended: hai artifact, cùng train — lớp UI kiểm lúc bắt tay nội-máy và **từ chối chạy** nếu lệch (Release & Compat §8). **Giao thoa #3 đã đóng.**
- Artifact thiếu `train_version`/`source_digest`/`provenance`/chữ ký ⇒ **từ chối cài**, không có chế độ "cài tạm".

## 4. Khóa & khôi phục — bốn nghĩa vụ từ blocker Đây là phần nặng nhất của charter. Luật gốc ở Vault §3 (ba vế: ngoài-backup · DR bắt buộc cho root/tenant-DEK · chỉ replica tiến-lên-trước). Charter khai **thủ tục**.

### 4.1 Sinh và xác nhận root key

Provisioning phát root key **một lần**, rồi **đòi thử thách checksum** trước khi cho cài đặt vào trạng thái phục vụ. Kết quả là entry. Thủ tục viết ra phải nêu **chính xác chỗ cất** theo hình thái, không nói chung chung:

| Hình thái | Đường DR của root key (tách khỏi backup dữ liệu) | |---|---| | Small-stack | Một **bản in/ghi ngoài máy** (password manager, phong bì niêm phong, USB cất rời) — thủ tục nêu ít nhất một lựa chọn cụ thể, không để người dùng tự nghĩ | | Production | KMS/HSM có **replica tiến-lên-trước** (destroy replicate được), **không snapshot point-in-time** — tư cách backend kiểm ở §4.4 |

### 4.2 Khôi phục trên máy trắng

Thủ tục phải chạy được theo đúng thứ tự: dựng máy mới → **nạp root key từ đường DR** → restore dữ liệu → replay → kiểm chứng bằng một truy vấn đọc được dữ liệu **chưa** shred. **Không có root key ⇒ engine nói thẳng "không thể khôi phục"**, không giả vờ khởi động được.

### 4.3 Gate: backup không được chạm khóa

Một lệnh mới của dev-cli — **`check-backup-key-isolation`** — chạy trong job `checks` và pre-commit: quét mọi script/manifest/chart trong `deploy/` và **fail** nếu có đường nào phủ lên vị trí root key theo bất kỳ hình thái nào. Lệnh này **chưa tồn tại** — nó sinh cùng lúc với thư mục `deploy/` và được ghi vào chuỗi PR của kế hoạch handoff (không để nó thành một lời dặn không ai nuôi). Đây là hiện thực hoá litmus #4 của Vault. _Lời dặn "đừng backup khóa" không phải cơ chế; một gate đỏ thì là._

### 4.4 Tư cách của backend key store

Tài liệu deploy **khai tường minh** backend nào đủ tư cách chạy crypto-shredding: `destroy` **không khôi phục được** **và** không cung cấp (hoặc cho phép tắt) **snapshot/rewind point-in-time**. Backend có recovery-window bắt buộc chỉ hợp lệ nếu cửa sổ đó khai được và **lệnh shred chỉ báo hoàn tất sau khi cửa sổ đóng**. Backend không đạt ⇒ engine **từ chối vai crypto-shredding**, không hứa thứ mình không làm được.

## 5. Backup & restore

**Cái gì vào backup**: event log · artifact blob · (tùy chọn) projection — projection rebuild được nên backup nó chỉ để nhanh, không để đúng.
**Cái gì KHÔNG BAO GIỜ vào backup**: **key material**, mọi tầng (Vault §3 vế a).

**Retention × support window — giao thoa #1 đã đóng**: retention **không được dài hơn** support window của Release & Compat §6, **trừ khi** charter khai một **restore path** tường minh (nâng backup cũ qua chuỗi migration tuần tự, và path đó phải được diễn tập). Giữ backup 5 năm trong khi chỉ hỗ trợ 2 major = đang giữ một lời hứa không thực hiện được. **Gate**: cấu hình retention vượt support window mà thiếu khai restore path ⇒ cảnh báo lúc khởi động, không im lặng.

**Diễn tập restore là bắt buộc và là entry**: một cài đặt chưa từng restore thử thì backup của nó là **giả thuyết**, không phải bảo hiểm. Thủ tục nêu chu kỳ tối thiểu và **ghi kết quả diễn tập vào log**.

## 6. Upgrade & rollback — thủ tục

Khớp 4 pha của Release & Compat §4 (cài cạnh → migrate → cutover → giữ). Charter thêm phần người bấm:

**Preflight bắt buộc, trước khi chạm gì**: kiểm train version đồng bộ mọi artifact · kiểm **mọi migration major trong bước này có `down` hoặc cờ `irreversible_migration`** · nếu có cờ thì **đòi Gate + bản sao** trước khi đi tiếp · kiểm backup gần nhất đã diễn tập.

**Hai đường lùi khác nhau, gọi đúng tên — giao thoa #2 đã đóng**:

| Trong cửa sổ rollback | Ngoài cửa sổ | |---|---| | **Rollback**: chạy đường nghịch, artifact cũ còn nguyên tại chỗ (pha 4) | **KHÔNG phải rollback** — đó là **restore + replay**: dựng lại từ backup, chấp nhận mất dữ liệu từ điểm backup, rủi ro và thời gian khác hẳn |

Thủ tục **cấm** dùng chữ "rollback" cho vế phải. Án văn: người vận hành bấm theo kỳ vọng gắn với cái tên; gọi hai thứ khác nhau bằng một tên là thiết kế ra một sự cố.

## 7. Operate — ô `operate` của P1

- **Health / readiness**: readiness chỉ xanh khi vault mở được, storage port trả lời, và protocol registry nạp xong. Xanh sớm là nói dối phía trên.
- **Log & metric**: ra **stdout/endpoint cục bộ** của người cài. **Không phone-home mặc định** — đây là ràng buộc từ trần (North Star §7, Hub), không phải tùy chọn cấu hình. Người cài muốn gửi đi đâu là việc của họ.
- **Lease & heartbeat**: thủ tục xử node mất heartbeat (lease TTL hết → task về hàng đợi), và cách phân biệt _node chết_ với _node từ chối claim vì lệch skew_ (Release & Compat §2) — hai thứ trông giống nhau trên dashboard, xử lý ngược nhau.
- **Fleet view**: node nào ở train nào — bảng này là thứ khiến §2 của Release & Compat có tác dụng.

## 8. Sunset một cài đặt — ô `sunset` của P1

Khác **vòng đời tenant** (Tenant §2b): đây là tắt **cả một cài đặt**.

Thứ tự **bắt buộc, không đảo**: (1) thông báo + đóng trigger mới → (2) để task đang chạy hoàn tất hoặc escalate → (3) **export trước** (dữ liệu ra định dạng đọc được, đủ đầy) → (4) xác nhận export đọc được trên máy khác → (5) **shred sau** (khóa, theo Vault §4) → (6) hủy hạ tầng.

**Án văn**: đảo (3) và (5) là mất dữ liệu vĩnh viễn với một lệnh; bước (4) tồn tại vì export chưa được đọc thử là export chưa tồn tại — cùng lý lẽ với diễn tập restore ở §5.

## 9. Non-goals

- **Không** IaC của nhà vận hành Cloud (thuộc `cloud/`).
- **Không** contract của storage port (ADR-0002 + Working Data).
- **Không** build/branch/CI (playbook giao hàng (không công bố)).
- **Không** quản trị tenant (Tenant §2b) — charter này quản **cài đặt**.
- **Không** telemetry mặc định, dưới mọi tên gọi.

## 10. Nhật ký quyết định

| Chủ đề | Chốt | Án văn | |---|---|---| | Ranh giới | **Ba** phân vùng: `deploy/` ship · `cloud/` vận hành · `shared/tools/` phát triển | Hai phân vùng để lọt tooling; sai một hướng là trao hạ tầng cho đối thủ, sai hướng kia là fair-code trên giấy | | Hình thái | Lời khai quy mô, không phải công tắc; grow-path = replay có chủ đích | Công tắc lúc chạy biến một quyết định kiến trúc thành một tai nạn cấu hình | | Bộ artifact | Cùng một train; installer **từ chối** bộ lệch | Skew nội-máy không kênh handshake nào của hệ nhìn thấy | | Root key DR | Thủ tục nêu **chỗ cất cụ thể theo hình thái**, không nói chung chung | "Hãy cất khóa an toàn" là lời dặn; một chỗ cất được nêu tên là thủ tục | | Gate backup×khóa | Lệnh `check-backup-key-isolation` chạy ở CI + pre-commit | Litmus #4 của Vault chỉ có giá trị khi có thứ chạy nó | | Retention | ≤ support window, hoặc khai restore path + diễn tập; vượt mà thiếu ⇒ cảnh báo lúc khởi động | Backup không đọc lại được là lời hứa suông (P3b) | | Diễn tập | Restore drill bắt buộc, là entry | Backup chưa thử là giả thuyết | | Hai đường lùi | Gọi đúng tên; **cấm** gọi restore là "rollback" | Người vận hành bấm theo kỳ vọng gắn với cái tên | | Readiness | Chỉ xanh khi vault + storage + protocol registry sẵn sàng | Xanh sớm là nói dối phía trên | | Sunset | Export → **xác nhận đọc được** → shred; không đảo | Đảo là mất vĩnh viễn bằng một lệnh; export chưa đọc thử là chưa tồn tại |

## 11. Litmus của charter

1. Lấy `deploy/` đưa cho một người lạ tự cài: họ dựng được hệ **mà không cần một dòng nào từ `cloud/`** không?
2. Ngược lại: có file nào trong `deploy/` mà **chỉ chúng ta** dùng — tức IaC vận hành đang trốn ở đây?
3. Thêm một dòng vào backup script phủ lên đường root key: **CI đỏ** — hay chỉ có một câu ghi chú trong tài liệu?
4. Máy trắng + root key từ đường DR: chạy hết thủ tục §4.2 rồi **đọc được** một bản ghi chưa shred? Và nếu **không** có root key thì hệ **nói thẳng không khôi phục được**, không khởi động nửa vời?
5. Cấu hình retention 5 năm với support window 2 major, không khai restore path: hệ **cảnh báo lúc khởi động** hay im lặng?
6. Đọc thủ tục rollback: nó có bao giờ gọi _restore-từ-backup_ là "rollback" không? (bắt buộc: không)
7. Một node mất heartbeat và một node từ chối claim vì lệch skew: người trực **phân biệt được bằng fleet view** hay phải đoán?
8. Chạy thủ tục sunset: có đường nào tới bước shred **mà chưa qua bước xác nhận export đọc được trên máy khác** không?
9. Cài một bộ artifact trong đó lớp UI attended lệch train với node runtime: installer **từ chối**, hay nó cài rồi hỏng sau?
