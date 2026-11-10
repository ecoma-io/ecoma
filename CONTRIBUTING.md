# Đóng góp cho Ecoma.io

Tài liệu này là điểm bắt đầu cho **developer**, **coding agent** và **người review** tham gia repository. Nó cho biết cần đọc gì, đi theo thứ tự nào, và nguồn nào có thẩm quyền cho từng quyết định.

Nó **không** thay thế các tài liệu canonical. Khi bạn cần chi tiết, hãy theo link — đừng suy ra từ tài liệu này.

## 1. Mục đích và phạm vi

Repository dùng một quy trình thống nhất cho người và agent: **Engineering Evolution Process**. Quy trình đó có ba tài liệu canonical:

| Tài liệu                                                                                 | Trả lời                                                        |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [`docs/engineering/evolution-process.md`](docs/engineering/evolution-process.md)         | Vòng đời kỹ thuật, năm Issue Type, ý nghĩa trạng thái năng lực |
| [`docs/engineering/work-management.md`](docs/engineering/work-management.md)             | Issue, Project, Milestone và Pull Request được dùng thế nào    |
| [`docs/engineering/contribution-workflow.md`](docs/engineering/contribution-workflow.md) | Từng bước thực hiện và handoff giữa các vai trò                |

Ràng buộc kỹ thuật của repository — security, Nx, Cloudflare, database ownership, commit signing, merge queue — nằm trong [`AGENTS.md`](AGENTS.md). Đó là nội dung có thẩm quyền cao hơn tài liệu này.

## 2. Bắt đầu đóng góp

### 2.1 Chuẩn bị môi trường

```bash
pnpm install          # cài dependency và chạy pnpm dx repo-prepare
```

`pnpm install` kích hoạt `prepare` hook, chạy `pnpm dx repo-prepare`: cài Git hook, kiểm tool bắt buộc, rồi sinh cấu hình agent cho Claude Code và OpenCode từ `.agents/` — `.claude/skills/`, `.opencode/skills/`, `.claude/agents/`, `.opencode/agents/`. Các đường dẫn sinh ra đó **không** commit và **không** sửa tay.

Bạn cần:

- **Commit signing** đã cấu hình. `pre-commit` chặn commit nếu thiếu cấu hình, nên hãy làm bước này trước lần commit đầu tiên. Chọn một trong hai cách, rồi kiểm bằng `./tools/dx/check-signing-config.sh`:

  ```bash
  # 1. SSH signing — tạo key nếu chưa có, rồi trỏ git tới public key:
  ssh-keygen -t ed25519 -C "you@example.com"      # bỏ qua nếu đã có key
  git config commit.gpgsign true
  git config gpg.format ssh
  git config user.signingkey ~/.ssh/id_ed25519.pub

  # 2. Hoặc GPG — tạo key nếu chưa có, rồi trỏ git tới key ID:
  gpg --full-generate-key                          # bỏ qua nếu đã có key
  gpg --list-secret-keys --keyid-format=long       # lấy ID sau "sec   ed25519/"
  git config commit.gpgsign true
  git config gpg.format openpgp                    # cần đặt tường minh nếu global đang là ssh
  git config user.signingkey <GPG-KEY-ID>
  ```

  Sau đó upload public key lên GitHub (Settings → SSH and GPG keys) để chữ ký hiển thị `Verified`. "Đã ký" ở repository này nghĩa là commit object có header `gpgsig`; GitHub là nơi xác minh chữ ký. Ba gate kiểm ở ba thời điểm khác nhau → [`docs/architecture/02-delivery.md`](docs/architecture/02-delivery.md) §2.

