---
title: "Ecoma — trạng thái đích của thiết kế"
status: design-end-state
canonical-sha: 49526f6e6437
---

# Ecoma — trạng thái đích của thiết kế

Cây tài liệu này mô tả hệ thống Ecoma **được thiết kế để trở thành**, không phải
hệ thống đang tồn tại hôm nay. Nó là một **trần**: mọi lát cắt giao hàng được
phép thu hẹp giá trị hoặc policy, không lát nào được vi phạm một cơ chế viết ở
đây. Khi roadmap và cây này bất đồng về việc một thứ _là gì_, cây này thắng; khi
bất đồng về việc nó _đến lúc nào_, roadmap thắng.

Không có gì ở đây là báo cáo hiện trạng. Một phát biểu trong các tài liệu này là
một cam kết về cách hệ thống hành xử sau khi được xây — và chính vì thế nó cãi
được, trước khi có dòng mã nào phụ thuộc vào nó.

## Hệ thống này là gì

**Ecoma là hệ điều hành lao động fair-code, tự cài đặt được, nơi con người, AI,
và rule/code là cùng một loại tài nguyên lao động (Role/Filler); quy trình — cả
deterministic lẫn reasoning — được người và AI cùng thiết kế trên chính engine;
mọi output đều có đường đi qua một checkpoint với confidence hiệu chỉnh theo dữ
liệu của riêng từng tenant; và sự chú ý của con người là tài nguyên được đo và
tối ưu.**

## Cây tài liệu được tổ chức thế nào

Ba domain dọc, mỗi domain một North Star sở hữu từ vựng của nó:

| Domain                                | Sở hữu cái gì                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| [Platform](../north-star/platform.md) | Điều phối lao động — các primitive, composition, và những subsystem dùng chung |
| [RPA](../north-star/rpa.md)           | Thực thi trên những môi trường hệ thống không kiểm soát                        |
| [Hub](../north-star/hub.md)           | Phân phối nội dung tĩnh: registry, index, marketplace                          |

Hai lớp cắt ngang cả ba, chứ không nằm cạnh chúng. **Enterprise** là một lớp
license: những module cắm vào các extension point do engine khai báo, không bao
giờ là một fork. **Cloud** là một hình thái vận hành: chính bản build đó chạy với
tenant cardinality lớn hơn một, cộng một control plane của nhà vận hành không
được ship.

Ranh giới giữa ba domain hẹp một cách có chủ ý, và cái hẹp đó chính là điểm mấu
chốt:

- Platform chạm tới RPA qua đúng hai giao diện runtime — một Filler và một
  Session effect. Bất cứ thứ gì khác sẽ đưa mối bận tâm về selector, vision và
  driver vào bên trong engine điều phối, nơi mà đổi một trình duyệt sẽ đổi luôn
  một workflow.
- Mọi bên chạm tới Hub qua đúng một client interface: `resolve` / `pull` /
  `verify`. **Hub không bao giờ chạm runtime.** Rút phích nó ra thì mọi thứ đã
  cài vẫn chạy vĩnh viễn — và đó là thứ khiến một kênh phân phối an toàn để phụ
  thuộc vào.

## Thứ tự đọc

Cây này không xếp theo bảng chữ cái và đọc theo thứ tự file thì không thông. Đây
là thứ tự mà giả định của mỗi tài liệu đã sẵn có:

1. **[Platform North Star](../north-star/platform.md)** — bản canonical của bốn
   nguyên tắc cơ chế và năm invariant. Mọi tài liệu khác tham chiếu tới chúng và
   không tài liệu nào chép lại.
2. **[Composition](../spec/composition.md)** — các primitive lắp thành một
   Process như thế nào, và ranh giới Platform/RPA nằm ở đâu.
3. **Các primitive**, theo thứ tự phụ thuộc: [Role](../spec/role.md) →
   [Task](../spec/task.md) → [Checkpoint](../spec/checkpoint.md) →
   [Handoff](../spec/handoff.md) → [Escalation](../spec/escalation.md).
4. **Cửa vào và cửa ra**: [Trigger & Channel](../spec/trigger-channel.md).
5. **Các subsystem tầng một** mà mọi cơ chế khác đứng lên:
   [Event Log](../spec/event-log.md), [Artifact Store](../spec/artifact-store.md),
   [Vault & Key](../spec/vault-key.md),
   [Tenant & Identity](../spec/tenant-identity.md).
