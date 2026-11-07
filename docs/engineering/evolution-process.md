# Engineering Evolution Process

> **Phạm vi:** quá trình kỹ thuật của repository ecoma-io — hiểu hệ thống, tiến hoá mô hình, chọn và hiện thực vertical slice, verify, release và reconcile. Tài liệu này là **canonical** cho ba lớp tri thức, bốn view, năm loại công việc, vòng đời bảy bước và ngữ nghĩa trạng thái năng lực.
>
> **Không thuộc tài liệu này:** quy tắc viết và sở hữu tài liệu → [`docs/AGENTS.md`](../AGENTS.md) · kiến trúc hệ thống → [`architecture/`](../architecture/README.md) · ranh giới domain, ngôn ngữ domain → [`domains/README.md`](../domains/README.md) · thiết kế application/composition → [`applications/README.md`](../applications/README.md) · test taxonomy và Nx target → [`06-testing.md`](../architecture/06-testing.md) · CI/CD, release, rollback → [`02-delivery.md`](../architecture/02-delivery.md).
>
> Tài liệu này mô tả **quá trình**, không mô tả trạng thái hiện tại của hệ thống và không tuyên bố một capability cụ thể đang ở đâu. Trạng thái được suy ra từ bằng chứng theo §5.

## 1. Nguyên tắc

1. **Tiến hoá liên tục, không waterfall.** Hiểu, mô hình hoá, deliver và reconcile chạy song song ở các nhánh công việc khác nhau.
2. **Tri thức có một chủ sở hữu.** Mỗi fact hoặc quyết định có đúng một canonical location (→ [`docs/AGENTS.md`](../AGENTS.md) §4). Nơi khác tham chiếu, không sao chép.
3. **Target không bị giới hạn bởi hiện tại.** Thiếu runtime, database hay deploy unit không xoá một capability khỏi mô hình target.
4. **Trạng thái phải có bằng chứng.** Không tuyên bố Specified, Implemented, Verified hay Released nếu không nêu được nguồn chứng minh tương ứng (§5).
5. **Kế hoạch và trạng thái không được duy trì thủ công.** Kế hoạch thuộc GitHub; trạng thái được suy ra khi cần, không lưu thành bảng song song trong tài liệu.
6. **Mỗi quy tắc phải hành động được.** Một quy tắc không giúp developer hoặc coding agent quyết định bước tiếp theo thì không thuộc tài liệu này.

## 2. Ba lớp

| Lớp                    | Câu hỏi                                                  | Nguồn sự thật                                          | Không làm                                         |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| **Knowledge**          | Hệ thống được hiểu như thế nào?                          | Repository — tài liệu canonical, ADR, contract, source | Không theo dõi tiến độ                            |
| **Work Management**    | Ai đang làm gì, vì outcome nào, theo thứ tự nào?         | GitHub — Issue, Project, Milestone, Pull Request       | Không lưu specification dài hạn                   |
| **Reality & Evidence** | Capability thật sự đạt tới đâu, dựa trên bằng chứng nào? | Code, test result, deployment record, runtime evidence | Không phải một tài liệu cần cập nhật thường xuyên |

Ba lớp bổ sung nhau: Knowledge định nghĩa target, Work Management tổ chức thay đổi, Reality & Evidence xác định khoảng cách giữa target và thực tế. Không lớp nào thay thế lớp khác.

## 3. Knowledge — bốn view

Repository là nguồn canonical của tri thức kỹ thuật, gồm bốn view:

| View             | Sở hữu                                                                                                                                                                                                                                                | Vị trí canonical hiện tại                                                                                                                                                                     | Không sở hữu                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Architecture** | Tổ chức kỹ thuật, ràng buộc, nguyên tắc, quyết định toàn hệ thống                                                                                                                                                                                     | [`architecture/`](../architecture/README.md); quyết định toàn hệ thống ở [`01-architecture.md`](../architecture/01-architecture.md) §8                                                        | Domain model, thiết kế application                                                                         |
| **Domains**      | Trách nhiệm nghiệp vụ, quy tắc, invariant, domain model, ranh giới context                                                                                                                                                                            | [`domains/README.md`](../domains/README.md) và `domains/<context>/`; ADR ở `domains/<context>/adr/`                                                                                           | Topology, hạ tầng, cấu trúc code                                                                           |
| **Applications** | Composition, BFF/UI, API runtime, use case/orchestration, adapter, persistence mechanics, queue/outbox, background job execution, retry/lease/concurrency, config/deploy/monitoring/runbook; contract **tiêu thụ và compose** ở ranh giới application | [`applications/`](../applications/README.md) — mỗi executable component có README và `01-architecture.md`/`02-requirements.md`/`03-operations.md`; background job nằm phẳng, không có `jobs/` | Định nghĩa contract (provider-owned); trách nhiệm nghiệp vụ; domain model                                  |
| **Features**     | Vấn đề người dùng, outcome mong muốn, product capability, requirement cấp sản phẩm                                                                                                                                                                    | [`features/`](../features/README.md)                                                                                                                                                          | Business rule/invariant (domain model); requirement kỹ thuật cấp application; cách hiện thực, backlog task |

