---
title: "Ecoma RPA — North Star"
status: design-end-state
canonical-sha: 404f3517c22f
---

# Ecoma RPA — North Star

## Trạng thái đích

**Ecoma RPA là engine tự động hóa tương tác môi trường thế hệ computer-use: mọi
hành động là một entity có danh tính, có lớp reversibility, và có bằng chứng; mọi
phiên đều durable, replay được, và người can thiệp được giữa chừng; script
deterministic và agent vision là hai đầu của cùng một trục chi phí–độ bền với
self-healing hai chiều — dùng độc lập, hoặc làm nguồn lao động cho
[Ecoma Platform](platform.md) qua đúng hai giao diện chuẩn.**

Các nguyên tắc cơ chế và invariant mà nó chuyên biệt hóa là canonical ở
[Platform North Star](platform.md) và không được chép lại ở đây.

## Bài toán, và định vị

Tự động hóa dựa trên selector là một cái hố bảo trì: giao diện đổi là nó vỡ.
Agent computer-use sống sót qua các lần đổi giao diện tốt hơn hẳn, nhưng không ai
dám cho nó chạy thật — không có reversibility, không có action log chuẩn, không
phân biệt xem với ghi, và secret thì lọt vào context của model.

Khoảng trống giữa hai thứ đó chính là toàn bộ sản phẩm: **một runtime tự động hóa
mà mọi hành động đều accountable.** Đó không phải một ý tưởng mới trong hệ này; nó
là phần còn lại của thiết kế Ecoma đẩy xuống tầng thực thi.

## Năm nguyên tắc cơ chế

Chúng chuyên biệt hóa bốn nguyên tắc canonical chứ không thay thế:

1. **Đối xứng tuyệt đối.** Hành động của người (takeover, demonstration) và của
   máy (script, agent) vào **cùng một action log**, cùng một schema, chỉ khác ở
   actor identity. Hai cái log nghĩa là hai sự thật, và câu hỏi đáng quan tâm —
   thực sự điều gì đã xảy ra trong phiên này — sẽ không có một câu trả lời duy
   nhất.
2. **Danh tính ổn định có lineage** cho mọi thứ tích lũy: action definition,
   script, driver, App Profile. Một script được self-healing vá là một version
   mới kế thừa từ cha nó.
3. **Engine ép tồn tại, template ép giá trị** — cùng một luật bảo thủ riêng của
   domain này: **reversibility không khai thì bị coi là irreversible.** Cách đọc
   an toàn của sự im lặng là cách duy nhất hỏng một cách an toàn.
4. **Độ phức tạp là lựa chọn của user.** Một script trần chạy được mà không phải
   khai gì; guard, masking, scope và confirmation đều là opt-in qua cascade.
5. **Integration-first.** RPA _luôn_ phát một Session effect và nói Filler
   interface, **kể cả khi chạy standalone** — nơi một consumer nội bộ tối giản
   đứng thay Platform. Không tồn tại đường chạy thứ hai, nên hai chế độ không thể
   trôi lệch nhau.

## Domain, và bộ spec của nó

| Lớp                                                       | Nó phủ cái gì                                             |
| --------------------------------------------------------- | --------------------------------------------------------- |
| [Action](../spec/rpa-action.md)                           | Vocabulary chuẩn hóa, reversibility, evidence, action log |
| [Session](../spec/rpa-session.md)                         | Vòng đời durable, takeover, record, replay, interruption  |
| [Driver & Perception](../spec/rpa-driver-perception.md)   | Contract của driver, scene hợp nhất, **semantic locator** |
| [Self-healing](../spec/rpa-self-healing.md)               | Script ↔ agent hai chiều, patch lineage, tín hiệu drift   |
| [Sandbox & Credential](../spec/rpa-sandbox-credential.md) | Cách ly phiên, vault, masking, permission scope           |

## Topology triển khai: Node

Một **Node** là ứng dụng RPA cài trên một máy — máy nhân sự là _attended_, server
là _unattended_, và cả hai chạy cùng một binary. Một node là một **host, không
phải một Filler**: các filler (một version của script, một cấu hình agent) đăng ký
_qua_ một node. Một node host nhiều filler, và một filler chạy được trên nhiều
node.

