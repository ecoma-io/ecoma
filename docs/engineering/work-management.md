# GitHub Work Management

> **Phạm vi:** cách repository dùng GitHub Issue, Project, Milestone và Pull Request để tổ chức công việc kỹ thuật — khi nào tạo một work item, nội dung tối thiểu của nó, và điều kiện đóng.
>
> **Không thuộc tài liệu này:** vòng đời kỹ thuật, năm loại công việc (Issue Type) và trạng thái năng lực → [`evolution-process.md`](./evolution-process.md) · cách thực hiện một đơn vị công việc → [`contribution-workflow.md`](./contribution-workflow.md) · quy tắc commit, PR title và merge → [`AGENTS.md`](../../AGENTS.md) `Pull requests` · hướng dẫn contributor → [`CONTRIBUTING.md`](../../CONTRIBUTING.md).
>
> Tài liệu này quy định **policy**, không phải ảnh chụp cấu hình GitHub. Cấu hình hiện tại phải đọc từ GitHub trước khi dùng (`gh label list`, `gh api repos/<owner>/<repo>/milestones`); một giá trị không đọc được thì không được đoán.
>
> **Transition:** §2.3 còn khối _transition_ cho Issue Type (chốt 2026-11-11); đọc khối đó trước khi áp dụng các mục liên quan. Membership Project (§3) đã chuyển đổi xong: không còn ràng buộc chuyển tiếp nào.

## 1. Nguyên tắc

1. **GitHub là Work Management layer.** Kế hoạch, ưu tiên và thứ tự thực hiện thuộc GitHub; tài liệu canonical giữ specification và quyết định ([`evolution-process.md`](./evolution-process.md) §2, [`docs/AGENTS.md`](../AGENTS.md) §3).
2. **Một work item, một outcome.** Đơn vị công việc là thứ có thể land bằng một PR và được review độc lập — không phải một bước kỹ thuật bên trong nó.
3. **Công cụ chỉ chứng minh phần việc của nó.** Issue đóng, PR merge, CI xanh và deploy thành công là bốn sự kiện khác nhau ([`evolution-process.md`](./evolution-process.md) §5.2).
4. **Không tạo công cụ thứ hai cho cùng một câu hỏi.** Không có file backlog, roadmap hay bảng trạng thái trong `docs/` thay cho Issue, Project và Milestone.
5. **Không có giá trị mặc định được suy diễn.** Label, Milestone, assignee, Project field chỉ được set sau khi đọc thấy chúng tồn tại.
6. **Không phải công việc nào cũng cần đủ bốn công cụ.** Issue là bắt buộc cho work item; membership Project theo quy tắc root issue (§3.2); Milestone là tuỳ chọn theo biên delivery (§4).

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

**Root issue và sub-issue.** Cấu trúc outcome/work dùng native parent/child, và đó là nguồn sự thật duy nhất của hierarchy — không label, không field song song:

- **Root issue** (Issue không có parent) quản lý **outcome**: nó cần outcome phát biểu được và điều kiện đóng kiểm được. Khi outcome cần phân rã, các unit là sub-issue của nó.
- **Sub-issue** (Issue có parent) quản lý **một unit công việc**: nó cần scope chạy được trong một unit — thoả định nghĩa independently trackable ở trên. Root issue không phân rã tự đóng vai trò unit của chính nó.

Root issue thuộc Project; sub-issue không thuộc — quy tắc membership ở §3.2.

### 2.2 Work item và các loại record khác

Trách nhiệm của công cụ do [`evolution-process.md`](./evolution-process.md) §4.2 quy định. Mục này **không** thêm một trục phân loại mới; nó chỉ giúp nhận ra năm dạng Issue đang tồn tại khi quyết định lấy cái nào làm việc của mình. Các dạng này cùng sống trong GitHub nhưng **không** thay thế nhau. Cột Issue Type cho biết record đó ghi type nào theo §2.3:

| Loại                     | Trả lời                                              | Issue Type                                   | Điều kiện đóng                                                                                                                                                                     | Ví dụ dấu hiệu                                               |
| ------------------------ | ---------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Work item**            | Outcome nào sẽ đạt, bởi thay đổi nào                 | Của chính nó — một trong năm giá trị (§2.3)  | Outcome đạt và reconciliation xong (§2.6)                                                                                                                                          | Có mục tiêu, phạm vi, tiêu chí chấp nhận                     |
| **Coordination ledger**  | Nhiều workstream đang ở đâu trong một nỗ lực dài     | Không có — root issue hợp lệ không mang type | Nỗ lực kết thúc, hoặc ledger được thay bằng Issue cụ thể                                                                                                                           | Liệt kê workstream, trạng thái từng phần, mở qua nhiều PR    |
| **Precondition tracker** | Điều kiện bên ngoài nào phải xong trước khi bắt đầu  | Không có — root issue hợp lệ không mang type | Điều kiện đạt hoặc bị loại bỏ                                                                                                                                                      | Danh sách điều kiện, không có outcome sản phẩm               |
| **Experiment record**    | Giả thuyết nào đã được xác nhận hay bác bỏ           | Experiment                                   | Kết luận được ghi và decision liên quan đã có                                                                                                                                      | Hypothesis, tiêu chí đo đặt trước, kết quả                   |
| **Decision Issue**       | Quyết định nào cần chốt và phương án nào đã cân nhắc | Modelling                                    | Quyết định được ghi vào canonical location hoặc ADR, hoặc trong Change Specification đang sở hữu nó (accepted target decision — [`../changes/README.md`](../changes/README.md) §3) | Các phương án, tiêu chí chọn; không phải implementation plan |