- **Docker daemon đang chạy.** `pre-push` chạy secret scan và semgrep qua Docker, không có fallback ngoài Docker; push sẽ fail nếu Docker không chạy.
- **Tool bắt buộc khác** — Helm, kustomize, kubeconform — do `repo-prepare` kiểm và báo nếu thiếu (xem `tools/dx/src/repository/tool-specs.ts`). `repo-prepare` chỉ cảnh báo, không chặn commit; contributor làm product code thường không cần chúng.
- **`gh` CLI** đã đăng nhập, để search Issue/PR trước khi tạo mới. Thêm scope `read:project` nếu bạn cần đọc Project field; thiếu scope thì `gh project` fail với `your authentication token is missing required scopes [read:project]` (khắc phục bằng `gh auth refresh -s read:project`) — ghi lại là chưa xác minh được, đừng đoán giá trị.

### 2.2 Đọc gì trước khi bắt đầu

Theo thứ tự, và chỉ đọc phần liên quan tới thay đổi của bạn:

1. [`AGENTS.md`](AGENTS.md) — ràng buộc bắt buộc, ngôn ngữ, quy tắc PR.
2. [`docs/README.md`](docs/README.md) — bản đồ tài liệu và trục nào sở hữu cái gì.
3. Tài liệu canonical của vùng bạn sắp chạm: `docs/architecture/`, `docs/domains/` hoặc `docs/applications/`.
4. [`docs/engineering/contribution-workflow.md`](docs/engineering/contribution-workflow.md) — mười hành động cụ thể.

Không đọc hết mọi thứ. Đọc đúng phần sở hữu câu hỏi của bạn; nếu không xác định được view nào sở hữu, xem bảng ở [`docs/AGENTS.md`](docs/AGENTS.md) §4.

## 3. Work item và quy trình GitHub

### 3.1 Tôi nên tạo hay tìm Issue?

Luôn **search trước**:

```bash
gh issue list --repo ecoma-io/ecoma --state all --search "<outcome keywords>" --limit 20
gh pr list --repo ecoma-io/ecoma --state all --search "<outcome keywords>" --limit 20
```

Search theo outcome, không chỉ theo từ trong title, và đọc body của mọi ứng viên. Sau đó chọn một trong ba:

- **Tái sử dụng** — đã có Issue theo cùng outcome.
- **Liên kết** — cùng chủ đề, outcome khác. Tạo Issue mới và nêu khác biệt.
- **Tạo mới** — outcome chưa được phủ.

Một **independently trackable work item** là thứ có outcome quan sát được, có thể land bằng một PR, có điều kiện hoàn thành kiểm được, và có owner. Chi tiết tiêu chí và các trường hợp không cần Issue → [`work-management.md`](docs/engineering/work-management.md) §2.1.

Có những Issue **không** phải work item: coordination ledger, precondition tracker, experiment record, decision Issue. Đừng nhận chúng làm việc của mình, và đừng biến chúng thành Issue mới. Bảng phân biệt → [`work-management.md`](docs/engineering/work-management.md) §2.2.

**Tạo Issue** qua form trong giao diện GitHub (tab Issues → New issue) — chọn một trong `.github/ISSUE_TEMPLATE/`: `bug_report.yml`, `feature_request.yml`, `documentation.yml`, hoặc `engineering_work.yml` cho các Issue Type Discovery / Modelling / Experiment và công việc kỹ thuật không mô tả được bằng ba form kia. Hoặc qua CLI:

```bash
gh issue create --repo ecoma-io/ecoma --title "fix(dx): ..." --body-file <path>
gh issue list --repo ecoma-io/ecoma --label documentation --limit 20
```

Tiêu đề Issue viết tiếng Anh theo Conventional Commits; scope ở Issue là free-form, không bị giới hạn một Nx project như scope của PR title. Body viết tiếng Việt. Không gắn label, Milestone hay assignee mà bạn chưa thấy tồn tại.

**Issue Type được set khi tạo Issue** — qua UI hoặc `gh issue create --type <name>`. Issue Forms không gán được Issue Type, nên chọn type ở bước tạo issue. Trong giai đoạn chuyển đổi khi org chưa cấu hình năm giá trị, kênh tạm thời là dòng `## Loại công việc` trong Issue body (`work-management.md` §2.3).

