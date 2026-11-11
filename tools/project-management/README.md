# project-management

Reconcile membership của GitHub Project **Ecoma EcoSystem** (#13, tổ chức
`ecoma-io`) theo policy quản trị work-management: **mọi root issue là member
của Project; sub-issue, dashboard do tool/bot sở hữu và historical test fixture
không phải**. Pipeline chạy độc lập qua CLI và qua GitHub Actions; business
logic nằm trọn trong TypeScript của package này, YAML workflow chỉ lo trigger,
permission, setup và upload artifact.

Ví chứng Issue gốc: ecoma-io/ecoma#95. Ràng buộc policy:
`docs/engineering/work-management.md` §3 (membership) và §3.3 (vòng đời
membership; label `project:track` đã retire).

## Pipeline

```
discover → audit → plan → apply → verify → report
```

- **discover** — đọc toàn bộ issue của repo và toàn bộ item của Project qua
  GraphQL, phân trang 100 mục/trang, đầy đủ tới trang cuối. Bất kỳ trang nào
  lỗi/malformed sau retries ⇒ `complete: false` ⇒ **fail-closed**: report
  `status: failed`, không audit, không mutation.
- **audit** — so desired membership với snapshot, sinh findings:
  `missing_membership`, `unexpected_membership`, `duplicate_project_items`,
  `orphaned_child`, `invalid_reference` (item PR/draft hoặc trỏ số issue lạ),
  `archived_item` (info), `labeled_not_root` (warning, label `project:track`
  trên sub-issue), `labeled_without_item` (info).
- **plan** — action deterministic (sort theo số issue): `add`, `remove`,
  `keep`, `keep_out`. Item trùng của cùng một desired member: giữ một item,
  remove phần thừa.
- **apply** (chỉ `--mode apply`) — thực thi add/remove, từng mutation được log
  vào report; một mutation lỗi không dừng các mutation còn lại.
- **verify** — sau apply luôn refetch snapshot item và re-derive drift còn
  lại. Kết quả mutation KHÔNG được tin mù quáng: mutation "thành công" nhưng
  refetch không thấy item ⇒ verification báo drift, report không `clean`.
- **report** — text cho người đọc ra stdout, JSON qua `--out` cho artifact.

Idempotency được chứng minh ngay trong lần chạy đầu: pipeline áp plan lên
trạng thái giả định sau-apply rồi re-plan (`computeIdempotencyCheck`); nếu còn
residual mutation thì field `idempotency` trong report sẽ nói rõ.

## Policy

File `config/membership-policy.json` (đường dẫn mặc định của `--policy`):

```json
{
  "projectNumber": 13,
  "exclusions": {
    "issueNumbers": [1, 8],
    "botAuthorSuffix": "[bot]",
    "titlePrefixes": ["TEST-FIXTURE-"]
  }
}
```

Issue bị loại trừ khi số nằm trong `issueNumbers`, HOẶC `authorLogin` kết thúc
bằng `botAuthorSuffix`, HOẶC `title` bắt đầu bằng một prefix trong
`titlePrefixes`. Validation fail-closed: key lạ, type sai, thiếu key đều làm
lệnh dừng với danh sách lỗi đầy đủ.

## Chạy local

Cần token có quyền đọc/ghi Project của tổ chức (xem dưới). Lấy token từ `gh`
đã đăng nhập và chạy:

```bash
export PROJECT_MANAGEMENT_TOKEN="$(gh auth token)"

# Chỉ đọc và báo drift (mặc định):
npx tsx tools/project-management/index.ts reconcile \
  --owner ecoma-io --repo ecoma-io/ecoma --project 13

# Ghi đè membership về desired state:
npx tsx tools/project-management/index.ts reconcile \
  --mode apply --owner ecoma-io --repo ecoma-io/ecoma --project 13 \
  --out /tmp/reconcile-report.json
```

Exit code: `0` cho cả `clean` lẫn `drift` (drift là dữ liệu, không phải
failure); `1` khi thiếu token, policy lỗi, hoặc `status: failed` (inventory
một phần, verify không chạy được).

## Chạy trong Actions

Workflow `.github/workflows/project-management.yml`:

- `workflow_dispatch` với input `mode` (`audit`/`apply`, mặc định `audit`) và
  `reason` (ghi vào log của run).
- `schedule` hằng ngày 05:30 UTC — **chỉ audit**, apply không bao giờ được chạy
  từ schedule.
- Report JSON được upload thành artifact `project-management-report` (kể cả
  khi step reconcile đỏ).
- Concurrency gộp về một group `project-management`, không cancel run đang
  chạy.

## Quyền token và cấu hình secret

- Token phải thao tác được **organization project**: PAT classic cần scope
  `read:project` cho audit và `write:project` (hoặc `project` scope cũ) cho
  apply; GitHub App cần permission Organization projects read/write.
  `GITHUB_TOKEN` mặc định của repo KHÔNG đủ vì Project nằm ở tổ chức.
- Secret tên `PROJECT_MANAGEMENT_TOKEN`, cấu hình ở cấp tổ chức (hoặc repo)
  do **org admin** thực hiện — đây là bước thủ công nằm ngoài repo. Workflow
  fail kèm thông báo `::error::` rõ ràng nếu `apply` chạy khi secret rỗng.

## Hạn chế đã biết

- GitHub **không có API disable** một native Project workflow — chỉ có
  `deleteProjectV2Workflow`; pipeline này vì vậy không tắt automation cũ mà chỉ
  đưa membership về đúng policy mỗi lần chạy.
- Sự kiện sub-issue **không có trigger Actions ổn định**, nên reconcile chạy
  định kỳ (schedule + dispatch) thay vì event-driven.
- Port GraphQL không đọc sub-issues: field `subIssueNumbers` của
  `NormalizedIssue` luôn rỗng với dữ liệu thật (query chỉ lấy `parent.number`,
  đủ cho classification root/child).
- Item PR/draft và item ISSUE trỏ số không có trong repo được báo qua audit
  (`invalid_reference`) nhưng **không được tự xoá** — pipeline chỉ mutation
  thứ mà nó định danh được là issue.
- `apply` còn drift sau verify (vd mutation bị lỗi) kết thúc với exit 0 nhưng
  `status: drift` trong report/artifact — người vận hành đọc report, không chỉ
  nhìn exit code.
- Chờ theo rate-limit header bị ghim tối đa 60s mỗi lần thử để không treo job
  CI; primary rate limit dài hơn sẽ cạn retry và fail-closed thay vì chờ tới
  khi reset.

## Kiểm tra

```bash
pnpm nx run @ecoma-io/project-management:lint
pnpm nx run @ecoma-io/project-management:typecheck
pnpm nx run @ecoma-io/project-management:test
```

Toàn bộ unit test dùng fake port/fake fetch — không test nào gọi GitHub thật.