Ba điểm dễ nhầm cần phân biệt rõ:

- **"Applications" là tên view, không phải Nx project type.** [`05-code-architecture.md`](../architecture/05-code-architecture.md) §6.1 dùng `type:application` cho DDD layer (use case, orchestration, ports) và `type:composition` cho thứ deploy được. View Applications bao trùm cả hai cùng job/BFF: nó là góc nhìn về ranh giới và composition, không phải một loại project.
- **"Capability" có ba nghĩa.** (i) _Business capability_ — trách nhiệm nghiệp vụ do một bounded context sở hữu, canonical ở [`domains/README.md`](../domains/README.md) §1.1. (ii) _Product capability_ — outcome sản phẩm do một Feature sở hữu, canonical ở [`features/`](../features/README.md). (iii) _Capability target_ — đơn vị mà §5 đo trạng thái; đó là một phần của (i) hoặc (ii) được phát biểu đủ hẹp để verify. Tài liệu này không định nghĩa lại (i).
- **Contract do provider sở hữu.** Định nghĩa contract thuộc bounded context cung cấp nó ([`05-code-architecture.md`](../architecture/05-code-architecture.md) §4); schema chính xác là machine-readable contract ([`docs/AGENTS.md`](../AGENTS.md) §4). View Applications chỉ sở hữu việc application tiêu thụ và compose contract đó.

Quy tắc:

1. **Mỗi view sở hữu tri thức của mình.** View khác tham chiếu bằng link tới canonical location, không chép lại nội dung.
2. **Không phải thay đổi nào cũng chạm cả bốn view.** Chỉ cập nhật view có tri thức thực sự thay đổi; bỏ qua view không liên quan là hành vi đúng.
3. **Features mô tả capability, không phải backlog hiện thực.** Một Feature nêu vấn đề, outcome, phạm vi và requirement; nó không liệt kê task, PR hay thứ tự thực hiện — những thứ đó thuộc Work Management.
4. **Task nhỏ không tự động cần Feature document.** Bug fix, refactor nội bộ, thay đổi tài liệu và task vận hành là công việc hợp lệ dù không thuộc Feature nào.
5. **Feature document mô tả capability, không mô tả trạng thái.** Một Feature document chỉ được tạo khi đã xác định được vấn đề người dùng và outcome quan sát được; nó không mang status field, không liệt kê issue/PR và không đóng vai trò backlog. Quy tắc viết → [`docs/AGENTS.md`](../AGENTS.md) §3.
6. **Model target không bị giới hạn bởi implementation hiện tại.** Thiếu runtime hoặc deploy unit không xoá capability khỏi view Domains hay Features (giữ nguyên quy tắc ở [`domains/README.md`](../domains/README.md) §1.2).
7. **Tài liệu target không mang trạng thái triển khai.** `architecture/`, `domains/` và `applications/` không có cột "đã implement/chưa implement" (→ [`docs/AGENTS.md`](../AGENTS.md) §2). Trạng thái là kết quả suy ra tại §5.
8. **ADR có thể là record canonical cho quyết định toàn hệ thống.** ADR hiện nằm dưới `domains/<context>/adr/`, kể cả khi quyết định có phạm vi toàn hệ thống — [`01-architecture.md`](../architecture/01-architecture.md) §8 trỏ tới ADR như vậy thay vì chép lại nội dung (ví dụ A18 trỏ ADR-0015, A21 trỏ ADR-0013). Không có ADR directory dưới `applications/`; quyết định cấp application vẫn ghi ADR dưới `domains/<context>/adr/` của context chịu ràng buộc, và view Applications trỏ tới ADR đó. Một quyết định chưa chốt không được ghi như đã chốt (→ [`docs/AGENTS.md`](../AGENTS.md) §6).

## 4. Work Management — công việc kỹ thuật

### 4.1 Năm loại công việc

Loại công việc phân loại **bản chất của thay đổi**, không phải kích thước hay người thực hiện. Loại được ghi bằng **free text** trong Issue hoặc PR body, hoặc bằng field `Loại công việc` (không bắt buộc) của Issue form; không có label riêng, và không được coi là machine-checkable. Cách ghi cụ thể → [`work-management.md`](./work-management.md) §2.3.