### 3.2 Làm sao xác định Issue Type?

Có đúng năm giá trị: **Discovery**, **Modelling**, **Experiment**, **Delivery**, **Remediation**. Giá trị được ghi bằng **Issue Type** — native metadata của GitHub và là nguồn classification duy nhất — chọn theo thứ tự ưu tiên và dừng ở loại khớp đầu tiên. Thứ tự, định nghĩa và điều kiện kết thúc nằm ở [`evolution-process.md`](docs/engineering/evolution-process.md) §4.1; cách ghi và giai đoạn transition ở `work-management.md` §2.3 — chép lại ở đây sẽ chỉ tạo bản sao lệch.

Issue Type **khác** nhãn Issue (`bug`, `enhancement`, `documentation`) và khác loại form: nhãn và form nói đây là loại artifact gì; Issue Type nói bản chất thay đổi là gì. Không suy Issue Type từ nhãn hay từ form.

Mỗi product có pipeline riêng theo horizon — **M1** (delivery hiện tại), **M2** (delivery kế tiếp), **Feature Discovery** (công việc đang mở chưa commit vào Milestone nào) — suy ra từ Milestone ladder; xem `work-management.md` §4.

### 3.3 Khi nào cần Discovery, Modelling hoặc Experiment trước Delivery?

Bạn cần một bước trước Delivery khi chưa trả lời được một trong các câu sau bằng bằng chứng hiện có:

- **Chọn hướng nào** — còn nhiều khả năng và chưa có dữ liệu để loại → **Discovery**.
- **Target nói gì** — specification hoặc quyết định chưa được accept → **Modelling**. Không implement một quyết định chưa accept như thể nó đã chốt.
- **Hành vi kỹ thuật thực tế ra sao** — câu trả lời phụ thuộc vào một phép đo chưa có → **Experiment**. Tiêu chí đánh giá phải đặt **trước** khi chạy.

Nếu đã đủ bằng chứng để chọn slice và verify độc lập, đi thẳng vào Delivery. Không cần chờ mô hình target hoàn chỉnh.

Phân biệt Discovery và Experiment: Discovery tìm bằng chứng **đã tồn tại**; Experiment **tạo** bằng chứng mới bằng cách chạy thứ gì đó. Chi tiết → [`evolution-process.md`](docs/engineering/evolution-process.md) §4.1.

### 3.4 Work item được lưu ở đâu

Issue là nơi duy nhất giữ kế hoạch triển khai. Không có file backlog, roadmap hay bảng trạng thái trong `docs/`.

Một work item phải nêu: outcome, phạm vi, ràng buộc, dependency, điều kiện hoàn thành. Nội dung bổ sung theo từng Issue Type → [`work-management.md`](docs/engineering/work-management.md) §2.4.

Issue **đóng** chỉ kết thúc unit công việc. Nó không chứng minh capability đã `Implemented`, `Verified` hay `Released` — trạng thái đó cần bằng chứng riêng ([`evolution-process.md`](docs/engineering/evolution-process.md) §5.1).

## 4. Vòng đời đóng góp

Mười hành động, handoff giữa các bước và cách chọn validation theo scope nằm ở [`contribution-workflow.md`](docs/engineering/contribution-workflow.md) §2 — đó là nguồn canonical, không chép lại ở đây. Đọc bảng ánh xạ sang bảy bước vòng đời ở §1 của tài liệu đó trước khi bắt đầu.

Ba ranh giới dễ bỏ qua:

- Discovery và Modelling **chạy song song** với Delivery. Không phải mọi task đều đi tuần tự qua bảy bước.
- Một **vertical slice** phải tạo outcome verify độc lập được — không phải "đã viết xong một tầng". Điều kiện hợp lệ → [`evolution-process.md`](docs/engineering/evolution-process.md) §7.
- Verification **thất bại** thì Issue không được đóng, và capability không đạt `Verified`.

