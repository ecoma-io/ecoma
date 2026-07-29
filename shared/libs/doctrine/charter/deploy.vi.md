---
title: "Ecoma — Charter triển khai & vận hành"
status: design-end-state
canonical-sha: a715453eed01
---

# Ecoma — Charter triển khai & vận hành

Một charter, không phải một spec: nó không định nghĩa một cơ chế mà sản phẩm cam
kết với tenant. Nó định nghĩa cách một nhà vận hành cài đặt, chạy, sao lưu, nâng
cấp, lùi lại và tắt một cài đặt — và ranh giới nằm ở đâu giữa thứ một người tự
cài nhận được và thứ ở lại với người vận hành dịch vụ.

## Ranh giới: ba phân vùng, và cấm trộn

| Phân vùng                          | Cái gì sống ở đó                                                                                                                              | Ship cho người tự cài?               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **Triển khai**                     | Thứ một người tự cài **nhận và chạy**: file compose, chart, service unit, installer, migration runner, mẫu cấu hình edge router               | Có                                   |
| **Control plane của nhà vận hành** | Hạ tầng và control plane của nhà vận hành dịch vụ: fleet, billing, vận hành quota, provisioning tự động                                       | Không — proprietary                  |
| **Tooling phát triển**             | Tooling của người phát triển hệ: lint rule, lệnh workspace, tự động hóa repo                                                                  | Không — không phải artifact sản phẩm |
| **Module enterprise**              | Tính năng cấp doanh nghiệp cho **self-host**: đăng nhập một lần, export audit, retention sâu, phân quyền nâng cao — và **không** có đa tenant | Có, kèm một license                  |

**Single-tenant là thuộc tính của hình thái triển khai, không phải một giới hạn
kỹ thuật của engine.** Mọi cài đặt self-host chạy đúng một tenant, bởi workflow
tạo tenant thứ hai chỉ ship trong control plane của nhà vận hành — **không** phải
vì runtime kiểm một entitlement, điều mà
[Platform North Star](../north-star/platform.md) cấm thẳng. Engine vẫn giữ tầng
tenant trong cây khóa kể cả ở cardinality bằng một. Vì thế charter này không nói
gì về provisioning đa tenant; đó là việc của control plane.

**Litmus của ranh giới gói trong một câu**: _mọi file trong phân vùng triển khai
phải hữu dụng với một người đang tự cài; một file chỉ **chúng ta** cần là đang
nằm sai chỗ._

Sai theo hướng này — hạ tầng nội bộ lọt vào phần được ship — là trao playbook vận
hành cho đối thủ. Sai theo hướng kia — thứ một người tự cài cần lại nằm trong
control plane — là fair-code chỉ đúng trên giấy, bởi người tự cài không dựng nổi
hệ. Đó là lý do ranh giới có **ba** phân vùng chứ không phải hai: tooling phát
triển từng là chỗ trú ẩn của cả hai loại nhầm.

## Hình thái triển khai là một lời khai quy mô, không phải một công tắc

Hai hình thái, mỗi hình thái ship một bộ khác nhau:

| Hình thái       | Storage mặc định                                                             | Ship cái gì                                                            |
| --------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Small-stack** | Bộ nhúng, kèm một vault dựa trên file                                        | Binary hoặc image, service unit, mẫu cấu hình, migration runner        |
| **Production**  | Một database gánh log, projection và vector, kèm một vault backend bên ngoài | Chart hoặc file compose, mẫu secret, migration runner, mẫu edge router |

Hình thái là **lời khai quy mô của người cài**, không phải một cờ bật tắt lúc
chạy. Đổi hình thái là một grow-path có chủ đích — replay log sang port mới — và
**không bao giờ** tự động. Một công tắc lúc chạy sẽ biến một quyết định kiến trúc
thành một tai nạn cấu hình.

Charter này không định nghĩa contract của storage port. Đó là việc của
[ADR-0002](../method/adr-ledger.md) và [Working Data](../spec/working-data.md).

## Ship cái gì, và các mảnh đi cùng nhau ra sao

Server, node runtime headless, lớp UI attended, và mẫu cấu hình edge router mount
các bề mặt công khai.

**Tất cả mang cùng một train version.** Installer **từ chối** một bộ vắt qua hai
train. Trên một máy attended có hai artifact trên cùng một host: lớp UI kiểm train
tại lần bắt tay nội-máy và **từ chối chạy** khi lệch — độ lệch đó vô hình với mọi
lần bắt tay khác của hệ, nên nó cần một phép kiểm riêng.

Một artifact thiếu train version, source digest, provenance hoặc chữ ký thì **bị
từ chối lúc cài**. Không có chế độ "cứ cài đi đã", bởi chính chế độ đó là nơi một
artifact chưa ký lọt vào một hệ thống production.