**Placement.** Một node khai nó có gì: ứng dụng đã cài, profile bền sẵn có, vùng
mạng, capacity, có người hiện diện hay không, và version engine cùng version
protocol của nó. Việc gán resolve theo một chuỗi — role, rồi filler pool, rồi một
node đủ điều kiện, trong đó version là một trong các điều kiện đó.

**Pull, chỉ outbound.** Một node claim task từ server. Platform không bao giờ đẩy
một lệnh điều khiển từ xa vào một node. Phiên chạy cục bộ và Session effect stream
ngược về. Transport là chi tiết; cơ chế bắt buộc là outbound-only cộng **một
stream có cursor resume được**. Mất mạng thì phiên vẫn durable cục bộ, log buffer
lại, và lần nối lại phát tiếp từ đúng offset — entry là content-addressed, nên
giao hàng at-least-once tự dedupe. Nếu node chết, phiên kết thúc ở trạng thái
interrupted với một trạng thái mà evidence chứng minh được.

**Một claim là một lease có heartbeat**, và việc nó hết hạn cố ý không phải là một
lần chạy lại. Khi log đã cho thấy có hành động đã thực hiện — nhất là đã qua một
commit point — âm thầm gán lại việc sẽ lặp lại một effect trên một hệ thống thật.
Thay vào đó nó trở thành một interruption cộng với đường thất bại đã khai. Một
phiên **pin vào node của nó** và không migrate, bởi trạng thái của nó là cục bộ.

**Enrollment là bắt buộc.** Một node có một danh tính mật mã và một admin duyệt nó
tường minh. Một task mang một credential scope nhất định chỉ định tuyến tới một
node được cấp scope đó tường minh, và vault chỉ phát secret ngắn hạn, cho một node
identity đã enroll, giới hạn theo từng phiên, tại tầng driver. Việc gỡ bỏ có kế
hoạch là một **graceful drain**: node ngừng claim, các phiên đang chạy kết thúc
hoặc được gán lại theo lease, rồi khóa bị thu hồi — mọi bước đều là một event. Đó
là một thủ tục khác với thu hồi khẩn cấp một node bị chiếm, vốn cắt tức thì.

**Takeover có kênh nhưng không bao giờ có đặc quyền thường trực.** Không tồn tại
năng lực điều khiển từ xa ambient nào. Một kênh xem-hoặc-điều-khiển mở **theo từng
phiên, do node khởi tạo, đi ra ngoài**, sau khi một assistance request được chấp
nhận và policy của chính node cho phép. Mọi input của người đi qua driver và trở
thành một Action có actor, trong cùng cái log. Trên một node attended, takeover
định tuyến tới chính người ngồi ở máy đó — người này cũng là một Filler.

**Attended là consent-first** (chạy khi máy rảnh, khi người dùng kích hoạt, hoặc
trong một virtual desktop tách biệt — một cascade policy). **Unattended là
isolation-first** (một sandbox hoặc một máy ảo).

**Lớp UI attended cục bộ không phải một giao diện thứ ba.** Node runtime là một
binary headless duy nhất chạy cả hai chế độ; một máy attended cài thêm một lớp UI
cục bộ nói với runtime qua một kênh nội-máy được xác thực bằng node identity. Ba
biên cứng giữ cho nó không trở thành một giao diện của hệ:

1. Kênh nội-máy chỉ mang **điều khiển phiên cục bộ** — mở, đóng, tạm dừng, tiếp
   quản. Nó không mang effect stream và không mang ngữ nghĩa lao động.
2. **Mọi hành động lao động từ UI attended — duyệt, phán quyết, claim, release —
   đi thẳng tới engine API**, như mọi client khác. Không tồn tại đường ghi riêng
   cho UI.
3. UI attended **không lưu frame nào**. Thứ tới được log luôn là một Scene đã
   masking.

Litmus rất thẳng: tắt kênh nội-máy đi, node runtime vẫn chạy — nó chỉ mất phần UI
— trong khi không đường ghi nào bị mất, bởi không đường nào trong số đó đi qua cái
kênh ấy.

**Cập nhật node có đường lùi.** Cập nhật một node qua Hub là một hành động tường
minh, và **lùi về digest trước đó cũng tường minh y như vậy và cũng là một
event**, hợp lệ trong đúng cửa sổ skew đã khai. Không có đường lùi thì "update" là
một thao tác một chiều trên thành phần nhạy cảm nhất về an ninh của cả hệ.