## 5. Coding standards và ràng buộc repository

Các ràng buộc dưới đây là **bắt buộc**, nguồn có thẩm quyền là [`AGENTS.md`](AGENTS.md) và các tài liệu được nó dẫn:

- **Database ownership** — một service sở hữu một database; service khác không truy cập trực tiếp. Giao tiếp qua API/event contract.
- **Migration** — expand → compatible rollout → contract; ưu tiên forward-fix hơn rollback dữ liệu.
- **Secrets** — không vào Git, PR build hay Preview runtime từ production. Dùng Worker Secrets.
- **Nx boundary** — giữ đúng `scope`, `type`, `runtime`; `pnpm dx arch-check` kiểm toàn workspace.
- **Observability** — không là dependency của serving path; không log prompt/response body.
- **Ngôn ngữ** — tiếng Anh cho mọi thứ, trừ văn xuôi hướng người đọc: tài liệu Markdown, code comment, Issue/PR body và review comment. Chi tiết và ngoại lệ → [`AGENTS.md`](AGENTS.md) `Language`.
- **Commit signing** — mọi commit phải được ký. Không dùng `--no-verify`.

Cấu trúc code, DDD layer và contract → [`docs/architecture/05-code-architecture.md`](docs/architecture/05-code-architecture.md). Bảo mật và secret → `gitleaks.toml` và CI.

## 6. Testing và verification

Nguyên tắc: **verify ở đúng tầng của behaviour**, không chạy mọi suite cho mọi thay đổi.

| Thay đổi                                | Tối thiểu                                      |
| --------------------------------------- | ---------------------------------------------- |
| Tài liệu, template, configuration       | `npx oxfmt --check .`; kiểm link thủ công      |
| Code trong một Nx project               | `lint`, `typecheck`, `test` của project đó     |
| Code chạm database hoặc dependency thật | Thêm `test-integration` của project sở hữu     |
| Thay đổi xuyên deploy unit              | Thêm `system-test` phù hợp, kèm local stack    |
| Tooling trong `tools/dx/`               | `test` của project `dx` và chạy command đã đổi |
| Project tag, deployment map, Nx graph   | `pnpm dx arch-check`                           |

Bảng trên là bản rút gọn cho contributor; bảng canonical ở [`contribution-workflow.md`](docs/engineering/contribution-workflow.md) §2.7 — khi hai bảng lệch nhau, bảng canonical đúng.

Không phải project nào cũng có đủ target (ví dụ các project `*-e2e` không có `typecheck`); kiểm bằng `pnpm nx show project <name>` trước khi chạy. Repository chưa có link checker tự động: kiểm link bằng cách mở các file đã sửa, hoặc chạy một script kiểm tương đối cục bộ. `npx oxfmt --check .` là lệnh CI dùng ở `.github/workflows/ci.yaml`; chạy `npx oxfmt` để tự sửa.

Test placement, category semantics và ba target canonical (`test`, `test-integration`, `system-test`) → [`docs/architecture/06-testing.md`](docs/architecture/06-testing.md).

Báo cáo verification:

- Ghi **lệnh đã chạy** và **kết quả thật** vào PR.
- Nếu một check không chạy được vì môi trường, ghi rõ blocker và phần chưa verify.
- Không tuyên bố pass khi chưa chạy. CI xanh chỉ chứng minh check đã chạy trên revision đó — không chứng minh deploy hay business outcome.

## 7. Pull Request và review

Một PR là **một logical change review độc lập được** — có thể chạm nhiều file, nhiều Nx project và nhiều loại artifact nếu chúng cùng phục vụ một outcome. Không bắt buộc một commit cho mỗi PR. Quy tắc PR đầy đủ → [`work-management.md`](docs/engineering/work-management.md) §5.

**Tiêu đề PR** (tiếng Anh, Conventional Commits):