Dashboard của công cụ ngoài (ví dụ Renovate Dependency Dashboard) là tool-owned, nằm ngoài taxonomy — không gán Issue Type cho nó.

Quy tắc:

- **Không biến record thành work item của mình.** Append finding vào ledger đang mở khi task yêu cầu; không mở lại record đã archive.
- **Không dùng work item thay ledger.** Nếu một Issue phải liệt kê nhiều outcome độc lập, tách work item ra và giữ Issue đó làm ledger — milestone không nhận nhiều outcome độc lập (§4).
- **Experiment record không phải delivery plan.** Kết quả experiment là bằng chứng để mở work item Modelling hoặc Delivery ([`evolution-process.md`](./evolution-process.md) §4.1).
- **Issue Type không quyết định loại record.** Một Issue type Experiment là record; một Issue type Delivery là work item — điều kiện đóng vẫn là §2.6, bảng trên chỉ mô tả khi nào record đó hết vai trò.

### 2.3 Issue Type trong GitHub

Năm giá trị canonical — **Discovery, Modelling, Experiment, Delivery, Remediation** — được định nghĩa tại [`evolution-process.md`](./evolution-process.md) §4.1. Tài liệu này quy định cách ghi chúng; không định nghĩa lại taxonomy hay điều kiện phân loại.

**Issue Type là nguồn classification duy nhất.** Bản chất của thay đổi được ghi bằng **Issue Type** — native metadata của GitHub, đặt được ngay khi tạo Issue (UI hoặc `gh issue create --type`). Sau transition, không tồn tại kênh song song nào: không custom Project field, không field trong Issue body, không label. Label không dùng vì hai hệ classification chồng nhau trên cùng một Issue, và vì type có thể đổi khi hiểu biết thay đổi — label đổi liên tục làm mất lịch sử.

**Issue Type khác issue category.** Category trả lời "đây là loại artifact nào" (label `bug`, `enhancement`, `documentation`); Issue Type trả lời "bản chất thay đổi là gì". Hai trục này không map cho nhau: một `bug` thường là Remediation, nhưng một `bug` chưa từng có behaviour cũng có thể là Delivery; một `documentation` issue có thể là Modelling hoặc Delivery. Không suy Issue Type từ category. GitHub hiện còn cấu hình type mặc định (Task/Bug/Feature) — đó là cấu hình mặc định của GitHub, không phải classification của org, và không được dùng thay cho năm giá trị Issue Type; cấu hình type cấp org là thay đổi cấu hình GitHub (Bước 2 của transition này), không phải policy. Label và issue category không là input của classification: không suy Issue Type từ chúng, và không tạo label hay field có tập giá trị trùng hoặc ánh xạ tới năm giá trị Issue Type.

**PR là carrier duy nhất.** Một PR không có Issue, và là nơi duy nhất mang thông tin về bản chất thay đổi, nêu Issue Type trong PR body với cùng một giá trị canonical. Đây là ngoại lệ hiếm, không phải kênh ghi thứ hai.

> **Transition — policy đích so với thực thi hiện tại (chốt 2026-11-11).**
>
> 1. **Bước 1 (thay đổi này):** policy only. Org chưa cấu hình năm Issue Type — type của org hiện là cấu hình mặc định của GitHub (Task/Bug/Feature), không phải classification theo policy này; Project và automation chưa thay đổi.
> 2. **Bước 2 (work item riêng A):** org cấu hình năm Issue Type Discovery/Modelling/Experiment/Delivery/Remediation. Issue Forms YAML không đặt được native type khi tạo, nên Issue tạo qua form vẫn ghi type bằng kênh tạm thời bên dưới cho tới khi bước 3 hoàn tất.
> 3. **Bước 3 (work item riêng B — dọn dẹp):** gỡ field work-kind tạm thời khỏi Issue form, gỡ single-select `Work kind` khỏi Project, retire convention kênh body, migrate các Issue hiện có một cách opportunistically (không bulk), audit Project membership cho sub-issue entries. (Automation root-aware đã ship 2026-11-11 — pipeline `project-management`, xem §3.2.)
>
> **Thẩm quyền khi lệch nguồn (divergence authority):** theo giai đoạn — (i) **trước Bước 2** (org chưa cấu hình năm Issue Type): dòng `## Loại công việc` trong Issue body là kênh **tạm thời và có thẩm quyền**; các nơi khác ghi lệch thì sửa theo nó. (ii) **Sau Bước 2, trước khi Bước 3 hoàn tất:** native Issue Type là kênh có thẩm quyền; Issue tạo qua form không đặt được native type nên vẫn ghi bằng dòng body — đó là kênh ghi hợp lệ của giai đoạn này cho tới khi được migrate opportunistically (Bước 3); khi một Issue có cả hai kênh mà lệch nhau, native thắng và dòng body được sửa theo nó. (iii) **Sau Bước 3:** native Issue Type là nguồn classification duy nhất; kênh body và dropdown bị retire. Kênh body là mục `Loại công việc` trong Issue body bất kể cấp heading hay hậu tố `(kênh tạm thời)` của form — đối chiếu theo tên mục, không theo literal string. Dropdown `Loại công việc` của Issue form là mặt form của kênh body (nó ghi chính dòng body đó): khi dropdown được dùng, giá trị `## Loại công việc` phải trùng dropdown — hai mặt của một kênh không được ghi lệch nhau. Sau Bước 2, không tạo classification trùng lặp: Issue đã có native type không ghi thêm dòng body, và Issue đã migrate thì dòng body được xoá ở lần cập nhật kế tiếp.
>
> **Đóng băng:** single-select `Work kind` của Project (§3.4) hiện tồn tại nhưng bị **đóng băng** — không set giá trị mới — chờ bước 3; còn dropdown `Loại công việc` trong Issue form là mặt form của kênh tạm thời `## Loại công việc` (nó ghi dòng body đó), giữ nguyên cho tới khi bước 3 gỡ bỏ.
>
> **Missing-type rule (cho work item):** blocker chỉ áp dụng khi work item cần một classification hoặc native GitHub capability không có kênh ghi nào được quy định — giá trị ngoài năm giá trị canonical, hoặc capability không có interim path; trong khi kênh tạm thời còn tồn tại (chưa tới bước 2), dùng kênh đó thay vì block; không tự chế classification thay thế; cũng không thay năm giá trị bằng type mặc định Task/Bug/Feature của GitHub.

