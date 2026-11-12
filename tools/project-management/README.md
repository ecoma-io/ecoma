# Project Management

Pipeline reconcile membership của GitHub Project **Ecoma EcoSystem** (#13, tổ chức `ecoma-io`) theo policy work-management: **root issue là member của Project; sub-issue, pull request, item do bot sở hữu và historical test fixture thì không**. Đây là **tooling vận hành** của repository, không phải application hay bounded context — nó chỉ đọc/ghi GitHub qua GraphQL, không sở hữu dữ liệu ứng dụng nào.

Nx project `@ecoma-io/project-management`, tags `type:tooling`, `runtime:native`, `scope:local`. Entrypoint `index.ts` gọi `runMain` của citty; registry ở `src/index.ts` khai đúng một subcommand `reconcile` (gọi không subcommand chỉ in usage). Business logic nằm trọn trong `src/`; workflow GitHub Actions chỉ lo trigger, permission, setup và upload artifact.

## Purpose

- Đưa Project #13 về desired membership mỗi kỳ chạy, thay vì thêm/xoá item bằng tay — quy tắc membership là policy của repository, ghi ở [`docs/engineering/work-management.md`](../../docs/engineering/work-management.md) §3.2–§3.3, và README này chỉ mô tả cách pipeline thực thi policy đó.
- Tách phần đọc/ghi GitHub khỏi phần quyết định: các stage `classify`/`audit`/`plan`/`diff` thuần, nhận dữ liệu đã normalize; port GraphQL được inject nên toàn bộ unit test chạy trên fake, không test nào gọi GitHub thật.

## Responsibilities

Input là token GitHub, tên org/repo, số Project và file policy; output là report text ra stdout cộng (tùy chọn) JSON qua `--out`, và — chỉ ở mode `apply` — các mutation `addProjectV2ItemById` / `removeProjectV2ItemById`.

- **discover** — đọc toàn bộ issue của repo và toàn bộ item của Project qua GraphQL, phân trang 100 mục/trang tới `hasNextPage: false`. Retry exponential backoff (base 500ms, trần 8s) cho 502/503/429, network error và dữ liệu malformed; chờ theo `retry-after`/`x-ratelimit-reset` bị ghim tối đa 60s mỗi lần thử để không treo job; 401/403/404 fail ngay. Bất kỳ trang nào không đọc được sau retry ⇒ `complete: false` ⇒ **fail-closed**: report `status: failed`, không audit, không mutation.
- **classify** — phân loại từng issue theo dữ liệu normalize: root hay child (qua `parentNumber` native), bị loại trừ bởi policy hay không, và desired membership (`!isPullRequest && root && !excluded`). Trạng thái OPEN/CLOSED không đổi desired membership. Sort theo số issue để output deterministic.
- **audit** — so desired membership với snapshot, sinh finding có severity: `missing_membership`, `unexpected_membership`, `duplicate_project_items`, `orphaned_child`, `invalid_reference` (item PR/draft hoặc trỏ số issue lạ) ở mức error; `labeled_not_root` warning; `archived_item`, `labeled_without_item` info.
- **plan** — action deterministic theo số issue rồi action rồi `itemId`: `add`, `remove`, `keep`, `keep_out`. Item trùng của cùng một desired member thì giữ một, remove phần thừa. Pipeline chỉ mutation thứ nó định danh được là ISSUE: item PR/draft và item trỏ số lạ bị báo qua audit nhưng **không tự xoá**.
- **idempotency-check** — áp plan lên trạng thái giả định sau-apply rồi re-plan; kết quả nằm ở field `idempotency` của report.
- **apply** (chỉ `--mode apply`) — thực thi từng add/remove, mỗi mutation được log kèm kết quả thật; một mutation lỗi không dừng các mutation còn lại.
- **verify** (sau apply) — refetch snapshot item và re-derive drift từ dữ liệu thật, không tin kết quả mutation. Poll bounded exponential backoff 2s → 4s → 8s → 16s → 30s (kèm jitter, trần interval 30s) trong deadline mặc định 120s (`--verify-deadline-ms`, trần 24h) vì GitHub Projects truyền bá item không đồng bộ. Trạng thái: `clean`, `propagation_pending` (residual toàn là hiệu ứng chưa hiện của mutation đã thành công — audit kỳ sau xác nhận), `drift` (residual không giải thích được — dừng poll sớm), `verification_failed` (API lỗi hết deadline), `inventory_incomplete` (snapshot dở dang hết deadline — không bao giờ kết luận trên inventory một phần). Verify không bao giờ mutation thêm.
- **report** — text cho người đọc ra stdout; JSON qua `--out` (thư mục cha được tạo nếu thiếu).

Thứ tự stage và ngữ nghĩa fail-closed được mô tả trong JSDoc của `src/reconcile.ts`; README không chép lại toàn bộ chi tiết đó.

## Boundaries

- Không sở hữu policy: desired membership và lifecycle nằm ở [`docs/engineering/work-management.md`](../../docs/engineering/work-management.md) §3; pipeline chỉ đọc policy file và thực thi.
- Không phải orchestration của GitHub Actions: workflow [`project-management.yml`](../../.github/workflows/project-management.yml) khai trigger, mint token, chọn mode và upload artifact; không có business logic nào trong YAML.
- Không cấu hình GitHub: filter của native Project workflow, label và field của Project là cấu hình GitHub — pipeline đọc từ API, tài liệu không chép lại.
- Không có trigger Actions native cho `sub_issues` hay `projects_v2_item` (platform fact GH9, [`04-platform-facts.md`](../../docs/architecture/04-platform-facts.md) §2.20) — hai loại thay đổi này chờ audit theo lịch; pipeline không thay thế webhook receiver.
- Chỉ thao tác trên item mà nó định danh được; mọi bất thường còn lại là dữ liệu trong report, không phải hành động tự động.

## Development

Chạy CLI trực tiếp bằng `npx tsx` (package khai `main: ./index.ts`, không có target `serve`):

```bash
export PROJECT_MANAGEMENT_TOKEN="$(gh auth token)"   # hoặc GITHUB_TOKEN

npx tsx tools/project-management/index.ts reconcile --owner ecoma-io --repo ecoma-io/ecoma --project 13
npx tsx tools/project-management/index.ts reconcile --mode apply --owner ecoma-io --repo ecoma-io/ecoma --project 13 --out /tmp/reconcile-report.json
```

Lệnh đầu đọc và báo drift (mặc định `--mode audit`); lệnh hai ghi membership về desired state rồi verify, kèm `--out` để giữ report JSON.

- `--repo` nhận tên đầy đủ `owner/name` (phần owner phải khớp `--owner`) hoặc tên trần.
- `--policy` mặc định là `config/membership-policy.json` của package: `projectNumber` cộng `exclusions` (`issueNumbers`, `botAuthorSuffix`, `titlePrefixes`). Validation fail-closed — key lạ, type sai hay thiếu key đều dừng lệnh với danh sách lỗi đầy đủ.
- Token đọc từ `PROJECT_MANAGEMENT_TOKEN` (ưu tiên) hoặc `GITHUB_TOKEN`; không có token là exit 1 trước khi gọi API. Project #13 là organization project nên `GITHUB_TOKEN` mặc định của repo không thao tác được — token phải có quyền organization project của org `ecoma-io`. CI mint installation token từ GitHub App của org theo mode (audit xin quyền read, apply xin write); chạy CLI local dùng PAT của tài khoản được cấp quyền đó, ví dụ `gh auth token`.
- Exit code: `0` cho `clean` lẫn `drift` (drift là dữ liệu, không phải failure); `1` khi thiếu token, policy lỗi, tham số sai hoặc `status: failed`. Residual sau apply đọc qua `verification.status` trong report, không chỉ nhìn exit code.

## Testing

```bash
pnpm nx run @ecoma-io/project-management:lint
pnpm nx run @ecoma-io/project-management:typecheck
pnpm nx run @ecoma-io/project-management:test       # vitest — spec colocated trong src/
```

- Toàn bộ unit test dùng fake port và fake `fetch`: pagination, retry/rate-limit, mutation, verify polling và policy validation đều chạy offline. Không có test nào gọi GitHub thật, nên một lần test xanh không chứng minh quyền của token.
- Bằng chứng vận hành thật là report JSON của workflow: artifact `project-management-report`, upload kể cả khi step reconcile đỏ, retention 7 ngày.
- Phân loại test và canonical target theo `docs/architecture/06-testing.md` §3–§4.

## Related Documentation

- [`docs/engineering/work-management.md`](../../docs/engineering/work-management.md) — policy Project và membership: §3.1 trách nhiệm, §3.2 root issue là member, §3.3 vòng đời, §3.4 cấu hình tối thiểu.
- [`docs/architecture/04-platform-facts.md`](../../docs/architecture/04-platform-facts.md) §2.20 — platform fact GH9–GH12 về trigger Actions, concurrency và độ trễ truyền bá item của Projects V2.
- [`tools/project-management/config/membership-policy.json`](./config/membership-policy.json) — policy đang dùng: Project #13 và các exclusion.
- [`.github/workflows/project-management.yml`](../../.github/workflows/project-management.yml) — trigger, token, mode và artifact.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) §6.1 — ý nghĩa tag `type:tooling`.