```
<type>(<scope>): <subject>
```

- `type` là bất kỳ loại hợp lệ nào (`feat`, `fix`, `docs`, `chore`, `refactor`, `ci`, ...).
- `scope` không bắt buộc; nếu có thì phải đúng **một** Nx project, dùng **tên không prefix**, không dùng dạng `@ecoma-io/<name>`. `pnpm nx show projects` in ra tên có thể kèm prefix (ví dụ `@ecoma-io/account`) hoặc không (ví dụ `account-deploy`), nên bỏ tiền tố `@ecoma-io/` khi viết scope; `account`, `transactional-mail`, `dx` là hợp lệ. Không có scope `docs` — thay đổi tài liệu dùng tiêu đề không scope, ví dụ `docs: ...`.
- Kiểm tiêu đề trước khi mở PR: `echo "docs(dx): ..." | pnpm exec commitlint`. Lệnh này chỉ kiểm commitlint, **không** kiểm quy tắc một-scope của `pr-check`: `feat(dx,account): ...` vẫn qua commitlint nhưng bị CI từ chối. `pnpm dx pr-check` là cổng CI, không chạy được ngoài GitHub Actions.
- Squash merge biến tiêu đề PR thành commit subject trên `main`, nên tiêu đề được viết có chủ đích.

**Body PR** viết tiếng Việt, dùng template trong [`.github/PULL_REQUEST_TEMPLATE/`](.github/PULL_REQUEST_TEMPLATE/). Nêu: lý do, thay đổi chính, cách verify, phần chưa làm.

**Liên kết Issue:**

- `Closes #N` chỉ khi PR hoàn thành **toàn bộ** Issue.
- `Refs #N` khi PR chỉ hoàn thành một phần.
- Không bắt buộc mọi PR phải có Issue.

**Điều kiện để PR được merge** — quy tắc nằm ở [`AGENTS.md`](AGENTS.md) `Pull requests`; giá trị đang áp dụng phải đọc từ ruleset `main` trên GitHub, không suy ra từ tài liệu này:

```bash
gh api repos/ecoma-io/ecoma/rulesets        # chỉ trả id/name/enforcement
gh api repos/ecoma-io/ecoma/rulesets/<id>   # rule và tham số hiện hành
```

Trước khi mở PR, tự kiểm những điều kiện không đọc được từ diff: CI xanh trên revision cuối, mọi review conversation đã resolve, mọi commit đã ký, nhánh đã rebase lên `main` mới nhất, PR title hợp lệ, và không còn work item phải xong trước (với stacked PR: nhánh cha đã land). Merge chỉ bằng squash và đi qua merge queue.

Đưa PR vào merge queue ngay khi nó đủ điều kiện — không để PR xanh nằm chờ.

## 8. Release và reconciliation

**Khi nào được đóng Issue:** khi outcome đã đạt, có bằng chứng tương ứng, và reconciliation đã ghi phân loại vào Issue comment. Với PR dùng `Closes #N`, GitHub đóng Issue ngay khi merge — trước khi reconciliation chạy; khi đó comment phân loại phải được ghi trong cùng ngày làm việc, và nếu phát hiện outcome chưa đạt thì mở lại Issue. Điều kiện đầy đủ và lý do đóng (`completed`, `not planned`, `duplicate`) → [`work-management.md`](docs/engineering/work-management.md) §2.6.

**Reconciliation sau merge hoặc release:**

1. So target với thực tế theo §8.1 của [`evolution-process.md`](docs/engineering/evolution-process.md).
2. Ghi phân loại kèm bằng chứng vào Issue: `Aligned`, `Partially implemented`, `Not implemented`, `Implemented, not verified`, `Released`, `Accepted deviation`, `Gap requiring work`.
3. Mở Remediation cho gap material.
4. Cập nhật specification nếu bằng chứng mới làm thay đổi target.