## Khóa và khôi phục

Đây là phần nặng nhất của charter. Các luật gốc thuộc về
[Vault & Key](../spec/vault-key.md) — key material không bao giờ vào backup, khôi
phục thảm họa là bắt buộc với khóa root và khóa tenant, và chỉ replica
tiến-lên-trước mới được giữ key material. Phần dưới đây là **thủ tục**.

### Sinh và xác nhận root key

Provisioning phát root key **một lần**, rồi **đòi một thử thách checksum** trước
khi cho cài đặt vào trạng thái phục vụ. Kết quả là một entry trong log. Thủ tục
viết ra phải nêu **chính xác chỗ cất**, theo từng hình thái, chứ không khuyên
chung chung:

| Hình thái   | Đường khôi phục của root key, tách khỏi đường backup dữ liệu                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Small-stack | Một bản ngoài máy — một password manager, một phong bì niêm phong, một USB cất riêng. Thủ tục nêu ít nhất một lựa chọn cụ thể thay vì để người vận hành tự nghĩ ra |
| Production  | Một dịch vụ quản lý khóa hoặc module phần cứng có **replica tiến-lên-trước**, không snapshot point-in-time. Tư cách được kiểm ở dưới                               |

"Hãy cất khóa ở đâu đó an toàn" là một lời khuyên. Một chỗ cất được nêu tên là một
thủ tục.

### Khôi phục trên một máy trắng

Thủ tục phải chạy đúng theo thứ tự này: dựng một máy mới → **nạp root key từ đường
khôi phục** → restore dữ liệu → replay → kiểm chứng bằng cách chạy một truy vấn
đọc được dữ liệu **chưa** bị shred.

**Không có root key, engine nói thẳng rằng không thể khôi phục.** Nó không khởi
động nửa vời, bởi một cài đặt boot lên mà không giải mã được gì là một cài đặt
trông như đã khôi phục nhưng thực ra thì không.

### Một gate: backup không được chạm khóa

Một lệnh của workspace, `check-backup-key-isolation`, chạy trong tích hợp liên tục
và trước mọi lần commit: nó quét mọi script, manifest và chart trong phân vùng
triển khai và **fail** nếu có đường nào phủ lên vị trí root key ở bất kỳ hình thái
nào.

_"Đừng backup khóa" là một lời khuyên; một gate đỏ là một cơ chế._

### Backend key store nào đủ tư cách

Tài liệu triển khai **khai tường minh** những backend nào đủ tư cách thực hiện
crypto-shredding: `destroy` phải **không khôi phục được** và backend phải không
cung cấp — hoặc phải cho phép tắt — snapshot hay rewind point-in-time. Một backend
có cửa sổ khôi phục bắt buộc chỉ đủ tư cách nếu cửa sổ đó khai được **và lệnh shred
chỉ báo hoàn tất sau khi cửa sổ đóng**.

Một backend không đủ tư cách nghĩa là engine **từ chối vai crypto-shredding** thay
vì hứa một sự xóa mà nó không thực hiện được.

## Backup và restore

**Cái gì vào backup**: event log, artifact blob, và tùy chọn là projection —
projection rebuild được, nên backup nó mua được tốc độ, không bao giờ mua được
tính đúng.

**Cái gì không bao giờ vào backup**: key material, ở mọi tầng.

**Retention không được vượt quá support window** mà
[Release & Compatibility](../spec/release-compat.md) định nghĩa, trừ khi charter
này khai một restore path tường minh — nâng một backup cũ qua chuỗi migration — và
path đó đã được diễn tập. Giữ năm năm backup trong khi chỉ hỗ trợ hai major là
đang giữ một lời hứa không thực hiện được. Một cấu hình retention vượt support
window mà không khai restore path thì **cảnh báo lúc khởi động** chứ không im
lặng.

**Diễn tập restore là bắt buộc và là một entry trong log.** Một cài đặt chưa bao
giờ restore thử thì đang giữ một **giả thuyết**, không phải một hợp đồng bảo hiểm.
Thủ tục nêu một chu kỳ tối thiểu và ghi kết quả mỗi lần diễn tập vào log.

## Upgrade và rollback

Bốn pha — cài cạnh, migrate, cutover, giữ lại — thuộc về
[Release & Compatibility](../spec/release-compat.md). Charter này thêm phần mà một
con người thực hiện.

**Một preflight là bắt buộc trước khi chạm vào bất cứ thứ gì**: xác nhận train
version khớp trên mọi artifact; xác nhận **mọi migration major trong bước này khai
hoặc một down-migration hoặc một cờ irreversible**; ở đâu có cờ đó thì **đòi một
gate và một bản sao** trước khi đi tiếp; và xác nhận backup gần nhất đã được diễn
tập.

