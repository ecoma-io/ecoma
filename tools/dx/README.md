# dx

Devtools CLI cho repository ecoma-io. Tự chạy khi `pnpm install` thông qua
script `prepare`.

## Lệnh

```bash
pnpm dx --help              # liệt kê các lệnh
pnpm dx repo-prepare        # hook, kiểm tra tool, đồng bộ cấu hình agent
pnpm dx sync-agent-config   # chỉ đồng bộ cấu hình agent (.agents/ → .claude/ và .opencode/)
pnpm dx pr-check            # kiểm PR theo policy của repository
```

`repo-prepare` chạy lại an toàn — mỗi bước đều bỏ qua việc đã xong.

### repo-prepare

1. Cài git hook (`lefthook install`).
2. Kiểm tra Docker, Helm, kustomize và kubeconform có chạy được không.
3. Đồng bộ cấu hình agent: mirror `.agents/skills/` và sinh định nghĩa
   subagent từ `.agents/agents/` cho cả `.claude/` và `.opencode/`.

### Kiểm tra tool

Một tool chỉ được coi là có mặt khi lệnh lấy version của nó chạy được trên
`PATH` hiện tại. Một binary nằm trong thư mục cài đặt mà shell này chưa nhận
diện thì không chạy được, trong khi các bước thiết lập trong `CONTRIBUTING.md`
lại giả định nó chạy được.

`repo-prepare` không bao giờ cài gì cả. Một máy không có root, không có TTY để
trả lời prompt `sudo`, hoặc đứng sau corporate proxy là một máy bình thường,
mà một installer không hoàn tất được sẽ khiến repository chỉ chuẩn bị được một
nửa. Tool còn thiếu được liệt kê kèm link tới hướng dẫn của chính vendor:

```
Checking required tools
Docker v29.5.3 is available
kubeconform v0.6.7 is available

2 required tools are missing. Install them before working on this repository:
  Helm: https://helm.sh/docs/intro/install/
  kustomize: https://kubectl.docs.kubernetes.io/installation/kustomize/
```

Lệnh vẫn exit 0 — một tool thiếu là thông tin, không phải thiết lập hỏng.

Docker được kiểm tra bằng `docker version` chứ không phải `docker --version`.
Flag trần báo binary đã cài dù daemon có chạy hay không, nên nó sẽ qua bước kiểm
tra này trên một máy rồi fail mọi commit vì daemon chưa từng tồn tại.

### sync-agent-config

Đồng bộ cấu hình agent từ source of truth ở `.agents/` sang cấu hình generated
cho hai coding agent:

- **Skills** — mirror `.agents/skills/` sang `.claude/skills/` và
  `.opencode/skills/`, giữ nguyên cấu trúc thư mục và tất cả file hỗ trợ
  (không chỉ `SKILL.md`). Copy file mới và file thay đổi, đồng thời xóa
  file/thư mục đích không còn đối ứng, nên chạy lặp lại là idempotent. Các thư
  mục đích hoàn toàn là generated output — custom skills phải đặt trong
  `.agents/skills/`. Nếu `.agents/skills/` không tồn tại, bước skills được bỏ
  qua với thông báo rõ ràng và các đích hiện có được giữ nguyên; nếu có nhưng
  rỗng, chúng được đồng bộ như một nguồn rỗng (làm trống đích). Bước này tôn
  trọng `.gitignore` cho việc duyệt và cho các input được copy, và không đi
  theo symlink ra ngoài source tree.
- **Agents** — mỗi file `.agents/agents/<name>.md` là một định nghĩa agent, viết
  bằng frontmatter của Claude Code (`name`, `description`, `tools`, `model`,
  `mode`, tùy chọn). Lệnh sinh `.claude/agents/<name>.md` gần nguyên văn và
  `.opencode/agents/<name>.md` với `mode` cộng `permissions` suy ra từ `tools`.
  `mode` chỉ nhận đúng ba giá trị `primary`, `subagent`, `all`; bỏ trống thì
  mặc định là `subagent`. Key này chỉ ảnh hưởng file OpenCode — Claude Code
  không có field `mode` nên nó không bao giờ được ghi vào
  `.claude/agents/<name>.md`. Vì OpenCode áp rule khai báo sau thắng rule khai
  báo trước, file sinh ra đặt catch-all `deny` trước rồi mới tới các `allow` —
  đây là thứ thực sự giới hạn quyền của agent. `model` chỉ được truyền sang
  OpenCode khi có dạng `provider/model`; alias của Claude bị bỏ kèm cảnh báo.

Năm định nghĩa agent hiện được sinh: `engineering-orchestrator` (`mode: primary`,
không có `Edit`/`Write` nhưng có `Bash`), `repository-analyst` và `architect`
(chỉ đọc, tool-enforced: không có write tool và không có shell), `implementer`
(ghi trong scope lock), `verifier` (không có `Edit`/`Write`, dùng `Bash` để chạy
validation). Chỉ hai vai không có write tool **và** không có shell mới thực sự bị
tool chặn ghi; mọi scope lock khác là instruction-level vì một `Bash` được cấp
vẫn ghi được file. Danh mục và ranh giới từng vai nằm ở `AGENTS.md` `Workflow` →
`Agent catalog`.

`name` phải trùng tên file, mọi key khác ngoài năm key trên là lỗi, và một tên
tool không có trong bảng ánh xạ cũng là lỗi — ba trường hợp đó fail lệnh thay vì
sinh ra một agent bị chặn quyền mà không ai biết.

### pr-check