| Loại            | Dùng khi                                              | Kết thúc khi                                                       | Artifact                                                      |
| --------------- | ----------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| **Discovery**   | Còn unknown phải giảm trước khi quyết định            | Có bằng chứng đủ để chọn hoặc loại một hướng                       | Issue với evidence và kết luận; không tạo thay đổi production |
| **Modelling**   | Specification hoặc quyết định cần thay đổi            | Specification được accept, hoặc ADR được accept                    | PR tài liệu, ADR                                              |
| **Experiment**  | Giả thuyết kỹ thuật chưa chắc và cần thử có kiểm soát | Giả thuyết được xác nhận hoặc bác bỏ theo tiêu chí đo đã đặt trước | Issue với tiêu chí đo, mã thử hoặc báo cáo kết quả            |
| **Delivery**    | Có outcome có giá trị và verify độc lập được          | Slice đạt Verified; đạt Released nếu phạm vi bao gồm deployment    | PR kèm test và bằng chứng verification                        |
| **Remediation** | Có deviation quan trọng hoặc gap đã biết              | Deviation được đóng, hoặc được chấp nhận có ghi nhận và có owner   | Issue + PR, hoặc ADR nếu deviation là quyết định              |

Phân biệt khi một thay đổi thoả nhiều loại — áp dụng theo thứ tự sau, dừng ở loại khớp đầu tiên:

1. **Remediation** nếu đóng một **deviation** đã được chấp nhận, hoặc một gap **do slice trước để lại** hay **do target thay đổi**. Gap mới phát hiện ở §6.3 cho một capability chưa từng có là input bình thường của Delivery, không phải Remediation — nếu không, mọi feature work sẽ bị xếp nhầm vào Remediation.
2. **Experiment** nếu mục đích chính là đo một giả thuyết và kết quả sẽ bị bỏ hoặc viết lại. Discovery khác ở chỗ nó tìm bằng chứng đã tồn tại; Experiment tạo bằng chứng mới bằng cách chạy thứ gì đó.
3. **Modelling** nếu sản phẩm chính là specification hoặc ADR. PR vừa đổi behavior vừa cập nhật tài liệu của chính behavior đó là **một** Delivery; PR chỉ đổi tài liệu là Modelling.
4. **Delivery** nếu tạo ra behavior mới có giá trị.
5. **Discovery** nếu chỉ tạo ra hiểu biết, không tạo ra behavior.

Experiment không đi vào production path. Code thử nằm trên branch riêng, không merge, và kết quả được ghi trong Issue cùng tiêu chí đo; nếu một experiment cần merge để đo thì nó là Delivery có kèm tiêu chí đo. Kết quả experiment là bằng chứng để chuyển thành Modelling hoặc Delivery.

### 4.2 Trách nhiệm của từng công cụ

| Công cụ              | Sở hữu                                                                           | Không sở hữu                                           |
| -------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **GitHub Issue**     | Một unit công việc independently trackable: vấn đề, phạm vi, tiêu chí hoàn thành | Specification dài hạn; trạng thái capability           |
| **GitHub Project**   | Portfolio visibility, ưu tiên, điều phối giữa các unit                           | Nguồn sự thật về trạng thái capability; specification  |
| **GitHub Milestone** | Một tập objective delivery có biên, gắn với outcome và thời điểm kết thúc        | Roadmap dài hạn; spec kiến trúc; danh sách task vô hạn |
| **Pull Request**     | Thay đổi reviewable và bằng chứng hiện thực của nó                               | Bằng chứng deploy hoặc business outcome                |

Quy tắc:

1. **Tài liệu không phải backlog thứ hai.** Không tạo danh sách task trong `docs/` để thay Issue. Kế hoạch triển khai thuộc GitHub Issue và Milestone; tài liệu chỉ giữ đặc tả, quyết định và bằng chứng ([`docs/AGENTS.md`](../AGENTS.md) §3).
2. **Không phải Issue nào cũng thuộc Feature.** Bug, remediation, discovery, experiment và hạ tầng thường không thuộc Feature nào.
3. **Đóng Issue không có nghĩa Feature hoàn thành.** Issue chỉ đóng unit công việc của nó; trạng thái capability xác định theo §5.
4. **Không tạo tầng tài liệu Roadmap.** Kế hoạch thuộc GitHub Issue và Milestone. Không thêm file roadmap, danh sách phase hay backlog thủ công vào `docs/`.
5. **Milestone không phải roadmap dài hạn và không phải đặc tả kiến trúc.** Nội dung của một Milestone được đo bằng outcome đóng được, không bằng số task.
6. **Trách nhiệm đích, không phải cấu hình đã có.** Bảng trên mô tả trách nhiệm của Project và Milestone, không tuyên bố chúng đã được thiết lập. Trạng thái cấu hình GitHub hiện tại thuộc PR hoặc Issue thiết lập chúng, không thuộc tài liệu này (§4.3).

Việc tạo Issue, branch và draft PR cho một unit tuân theo [`AGENTS.md`](../../AGENTS.md) `Workflow`; tài liệu này không chép lại các bước đó.

### 4.3 Chưa chốt trong tài liệu này

Chi tiết Issue form, Project field, label và PR template **không** thuộc tài liệu này. Chúng thuộc thay đổi riêng và chỉ có hiệu lực khi được cập nhật ở nguồn canonical tương ứng (`.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE/`, cấu hình GitHub). Tài liệu này không mô tả cấu hình GitHub nào chưa được xác minh.