**Hai đường lùi khác nhau, gọi đúng tên của chúng**:

| Trong cửa sổ rollback                                                       | Ngoài cửa sổ                                                                                                                                       |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rollback**: chạy migration nghịch; các artifact cũ vẫn còn nguyên tại chỗ | **Không phải rollback** — đây là **restore và replay**: dựng lại từ một backup, chấp nhận mất dữ liệu kể từ backup đó. Rủi ro khác, thời gian khác |

Thủ tục **cấm** dùng chữ "rollback" cho cột bên phải. Một người vận hành bấm một
cái nút theo kỳ vọng gắn với cái tên của nó, nên gọi hai thao tác khác nhau bằng
một tên là thiết kế sẵn một sự cố.

## Vận hành

- **Health và readiness**: readiness chỉ xanh khi vault mở được, storage port trả
  lời, và protocol registry đã nạp xong. Xanh sớm là nói dối với thứ ở phía trên.
- **Log và metric** đi ra output hoặc endpoint cục bộ của chính người cài. **Không
  phone-home mặc định** — một ràng buộc thừa hưởng từ trần, không phải một tùy
  chọn cấu hình. Người cài chuyển tiếp chúng đi đâu là việc của họ.
- **Lease và heartbeat**: thủ tục xử lý một node mất heartbeat, và — tách riêng —
  cách phân biệt nó với một node **từ chối claim vì nằm ngoài cửa sổ skew**. Hai
  thứ trông giống nhau trên một dashboard và đòi hai cách xử lý ngược nhau.
- **Fleet view**: node nào chạy train nào. Chính cái bảng này làm cho luật skew
  vận hành được chứ không chỉ là lý thuyết.

## Tắt một cài đặt

Việc này khác với vòng đời của một tenant: ở đây cả một cài đặt đang bị tắt đi.

Thứ tự là **bắt buộc và không được hoán vị**: (1) thông báo, và đóng các trigger
mới; (2) để các task đang chạy hoàn tất hoặc escalate; (3) **export trước**, ra
một định dạng đọc được và đầy đủ; (4) xác nhận bản export đọc được **trên một máy
khác**; (5) **shred sau**; (6) hủy hạ tầng.

Hoán đổi bước 3 và bước 5 là mất dữ liệu vĩnh viễn bằng đúng một lệnh. Bước 4 tồn
tại bởi một bản export chưa ai đọc là một bản export chưa tồn tại — cùng một lý lẽ
với diễn tập restore ở trên.

## Non-goals

- **Không** phải hạ tầng của nhà vận hành dịch vụ, vốn không được công bố.
- **Không** phải contract của storage port.
- **Không** phải build, branching hay tích hợp liên tục.
- **Không** phải quản trị tenant — charter này quản một **cài đặt**.
- **Không** telemetry mặc định, dưới bất kỳ tên gọi nào.

## Litmus

1. Đưa phân vùng triển khai cho một người lạ: họ có dựng được hệ **mà không cần
   một dòng nào từ control plane của nhà vận hành** không?
2. Chiều ngược lại: có file nào trong phân vùng triển khai mà chỉ **chúng ta** dùng
   — tức là hạ tầng vận hành đang trốn trong phần được ship?
3. Thêm một dòng vào một script backup phủ lên đường root key: tích hợp liên tục có
   **đỏ** không, hay chỉ có một dòng ghi chú trong tài liệu?
4. Một máy trắng cộng root key từ đường khôi phục của nó: chạy hết thủ tục có kết
   thúc bằng một bản ghi chưa shred **đọc được** không? Và khi **không** có root
   key, hệ có nói thẳng rằng nó không khôi phục được, thay vì khởi động nửa vời
   không?
5. Cấu hình retention năm năm với một support window hai major mà không khai restore
   path: hệ có **cảnh báo lúc khởi động** không, hay im lặng?
6. Đọc thủ tục rollback: nó có bao giờ gọi restore-từ-backup là "rollback" không?
   (Câu trả lời bắt buộc: không.)
7. Một node mất heartbeat và một node từ chối claim vì lệch skew: người trực có
   **phân biệt được từ fleet view** không, hay phải đoán?
8. Chạy thủ tục tắt cài đặt: có đường nào tới bước shred mà chưa đi qua bước xác
   nhận bản export đọc được trên một máy khác không?
9. Cài một bộ artifact trong đó lớp UI attended lệch train với node runtime:
   installer có **từ chối** không, hay nó cài rồi hỏng sau?