Đọc PR từ event payload mà GitHub Actions đã ghi ra đĩa (`GITHUB_EVENT_PATH`)
— title lẫn SHA của `pull_request.base` và `pull_request.head` — thay vì nhận
thông tin qua đối số của CI, rồi kiểm ba lớp:

1. commitlint với `commitlint.config.mjs` — syntax Conventional Commits và Nx
   scope, đúng nguyên trạng rule mà hook `commit-msg` đang dùng.
2. Chính sách title — đúng một Nx scope; type tùy ý: `feat`, `fix`, `chore`,
   `docs`, `refactor`, `ci`, ...
3. Chính sách development commits — trên khoảng `base.sha..head.sha`, mỗi
   commit được parse để xác nhận git history đọc được, nhưng không kiểm type và
   không giới hạn số lượng: `feat`, `fix`, `chore`, `docs`, ... đều hợp lệ.
   Từng message được parse bằng cùng parser preset của commitlint.

Khoảng commit được đối chiếu với git history tại chỗ (CI checkout với
`fetch-depth: 0`) — pr-check không gọi GitHub API và không dùng trường
`pull_request.commits`. Chính sách nằm ở đây chứ không nằm trong
`commitlint.config.mjs` vì hook `commit-msg` vẫn phải cho `chore`, `docs`,
`refactor`... đi qua trên nhánh phát triển; chỉ PR bị siết lại. CI gọi lệnh này
và không tự parse payload trong YAML nữa.

Ngoài bối cảnh `pull_request` của GitHub, thiếu SHA, hoặc git không đọc được
range thì lệnh exit 1 thay vì báo xanh — một check không xác định được history
thì không có quyền thông qua.

Squash merge và merge queue do GitHub repository/ruleset cấu hình, nên `pr-check`
không kiểm và cũng không giả vờ kiểm những thứ đó.

## Test

```bash
nx test dx         # unit test
nx typecheck dx    # tsc
nx lint dx         # oxlint
```

## Bố cục

Source tổ chức theo **capability** — mỗi thư mục con của `src/` là một nhóm trách
nhiệm, module nào cũng chỉ import chéo theo các hướng được liệt kê ở "Ranh giới
phụ thuộc" dưới đây:

| Path                             | Vai trò                                                                                                                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                       | Entry point, đưa `app` cho `runMain` của citty.                                                                                                                                                     |
| `src/index.ts`                   | Registry 17 lệnh — lazy-load qua `import()` của citty, không auto-discovery.                                                                                                                        |
| `src/utils.ts`                   | `ROOT_DIR`, `runCommand`, `gitEnv` — dùng chung cho mọi capability.                                                                                                                                 |
| `src/repository/`                | Chuẩn bị repository: `repo-prepare`, đồng bộ cấu hình agent (`sync-agent-config`, transform frontmatter ở `agent-frontmatter.ts`), dò tool.                                                         |
| `src/pull-request/`              | Chính sách PR: `pr-check` (commitlint là nguồn sự thật cho parse + validate).                                                                                                                       |
| `src/architecture/`              | Kiểm tra tag kiến trúc: `arch-check`, validator tag trên project graph Nx.                                                                                                                          |
| `src/security/`                  | Kiểm tra an toàn: `commit-signing`, `gitleaks-scope`, `gitleak-local`, `gitleak-ci`, `semgrep-scan-local`, `semgrep-scan-ci`, `semgrep-test-local`, `semgrep-test-ci`.                              |
| `src/deployment/`                | Orchestration local platform (`local-platform/`).                                                                                                                                                   |
| `src/deployment/local-platform/` | Labels, outputs contract, Pulumi context, `local-status`/`local-cleanup` và smoke test — lifecycle up/down của từng deploy project nằm ở entry colocated `deploys/<project>/local.ts`, không ở đây. |
| `src/local-runtime/`             | Tiện ích local dùng chung: namespace worktree, lock, args/lệnh `local-*`.                                                                                                                           |
| `src/workers/`                   | Worker runtime: discovery, config, process lifecycle, orchestration, CLI.                                                                                                                           |
| `src/review-tooling/`            | Spec cho các script OCR trong `scripts/` (script giữ nguyên vị trí cũ).                                                                                                                             |
| `scripts/`                       | Script standalone gọi bằng đường dẫn (`ocr-result-gate.mjs`, `ocr-selection-probe.mjs`) — được CI gọi qua đường dẫn tuyệt đối, không dời.                                                           |

`docker-context.spec.ts` đứng ở gốc `src/`: nó kiểm hợp đồng `.dockerignore` của
repo root, không thuộc capability nào cả.

### Ranh giới phụ thuộc

- Mọi capability được dùng `utils.ts` ở gốc `src/`; `utils.ts` không import lại
  capability nào.
- `local-runtime/` là lớp dùng chung cho local platform lẫn worker runtime — nó
  KHÔNG được import ngược vào `deployment/` hay `workers/`.
- `workers/` KHÔNG import module của `deployment/`; muốn helper local thì đi qua
  `local-runtime/`.
- Module lệnh không import registry (`src/index.ts`); registry là điểm duy nhất
  biết danh sách lệnh.

Một tool được mô tả bởi một `ToolSpec` (`src/repository/`) — tên hiển thị,
executable, flag lấy version và URL cài đặt chính thức — nên thêm tool thứ năm
là thêm một spec, không phải viết code mới.

## Quy ước

- Lệnh chạy từ `ROOT_DIR`, được suy ra từ vị trí file, nên kết quả không phụ
  thuộc vào working directory của caller.
- Import tương đối luôn có extension `.js` tường minh. Source là ESM dưới
  `nodenext`, nơi `./tools.js` chính là tên file sau khi compile mà Node nạp.