## 5. Reality & Evidence — trạng thái thực tế

### 5.1 Bốn trạng thái năng lực

| Trạng thái      | Nghĩa                                                 | Bằng chứng tối thiểu                                                                                                                                                                                                                                            | Không chứng minh        |
| --------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **Specified**   | Behavior mong muốn đã được ghi ở canonical location   | Một specification đã được review và accept, **hoặc** một ADR có status `Accepted` và **không** bị supersede ở phần đang xét, hoặc một requirement đã accept. Requirement đánh dấu có điều kiện (`nếu chốt`) hoặc nằm trong open-boundary section **không** tính | Behavior đã tồn tại     |
| **Implemented** | Behavior có hiện thực trong source code hoặc contract | Source code, schema, API/event contract **hoặc** cấu hình, ở đúng nơi chứa behavior đó                                                                                                                                                                          | Behavior đúng           |
| **Verified**    | Behavior đã đạt tiêu chí verification áp dụng         | Kết quả chạy của target test đúng tầng — `test`, `test-integration`, `system-test` hoặc contract verification (→ [`06-testing.md`](../architecture/06-testing.md) §4)                                                                                           | Behavior đã deploy      |
| **Released**    | Behavior đã deploy tới environment dự định            | Deployment record **và** kiểm tra environment sau deploy                                                                                                                                                                                                        | Business outcome đã đạt |

**"Accept"** ở đây nghĩa là review đã hoàn tất và quyết định được ghi lại — ADR có status `Accepted`, hoặc specification được merge sau review. Repository không có field acceptance riêng cho specification; PR review là bằng chứng. Với ADR bị supersede một phần, claim `Specified` chỉ áp dụng cho phần **chưa** bị supersede: ví dụ ADR-0001 (staff/RBAC storage) vẫn Accepted nhưng phần database/schema đã bị ADR-0013 thay thế.

**"Environment dự định"** là environment mà capability được thiết kế để phục vụ, do specification của nó xác định. Deploy local chỉ chứng minh `Released` khi environment dự định đúng là local (ví dụ tooling chỉ dùng cho developer). Với capability phục vụ người dùng thật, deploy local **không** chứng minh `Released`.

**Giới hạn hiện tại của `Released`:** repository chưa có deploy pipeline staging/production và chưa có nơi lưu deployment record — [`02-delivery.md`](../architecture/02-delivery.md) §12 liệt kê chính việc lưu provenance release là chưa chốt. Vì vậy `Released` hiện **không thể** được chứng minh cho capability phục vụ production bằng artifact trong repository; nó chỉ khả dĩ cho environment mà chính lần chạy local tạo ra bằng chứng ghi lại được. Khi cơ chế đó được thiết lập, điều kiện `Released` không đổi — chỉ nguồn bằng chứng trở nên khả dụng.

Bốn trạng thái là **bốn tuyên bố độc lập**, mỗi trạng thái cần bằng chứng riêng của nó. Không trạng thái nào suy ra trạng thái khác: Implemented không suy ra từ Specified, Verified không suy ra từ Implemented, Released không suy ra từ Verified.

### 5.2 Không được đánh đồng

- Issue đã đóng **không** có nghĩa capability đã hoàn thành.
- PR đã merge **không** có nghĩa behavior đã được verify.
- CI xanh **không** có nghĩa đã deploy thành công.
- Deploy thành công **không** có nghĩa business outcome đã đạt.

Mỗi câu trên đúng vì công cụ chỉ chứng minh phần việc của nó: Issue đóng chứng minh unit công việc kết thúc; CI xanh chứng minh các check đã chạy trên đúng revision; deployment record chứng minh artifact đã tới environment, không chứng minh tác động nghiệp vụ.

### 5.3 Nguồn bằng chứng và giới hạn

| Nguồn                                    | Suy ra được                         | Giới hạn                                                         |
| ---------------------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| Tài liệu canonical, ADR                  | Specified                           | Không suy ra bất kỳ trạng thái nào khác                          |
| Source code, schema, contract, cấu hình  | Implemented                         | Không chứng minh behavior đúng                                   |
| Kết quả test đúng tầng                   | Verified trong phạm vi test đã chạy | Không phủ behavior ngoài phạm vi; không phải deployment evidence |
| CI result                                | Các check đã chạy trên revision đó  | Không phải deployment record; không chứng minh môi trường thật   |
| Deployment record + kiểm tra environment | Released                            | Không chứng minh business outcome                                |
| Telemetry, metric nghiệp vụ              | Outcome thực tế                     | Không có sẵn trong repository; cần nguồn ngoài                   |

**Giới hạn bắt buộc phải nêu:** file trong repository **không** chứng minh trạng thái runtime của production. Khi một capability không có deployment record, trạng thái của nó dừng ở `Verified`; không được suy ra `Released` từ việc source hoặc tài liệu đã merge. Business outcome luôn cần dữ liệu ngoài repository và người xác nhận.