**Evidence stream dưới dạng hash ngay lập tức và upload blob một cách lười**, nên
tính toàn vẹn của log là tức thì và băng thông không phải nút thắt. Node cập nhật
qua chính Hub, có verify chữ ký, và **không bao giờ tự động cập nhật trong bất kỳ
cấu hình mặc định nào**.

## Mỗi khái niệm RPA trở thành gì khi tích hợp

| Trong RPA                                                                            | Khi cắm vào Platform                                                                                                                                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session                                                                              | Session effect của một Task                                                                                                                                                           |
| Người takeover                                                                       | Một assistance request — một escalation mà người xử lý cũng chính là một Filler                                                                                                       |
| Một version script đã được heal                                                      | Một Filler identity mới có lineage, đi qua các trust tier                                                                                                                             |
| Một confirmation của healing                                                         | Một Gate, với criteria dẫn xuất từ reversibility                                                                                                                                      |
| Action log cộng evidence                                                             | Provenance của một Artifact                                                                                                                                                           |
| Một App Profile                                                                      | Một block type trên Hub; cài vào một tenant thì nó trở thành một nguồn giá trị mặc định của cascade                                                                                   |
| Tín hiệu drift giao diện                                                             | Đầu vào cho escalation và intelligence — một process smell ở tầng thực thi                                                                                                            |
| Một session scope chỉ đọc                                                            | Một rail trên spawn policy khi một agent tự tạo task RPA                                                                                                                              |
| **Một automation** (một version script cộng healing policy, hoặc một cấu hình agent) | **Chính là Filler đã đăng ký.** Chuyển giao một action giữa script, agent và người là hành vi _bên trong_ filler, ghi lại dưới dạng sub-actor; calibration bám theo filler đã đăng ký |
| Learning signal                                                                      | Dẫn xuất từ Session effect cộng các entry `proposal` trong cùng stream — **không phải một giao diện thứ ba** — về đích là Judgment, escalation, hoặc calibration theo từng tenant     |

## Deterministic và reasoning, trên cùng một trục

Cùng một trục, dial theo **từng action** chứ không phải theo từng sản phẩm:

| Khía cạnh          | Deterministic               | Reasoning                       |
| ------------------ | --------------------------- | ------------------------------- |
| Executor           | Script, các tầng structural | Agent vision, các tầng semantic |
| Nó bắt đầu từ đâu  | Ghi lại một demonstration   | Distillation từ một agent       |
| Resolve một target | Structural anchor           | Semantic intent                 |
| Kiểm tra           | Assert precondition         | Reconcile và healing            |
| Chuyển giao        | Script → agent khi fail     | Agent → script khi đã ổn định   |

## Một lõi học duy nhất, và RPA là nơi sản xuất tín hiệu cho nó

**RPA không có lõi học riêng.** Lõi duy nhất là tầng intelligence của Platform.
Learning signal không phải một kênh thứ ba: phần lớn dẫn xuất từ chính action log,
tức là Session effect, và các _đề xuất_ — vá một App Profile, distill thành một
script, đổi routing model — là những entry kiểu `proposal` trong cùng stream đó,
được Platform materialize thành Task. Khi chạy standalone, một consumer nội bộ tối
giản chỉ làm thống kê deterministic: đếm, ngưỡng, và promote một anchor **trong
chính script của nó** theo cùng những luật duyệt đó. Cố ý không có bộ não thứ hai
nào để trôi lệch khỏi bộ não thứ nhất.

Mọi đề xuất đều được áp dụng **qua một vòng duyệt**, không bao giờ bằng cách sửa
runtime. Tín hiệu thuộc về tenant; một catalog cộng đồng chỉ nhận chúng khi có
opt-in, qua review.

## Litmus

1. Cùng một automation có chạy được bằng script **và** bằng agent vision mà không
   đổi định nghĩa của nó không?
2. Khi một script vỡ vì giao diện đổi, agent có tiếp quản và sinh ra một version
   đã vá có lineage mà không cần người sửa tay không?
3. Có replay được bất kỳ phiên nào từ log và evidence — ai hoặc cái gì đã làm gì,
   lúc nào, và màn hình trông ra sao không?
