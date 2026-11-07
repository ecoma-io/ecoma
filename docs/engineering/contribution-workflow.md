# Contribution Workflow

> **Phạm vi:** cách developer và coding agent đi từ một yêu cầu tới Issue, thay đổi, PR, merge và reconciliation. Tài liệu này là **cầu nối thực hành** giữa vòng đời bảy bước của [`evolution-process.md`](./evolution-process.md) và các ràng buộc repository trong [`AGENTS.md`](../../AGENTS.md).
>
> **Không thuộc tài liệu này:** ý nghĩa của từng bước trong vòng đời → [`evolution-process.md`](./evolution-process.md) §6 · quy tắc Issue/Project/Milestone/PR → [`work-management.md`](./work-management.md) · quy tắc commit, ký commit, PR title, merge queue → [`AGENTS.md`](../../AGENTS.md) · entry point cho người mới → [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

Tài liệu này mô tả **hành động và handoff**, không định nghĩa lại process và không mô tả cấu hình GitHub.

## 1. Bảy bước trong công việc thực tế

Mỗi bước dưới đây ánh xạ một-một tới [`evolution-process.md`](./evolution-process.md) §6. Bước ghi rõ **ai làm gì**, **kết thúc khi nào**, và **bàn giao gì**. Bước `Discover & Model` ở vòng đời tương ứng với hai hoạt động có thể chạy song song; các bước còn lại giữ nguyên tên.

| Bước (evolution process)         | Việc thực tế                                                                                          | Handoff                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1. Understand                    | Đọc canonical artifact và code liên quan; ghi rõ đã verify / suy luận / chưa biết; xác định work kind | Issue body hoặc comment với view sở hữu, ràng buộc, unknown |
| 2. Discover & Model              | Điều tra unknown; sửa specification/ADR ở view sở hữu khi decision đã accept                          | Evidence trong Issue; specification/ADR accepted            |
| 3. Identify Gaps & Opportunities | So target với thực tế theo §8.1 của evolution process                                                 | Danh sách gap/opportunity có loại và bằng chứng             |
| 4. Select & Plan                 | Chọn vertical slice; tạo hoặc tái dùng Issue; xác định dependency và thứ tự                           | Issue với outcome, phạm vi, tiêu chí verify                 |
| 5. Deliver                       | Tạo branch, draft PR, thực hiện thay đổi, chạy validation                                             | PR reviewable kèm bằng chứng                                |
| 6. Verify & Release              | Đối chiếu bằng chứng với tiêu chí; deploy nếu phạm vi bao gồm                                         | Claim trạng thái kèm nguồn                                  |
| 7. Reconcile                     | So target với thực tế; ghi deviation; đóng Issue khi đủ điều kiện                                     | Issue comment reconciliation; Remediation Issue nếu có      |

Điều quan trọng hơn bảng này: **các bước không phải một pipeline tuần tự cho cả repository**. Discovery và Modelling chạy song song với Delivery ở các nhánh công việc khác nhau. Một task cụ thể có thể bắt đầu từ bước 4 khi hiểu biết đã đủ.

## 2. Mười hành động

### 2.1 Hiểu yêu cầu và context

Trước khi quyết định làm gì:

1. Xác định yêu cầu là **outcome** hay **phương án**. Một phương án được yêu cầu vẫn phải qua bước chọn slice; không tự động thành thiết kế.
2. Đọc canonical document sở hữu vùng bị ảnh hưởng — không dựa vào trí nhớ hay vào tên file. Bảng ownership ở [`docs/AGENTS.md`](../AGENTS.md) §4.
3. Đọc code và configuration hiện tại. Tài liệu target không phải mô tả behaviour đang chạy ([`AGENTS.md`](../../AGENTS.md) `Source of truth`).
4. Ghi riêng: **đã verify** (kèm `file:line` hoặc lệnh), **suy luận**, **chưa biết**.

Kết thúc khi nêu được: view nào sở hữu capability, ràng buộc nào đang áp dụng, và danh sách unknown.

### 2.2 Xác định work kind

Dùng đúng năm giá trị canonical ở [`evolution-process.md`](./evolution-process.md) §4.1 và áp dụng thứ tự ưu tiên ở đó — Remediation → Experiment → Modelling → Delivery → Discovery.

- Không chọn work kind theo loại issue form. Form `bug` có thể là Delivery nếu behaviour chưa từng tồn tại.
- Không đổi work kind giữa chừng mà không ghi lý do vào Issue.
- Work kind là thông tin định hướng, không phải input của CI.

Cách ghi vào Issue → [`work-management.md`](./work-management.md) §2.3.

### 2.3 Tìm Issue/PR, rồi chọn reuse, link hoặc create

Search trước khi tạo, cả open lẫn closed:

```bash
gh issue list --repo ecoma-io/ecoma --state all --search "<outcome keywords>" --limit 20
gh pr list --repo ecoma-io/ecoma --state all --search "<outcome keywords>" --limit 20
```

Search theo outcome và subsystem, không chỉ theo từ trong title. Đọc body của mọi ứng viên.

Ba kết quả hợp lệ:

- **Reuse** — Issue mở đã theo dõi cùng outcome. Làm dưới Issue đó.
- **Link** — cùng chủ đề, outcome khác material. Tạo Issue mới và nêu khác biệt trong một câu.
- **Create** — outcome chưa được phủ. Nêu trong một câu nó khác ứng viên gần nhất ở đâu.

Issue closed vẫn là nguồn quyết định: trích dẫn constraint đã ghi, không suy lại.

### 2.4 Làm rõ scope, dependency, ràng buộc và tiêu chí hoàn thành

Viết vào Issue:

- **Scope** — phần nào được phép thay đổi, và phần nào là non-goal.
- **Dependency** — Issue/PR phải xong trước; nếu phụ thuộc một quyết định chưa chốt, nêu tên nó.
- **Ràng buộc** — invariant và contract đang áp dụng, kèm link tới canonical.
- **Tiêu chí hoàn thành** — kết quả quan sát được, verify được, không phải danh sách task.

Nếu một mục không xác định được, đừng điền giá trị mặc định. Ghi nó là unknown hoặc open decision.

### 2.5 Tạo branch và draft PR

Khi công việc đủ rõ để implement:

1. Tạo branch từ default branch mới nhất.
2. Tạo draft PR ngay, liên kết Issue bằng `Closes #N` hoặc `Refs #N` theo [`work-management.md`](./work-management.md) §5.2.
3. Ghi vào PR body: outcome, phạm vi, phần chưa làm, cách verify dự kiến.

Với công việc thăm dò chưa đủ định nghĩa: điều tra trước để định nghĩa work item, rồi mới tạo Issue, branch và PR ([`AGENTS.md`](../../AGENTS.md) `Workflow`).

Commit phải được ký. Nếu không có signing key, dừng và báo — không làm việc quanh nó.

### 2.6 Thực hiện với scope lock

- Chỉ sửa phần nằm trong scope của Issue. Phát hiện ngoài scope: ghi vào Issue hoặc mở Issue mới, không nhét vào PR.
- Tuân thủ ràng buộc repository: database ownership, contract, migration expand → compatible rollout → contract, Nx boundary, language rules ([`AGENTS.md`](../../AGENTS.md) `Non-negotiable architecture`).
- Không hiện thực một quyết định chưa accept như thể nó đã chốt ([`evolution-process.md`](./evolution-process.md) §6.8). Nếu slice bị chặn bởi open decision, chuyển sang slice khác.
- Commit theo `.agents/skills/commit-message/SKILL.md`; không bypass hook.

### 2.7 Chạy validation phù hợp

Chọn check theo **loại thay đổi**, không chạy mọi thứ cho mọi PR:

| Thay đổi                                | Tối thiểu                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| Tài liệu, template, configuration       | `npx oxfmt --check .`; kiểm link thủ công (chưa có link checker tự động)             |
| Code trong một Nx project               | `lint`, `typecheck`, `test` của đúng project đó                                      |
| Code chạm database hoặc dependency thật | Thêm `test-integration` của project sở hữu                                           |
| Thay đổi xuyên deploy unit              | Thêm `system-test` phù hợp; local stack theo `AGENTS.md` `Local Development Preview` |
| Thay đổi tooling trong `tools/dx/`      | `test` của project `dx` và chạy command đã đổi                                       |
| Project tag, deployment map, Nx graph   | `pnpm dx arch-check`                                                                 |

- Ghi lệnh và kết quả thật vào PR. Không ghi "đã test" mà không có output.
- Không phải project nào cũng có đủ target (ví dụ các project `*-e2e` không có `typecheck`); kiểm bằng `pnpm nx show project <name>` trước khi chạy, và ghi rõ target nào không tồn tại thay vì bỏ qua im lặng.
- Nếu một check không chạy được vì môi trường, ghi rõ blocker và phần chưa verify.
- Không tuyên bố pass khi chưa chạy. `pnpm dx pr-check` chỉ chạy trong GitHub Actions; kiểm PR title cục bộ bằng `echo "<title>" | pnpm exec commitlint`.

Test placement và target names → [`06-testing.md`](../architecture/06-testing.md).

### 2.8 Review, xử lý finding và cập nhật bằng chứng

- Sửa mọi finding **material** trong cùng PR.
- Finding ngoài scope: ghi thành Issue riêng hoặc comment trong Issue hiện tại; không mở rộng PR chỉ để xử lý hết finding ([`evolution-process.md`](./evolution-process.md) §6.5).
- Finding làm thay đổi giả định: quay lại bước hiểu biết, không sửa code cho khớp review.
- Sau mỗi lần sửa material, chạy lại validation bị ảnh hưởng và cập nhật mục kiểm chứng.

### 2.9 Rebase và merge

- Rebase lên default branch mới nhất trước khi mark ready và trước khi push lần cuối.
- Ready for review khi CI xanh và mọi conversation đã resolve.
- PR đã approve, CI xanh và không bị chặn: đưa vào merge queue ngay ([`AGENTS.md`](../../AGENTS.md) `Pull requests`).
- Squash merge là cách duy nhất để land; PR title trở thành commit subject trên `main`.

### 2.10 Reconcile và đóng Issue

Sau khi PR merge:

1. So target với thực tế theo §8.1 của [`evolution-process.md`](./evolution-process.md).
2. Ghi phân loại kèm bằng chứng vào Issue comment, dùng đúng tên ở §8.1: `Aligned`, `Partially implemented`, `Not implemented`, `Implemented, not verified`, `Released`, `Accepted deviation`, `Gap requiring work`.
3. Mở Remediation cho gap material.
4. Đóng Issue khi đủ điều kiện ở [`work-management.md`](./work-management.md) §2.6.

Khi `Closes #N` đã đóng Issue tự động, comment reconciliation vẫn bắt buộc — việc đóng không thay thế bước này.

## 3. Ranh giới giữa tài liệu hướng dẫn và ràng buộc repository

| Nội dung                                                            | Nguồn có thẩm quyền                                |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| Ý nghĩa work kind, vertical slice, capability state, reconciliation | [`evolution-process.md`](./evolution-process.md)   |
| Khi nào tạo/tái dùng Issue, điều kiện đóng, PR liên kết Issue       | [`work-management.md`](./work-management.md)       |
| Issue nào cần label `project:track` và vòng đời label đó            | [`work-management.md`](./work-management.md) §3.3  |
| Thứ tự hành động, handoff, chọn validation theo scope               | Tài liệu này                                       |
| Ràng buộc kỹ thuật, security, Nx, Cloudflare, database ownership    | [`AGENTS.md`](../../AGENTS.md)                     |
| Commit signing, PR title, merge queue, squash merge                 | [`AGENTS.md`](../../AGENTS.md) `Pull requests`     |
| Test taxonomy, target names, môi trường test                        | [`06-testing.md`](../architecture/06-testing.md)   |
| Delivery, release, migration, rollback                              | [`02-delivery.md`](../architecture/02-delivery.md) |
| Ownership của tài liệu và artifact                                  | [`docs/AGENTS.md`](../AGENTS.md)                   |

Tài liệu này **không** lặp lại nội dung của các nguồn trên. Khi hai nguồn mâu thuẫn, dừng và báo — không tự chọn bên thắng.

## 4. Coding agent

Agent thực hiện cùng mười hành động trên, với bốn khác biệt:

1. **Đọc trước khi sửa.** Canonical document và repository instructions có precedence cao hơn skill. Skill chỉ cung cấp cách thực thi cho một loại công việc.
2. **Dừng và báo** khi thiếu decision cần thiết, khi canonical artifact mâu thuẫn, khi scope thực tế vượt Issue/PR, khi không thu được bằng chứng, hoặc khi có nguy cơ phá invariant hay backward compatibility.
3. **Không tự mở rộng quyền.** Agent không tự tạo Project/Milestone, không đóng Issue của người khác, không đổi cấu hình GitHub ngoài phạm vi Issue.
4. **Báo cáo trung thực.** Validation chưa chạy được thì nói rõ; không tuyên bố pass, không tuyên bố `Released` khi chưa có deployment evidence.

Quy tắc chọn skill và escalation đầy đủ → [`AGENTS.md`](../../AGENTS.md) `Workflow`.

Danh mục agent canonical nằm ở [`AGENTS.md`](../../AGENTS.md) `Agent catalog`: năm vai
(`engineering-orchestrator`, `repository-analyst`, `architect`, `implementer`, `verifier`),
trách nhiệm và ranh giới của từng vai. Tài liệu này không chép lại danh mục đó. Ranh giới
chỉ được tool thực thi khi một tool bị rút hoàn toàn — `repository-analyst` và `architect`
không có write tool và không có shell; mọi ranh giới khác, kể cả scope lock và vai chỉ
đọc nhưng có `Bash`, đều là instruction-level vì `Bash` vẫn ghi được file. Chỉ
`engineering-orchestrator` dispatch agent khác; mỗi agent được dispatch nhận một scope lock
tường minh và không kế thừa scope rộng hơn.

## 5. Bảo trì tài liệu này

- Canonical location là `docs/engineering/contribution-workflow.md`.
- Thay đổi ở [`evolution-process.md`](./evolution-process.md) hoặc [`work-management.md`](./work-management.md) có thể làm tài liệu này stale; cập nhật trong cùng thay đổi khi bước hoặc handoff bị ảnh hưởng.
- Không thêm nội dung thuộc nguồn khác vào đây, kể cả khi nó tiện cho người đọc. Dùng link.