## 6. Vòng đời liên tục

Bảy bước dưới đây là một vòng lặp cho **capability evolution**. Chúng không thay thế năm phase trong [`AGENTS.md`](../../AGENTS.md) `Workflow` (Understand → Plan → Execute → Validate → Deliver), vốn điều phối **một task đơn lẻ**. Khi hai cách gọi trùng tên, phạm vi khác nhau: bước `Deliver` ở đây bao gồm validation và kết thúc trước deploy, còn phase `Deliver` trong `AGENTS.md` là bước cuối của một task.

Mỗi bước nêu mục đích, input, hoạt động, output, điều kiện hoàn thành và bước kế tiếp.

### 6.1 Understand

- **Mục đích:** biết mình đang thay đổi cái gì, ai sở hữu nó, ràng buộc nào áp dụng.
- **Input:** yêu cầu hoặc vấn đề; tài liệu canonical của các view liên quan; code và cấu hình liên quan.
- **Hoạt động:** đọc canonical location thay vì suy đoán; phân biệt rõ **đã verify**, **suy luận** và **chưa biết**; xác định invariant và ADR đang ràng buộc.
- **Output:** hiểu biết có nguồn, kèm danh sách giả định chưa xác minh — ghi trong Issue body hoặc comment của unit công việc.
- **Hoàn thành khi:** Issue nêu được view sở hữu capability, ràng buộc đang áp dụng (kèm nguồn), và danh sách unknown với nguồn bằng chứng của từng mục.
- **Kế tiếp:** unknown đã biết trở thành công việc Discovery; phần đã rõ đi sang §6.3 để phân loại gap trước khi Select.

### 6.2 Discover & Model

- **Mục đích:** giảm unknown và cập nhật mô hình target trước khi thay đổi hệ thống.
- **Input:** unknown từ bước 1; bằng chứng hiện có; ADR và open decision hiện có.
- **Hoạt động:** Discovery để tìm bằng chứng; Modelling để sửa specification ở view sở hữu; ADR cho quyết định kiến trúc; Experiment khi câu trả lời phụ thuộc vào hành vi kỹ thuật chưa đo được.
- **Output:** specification hoặc ADR accepted; kết quả experiment; evidence ghi trong Issue.
- **Hoàn thành khi:** chọn được slice mà không phải đoán; open decision vẫn là open, không bị hoá thành giả định trong code.
- **Kế tiếp:** Modelling tiếp tục trong lúc Delivery đang chạy; không cần chờ mô hình hoàn chỉnh.

### 6.3 Identify Gaps & Opportunities

- **Mục đích:** biết chính xác khoảng cách giữa target và thực tế, và cơ hội cải thiện đáng làm.
- **Input:** mô hình target; bằng chứng trạng thái theo §5.
- **Hoạt động:** phân loại từng phần theo bảng ở §8.1, dùng đúng tên phân loại ở đó.
- **Output:** danh sách gap và opportunity, mỗi mục có loại và bằng chứng — ghi trong Issue body hoặc Issue comment, không phải bảng trạng thái trong `docs/` (§8.3).
- **Hoàn thành khi:** mỗi ứng viên nêu được outcome, loại §8.1 kèm bằng chứng, và cách verify độc lập; limitation tạm thời được ghi tách khỏi deviation cố ý.
- **Kế tiếp:** chuyển sang Select; gap do slice trước để lại hoặc do target thay đổi có thể thành Remediation độc lập.

### 6.4 Select & Plan

- **Mục đích:** chọn thay đổi tiếp theo theo giá trị, rủi ro, dependency và chi phí.
- **Input:** danh sách gap/opportunity; ưu tiên hiện hành; dependency giữa các slice.
- **Hoạt động:** chọn một vertical slice (§7); tạo Issue cho unit independently trackable; xác định dependency và thứ tự; gán Issue vào Milestone hoặc Project khi cần visibility — chưa có cấu hình nào như vậy được xác minh (§4.2).
- **Output:** Issue có outcome, phạm vi và tiêu chí verify.
- **Hoàn thành khi:** slice phát biểu được outcome quan sát được, giới hạn phạm vi rõ, tiêu chí verify thuộc đúng tầng, dependency đã biết.
- **Kế tiếp:** sang Deliver. Slice quá lớn, hoặc thiếu bằng chứng để verify, quay lại §6.2 hoặc §6.3.

### 6.5 Deliver

