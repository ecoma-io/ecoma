# GitHub Work Management

> **Phạm vi:** cách repository dùng GitHub Issue, Project, Milestone và Pull Request để tổ chức công việc kỹ thuật — khi nào tạo một work item, nội dung tối thiểu của nó, và điều kiện đóng.
>
> **Không thuộc tài liệu này:** vòng đời kỹ thuật, năm work kind và trạng thái năng lực → [`evolution-process.md`](./evolution-process.md) · cách thực hiện một đơn vị công việc → [`contribution-workflow.md`](./contribution-workflow.md) · quy tắc commit, PR title và merge → [`AGENTS.md`](../../AGENTS.md) `Pull requests` · hướng dẫn contributor → [`CONTRIBUTING.md`](../../CONTRIBUTING.md).
>
> Tài liệu này quy định **policy**, không phải ảnh chụp cấu hình GitHub. Cấu hình hiện tại phải đọc từ GitHub trước khi dùng (`gh label list`, `gh api repos/<owner>/<repo>/milestones`); một giá trị không đọc được thì không được đoán.

## 1. Nguyên tắc

1. **GitHub là Work Management layer.** Kế hoạch, ưu tiên và thứ tự thực hiện thuộc GitHub; tài liệu canonical giữ specification và quyết định ([`evolution-process.md`](./evolution-process.md) §2, [`docs/AGENTS.md`](../AGENTS.md) §3).
2. **Một work item, một outcome.** Đơn vị công việc là thứ có thể land bằng một PR và được review độc lập — không phải một bước kỹ thuật bên trong nó.
3. **Công cụ chỉ chứng minh phần việc của nó.** Issue đóng, PR merge, CI xanh và deploy thành công là bốn sự kiện khác nhau ([`evolution-process.md`](./evolution-process.md) §5.2).
4. **Không tạo công cụ thứ hai cho cùng một câu hỏi.** Không có file backlog, roadmap hay bảng trạng thái trong `docs/` thay cho Issue, Project và Milestone.
5. **Không có giá trị mặc định được suy diễn.** Label, Milestone, assignee, Project field chỉ được set sau khi đọc thấy chúng tồn tại.
6. **Không phải công việc nào cũng cần đủ bốn công cụ.** Issue là bắt buộc cho work item; Project và Milestone là tuỳ chọn theo nhu cầu phối hợp.

## 2. GitHub Issue

### 2.1 Khi nào cần Issue

| Tình huống                                                      | Hành động                                                                                                      |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Unit công việc independently trackable, có thể land bằng một PR | Tạo Issue, sau khi search                                                                                      |
| Đã có Issue mở theo cùng outcome                                | Tái sử dụng; không tạo bản song song                                                                           |
| Cùng chủ đề nhưng outcome khác một cách material                | Tạo Issue mới, link Issue gần nhất và nêu khác biệt trong một câu                                              |
| Giải thích, tư vấn, review nằm trong một PR đang có             | Không tạo Issue; trả lời tại chỗ                                                                               |
| Phát hiện follow-up trong lúc làm unit của người khác           | Ghi như proposal trong Issue/PR hiện tại; chỉ tạo Issue khi nó thật sự độc lập và task bao gồm việc bắt đầu nó |
| Thay đổi chỉ để hoàn thiện hình thức (label, field, template)   | Không tạo Issue riêng nếu không có outcome vận hành                                                            |

**Independently trackable** nghĩa là thoả đồng thời:

1. Có một outcome quan sát được hoặc một quyết định cần chốt, phát biểu được trong một câu.
2. Có thể land bằng một PR, hoặc bằng một chuỗi PR trong cùng một nhánh công việc mà người review theo được.
3. Có điều kiện hoàn thành kiểm được mà không cần đọc ý định của người viết.
4. Có owner rõ — người hoặc agent đang giữ nó.