### 2.4 Nội dung tối thiểu

Mọi work item phải trả lời được, bằng câu ngắn:

- **Outcome** — kết quả quan sát được sau khi xong.
- **Phạm vi** — phần nào của hệ thống được phép thay đổi.
- **Product attribution** — Product ID đang lái hoặc shared context nhận diện tường minh, theo quy ước ở §4; root issue cross-product liệt kê các product tham gia thay vì một Product ID duy nhất.
- **Ràng buộc** — invariant, contract, quyết định đã accept đang ràng buộc.
- **Dependency** — work item hoặc điều kiện phải xong trước.
- **Điều kiện hoàn thành** — cách verify, không phải danh sách việc cần làm.

Nội dung bổ sung theo Issue Type:

| Issue Type      | Thêm vào body                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| **Discovery**   | Câu hỏi cần trả lời; bằng chứng đã có; nguồn sẽ tìm; điều kiện để kết luận "đủ để chọn hoặc loại một hướng" |
| **Modelling**   | Specification/ADR nào sẽ thay đổi; quyết định nào đang mở; điều kiện accept                                 |
| **Experiment**  | Hypothesis; phạm vi và môi trường đo; tiêu chí đánh giá **đặt trước**; cách ghi kết quả                     |
| **Delivery**    | Outcome quan sát được; phần nào của capability target được phủ và phần nào chưa; tiêu chí verify đúng tầng  |
| **Remediation** | Deviation hoặc gap đang được đóng; nguồn gốc; điều kiện coi là đã đóng                                      |

Không đưa vào body: specification dài hạn, bảng trạng thái capability, hay danh sách task không có outcome. Những thứ đó thuộc canonical document hoặc Milestone.

**Root issue sở hữu Change Specification** tham chiếu spec bằng đường dẫn trong body; quy tắc ownership (một owner duy nhất, cách kiểm tra) thuộc [`../changes/README.md`](../changes/README.md) §4.

### 2.5 Cập nhật khi scope hoặc giả định thay đổi

- **Scope mở rộng quá Issue:** không tự mở rộng. Ghi phát hiện vào Issue, chọn một trong hai: mở Issue mới cho phần mới, hoặc sửa Issue hiện tại kèm lý do khi phần mới thật sự cùng outcome.
- **Giả định sai:** sửa Issue body hoặc thêm comment nêu giả định cũ, bằng chứng mới và ảnh hưởng — không xoá dấu vết giả định cũ. Nếu giả định sai làm đổi target, việc sửa canonical document là work item riêng.
- **Issue Type đổi:** ghi lý do trong comment; không silently reclassify.
- **Bị block bởi quyết định chưa chốt:** ghi rõ quyết định nào, ai/cái gì mở nó; chuyển sang work item khác thay vì giữ "đang làm dở" ([`evolution-process.md`](./evolution-process.md) §6.8).
- **Không cập nhật Issue cho khớp thực tế là lỗi quy trình**, không phải chi tiết hành chính.

### 2.6 Điều kiện đóng

Issue chỉ đóng với lý do **completed** khi:

1. Outcome trong Issue đã đạt, **hoặc** quyết định đã được ghi vào canonical location, **hoặc** experiment đã có kết luận.
2. Có bằng chứng tương ứng — lệnh đã chạy và kết quả, PR đã merge, ADR đã accept.
3. Reconciliation đã phân loại phần phạm vi theo [`evolution-process.md`](./evolution-process.md) §8.1 và ghi vào Issue comment.