- **Mục đích:** hiện thực slice với thay đổi nhỏ nhất tạo ra outcome, và thu bằng chứng test trước khi merge.
- **Input:** Issue; specification liên quan.
- **Hoạt động:** làm việc theo [`AGENTS.md`](../../AGENTS.md) `Workflow`; giữ change nhỏ nhất; chạy target test đúng tầng theo [`06-testing.md`](../architecture/06-testing.md) và ghi lại lệnh cùng kết quả. Ràng buộc migration và các điều kiện merge khác giữ nguyên theo [`AGENTS.md`](../../AGENTS.md), không chép lại ở đây.
- **Output:** PR reviewable, kèm mô tả change, giới hạn phạm vi, cách verify và kết quả test đã chạy.
- **Hoàn thành khi:** các điều kiện merge trong [`AGENTS.md`](../../AGENTS.md) đã đạt trên revision cuối, và PR nêu rõ phần chưa làm.
- **Kế tiếp:** sang Verify & Release; nếu phát hiện giả định sai, quay lại §6.2 thay vì mở rộng phạm vi PR.

### 6.6 Verify & Release

- **Mục đích:** chốt bằng chứng `Verified`, và thu bằng chứng `Released` khi slice bao gồm deployment.
- **Input:** PR đã merge; tiêu chí verify từ Issue; bằng chứng test đã thu ở §6.5.
- **Hoạt động:** đối chiếu kết quả test với tiêu chí đã đặt để chốt `Verified`; nếu slice cần runtime, deploy tới environment dự định và ghi deployment evidence để chốt `Released`. Khi đường deploy chưa tồn tại, dừng ở `Verified` và nói rõ.
- **Output:** bằng chứng `Verified`; bằng chứng `Released` nếu slice bao gồm deployment.
- **Hoàn thành khi:** mỗi tuyên bố trạng thái có lệnh, kết quả hoặc record tương ứng; không tuyên bố vượt quá bằng chứng.
- **Kế tiếp:** sang Reconcile. Nếu verification thất bại, slice **chưa** hoàn thành và capability **không** đạt `Verified`. Mở một Issue Remediation, ghi lệnh và kết quả thất bại vào Issue/PR đã merge, và giữ nguyên claim trạng thái thấp hơn cho tới khi Remediation đóng. Nếu lỗi xuất hiện **sau** deploy, xử lý theo [`02-delivery.md`](../architecture/02-delivery.md) (release record, incident, rollback có kiểm soát) thay vì tạo đường xử lý song song.

### 6.7 Reconcile

- **Mục đích:** cập nhật hiểu biết về thực tế và chọn việc tiếp theo.
- **Input:** trạng thái sau merge/release; Issue và PR liên quan.
- **Chủ sở hữu và trigger:** session/PR đã deliver slice thực hiện reconciliation **trước khi đóng Issue**, ngay sau khi PR merge. Không cần chờ ai chỉ định; "người xác nhận" chỉ bắt buộc cho trạng thái runtime production và business outcome (§8.3).
- **Hoạt động:** so target với thực tế theo §8; ghi nhận deviation; mở Remediation cho gap quan trọng; cập nhật specification nếu bằng chứng mới làm thay đổi giả định; cập nhật Issue/PR cho khớp thực tế.
- **Output:** phân loại reconciliation theo §8.1, ghi trong Issue comment của unit vừa xong, kèm Issue Remediation nếu có; specification được sửa khi cần.
- **Hoàn thành khi:** Issue của unit đã đóng chỉ sau khi có phân loại §8.1 kèm bằng chứng cho mỗi phần của phạm vi đang xét.
- **Kế tiếp:** quay lại Understand cho slice kế tiếp, hoặc Discover & Model nếu hiểu biết nền thay đổi.

### 6.8 Nguyên tắc vận hành vòng lặp

- Discovery và Modelling **không** dừng khi Delivery đang chạy.
- Delivery **không** phải chờ mô hình target hoàn chỉnh, nhưng **không** được hiện thực một quyết định chưa chốt như thể nó đã chốt.
- Một vertical slice có thể chỉ hiện thực một phần capability target (§7).
- Giới hạn phạm vi và ràng buộc cố ý phải được ghi rõ, không để người đọc suy ra.
- Reconciliation là hoạt động liên tục, không phải pha cuối của dự án: nó chạy sau mỗi slice, do session đã deliver slice thực hiện (§6.7).
- Khi một quyết định đã accept bị supersede, mọi capability chịu ảnh hưởng **không còn** `Aligned`; mở Remediation và yêu cầu ADR mới nêu rõ các slice bị ảnh hưởng. Điều này áp dụng cả khi slice đã merge hoặc đã Released.
- Slice bị chặn bởi một open decision **không** được hiện thực; nó được ghi lại và chuyển sang slice khác, không giữ ở trạng thái "đang làm dở" kéo dài.
- Bằng chứng mới có thể thay đổi giả định, specification, ưu tiên và công việc tiếp theo. Sửa specification sau reconciliation là kết quả hợp lệ, không phải thất bại.

## 7. Vertical Slice

**Định nghĩa:** một thay đổi cắt xuyên các tầng cần thiết để tạo ra **một outcome quan sát được và verify độc lập được**, dù chỉ phủ một phần capability target.

Một slice hợp lệ phải thoả tất cả điều kiện sau:

1. **Phát biểu outcome bằng behavior quan sát được**, không bằng khối lượng code đã viết.
2. **Nêu rõ phần nào của capability target được hiện thực và phần nào chưa** — giới hạn phạm vi là một phần của slice, không phải điều phải giấu.
3. **Có tiêu chí verify thuộc đúng tầng** theo [`06-testing.md`](../architecture/06-testing.md), và tiêu chí đó không phụ thuộc vào phần chưa làm.
4. **Không tạo trạng thái không quan sát được hoặc không thể đảo ngược** — ràng buộc migration theo [`AGENTS.md`](../../AGENTS.md) `Non-negotiable architecture`.
5. **Nêu dependency chưa xong và cách slice vẫn an toàn khi thiếu chúng** — ví dụ fail-closed khi thiếu dữ liệu từ context khác.

Slice **không** cần: phủ hết requirement của Feature, chờ các context khác xong, hay release production. Slice **không** hợp lệ khi: chỉ hoàn thành một tầng mà không có outcome nào quan sát được; gộp nhiều outcome không liên quan vào một PR; hoặc chỉ verify được sau khi target model hoàn chỉnh.

**Prerequisite work.** Có công việc không thể phát biểu thành outcome quan sát được khi đứng một mình — ví dụ contract hoặc domain model mà application tiêu thụ chưa tồn tại. Công việc đó vẫn hợp lệ, nhưng được phân loại là **Implemented, not verified** ở mức capability, không phải một slice đã hoàn thành. Nó phải nêu rõ nó mở đường cho slice nào và slice đó thuộc Issue nào; nếu không nêu được, nó là công việc không có đích.

## 8. Reconciliation và deviation

### 8.1 Phân loại khi so target với thực tế

Các phân loại dưới đây **không loại trừ lẫn nhau**: chúng trả lời hai câu hỏi khác nhau. `Aligned`, `Partially implemented`, `Not implemented`, `Implemented, not verified` mô tả **mức phủ** của target trong source. `Released` mô tả **mức tới được** của environment. `Accepted deviation` và `Gap requiring work` mô tả **thái độ** với khác biệt. Một capability vừa `Released` vừa `Aligned` là bình thường; hãy nêu cả hai.

| Phân loại                     | Nghĩa                                                  | Bằng chứng để kết luận                                      |
| ----------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| **Aligned**                   | Target và thực tế khớp ở phạm vi đang xét              | Implemented + Verified, và không có deviation đã biết       |
| **Partially implemented**     | Một phần capability target đã có trong source/contract | Source/contract phủ một phần specification                  |
| **Not implemented**           | Chưa có hiện thực                                      | Không tìm thấy source/contract tương ứng                    |
| **Implemented, not verified** | Có hiện thực nhưng chưa có bằng chứng verification     | Source tồn tại, thiếu kết quả test hoặc verification record |
| **Released**                  | Đã deploy tới environment dự định                      | Deployment record + kiểm tra environment                    |
| **Accepted deviation**        | Cố ý khác target, có lý do và có ghi nhận              | Decision record (ADR) hoặc ghi nhận trong Issue/PR          |
| **Gap requiring work**        | Khác biệt chưa được xử lý và cần công việc tiếp theo   | Gap có loại và bằng chứng, chưa có quyết định chấp nhận     |

### 8.2 Limitation tạm thời và deviation cố ý

Hai thứ này khác nhau và phải được gọi đúng tên:

- **Limitation tạm thời** — chưa làm, hoặc làm hẹp hơn target vì thứ tự, chi phí hoặc dependency. Target **không** đổi. Phải ghi rõ trong PR/Issue và được reconcile ở vòng sau.
- **Deviation cố ý** — target cố ý khác đi vì lý do kiến trúc hoặc nghiệp vụ. Khi deviation là material, cần decision record (ADR) và target canonical phải được cập nhật để không còn mâu thuẫn với thực tế.
- **Khác biệt nhỏ** — không cần record riêng; ghi trong PR hoặc Issue là đủ.

Không được để một deviation cố ý tồn tại chỉ trong code trong khi tài liệu canonical vẫn nói ngược lại. Cũng không được tạo record cho mọi khác biệt nhỏ: record chỉ dành cho quyết định làm thay đổi target hoặc ràng buộc hệ thống.

### 8.3 Quy tắc reconciliation

1. **Dựa trên bằng chứng, không dựa trên trạng thái Issue hay trí nhớ.** Kết luận phải chỉ ra nguồn theo §5.
2. **Không duy trì bản sao trạng thái thủ công.** Không thêm bảng "đã implement/chưa implement" vào tài liệu target; điều này đã bị cấm bởi [`docs/AGENTS.md`](../AGENTS.md) §2 và [`domains/README.md`](../domains/README.md) §1.2. Trạng thái được suy ra khi cần.
3. **Kết quả reconciliation thuộc Work Management.** Gap và deviation được ghi vào Issue/PR/Milestone; nếu kết quả làm đổi target thì sửa canonical document tương ứng.
4. **Nêu rõ phần không tự động hoá được.** Trạng thái runtime production, business outcome và chất lượng quyết định kiến trúc cần người xác nhận; mọi tuyên bố về chúng phải nêu nguồn và mức tin cậy.
5. **Reconciliation không phải một deliverable riêng.** Nó là hoạt động ở §6.7, diễn ra sau mỗi slice, không phải tài liệu phải viết lại toàn bộ hệ thống.