Không thoả (1) hoặc (3) nghĩa là chưa đủ định nghĩa: làm rõ trước, hoặc ghi thành Discovery.

### 2.2 Work item và các loại record khác

Trách nhiệm của công cụ do [`evolution-process.md`](./evolution-process.md) §4.2 quy định. Mục này **không** thêm một trục phân loại mới; nó chỉ giúp nhận ra năm dạng Issue đang tồn tại khi quyết định lấy cái nào làm việc của mình. Các dạng này cùng sống trong GitHub nhưng **không** thay thế nhau:

| Loại                     | Trả lời                                              | Điều kiện đóng                                           | Ví dụ dấu hiệu                                               |
| ------------------------ | ---------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| **Work item**            | Outcome nào sẽ đạt, bởi thay đổi nào                 | Outcome đạt và reconciliation xong (§2.6)                | Có mục tiêu, phạm vi, tiêu chí chấp nhận                     |
| **Coordination ledger**  | Nhiều workstream đang ở đâu trong một nỗ lực dài     | Nỗ lực kết thúc, hoặc ledger được thay bằng Issue cụ thể | Liệt kê workstream, trạng thái từng phần, mở qua nhiều PR    |
| **Precondition tracker** | Điều kiện bên ngoài nào phải xong trước khi bắt đầu  | Điều kiện đạt hoặc bị loại bỏ                            | Danh sách điều kiện, không có outcome sản phẩm               |
| **Experiment record**    | Giả thuyết nào đã được xác nhận hay bác bỏ           | Kết luận được ghi và decision liên quan đã có            | Hypothesis, tiêu chí đo đặt trước, kết quả                   |
| **Decision Issue**       | Quyết định nào cần chốt và phương án nào đã cân nhắc | Quyết định được ghi vào canonical location hoặc ADR      | Các phương án, tiêu chí chọn; không phải implementation plan |

Quy tắc:

- **Không biến record thành work item của mình.** Append finding vào ledger đang mở khi task yêu cầu; không mở lại record đã archive.
- **Không dùng work item thay ledger.** Nếu một Issue phải liệt kê nhiều outcome độc lập, tách work item ra và giữ Issue đó làm ledger — hoặc chuyển sang Milestone.
- **Experiment record không phải delivery plan.** Kết quả experiment là bằng chứng để mở Modelling hoặc Delivery ([`evolution-process.md`](./evolution-process.md) §4.1).
- **Work kind không quyết định loại record.** Một Issue Experiment là record; một Issue Delivery là work item — điều kiện đóng vẫn là §2.6, bảng trên chỉ mô tả khi nào record đó hết vai trò.

### 2.3 Work kind trong GitHub

Năm work kind canonical — **Discovery, Modelling, Experiment, Delivery, Remediation** — được định nghĩa tại [`evolution-process.md`](./evolution-process.md) §4.1. Tài liệu này chỉ quy định cách ghi chúng; không định nghĩa lại taxonomy hay điều kiện phân loại.

**Work kind khác issue category.** Category trả lời "đây là loại artifact nào" (`bug`, `enhancement`, `documentation`); work kind trả lời "bản chất thay đổi là gì". Một `bug` thường là Remediation, nhưng một `bug` chưa từng có behaviour cũng có thể là Delivery; một `documentation` issue có thể là Modelling hoặc Delivery. Không suy work kind từ label.

Cách ghi:

1. **Trong Issue body** — một dòng hoặc một mục `## Loại công việc` với đúng một giá trị canonical. Chọn theo thứ tự ưu tiên ở [`evolution-process.md`](./evolution-process.md) §4.1, dừng ở loại khớp đầu tiên.
2. **Trong Issue form** — field `Loại công việc` của các form trong `.github/ISSUE_TEMPLATE/`. Field này optional: Issue tạo bằng API, bằng `blank` hoặc bằng comment không có nó vẫn hợp lệ.
3. **Trong PR body** — chỉ khi PR đó là nơi duy nhất mang thông tin (ví dụ PR không có Issue); cùng một giá trị canonical.
4. **Trong GitHub Project** — một single-select field tên `Work kind` với đúng năm giá trị, chỉ khi Project tồn tại (§3.4).