**Đóng theo cấp.** Điều kiện (1)–(3) áp cho từng **sub-issue** theo unit của nó; một root issue không phân rã đóng như một unit. **Root issue** đóng khi **outcome** của nó đạt và reconciliation của outcome đó xong — tiến độ các sub-issue hiển thị native trên root issue (sub-issues progress), không cần bảng trạng thái song song.

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

Project sở hữu **portfolio visibility**: nhìn nhiều root issue cùng lúc, sắp thứ tự, thấy cái gì đang chờ. Project **không** sở hữu specification, không phải nguồn sự thật về trạng thái capability, và không thay thế Issue, Milestone hay tài liệu canonical ([`evolution-process.md`](./evolution-process.md) §4.2).

Project status **không phải** capability state. `In progress` trên Project không có nghĩa capability đang `Implemented`; `Done` không có nghĩa `Verified` hay `Released`.

### 3.2 Thành viên: root issue, không phải sub-issue

**Policy đích:**

- **Mọi root issue thuộc Project — không chọn lọc, không cần lý do.** Tư cách root issue (Issue không có parent) tự động kéo theo membership; sở hữu outcome (§2.1) là vai trò của root issue, không phải điều kiện phải đáp ứng để được theo dõi.
- **Sub-issue không thuộc Project.** Sub-issue sở hữu một unit công việc; nó được thấy qua root issue của mình nhờ sub-issues progress native, không cần item riêng.
- **Parent/child là nguồn sự thật của hierarchy.** Tư cách root/sub suy từ parent/child native — không từ label, không từ field, không từ Milestone.
- **Issue Type lấy từ native metadata**, không lưu lại bằng custom Project field (§2.3).
- **Milestone chỉ là delivery commitment** (§4); thuộc Milestone nào không đổi tư cách thành viên Project.

**Thực thi (đã chuyển đổi 2026-11-11):** membership được duy trì bởi reconciliation workflow của repository — pipeline `project-management` (Nx `@ecoma-io/project-management`) chạy audit theo lịch hằng ngày, theo sự kiện vòng đời issue (native `issues` trigger), và apply qua workflow dispatch. Pipeline suy desired membership từ parent/child native cộng các exclusion tường minh khai báo trong policy config colocated với pipeline, so với thực tế Project, rồi thêm/xoá item theo plan đã audit (§3.3). Label `project:track` đã retire: không gắn cho issue mới và đã bỏ khỏi issue đang mở; label object giữ lại vì issue đóng vẫn mang nó trong lịch sử. Filter của native `Auto-add to project` và trạng thái workflow là cấu hình GitHub — đọc từ GitHub, không chép vào tài liệu này (§1). Tìm thấy sub-issue nằm trong Project là **lệch**: pipeline báo trong report; không xoá tay.

### 3.3 Vòng đời membership

Membership được duy trì tự động bởi reconciliation workflow (§3.2): root issue mới vào Project ở kỳ reconcile kế tiếp (sự kiện vòng đời issue, lịch hằng ngày, hoặc dispatch apply); issue hết tư cách root rời Project theo plan của pipeline sau khi audit. Mỗi thay đổi parent/child có thể đổi tư cách root/sub, và membership đổi theo — bởi pipeline, không phải bằng tay.

Agent **không tự quản item**: không tự archive, không tự xoá, không tự thêm item, không gắn/bỏ label `project:track` (retired). **Mọi lệch** (sub-issue nằm trong Project, item trùng, item của issue không còn desired, item lạ không định danh được) xuất hiện trong report của pipeline; kênh sửa lệch là chạy lại pipeline (audit để xem, apply để sửa), không phải thao tác tay trên UI. Chỉnh sửa tay chỉ khi pipeline không chạy được, và phải ghi lại lý do.

| Tình huống                        | Hành vi của pipeline                                           |
| --------------------------------- | -------------------------------------------------------------- |
| Root issue được tạo               | Kỳ reconcile kế tiếp thêm item (Status do native workflow đặt) |
| Root issue được gắn parent        | Không còn là root → item bị remove ở kỳ apply kế tiếp          |
| Sub-issue bị tách parent          | Trở thành root → được thêm ở kỳ apply kế tiếp                  |
| Sub-issue chuyển sang parent khác | Vẫn là sub-issue → membership không đổi                        |
| Issue đóng                        | Item ở lại Project; membership lịch sử                         |
| Item trùng của cùng issue         | Giữ đúng một item, remove phần thừa                            |
| Item PR/draft trong Project       | Không bao giờ tự remove — chỉ báo trong report                 |

Quy tắc:

- **Sửa lệch qua pipeline, không qua tay.** Report audit là bằng chứng lệch; apply là cách sửa. Không kết luận lệch từ một lần đọc duy nhất nếu pipeline vừa chạy xong — GitHub Projects cần thời gian truyền bá item mới (đọc lại hoặc đợi kỳ audit sau).
- **Xoá item chỉ theo plan đã audit của pipeline; archive là quyết định riêng của coordinator**, cần lý do được ghi; không suy ra việc archive từ thay đổi hierarchy.
- **Membership không phải Project `Status`.** `Done` của Project vẫn không phải capability state (§3.1). Native workflow có thể tự đặt `Status` khi item được thêm, Issue đóng hoặc Pull Request merge — đó là trạng thái của item, không phải capability state. Các field còn lại do coordinator cập nhật theo công việc thực tế; policy này không quy định việc bật hay tắt các workflow đó.