## 9. Ví dụ — Ecoma LLM Marketplace

Ví dụ dưới đây là một lượt **giả định** qua vòng đời cho một capability của `llm-marketplace`. Mô hình target lấy từ [`domains/llm-marketplace/`](../domains/llm-marketplace/README.md) (FR-003 tạo model offer, FR-004 activate/deactivate offer). Trạng thái trong ví dụ là giả thiết để minh hoạ cách lập luận reconciliation; nó **không** phải bản ghi trạng thái của repository — trạng thái thật phải suy ra lại theo §5.

1. **Understand.** Capability "seller công bố model offer" thuộc view Domains, canonical tại `domains/llm-marketplace`; ràng buộc áp dụng: `llm-marketplace` sở hữu offer, `llm-seller-tenant` cùng `llm-seller-governance` sở hữu seller lifecycle, `llm-consumer-routing` sở hữu alias/routing, `llm-seller-pricing` sở hữu giá. Chưa biết: activation cần điều kiện gì để customer gọi được, và phần nào thuộc context khác.
2. **Discover & Model.** Giả sử Discovery cho thấy context chưa có library hay application nào; capability ở trạng thái **Specified**, không phải Implemented. Modelling chốt rằng slice đầu tiên chỉ cần offer draft + activation với một provider model, không cần endpoint pool hay tích hợp pricing. Quyết định nào chưa chốt được ghi là open, không hoá thành giả định trong code.
3. **Identify Gaps & Opportunities.** Đối chiếu target với source và contract theo giả thiết trên: không tìm thấy hiện thực nào của context, nên FR-003 đến FR-009 là **Not implemented**, không phải **Implemented, not verified**. Không có deviation cố ý nào cần record.
4. **Select & Plan.** Chọn vertical slice: "gọi API tạo offer draft rồi activate, và API đọc trả về offer đang active". Giới hạn phạm vi: một provider model, chưa có endpoint pool, chưa có routing và pricing. Tạo một Issue Delivery với outcome và tiêu chí verify.
5. **Deliver.** Tạo branch và draft PR; thêm domain model cho offer lifecycle, persistence và application module phục vụ hai API trên; migration theo expand → compatible rollout → contract; test unit cho lifecycle và test integration với PostgreSQL thật theo NFR-003 của context. Chạy `test` và `test-integration` local, ghi lệnh và kết quả vào PR. PR nêu rõ phần chưa làm.
6. **Verify & Release.** Đối chiếu kết quả test với tiêu chí đã đặt → slice đạt **Verified** trong phạm vi đã nêu: hai API behavior đã được verify ở tầng app-owned. Slice **không** đạt **Released** vì không có deployment record tới environment dự định; trạng thái dừng ở Verified chứ không suy ra Released từ việc PR đã merge. Slice cũng **không** verify được hành vi xuyên deploy unit — điều đó cần `system-test` và một stack chạy thật.
7. **Reconcile.** Sau merge: FR-003 và FR-004 là **Partially implemented** (một provider model, chưa có endpoint pool); FR-005 đến FR-009 vẫn **Not implemented**; activation không có routing và pricing là **limitation tạm thời**, không phải deviation cố ý. Feature chưa hoàn thành dù Issue đã đóng. Vòng tiếp theo chọn slice endpoint pool hoặc tích hợp routing, theo cùng quy trình.

## 10. Bảo trì tài liệu này

- Canonical location của quá trình là `docs/engineering/evolution-process.md`; mọi tài liệu khác tham chiếu tới đây thay vì chép lại quy tắc.
- Thay đổi quy tắc phải sửa file này và cập nhật index liên quan trong cùng thay đổi (→ [`docs/AGENTS.md`](../AGENTS.md) §5).
- Khi vị trí canonical của một view thay đổi (ví dụ thư mục của view Applications hay vị trí của view Features), cập nhật bảng ở §3 cùng lúc với thay đổi đó.
- Tài liệu này dài hơn mốc ~200 dòng của [`docs/AGENTS.md`](../AGENTS.md) §2. Lý do: ba lớp, bốn view, năm loại công việc và bảy bước tạo thành **một** specification; tách rời sẽ khiến mỗi phần thiếu ngữ cảnh của phần kia và sinh thêm canonical location phải bảo trì. §5 và §8 là hai chủ đề độc lập nhất, nên là ứng viên tách đầu tiên nếu mốc này bị vượt đáng kể.