6. **Các module opt-in và projection**: [Knowledge](../spec/knowledge.md),
   [Memory](../spec/memory.md), [Working Data](../spec/working-data.md),
   [Calibration](../spec/calibration.md),
   [Human Surface](../spec/human-surface.md).
7. **Các cơ chế xuyên tầng**:
   [Release & Compatibility](../spec/release-compat.md),
   [Test Harness](../spec/test-harness.md).
8. **[RPA North Star](../north-star/rpa.md)**, rồi tới các spec của nó:
   [Action](../spec/rpa-action.md) → [Session](../spec/rpa-session.md) →
   [Driver & Perception](../spec/rpa-driver-perception.md) →
   [Self-healing](../spec/rpa-self-healing.md) →
   [Sandbox & Credential](../spec/rpa-sandbox-credential.md).
9. **[Hub North Star](../north-star/hub.md)**, rồi [Block](../spec/block.md).

Nằm ngoài bộ trần, và cố ý như vậy: [roadmap](../method/roadmap.md) (thứ tự xây
— tài liệu duy nhất được phép gọi tên các phase),
[rubric review](../method/review-rubric.md) và
[scenario catalog](../method/scenario-catalog.md) (những công cụ dùng để review
chính cây này), [sổ ADR](../method/adr-ledger.md) (các quyết định triển khai), và
[deploy charter](../charter/deploy.md) (cách một nhà vận hành chạy nó).

## Glossary — một khái niệm, một tên

Một khái niệm có thêm tên thứ hai là có thêm định nghĩa thứ hai, và hai định
nghĩa đó sẽ lệch nhau ngay lần đầu ai đó chỉ sửa một bên. Đây là những cái tên
đó.

**Lao động.** _Role_ — một vị trí lao động, định nghĩa bằng năng lực chứ không
bằng ai lấp vào. _Filler_ — người, agent, rule, hoặc process đang lấp một Role.
_Task_ — một instance của việc; _Attempt_ — một lần thử, là hạng nhất để retry
luôn mang theo feedback đã gây ra nó.

**Phán quyết.** _Checkpoint_ tách thành ba thứ cố ý không gộp làm một: một _Gate_
(điểm chặn), một _Judgment_ (phán quyết có chữ ký, append-only), và một
_Criterion_ (entity thư viện thuộc về tenant).

**Chuyển động giữa các bước.** _Handoff_ — chính việc bàn giao. _Contract_ — thứ
được hứa với bước nhận. _Artifact_ — bất biến, content-addressed. _Envelope_ —
ngữ cảnh đã tích lũy, giao đi dưới dạng projection. _Effect_ — reversible,
compensable, hoặc irreversible, mang theo một serialization key. _Escalation_ —
một taxonomy mở với terminal handler bắt buộc, để không đường nào kết thúc trong
im lặng.

**Phân phối.** _Block_ — đơn vị đóng gói và phân phối. _Template_ — một Block đã
curate theo một vertical.

**Knowledge và Memory, hai thứ không phải là nhau.** _Collection_ / _Chunk_ /
_Curator_ thuộc về Knowledge. _Memory entry_ / _Subject_ / _Party_ thuộc về
Memory. _Calibration_ nói về **người đang lao động**; _Memory_ nói về **bên đang
được phục vụ**. Gộp chúng lại sẽ khiến một lần đổi model xoá sạch những gì tổ
chức biết về một khách hàng.

**Dữ liệu.** _DataTable_ — một projection ghi được. _Lease_ — primitive khóa duy
nhất, TTL bắt buộc. _Projection_ — mọi view dẫn xuất từ Event Log, luôn rebuild
được. _Classification lattice_ và _leakage gate_ quản cái gì được phép đi ra.

**Danh tính.** _Principal_ — user, agent, rule, node, hoặc external. _Tenant_ —
một biên cứng. _Workspace_ — một vách mềm cho quản trị và hiển thị, **không**
phải biên an ninh: cùng khóa tenant, cùng namespace log, dedup được phép. _Party_
— một chủ thể của memory, merge được qua một Gate.

**Calibration.** _CalKey_ và _Cell_ — khóa và ô của một projection calibration.
_Estimator identity_ — `method@version` của chính phép ước lượng, để một lần đổi
estimator là nhìn thấy được chứ không âm thầm.