### 3.4 Cấu hình tối thiểu

Một Project mới chỉ cần đúng những thứ sau để dùng được:

| Field    | Loại   | Giá trị                                                                                    |
| -------- | ------ | ------------------------------------------------------------------------------------------ |
| `Status` | native | `Todo` · `In Progress` · `Done` (giá trị mặc định của GitHub; đổi tên khi có lý do cụ thể) |

Project đang tồn tại còn single-select `Work kind` — có trước policy này và bị **đóng băng**: không set giá trị mới, deprecated chờ bước dọn dẹp trong khối transition ở §2.3. Không đưa nó vào cấu hình tối thiểu và không tạo field phân loại song song với Issue Type.

Chỉ thêm field khác khi có semantics rõ và có người dùng thật:

- `Priority` chỉ khi có tiêu chí ưu tiên được ghi và có người sắp thứ tự theo nó.
- Field ngày chỉ khi dùng để trả lời một câu hỏi cụ thể (ví dụ "việc gì đang trễ").
- Không thêm field chỉ để Project trông đầy đủ. Field không ai cập nhật là nhiễu, không phải cấu trúc.

Cấu hình Project là **work item riêng**, cần outcome được người có thẩm quyền xác nhận. PR đổi policy không tự tạo Project. Điều này áp dụng cả cho việc bật hoặc sửa `Auto-add to project` workflow và cho reconciliation pipeline đang chạy (§3.2): đổi policy config của pipeline hoặc filter của native workflow là thay đổi cấu hình, không phải thay đổi policy.

## 4. GitHub Milestone

Milestone chỉ dùng cho **một delivery outcome có biên rõ ràng** — nó là **delivery commitment**, độc lập với product: milestone không phải product boundary, không phải planning horizon, không phải release, và không phải calendar bucket.

- **Scope** — tập capability hoặc thay đổi thuộc milestone.
- **Mục tiêu** — outcome đóng được, phát biểu bằng kết quả chứ không bằng số task.
- **Điều kiện hoàn thành** — cách biết milestone xong.
- **Điều kiện kết thúc** — khi nào milestone đóng dù chưa đạt, và phần còn lại đi đâu.

Milestone chứa Issue của **một hoặc nhiều product**. Phạm vi milestone chọn theo outcome, không theo thời gian hay theo product:

| Tình huống                                                                        | Milestone                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Một product có delivery outcome coherent                                          | Milestone của product đó                                                                                                                                                                                                                 |
| Nhiều product phải phối hợp để đạt một delivery outcome duy nhất                  | Cross-product milestone                                                                                                                                                                                                                  |
| Các product có outcome độc lập, kể cả trong cùng thời kỳ                          | Milestone riêng cho từng outcome                                                                                                                                                                                                         |
| Shared capability ảnh hưởng nhiều product nhưng không tạo coordinated outcome nào | Shared change được mô hình một lần (Change Specification canonical); mỗi product bị ảnh hưởng có ghi nhận đúng phạm vi của mình — work item delivery khi cần delivery, ghi nhận impact trong Dependencies của spec khi chỉ chịu tác động |

Quy tắc:

- Một Milestone **có thể** chứa nhiều Issue độc lập; đó là mục đích của nó. Các Issue có thể thuộc một product hoặc nhiều product.
- **Cross-product milestone chỉ khi các product phải phối hợp cho một delivery outcome duy nhất.** Positive test: milestone chỉ tồn tại khi có một điều kiện hoàn thành duy nhất thỏa được chung cho toàn bộ scope của nó. Không tạo cross-product milestone chỉ vì các công việc rơi vào cùng thời kỳ; nỗ lực cắt ngang không có shared outcome dùng coordination ledger root issue (§2.2) cộng milestone riêng theo product.
- Không tạo Milestone cho từng Issue, hay để biểu diễn roadmap dài hạn.
- Milestone không mang số phase hay thứ tự roadmap. Nếu cần đánh số, số đó thuộc Milestone đang tồn tại, không phải di sản của roadmap cũ. Horizon (§4.1) là vị trí pipeline của từng product, không phải tên, số hay thứ tự của Milestone. Dòng khai báo trong description là bản ghi commitment (§4.1), không phải số phase hay thứ tự roadmap.
- Milestone không phải specification kiến trúc và không chứa danh sách task vô hạn.
- Milestone đóng không chứng minh capability `Released`, không chứng minh product nào được activate hay release — đó là các trạng thái độc lập (§4.2); `Released` vẫn cần bằng chứng deployment ([`evolution-process.md`](./evolution-process.md) §5.1).

**Root issue và milestone.** Root issue sở hữu outcome (§2.1) và có thể là product-specific hoặc cross-product. Root issue cross-product nêu outcome chung và phạm vi của từng product tham gia; nó **không** mang một Product ID toàn cục hay một horizon toàn cục — product scope nằm ở từng delivery issue, horizon nằm ở khai báo commitment của Milestone (§4.1). Delivery issue (sub-issue) thuộc **một Product ID** hoặc **một shared context nhận diện tường minh** — shared context được nêu bằng tên bounded context trong catalog Domains, hoặc tên shared capability kèm canonical location của nó — và nêu product/context, work type, milestone (khi có), dependency và điều kiện hoàn thành theo quy ước repository. Không tạo sub-issue cross-product rộng khi công việc phân rã được thành các item thuộc product riêng.