Ghi ở nhiều nơi thì các nơi phải khớp nhau. Khi chúng lệch, Issue body là bản ghi có thẩm quyền và nơi khác phải được sửa theo.

Không tạo label cho work kind:

- Label hiện có đã biểu đạt category và một số vùng công việc; thêm năm label work kind tạo hai hệ classification chồng nhau trên cùng một Issue.
- Work kind có thể thay đổi khi hiểu biết thay đổi (một Delivery hoá ra là Discovery); label đổi liên tục làm mất lịch sử, còn body/field sửa được kèm lý do.
- Không có automation nào đọc work kind. Nó là thông tin cho người đọc và cho việc chọn template, không phải input của CI.

Ngoại lệ: khi repository thiết lập automation đọc work kind (ví dụ Project view hoặc báo cáo), việc thêm field/label trở thành một work item riêng, không tự động đi kèm PR đổi policy.

### 2.4 Nội dung tối thiểu

Mọi work item phải trả lời được, bằng câu ngắn:

- **Outcome** — kết quả quan sát được sau khi xong.
- **Phạm vi** — phần nào của hệ thống được phép thay đổi.
- **Ràng buộc** — invariant, contract, quyết định đã accept đang ràng buộc.
- **Dependency** — work item hoặc điều kiện phải xong trước.
- **Điều kiện hoàn thành** — cách verify, không phải danh sách việc cần làm.

Nội dung bổ sung theo work kind:

| Work kind       | Thêm vào body                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| **Discovery**   | Câu hỏi cần trả lời; bằng chứng đã có; nguồn sẽ tìm; điều kiện để kết luận "đủ để chọn hoặc loại một hướng" |
| **Modelling**   | Specification/ADR nào sẽ thay đổi; quyết định nào đang mở; điều kiện accept                                 |
| **Experiment**  | Hypothesis; phạm vi và môi trường đo; tiêu chí đánh giá **đặt trước**; cách ghi kết quả                     |
| **Delivery**    | Outcome quan sát được; phần nào của capability target được phủ và phần nào chưa; tiêu chí verify đúng tầng  |
| **Remediation** | Deviation hoặc gap đang được đóng; nguồn gốc; điều kiện coi là đã đóng                                      |

Không đưa vào body: specification dài hạn, bảng trạng thái capability, hay danh sách task không có outcome. Những thứ đó thuộc canonical document hoặc Milestone.

### 2.5 Cập nhật khi scope hoặc giả định thay đổi

- **Scope mở rộng quá Issue:** không tự mở rộng. Ghi phát hiện vào Issue, chọn một trong hai: mở Issue mới cho phần mới, hoặc sửa Issue hiện tại kèm lý do khi phần mới thật sự cùng outcome.
- **Giả định sai:** sửa Issue body hoặc thêm comment nêu giả định cũ, bằng chứng mới và ảnh hưởng — không xoá dấu vết giả định cũ. Nếu giả định sai làm đổi target, việc sửa canonical document là work item riêng.
- **Work kind đổi:** ghi lý do trong comment; không silently reclassify.
- **Bị block bởi quyết định chưa chốt:** ghi rõ quyết định nào, ai/cái gì mở nó; chuyển sang work item khác thay vì giữ "đang làm dở" ([`evolution-process.md`](./evolution-process.md) §6.8).
- **Không cập nhật Issue cho khớp thực tế là lỗi quy trình**, không phải chi tiết hành chính.

### 2.6 Điều kiện đóng

Issue chỉ đóng với lý do **completed** khi:

1. Outcome trong Issue đã đạt, **hoặc** quyết định đã được ghi vào canonical location, **hoặc** experiment đã có kết luận.
2. Có bằng chứng tương ứng — lệnh đã chạy và kết quả, PR đã merge, ADR đã accept.
3. Reconciliation đã phân loại phần phạm vi theo [`evolution-process.md`](./evolution-process.md) §8.1 và ghi vào Issue comment.

Lý do đóng phải đúng loại:

- **Completed** — outcome đạt; dùng khi (1)–(3) thoả.
- **Not planned** — quyết định không làm, kèm lý do và nơi ghi quyết định. Đây là ngoại lệ của (1)–(3): không có outcome đạt được để verify, nên điều kiện là **quyết định không làm đã được ghi và có người chịu trách nhiệm**.
- **Duplicate** — trùng một Issue khác, kèm link tới Issue được giữ. Đây là ngoại lệ của (1)–(3): phần còn lại chuyển sang Issue được giữ, và điều kiện là **link đó tồn tại**. Issue được giữ phải tự thoả điều kiện đóng của nó.

Khoảng giữa auto-close và reconciliation:

- `Closes #N` làm GitHub đóng Issue ngay khi merge, trước khi reconciliation được ghi. Đó là hành vi của công cụ, không phải bằng chứng: Issue đóng ở trạng thái **completed** chỉ có nghĩa unit đã land. Nghĩa vụ reconciliation ở (3) vẫn còn và phải được ghi trong cùng ngày làm việc.
- Nếu reconciliation phát hiện outcome **chưa** đạt, mở lại Issue hoặc mở work item mới trỏ tới Issue cũ; không để trạng thái đóng đứng một mình như một claim sai.
- Với unit mà reconciliation chắc chắn phải chạy trước khi biết đóng được hay không, dùng `Refs #N` thay vì `Closes #N` (§5.2).

Quy tắc:

- **Issue closed không phải bằng chứng capability đã hoàn thành.** Đóng chỉ kết thúc unit công việc; trạng thái capability suy ra theo [`evolution-process.md`](./evolution-process.md) §5.1.
- **Verification thất bại thì không đóng.** Mở Remediation, giữ nguyên claim trạng thái thấp hơn ([`evolution-process.md`](./evolution-process.md) §6.6).
- **Không đóng Issue của người khác** khi chưa được uỷ quyền; thêm comment thay vì sửa.
- **Ledger và precondition tracker** đóng theo điều kiện riêng của chúng, không theo điều kiện của một work item bên trong.

## 3. GitHub Project

### 3.1 Trách nhiệm

Project sở hữu **portfolio visibility**: nhìn nhiều work item cùng lúc, sắp thứ tự, thấy cái gì đang chờ. Project **không** sở hữu specification, không phải nguồn sự thật về trạng thái capability, và không thay thế Issue, Milestone hay tài liệu canonical ([`evolution-process.md`](./evolution-process.md) §4.2).

Project status **không phải** capability state. `In progress` trên Project không có nghĩa capability đang `Implemented`; `Done` không có nghĩa `Verified` hay `Released`.

### 3.2 Khi nào đưa Issue vào Project

Đưa vào khi cần một trong các thứ sau:

- Nhìn thấy nhiều work item đang mở cùng lúc để chọn việc tiếp theo.
- Sắp thứ tự giữa các work item có dependency.
- Theo dõi một nhóm work item qua nhiều Milestone.

Không đưa vào chỉ vì Issue tồn tại. Một Issue đơn lẻ, hoặc một chuỗi Issue trong cùng một Milestone đã đủ rõ, không cần Project.

Ý định tracking được biểu đạt bằng label `project:track` (§3.3); Project membership là kết quả quan sát được từ label đó, không phải một quyết định song song.

### 3.3 Theo dõi Issue bằng label `project:track`

**Mục đích.** Label đánh dấu Issue cần **portfolio visibility** hoặc **coordination ở cấp Project**. Project không phải bản sao của backlog hay Milestone: không phải mọi Issue đều cần xuất hiện trong Project.