**RPA.** _Node_ — một host RPA. _Session_ — một lần chạy trên một môi trường.
_Scene_ — snapshot ba lớp, content-addressed, đã masking, của môi trường đó.
_Evidence_ — hash của một Scene trước và sau một Action. _Commit point_ — action
irreversible đầu tiên đã chạy, tức là biên của mọi lần unwind. _Macro_ — một chuỗi
Action có tên và có version. _App Profile_ — tri thức theo ứng dụng: lớp
reversibility và locator ổn định. _Sub-actor_ — một tác nhân _bên trong_ một
Filler (script, agent, người, tool call); không phải một Task.

**Kiểm thử.** _Test run scope_ — một lần chạy mang nhãn `run_kind: test` bên
trong chính tenant thật, cách ly bằng bộ lọc projection chứ không bằng một tenant
riêng. _`environment: production | test`_ — một chiều của Filler identity, không
phải trust tier thứ năm. _Mock filler_ — một Filler thật, `mock:<name>@version`,
gọi qua đúng Filler interface. _Fixture_ — dữ liệu mồi có id, version và lineage.
_Assertion artifact_ — một assertion khai báo, có version, đo trên log.
_Conformance suite_ — cùng cơ chế harness, với chủ thể là một _implementation_
của một interface. _`supports_dry_run`_ — một năng lực của adapter; adapter không
hỗ trợ thì resolve contract `dry_run` về `forbidden` thay vì giả vờ.

**Khóa.** _Rotate ≠ Shred_ — xoay khóa không re-encrypt; hủy một khóa là xóa vĩnh
viễn. _Vault_ tách thành hai nghĩa không được gộp: _credential vault_ (secret vận
hành) và _PII vault backend_ (khóa của data-subject, một extension point
Enterprise). _Replica tiến-lên-trước_ — loại bản sao duy nhất hợp lệ cho key
material, bởi một lệnh `destroy` phải replicate được tới nó; snapshot
point-in-time của key material bị cấm.

**Release.** _Release train `X.Y.Z`_ — trục version của **workspace**, không phải
của một app. _Protocol version_ — một số nguyên đơn điệu riêng cho từng protocol.
_Cửa sổ rollback_ — ra ngoài nó thì thao tác không còn là rollback mà là restore
rồi replay. _Support window_ — major hiện tại cộng một major trước đó; retention
của backup không được vượt quá.

**Lưu trữ.** _Reference backend ≠ default cài đặt_ — Postgres là thứ contract
suite được chứng minh trên đó; một cài đặt cụ thể chạy gì thì tùy hình thái triển
khai của nó (xem [ADR-0002](../method/adr-ledger.md)). _Small-stack_ — SQLite,
DuckDB và sqlite-vec, cho hình thái đơn-binary và một-container.

**Bề mặt và cấp phép.** _Work Item_ / _Action Item_ — object model của Human
Surface. _`run_kind: production | test`_ — một nhãn trên entry của log; mọi
projection phải khai lập trường của nó. _`<area>/enterprise/`_ — thư mục
Enterprise License, tag `license:ee`; `ee` import được `sul`, và `sul` không bao
giờ import được `ee`. _Single-tenant self-host_ — bị cap bằng một **biên sản
phẩm** (workflow tạo tenant chỉ ship trong control plane của nhà vận hành), không
bao giờ bằng một license check.

## Xử lý mâu thuẫn

Hai luật, cả hai đều vì một bộ tài liệu không có luật phân xử sẽ giải quyết mâu
thuẫn theo người sửa sau cùng:

- **Thứ tự ưu tiên khi các phát biểu bất đồng**: invariant, rồi nguyên tắc
  canonical, rồi nguyên tắc domain, rồi template. Các invariant và các nguyên tắc
  canonical sống ở [Platform North Star](../north-star/platform.md); mọi tài liệu
  khác tham chiếu chứ không chép lại, nên chỉ có một văn bản cần sửa.
- **Một khái niệm mới phải nói nó là khái niệm _của_ cái gì**: entity, policy,
  hay template của cơ chế nào. Một khái niệm không trả lời được là một cái tên
  đang đi tìm cơ chế, và rồi nó sẽ được gán cho một cơ chế nào đó một cách tình
  cờ.