### 4.1 Product pipeline và Horizon

Mỗi product có một pipeline `M1 → M2 → Feature Discovery` **độc lập** với pipeline của product khác; một cross-product initiative không gộp các pipeline này thành một pipeline toàn cục. Pipeline là vị trí tiến hoá và sẵn sàng của scope product đó; hướng promotion là Feature Discovery → M2 → M1 ([`../changes/README.md`](../changes/README.md) §3). Feature Discovery là trạng thái suy ra, có thể rỗng — product chưa có M2 committable hay chưa có Feature Discovery đang mở là trạng thái hợp lệ, không tạo placeholder để lấp. Horizon đọc từ trạng thái GitHub của các khai báo commitment — không từ tài liệu, không từ Issue Type, không từ tên Milestone:

| Horizon               | Nghĩa                                                                                                                                                                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1**                | Delivery hiện tại của product — khai báo `Horizon: M1` trỏ product đó, trên một Milestone committed đang mở                                                                                                                                                                                                 |
| **M2**                | Delivery kế tiếp của product — khai báo `Horizon: M2` trỏ product đó; chỉ tạo khi scope committable, không tạo placeholder                                                                                                                                                                                  |
| **Feature Discovery** | Công việc Discovery/Modelling/Experiment còn mở được gán Product ID đó, chưa nằm dưới khai báo `Horizon:` nào trỏ product đó. Công việc không thuộc Product ID nào của Product Registry (dùng chung, cắt ngang) không nằm ở horizon riêng — nó theo pipeline đang tiêu thụ, quy tắc shared context dưới đây |

**Khai báo commitment.** Một Milestone là **committed** khi đang mở và description mang đúng các dòng khóa — đối chiếu theo tên khóa, không theo literal string. Phạm vi product của milestone ghi bằng **đúng một** trong hai dạng: `Product: <product>` — milestone của **một** product, với `<product>` khớp chính xác một Product ID trong Product Registry dưới đây; hoặc `Participating products: <product>[, <product>...]` — cross-product milestone với từ hai Product ID trở lên. Không mang cả hai dạng. Thêm không giới hạn số dòng `Horizon: M1` / `Horizon: M2`: dòng trong milestone có dòng `Product:` bind tới product đó; dòng trong cross-product milestone phải nêu rõ product với dạng `Horizon: M1 (<product>)`. Một dòng `Horizon:` bind **đúng một** product tới M1 hoặc M2; product tham gia cross-product milestone không bắt buộc có dòng `Horizon:` nào. Dòng khai báo là bản ghi commitment trong description, không phải số phase, và không bao giờ vào tên Milestone (§4). Milestone đóng thì hết tư cách committed; dòng khai báo còn lại chỉ là lịch sử. Milestone committed không có dòng `Horizon:` nào vẫn hợp lệ — delivery outcome của nó không gắn horizon nào; product tham gia giữ pipeline position riêng, đọc từ các khai báo khác của product đó nếu có. Product tham gia theo hai cách: **committed** — khai báo `Horizon:` trỏ product đó trên milestone này; **contributing** — tham gia mà không khai báo horizon, pipeline position của product đó không đổi. Work item của shared context có thể nằm trong một Milestone committed khi nó phục vụ outcome của các product tham gia; nó không tạo dòng khai báo riêng và không chiếm khe uniqueness nào.

**Product Registry.** Danh sách Product ID hợp lệ cho dòng `Product:` — portfolio vocabulary do tài liệu này sở hữu:

| Product ID        | Product         |
| ----------------- | --------------- |
| `llm-marketplace` | LLM Marketplace |
| `pact-broker`     | Pact Broker     |
| `remote-cache`    | Remote Cache    |

- **Registry là nguồn duy nhất của Product ID.** Đây là vocabulary portfolio, không phải một knowledge view; không suy Product identity từ tên thư mục Feature, tên bounded context, tên Nx project, tên application, tên deploy unit, số Issue hay tên Milestone.
- **Hợp lệ không phụ thuộc Features view.** Một Product ID vẫn hợp lệ khi [`../features/README.md`](../features/README.md) chưa có Feature document nào đã hiện thực; không thêm Feature document target-only chỉ để làm Product ID hợp lệ.
- **Không tự chế product.** Không tạo product `shared`, `platform` hay `ecoma-platform`; shared context không là product (khối dưới).
- **Application không phải pipeline.** `llm-seller` và `llm-console` là application của `llm-marketplace`, không phải Product ID riêng.
- **Mở rộng tường minh.** Product ID mới yêu cầu cập nhật registry này trước khi dùng trong khai báo Milestone.