**Cơ chế.** Project dùng native `Auto-add to project` workflow, lọc theo repository liên kết và label này. Không dùng custom GitHub Action, sync script hay automation hai chiều. Filter và trạng thái thực tế của workflow là cấu hình GitHub — đọc từ GitHub, không chép vào tài liệu này (§1).

**Điều kiện phân loại** theo work kind ([`evolution-process.md`](./evolution-process.md) §4.1):

| Work kind       | Mặc định  | Gắn `project:track` khi                                                                                        |
| --------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| **Discovery**   | Selective | Cần coordination giữa các workstream, hoặc kết quả ảnh hưởng quyết định của MVP                                |
| **Modelling**   | Selective | Quyết định có tác động cross-domain, hoặc nhiều workstream phải theo nó                                        |
| **Experiment**  | Không     | Chỉ khi kết quả có tác động chiến lược hoặc cần theo dõi một quyết định                                        |
| **Delivery**    | Selective | Phân biệt với phần còn lại của outcome: nằm trên critical path, là node nghiệm thu, hoặc chặn nhiều workstream |
| **Remediation** | Selective | Ảnh hưởng MVP, release, hoặc nhiều workstream                                                                  |

Gắn label khi cần theo dõi **dependency, ownership, tiến độ hoặc quyết định** ở cấp portfolio. Trắc nghiệm đơn giản: Issue này có **từ hai workstream trở lên** phải chờ, phải xếp thứ tự, hoặc phải cùng biết không — hoặc nó là mốc mà kết quả của cả nhóm được đo tại đó.

Không gắn label:

- Chỉ vì Issue có priority cao.
- Chỉ vì Issue thuộc một product hoặc một Milestone. **Mọi deliverable của một Milestone đều thuộc Milestone đó**; nếu đó là lý do đủ thì Project chỉ là bản sao của Milestone. Một delivery chỉ đáng track khi nó phân biệt được với các deliverable còn lại của cùng Milestone.
- Mặc định cho bug nhỏ, refactor độc lập, bảo trì tài liệu và task kỹ thuật thông thường.
- Vì suy ra rằng toàn bộ Issue của một Milestone phải vào Project. Milestone và Project là hai trục khác nhau: Milestone biểu đạt một delivery outcome, `project:track` biểu đạt nhu cầu coordination. Một Issue có thể thuộc cả hai, một trong hai, hoặc không.

Một Issue ngoài các nhóm trên vẫn có thể được track khi có lý do coordination rõ ràng; khi đó ghi lý do đó, không mở rộng ngầm.

**Trách nhiệm phân loại.**

| Vai trò                 | Việc                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Planner (Select & Plan) | Đề xuất classification và lý do **trước khi** Issue được tạo, hoặc trước khi Epic được phân rã thành Issue         |
| Issue creator           | Gắn label khi và chỉ khi policy thoả; ghi lý do theo mục dưới                                                      |
| Reviewer                | Kiểm tra cả hai chiều: Issue cần track nhưng thiếu label, và Issue có label nhưng không có lý do hợp lệ            |
| Project coordinator     | Kiểm tra Project membership khớp với label; phát hiện item thiếu hoặc thừa, và báo thay vì tự sửa ngoài thẩm quyền |

Khi phân rã một Epic hoặc một Milestone thành nhiều Issue, đánh giá **từng Issue độc lập**. Khi review backlog, kết luận cho mỗi Issue là một trong ba giá trị: **track**, **không track**, **cần làm rõ** — không gắn label cho nhóm thứ ba.

**Ghi lý do.** Lý do tracking là một câu nêu nhu cầu coordination, ghi ở một trong hai nơi:

- Mục `## Theo dõi Project` trong Issue body, cùng chỗ với các metadata khác của Issue.
- Comment trên Issue, khi body không được sửa (Issue đang có người làm, hoặc thay đổi phải tối thiểu).