4. Khi một người takeover giữa phiên, hành động của họ có nằm cùng cái log với
   hành động của máy không?
5. Secret có bao giờ xuất hiện trong log, trong một screenshot đưa cho model, hay
   trong context của một agent không?
6. Standalone và tích hợp có phải là **cùng một binary trên cùng một đường phát
   effect** không?
7. Nếu một node mất mạng giữa phiên, phiên có tiếp tục cục bộ và resume từ cursor
   mà không mất và không trùng entry nào không?
8. Một node chưa enroll có claim được task hay nhận được secret không — kể cả khi
   khai placement attribute hoàn hảo?
9. Có tồn tại một kênh điều khiển thường trực nào vào node không, hay takeover chỉ
   mở theo từng phiên, do node khởi tạo, với mỗi input trở thành một Action có
   actor?
10. Tắt kênh nội-máy của UI attended: runtime có còn chạy không, và có đường ghi
    nào bị mất không?

## Non-goals

- **Không orchestrate đa bước, đa role, có checkpoint.** Đó là việc của Platform.
- **Không phải một nền tảng tích hợp.** Ở đâu có API thì gọi API — đó là một rule
  filler bên phía Platform. RPA dành cho nơi **không có** API.
- **Không xây vision model riêng.** Model đến qua một adapter, dưới một taxonomy
  mở.
- **Không lưu secret ngoài vault, và không có đường tích hợp riêng** với Platform
  dù chung một repo.
- **Không kỹ nghệ hóa sự không-bị-phát-hiện.** Giải một access challenge trình ra
  cho một session được ủy quyền — một CAPTCHA trước một login mà tenant giữ
  credential — là một Action bình thường, ghi kèm actor như mọi Action khác, và
  đó đúng là ý nghĩa của "cho nơi không có API". Cái engine **không** tự viết là
  năng lực ngược lại, mà chức năng duy nhất là làm đích đến misattribute máy thành
  người: spoof fingerprint, xoay residential proxy, giả nhịp gõ để đánh bại
  detector. Lý do là chính lập trường của domain — mọi hành động có trách nhiệm
  giải trình, và trách nhiệm đó là **đầu-cuối**: lái một đường con-người được ủy
  quyền để log của chính đích đến trung thực, trong khi né tránh tồn tại _để_ làm
  log đó nói dối. Hai act khác nhau, và lằn được kẻ tại session permission scope
  (Sandbox & Credential §4). Tenant cần năng lực không-bị-phát-hiện thì cài nó
  dưới dạng driver class `code` opt-in và tự gánh ToS + phơi nhiễm pháp lý; engine
  không ship và không marketing nó.

## Phân phối

- Domain sống trong area riêng của nó. Cấp phép theo luật phân loại canonical ở
  [Platform North Star](platform.md) — action vocabulary, driver interface và App
  Profile schema là những thứ bên thứ ba cắm vào; core và node runtime là những
  thứ để chạy. Tài liệu này không khai lại luật đó, nên không có nguồn thứ hai cho
  nó.
- App Profile, macro, script và driver được phân phối dưới dạng **block qua
  [Hub](hub.md)** — RPA nói với Hub trực tiếp qua client interface, kể cả khi
  standalone, chứ không đi vòng qua Platform. Một driver là một artifact **code**,
  vốn là một trust class riêng: nó đòi một publisher đã verified và một opt-in
  tường minh của admin.
- Standalone nghĩa là một command line, một SDK, và self-host. Đó là wedge adoption:
  đến vì automation, ở lại vì Platform.

## Các kiểu hỏng

| Hỏng                              | Phát hiện bằng                    | Phục hồi                                                                                                                                             |
| --------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node mất mạng giữa phiên          | Heartbeat và lease hết hạn        | Phiên vẫn durable cục bộ và resume từ cursor; nếu node chết hẳn thì kết thúc ở trạng thái interrupted với một trạng thái mà evidence chứng minh được |
| Node bị chiếm                     | Enrollment identity, thu hồi khóa | Mọi claim và mọi yêu cầu secret bị từ chối tức thì                                                                                                   |
| Buffer evidence đầy trên một node | Hash đã stream, blob thì lười     | Một cảnh báo dung lượng; tính toàn vẹn của log không bị ảnh hưởng vì các hash đã được ghi                                                            |