**Product và các khái niệm láng giềng.** **Product** là pipeline identity lấy từ registry trên; **driving Milestone** của một work item là Milestone committed đang mở mà work item đó nằm dưới — bất kể milestone đó là của một product hay cross-product — hai khái niệm này định nghĩa tại đây. **Pipeline position** của product là horizon của product đó (bảng trên) — không phải một khái niệm thứ hai. Bốn khái niệm còn lại có canonical home riêng, chỉ link không định nghĩa lại: **feature area** — nhóm thư mục của view Features ([`../features/README.md`](../features/README.md)); **bounded context** — catalog của [`../domains/README.md`](../domains/README.md); **application** — view [`../applications/README.md`](../applications/README.md); **shared context** — ngữ cảnh cắt ngang nhiều pipeline, không có pipeline riêng. Cross-product initiative **không phải một artifact** và không sở hữu gì: bản ghi của nó là shared specification, các work item theo product, tối đa một Milestone, và tuỳ chọn một coordination ledger root issue (§2.2).

**Thẩm quyền commitment.** Tạo Milestone, sửa dòng khai báo và đóng Milestone là thay đổi cấu hình GitHub — work item riêng do người có thẩm quyền quyết định và xác nhận, như cấu hình Project ở §3.4. Agent chỉ đọc và báo lệch; không tự tạo, sửa hay đóng.

Quy tắc:

- **Tính duy nhất theo từng product:** tối đa một khai báo `Horizon: M1` và một khai báo `Horizon: M2` đang mở cho mỗi product, tính trên **tất cả** Milestone committed đang mở — của chính product đó lẫn cross-product; khe này thuộc về từng product, không phải một khe chung toàn repository, và không bao giờ gộp giữa các product.
- **M2 cần M1:** `Horizon: M2` của một product chỉ hợp lệ khi product đó đang có khai báo `Horizon: M1` mở. Khi M1 đóng, trong cùng thay đổi cấu hình: nâng khai báo `Horizon: M2` (nếu có) lên `Horizon: M1`, hoặc để khe M1 trống trung thực khi chưa có M2 committable. Khai báo `Horizon: M2` mở mà product không còn M1 mở là **lệch**: báo, không tự sửa. Việc nâng M2 lên M1 là thay đổi cấu hình tường minh, không tự động theo việc đóng M1.
- **Tham gia không gộp pipeline:** product tham gia cross-product milestone giữ nguyên pipeline position, scope, priority và quyết định release của mình. Tham gia không tạo product chung, không tạo horizon chung, và không đặt ra nghĩa vụ khai báo `Horizon:` cho product nào.
- **Nguồn suy diễn cấm:** không suy horizon từ thứ tự tạo Milestone, due date, tên Milestone, số Issue, việc một product tham gia milestone nào hay phán đoán. Không đọc được dòng khai báo, hoặc đọc được nhiều giá trị xung đột cho một product (hai M1, hai M2, M2 không có M1, `Product`/`Participating products` không khớp chính xác Product Registry) → **báo ambiguity kèm bằng chứng đã đọc** (`gh api repos/<owner>/<repo>/milestones`), không chọn giá trị.
- **Trục product** là các Product ID của Product Registry; mỗi Product ID có đúng một pipeline. Shared context không tạo pipeline riêng: khi một pipeline thật sự lái công việc, gán work item với Product ID của pipeline đó; khi không pipeline nào thật sự lái một work item cắt ngang, để product attribution trống — không bịa commitment M1/M2 để lấp field. **Product attribution của work item** là giá trị trường `Sản phẩm (Product)` của Issue form `engineering_work.yml`, hoặc dòng tương đương trong body khi Issue không tạo qua form; root issue cross-product để trường này trống và liệt kê các product tham gia trong body. Change Specification phục vụ nhiều pipeline ghi từng pipeline chịu tác động (Product ID, kèm Milestone thực tế đang lái nếu có) trong Dependencies, **không ghi giá trị horizon** ([`../changes/README.md`](../changes/README.md) §2).
- **Shared change không nhân bản:** một shared change = một Change Specification canonical với một owning root issue ([`../changes/README.md`](../changes/README.md) §4); mỗi product pipeline bị ảnh hưởng xuất hiện trong Dependencies của spec đó; delivery issue theo product link về cùng spec. Khi hai product thật sự cần target model khác nhau, giải bằng tách spec tại ranh giới ownership/contract với dependency một chiều — các phương án như xử lý dependency cycle ([`../changes/README.md`](../changes/README.md) §4) — không tạo bản sao spec theo product.
- **Horizon là mục tiêu, không phải slot bắt buộc.** Khoảng trống pipeline được thể hiện trung thực, không tạo Milestone giả để lấp.

### 4.2 Milestone completion, activation và release

Bốn khái niệm khác nhau và không suy ra nhau:

| Khái niệm                | Nghĩa                                                                            | Bằng chứng                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Issue completion**     | Unit công việc đạt điều kiện đóng (§2.6)                                         | Bằng chứng theo §2.6                                                                                              |
| **Milestone completion** | Delivery outcome đạt theo điều kiện hoàn thành ghi trong milestone (§4)          | Đối chiếu điều kiện hoàn thành của milestone với trạng thái các phần tham gia — không phải chỉ số Issue đã đóng   |
| **Activation**           | Capability hoặc product được đưa vào vận hành theo activation process của nó     | Bằng chứng theo activation process của capability/product đó; activation không phải một capability state của §5.1 |
| **Release decision**     | Quyết định và quy trình riêng của từng product để ship hoặc expose functionality | Quyết định có ghi nhận của product đó; không tự suy ra capability state nào                                       |