Không tạo thêm label để biểu diễn lý do, và không lưu lý do chỉ trong Project field.

**Vòng đời.**

- **Gắn label** → Issue đủ điều kiện; native workflow thêm item vào Project khi Issue được tạo hoặc cập nhật.
- **Bỏ label** → Issue không còn được theo dõi, nhưng **không** tự động bị xoá khỏi Project. Item ở lại để giữ lịch sử coordination; workflow auto-add không có hành vi xoá.
- **Xoá hoặc archive item** là quyết định riêng của Project coordinator, cần lý do được ghi. Không suy ra việc xoá từ việc label bị bỏ.
- **Label không phải Project `Status`.** Gắn hay bỏ label không đổi status; `Done` của Project vẫn không phải capability state (§3.1).
- **Issue đóng không tự xoá item.** Item đóng ở lại Project theo hành vi của GitHub; đó không phải bằng chứng capability và cũng không phải lý do xoá item.

### 3.4 Cấu hình tối thiểu

Một Project mới chỉ cần đúng những thứ sau để dùng được:

| Field       | Loại          | Giá trị                                                                                    |
| ----------- | ------------- | ------------------------------------------------------------------------------------------ |
| `Status`    | native        | `Todo` · `In Progress` · `Done` (giá trị mặc định của GitHub; đổi tên khi có lý do cụ thể) |
| `Work kind` | single select | `Discovery` · `Modelling` · `Experiment` · `Delivery` · `Remediation`                      |

Chỉ thêm field khác khi có semantics rõ và có người dùng thật:

- `Priority` chỉ khi có tiêu chí ưu tiên được ghi và có người sắp thứ tự theo nó.
- Field ngày chỉ khi dùng để trả lời một câu hỏi cụ thể (ví dụ "việc gì đang trễ").
- Không thêm field chỉ để Project trông đầy đủ. Field không ai cập nhật là nhiễu, không phải cấu trúc.

Cấu hình Project là **work item riêng**, cần outcome được người có thẩm quyền xác nhận. PR đổi policy không tự tạo Project. Điều này áp dụng cả cho việc bật hoặc sửa `Auto-add to project` workflow: thay đổi filter là thay đổi cấu hình GitHub, không phải thay đổi policy.

## 4. GitHub Milestone

Milestone chỉ dùng cho **một delivery outcome có biên rõ ràng**:

- **Scope** — tập capability hoặc thay đổi thuộc milestone.
- **Mục tiêu** — outcome đóng được, phát biểu bằng kết quả chứ không bằng số task.
- **Điều kiện hoàn thành** — cách biết milestone xong.
- **Điều kiện kết thúc** — khi nào milestone đóng dù chưa đạt, và phần còn lại đi đâu.

Quy tắc:

- Một Milestone **có thể** chứa nhiều Issue độc lập; đó là mục đích của nó.
- Không tạo Milestone cho từng work kind, từng Issue, hay để biểu diễn roadmap dài hạn.
- Milestone không mang số phase hay thứ tự roadmap. Nếu cần đánh số, số đó thuộc Milestone đang tồn tại, không phải di sản của roadmap cũ.
- Milestone không phải specification kiến trúc và không chứa danh sách task vô hạn.
- Milestone đóng không chứng minh capability `Released`; đó vẫn là bằng chứng deployment ([`evolution-process.md`](./evolution-process.md) §5.1).

## 5. Pull Request

### 5.1 Một PR là một logical change

Một PR đại diện cho **một thay đổi logic review độc lập được** — không phải một file, một commit hay một Nx project. Một logical change có thể chạm nhiều file, nhiều Nx project, test, docs và configuration nếu chúng cùng phục vụ một outcome.