**Không tuyên bố `Released` nếu chưa có deployment evidence.** Deploy local chỉ chứng minh `Released` khi environment dự định đúng là local. Repository hiện chưa có deploy pipeline staging/production và chưa có nơi lưu deployment record — xem [`02-delivery.md`](docs/architecture/02-delivery.md) §12.

## 9. Phát triển có agent hỗ trợ

Coding agent làm việc theo cùng quy trình, với các quy tắc bổ sung:

- **Đọc trước khi sửa.** Canonical document và [`AGENTS.md`](AGENTS.md) có precedence cao hơn skill. Skill chỉ cung cấp cách thực thi cho một loại công việc.
- **Chọn skill theo trigger** trong `description` của skill, trong `.agents/skills/`. Không load toàn bộ skill không liên quan.
- **Dừng và báo lại** khi thiếu decision cần thiết, khi canonical artifact mâu thuẫn, khi scope thực tế vượt Issue/PR, khi không thu được bằng chứng, hoặc khi có nguy cơ phá invariant hay backward compatibility.
- **Không tự mở rộng quyền**: không tạo Project/Milestone, không đóng Issue của người khác, không đổi cấu hình GitHub ngoài phạm vi Issue.
- **Báo cáo trung thực**: validation chưa chạy được thì nói rõ.

Skill và định nghĩa subagent là nguồn canonical ở `.agents/`; `.claude/` và `.opencode/` chỉ chứa output sinh. Không author trực tiếp file sinh ra. Quy tắc đầy đủ về skill usage và escalation → [`AGENTS.md`](AGENTS.md) `Workflow`.

**Agent chuyên vai.** Danh mục năm agent (`engineering-orchestrator`, `repository-analyst`, `architect`, `implementer`, `verifier`) cùng trách nhiệm và ranh giới read-only/write của từng vai nằm ở [`AGENTS.md`](AGENTS.md) `Agent catalog` — đó là nguồn canonical, không chép lại ở đây. Dùng orchestrator cho một task cần điều phối: chạy `claude --agent engineering-orchestrator`, hoặc chọn agent đó trong OpenCode sau khi `pnpm dx repo-prepare` sinh `.opencode/agents/`. Các agent chuyên vai còn lại do orchestrator dispatch, không tự chạy song song ngoài nó.

## 10. Tài liệu canonical

| Cần biết                                               | Đọc                                                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Ràng buộc repository, ngôn ngữ, PR policy              | [`AGENTS.md`](AGENTS.md)                                                                                       |
| Bản đồ tài liệu, ownership từng loại artifact          | [`docs/README.md`](docs/README.md), [`docs/AGENTS.md`](docs/AGENTS.md)                                         |
| Vòng đời, Issue Type, capability state, reconciliation | [`docs/engineering/evolution-process.md`](docs/engineering/evolution-process.md)                               |
| Issue, Project, Milestone, PR semantics                | [`docs/engineering/work-management.md`](docs/engineering/work-management.md)                                   |
| Từng bước thực hiện và handoff                         | [`docs/engineering/contribution-workflow.md`](docs/engineering/contribution-workflow.md)                       |
| Kiến trúc hệ thống                                     | [`docs/architecture/01-architecture.md`](docs/architecture/01-architecture.md)                                 |
| Delivery, CI/CD, migration, release                    | [`docs/architecture/02-delivery.md`](docs/architecture/02-delivery.md)                                         |
| Cấu trúc Nx, DDD layer, contract                       | [`docs/architecture/05-code-architecture.md`](docs/architecture/05-code-architecture.md)                       |
| Test taxonomy và Nx test target                        | [`docs/architecture/06-testing.md`](docs/architecture/06-testing.md)                                           |
| Domain map và bounded context                          | [`docs/domains/README.md`](docs/domains/README.md)                                                             |
| Chạy local stack và preview                            | [`docs/architecture/local-development/03-operations.md`](docs/architecture/local-development/03-operations.md) |