Quy tắc:

- **Milestone completion không activate hay release product nào.** Milestone đóng chỉ chứng minh delivery outcome đạt. Ngược lại, capability state `Released` vẫn theo [`evolution-process.md`](./evolution-process.md) §5.1 và không bao giờ suy ra từ việc milestone đóng hay release decision đã đưa.
- **Điều kiện hoàn thành của cross-product milestone là hội (conjunction)** của scope đã khai báo của từng product tham gia và từng integration gate được nêu. Bằng chứng đóng gồm: issue completion của từng phần tham gia (§2.6) kèm bằng chứng verify từng gate — liệt kê trong work item cấu hình thực hiện việc đóng (§4.1 Thẩm quyền commitment). Milestone có điều kiện hoàn thành không thể thoả đóng theo điều kiện kết thúc của nó (§4); phần còn lại đi theo quy tắc rút participation dưới đây.
- **Release là quyết định product-specific và độc lập.** Một product hoàn thành phần scope của mình trong cross-product milestone có thể đưa ra release decision khi điều kiện riêng của phần đó thoả và không có integration gate nào chặn — kể cả khi milestone chưa hoàn thành và product khác còn bị chặn. Cross-product milestone không suy ra release đồng bộ.
- **Integration gate là ràng buộc chung duy nhất.** Dependency xuyên product và integration gate được khai báo tường minh — trong milestone, root issue, hoặc mục Dependencies của Change Specification liên quan. Gate trỏ tới nguồn canonical của ràng buộc, không chép lại. Khi gate bảo vệ một system invariant (ví dụ database là quota/settlement authority), gate đó là bắt buộc và không được bỏ qua theo từng product; ngoài phần đã khai báo, không tạo phụ thuộc delivery/release giữa các product khi outcome phân rã được thành phần độc lập.
- **Participation kết thúc theo từng product.** Phần tham gia của một product coi như hoàn thành khi scope đã khai báo của product đó và các gate ràng buộc nó thoả — milestone vẫn mở cho các product còn lại, và từ thời điểm đó phần tham gia này không còn tính vào khe uniqueness `Horizon:` của product đó (§4.1). Kết thúc participation được ghi nhận bằng cách gỡ dòng `Horizon:` trỏ product đó khỏi khai báo commitment trong cùng thay đổi cấu hình — trạng thái khai báo phải luôn phản ánh đúng các khe uniqueness đang tính, vì §4.1 đọc khai báo chứ không đọc trạng thái issue. Product rút khỏi milestone giữa chừng bằng cách gỡ scope tham gia (thay đổi cấu hình GitHub theo thẩm quyền ở §4.1); work item còn lại chuyển sang milestone kế của product đó hoặc không thuộc milestone nào — khe trống trung thực.
- **Đổi scope milestone committed là material change**, triggering impact assessment ([`../changes/README.md`](../changes/README.md) §3–§4); phần đã delivery được reconcile độc lập. Khi delivery của một product làm invalidate Change Specification mà pipeline khác đang dựa vào, xử lý theo cơ chế impact hiện có — verdict ghi trên owning root issue; delivery unit đang tiêu thụ spec bị Blocked/Superseded dừng theo [`evolution-process.md`](./evolution-process.md) §6.8; horizon promotion của package bị invalidate chờ spec được re-derive.
- **Activation bị hoãn là công việc của product đó.** Milestone completion không tự động kéo theo activation; phần activation chưa làm được theo activation process của capability/product được track bằng work item riêng của product đó, với điều kiện hoàn thành và bằng chứng riêng.
- **Bốn khái niệm không suy ra nhau.** Mỗi tuyên bố cần bằng chứng riêng theo [`evolution-process.md`](./evolution-process.md) §5.

## 5. Pull Request

### 5.1 Một PR là một logical change

Một PR đại diện cho **một thay đổi logic review độc lập được** — không phải một file, một commit hay một Nx project. Một logical change có thể chạm nhiều file, nhiều Nx project, test, docs và configuration nếu chúng cùng phục vụ một outcome.

- **Không bắt buộc một commit cho mỗi PR.** Số commit trên nhánh là lựa chọn của người làm; squash merge giữ lịch sử sạch trên `main`.
- **Không có check nào đo "một logical change"** bằng số file hay số project; đó là phán đoán của người review.
- **Stacked PR** dùng khi các thay đổi có dependency nhưng vẫn cần review độc lập; nhánh con rebase theo nhánh cha và tự retarget khi nhánh cha land.
- PR chỉ đổi tài liệu là công việc có Issue Type Modelling; PR vừa đổi behaviour vừa cập nhật tài liệu của chính behaviour đó là một Delivery ([`evolution-process.md`](./evolution-process.md) §4.1).

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
- Khối _transition_ ở §2.3 và §3 phải được cập nhật trong cùng thay đổi khi work item cấu hình Issue Type hoặc work item dọn dẹp transition hoàn tất; không để policy đích và thực thi hiện tại mâu thuẫn nhau mà không ghi nhận.