- **Không bắt buộc một commit cho mỗi PR.** Số commit trên nhánh là lựa chọn của người làm; squash merge giữ lịch sử sạch trên `main`.
- **Không có check nào đo "một logical change"** bằng số file hay số project; đó là phán đoán của người review.
- **Stacked PR** dùng khi các thay đổi có dependency nhưng vẫn cần review độc lập; nhánh con rebase theo nhánh cha và tự retarget khi nhánh cha land.
- PR chỉ đổi tài liệu là Modelling; PR vừa đổi behaviour vừa cập nhật tài liệu của chính behaviour đó là một Delivery ([`evolution-process.md`](./evolution-process.md) §4.1).

### 5.2 Liên kết Issue

| Liên kết    | Dùng khi                                                                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Closes #N` | PR hoàn thành **toàn bộ** phạm vi Issue, và không còn phần nào phải làm sau merge. GitHub đóng Issue khi PR merge; reconciliation (§2.6) được ghi ngay sau đó, không phải trước. |
| `Refs #N`   | PR chỉ hoàn thành một phần Issue, hoặc chỉ hỗ trợ nó. Người làm phải tự đóng Issue sau khi phần còn lại xong và reconcile.                                                       |

- Không bắt buộc mọi PR có `Closes #`. PR không cần Issue khi là thay đổi nhỏ có outcome tự giải thích, và template cho phép giải thích lý do.
- `Closes #N` sai khi PR còn phần chưa làm: GitHub đóng Issue sớm, và việc đóng đó trở thành bằng chứng sai.
- PR merge không tự hoàn thành Issue. Reconciliation là bước riêng (§2.6, [`evolution-process.md`](./evolution-process.md) §6.7).

### 5.3 Vòng đời PR

- **Draft** khi bắt đầu implement, trừ thay đổi nhỏ đã hoàn chỉnh.
- **Ready for review** sau khi đã rebase lên default branch mới nhất, CI xanh, và mô tả nêu phần chưa làm.
- **Review** xử lý mọi finding material. Finding ngoài scope mở Issue riêng, không mở rộng PR.
- **CI** phải xanh trên revision cuối. CI xanh chỉ chứng minh check đã chạy, không chứng minh deploy ([`evolution-process.md`](./evolution-process.md) §5.2).
- **Merge queue và squash merge** là cơ chế duy nhất để land; chi tiết và `pr-check` → [`AGENTS.md`](../../AGENTS.md) `Pull requests`.
- **Sau merge**: reconcile, cập nhật Issue, đóng khi đủ điều kiện.

Quy tắc Conventional Commit cho PR title, scope Nx project và policy machine-enforced **không** thuộc tài liệu này. Nguồn canonical là [`AGENTS.md`](../../AGENTS.md) `Pull requests`, `commitlint.config.mjs` và `pnpm dx pr-check`; tài liệu này không chép lại.

## 6. Khi tài liệu này không trả lời được

Ghi lại giới hạn thay vì tự chọn giá trị:

- **Cấu hình không đọc được** (thiếu quyền, Project chưa tồn tại, token thiếu scope) — nêu rõ cái gì chưa xác minh được và để người có quyền quyết định.
- **Policy chưa từng được chốt** — ghi như open decision trong Issue hoặc trong tài liệu canonical sở hữu quyết định đó ([`docs/AGENTS.md`](../AGENTS.md) §11), không mặc định một giá trị.
- **Hai canonical document mâu thuẫn** — dừng và báo; không tự chọn bên thắng.

## 7. Bảo trì tài liệu này

- Canonical location là `docs/engineering/work-management.md`; tài liệu khác tham chiếu, không chép lại.
- Thay đổi quy tắc phải cập nhật đồng thời các template trong `.github/` và [`contribution-workflow.md`](./contribution-workflow.md) nếu chúng bị ảnh hưởng.
- Khi cấu hình GitHub thực sự thay đổi (Project được tạo, Milestone được thiết lập), cập nhật phần mô tả **policy**, không thêm ảnh chụp cấu hình.
