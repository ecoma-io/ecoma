---
title: "ADR Ledger"
status: design-end-state
canonical-sha: 4d9211332a04
---

# ADR Ledger

> Nhà của quyết định **triển khai** (tầng 3 theo playbook giao hàng (không công bố) §5c: trần / charter / ADR). Append-only, supersede có lineage. ADR không được mâu thuẫn trần — mâu thuẫn thì trần thắng. Mỗi ADR đã chốt = owner duyệt tường minh sau vòng đối kháng (log ở scenario catalog).

## ADR-0001 — Durable execution: TỰ VIẾT trên Event Log ✅ CHỐT

- **Quyết định**: không dùng workflow framework ngoài; trạng thái bền = replay stream, timer/SLA/lease-TTL = entry (Event Log §5) — trần đã mô tả cơ chế, ADR xác nhận không mua ngoài.
- **Bác Temporal/Cadence — án văn cơ chế thuần**: (1) chúng giữ event history riêng = **nguồn sự thật thứ hai** (E5); (2) "workflow-as-code là source of truth" xung đột _process-definition-là-Artifact-có-Gate_ (Composition §1); (3) cluster ops riêng phá "self-host đơn giản nhất".
- **Hệ quả**: engine tự chịu scheduler/claim/replay — đã nằm trong M0; conformance suite của G0 là lưới kiểm.

## ADR-0002 — Storage: 5 port, reference Postgres, default THEO HÌNH THÁI ✅ CHỐT

**5 port** (đều đã có trong trần, ADR chỉ gọi tên): `log-store` · `SQL-read` · `vector` · `blob-CAS` · `metrics-projection`.

| Khái niệm                                                                                           | Chốt                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reference backend**                                                                               | **Postgres** — nơi contract-suite định nghĩa hành vi chuẩn. _Reference ≠ default cài đặt_                                                                                                                                                                                                                                       |
| **Contract SQL-read**                                                                               | **Suite-defined** (executable), không định nghĩa bằng tên sản phẩm — sửa Working Data §5. Contract-bằng-suite kiểm được cho mọi backend; contract-bằng-tên thì không                                                                                                                                                            |
| **Default theo hình thái cài đặt** (không có config switch — hình thái là lời khai quy mô của user) | Binary đơn / `docker run` 1 container → **small-stack: SQLite (log/OLTP) + DuckDB (SQL-read/OLAP) + sqlite-vec** · `docker compose` production / helm → **Postgres + pgvector + TimescaleDB** · Cloud/SaaS → Postgres                                                                                                           |
| Small-stack — vì sao hợp lệ                                                                         | Đối kháng thuần cơ chế: mọi cơ chế trần chạy được; SQLite = đường GHI, DuckDB = đường HỎI — **tách vật lý đúng cái trần tách logic** ("SQL để hỏi, event để ghi"); engine là process ghi duy nhất = đúng luật DB-là-tài-sản-engine (Working Data §2)                                                                            |
| **Grow-path**                                                                                       | Nâng cấp small→Postgres = **replay log sang port mới** (event-sourced cho không); engine đo ngưỡng (event/ngày, kích thước file, p95) → **cảnh báo + migrate là Task tường minh** — không bao giờ auto (I3)                                                                                                                     |
| **Key store backend**                                                                               | Điều kiện cứng của mọi backend đóng vai key store (KMS / HashiCorp Vault / HSM / file): `destroy` không khôi phục được **và** không cung cấp (hoặc cho phép tắt) **snapshot / rewind point-in-time** trên key material — Vault §6.2. Án văn: snapshot key store hồi sinh đúng khóa đã shred ⇒ mở lại lỗ backup×shred ở cửa khác |
| Qdrant (vector, scale)                                                                              | ✅ qua vector-port; điều kiện: index là projection rebuild-từ-log + backend chịu **classification policy** (collection `secret` không rời danh sách duyệt)                                                                                                                                                                      |
| ClickHouse                                                                                          | ✅ đúng 2 cửa: projection-backend _opt-in_ + đích **BYO-export**; ❌ không nhận write trực tiếp (E5), ❌ không vào default                                                                                                                                                                                                      |
| BYO-export                                                                                          | Format = **Parquet** (open table); **DuckDB = consumer đề xuất** cho phân tích local                                                                                                                                                                                                                                            |
| Chroma                                                                                              | ❌ — không giải gì pgvector/sqlite-vec chưa giải                                                                                                                                                                                                                                                                                |
| Kafka                                                                                               | ❌ làm nguồn sự thật (retention xung đột "entry vĩnh viễn", ops nặng); tương lai chỉ được làm transport/projection-feed qua adapter                                                                                                                                                                                             |
| CI                                                                                                  | Small-stack **first-class từ M0**: conformance suite các storage-port chạy trên cả reference lẫn small-stack                                                                                                                                                                                                                    |
| Rủi ro (không phải án bác)                                                                          | Chạm cược **B1**; kill-trigger: duy trì 2 default làm **trễ 2 milestone liên tiếp** → xét lại phạm vi small-stack (ghi chú tại ICP ledger B7)                                                                                                                                                                                   |

## ADR-0003 — Ngôn ngữ hạ tầng: **GÓI D** ✅ CHỐT

**Quyết định — biên-theo-vai**: **Go = tầng điều phối** (engine core, agent runtime, hub service) · **Rust = tầng cách ly** (node runtime, driver native, Tauri shell, sandbox host) · **Vue/TS = tầng giao diện**. Điều kiện: (1) **schema-first codegen** cho protocol engine↔node từ ngày 0 — cấm viết tay types hai bên; (2) ngôn ngữ không lan trái vai.

**Án văn chốt**: biên engine↔node là biên protocol lỏng version-hóa (skew N-1 là cơ chế trần → codegen bắt buộc dù cùng ngôn ngữ — chi phí 2 ngôn ngữ thấp hơn vẻ ngoài); biên node↔driver↔Tauri là biên chặt cùng máy → cùng Rust; node = thành phần an ninh nhạy nhất (credential injection, masking) → memory-safety là giá trị thật. **Trục scale/compute-cost (K8s/SaaS)**: Go 1-binary distroless ~20MB, density cao = SaaS cost thấp; **engine stateless-by-design** (state trong log+lease — litmus kill-9 chính là bài test HPA), shard tự nhiên theo (tenant, stream); CPU-burst replay/rebuild là chỗ TS-engine rớt — loại B/C lần cuối.

_Hồ sơ cân nhắc (giữ để truy vết):_

Frontend/SDK-đầu = TypeScript (đã định bởi web charter — không tranh cãi). Câu mở: **engine server + RPA node**. Ba gói trên bàn:

| Gói                        | Cấu hình            | Được                                                                                              | Mất                                                                            |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A _(khuyến nghị hiện tại)_ | Go server + Go node | Một chuỗi type log→engine→node; OCI/sigstore SDK hạng nhất; node 1 static binary; AI viết-soi tốt | Thiếu sum-type — taxonomy mô hình bằng interface + suite bù                    |
| B                          | TS engine + Go node | AI-throughput tối đa ở engine                                                                     | Thuế 2 ngôn ngữ thường trực (protocol types ×2, 2 chuỗi build)                 |
| C                          | TS toàn phần        | Một ngôn ngữ cả nhà                                                                               | Node đóng gói cồng kềnh — đập vào ấn tượng đầu wedge; CPU-burst projection yếu |

Tiền lệ trung thực: n8n = TS toàn phần thành công (nhưng n8n không event-sourced, chi phí khác). **Phạm vi (làm rõ — phòng hiểu nhầm)**: ADR-0003 chỉ chọn ngôn ngữ _viết hạ tầng_ (engine/hub-service/node-runtime) — KHÔNG giới hạn đa-ngôn-ngữ của user: script RPA là artifact _declarative_ (không phải code — RPA NS §5), driver polyglot qua contract, external filler viết bằng bất kỳ ngôn ngữ nào qua SDK/API; custom code block là cánh cửa tương lai qua sandbox + trust class Hub, không bị ADR này đóng. Điểm yếu desktop-automation của Go đã hóa giải: driver được phép polyglot (contract Apache 2.0). 3 câu tự vấn cho owner: thoải mái soi Go? contributor kỳ vọng từ đâu? chỗ nào muốn AI ít sáng tạo nhất? **Small-stack không ảnh hưởng lựa chọn** — cả 3 gói nhúng SQLite/DuckDB tốt.

## ADR-0004 — Frontend: hệ sinh thái Vue ✅ CHỐT

- **Quyết định**: Vue ecosystem cho mọi frontend — Nuxt (site `/`, hub-index `/hub` — nơi cần SSG+ISR), Vue 3 + Vite (console `/app`, canvas pair-design), Storybook Vue (`/design`), Vue Flow (editor node-graph). TypeScript giữ nguyên.
- **Đối chiếu trần**: web charter **framework-agnostic có chủ đích** (§3b: mô hình render là "hệ quả cơ chế, không phải lựa chọn framework") → không đụng trần dòng nào.
- **Tiền lệ mạnh**: n8n xây toàn bộ visual automation editor bằng Vue — đúng bài toán frontend khó nhất của ecoma.
- **2 rủi ro có van**: (1) ISR on-demand của Nuxt/Nitro non hơn Next — yêu cầu charter ở tầng _hành vi cache_, webhook-rebuild-trang-đơn đạt cùng hành vi nếu cần; (2) LLM training data nghiêng React nhẹ — van: design system Storybook + spec-anchor làm nguồn sự thật.
- Không ảnh hưởng ADR-0003 (engine) — độc lập hoàn toàn.

## ADR-0005 — Desktop attended: Tauri + Rust native, kiến trúc tách runtime/UI ✅ CHỐT

- **Quyết định**: app desktop attended = **Tauri** (shell Rust + frontend **Vue** — tái dùng design system `/design` và component console, gồm khung takeover/approve = component diff-Judgment); native **Rust** cho modules desktop cần hệ thống (screen capture, input injection, UIA/AX bindings).
- **Hóa giải xung đột "cùng binary attended/unattended" (RPA NS)**: **node runtime = MỘT binary headless duy nhất chạy cả hai chế độ** — trần giữ nguyên; Tauri là **lớp UI attended đính kèm**, nói chuyện với runtime qua **localhost IPC có auth theo node identity**. Unattended không cài webview. Cả hai artifact update qua Hub.
- **Sửa cụm từ**: bản trước viết _"khung takeover/approve = component diff-Judgment"_, **gộp nhầm hai thứ khác loại**. Tách: (1) **xác nhận trong phiên attended** — người đang ngồi trước máy, cho phép một Action sắp làm; đây là **điều khiển phiên cục bộ**, đi kênh nội-máy, thuộc **◆G1**, có ở M1; (2) **duyệt một Action Item trong hàng đợi** — người không ngồi trước máy đó; đây là **bề mặt lao động**, đi thẳng engine API + projection read-API, thuộc **◆G4**, thuộc Track E. Tauri ở M1 **chỉ làm (1)**.
- **Ba biên cứng do trần khai** — RPA NS §4 "Lớp UI attended cục bộ": (1) IPC **chỉ mang điều khiển phiên cục bộ**, không mang effect stream, không mang ngữ nghĩa lao động ⇒ hai giao diện của hệ vẫn là hai (D1); (2) **mọi hành động lao động của UI (approve / Judgment / claim / release) đi THẲNG engine API** — component diff-Judgment của Tauri là **client của projection read-API (◆G4)**, không phải đường ghi qua IPC (Human Surface §0); (3) UI **không lưu frame** — thứ vào log luôn là Scene đã masking. Kiểm bằng RPA NS litmus **#10** (tắt IPC → runtime chạy đủ). _Hệ quả xếp lịch_: Track B nhận thêm cổng ◆G4 cho phần bề mặt duyệt (roadmap §1b luật #8).
- **Rust scope**: desktop-shell + driver-native _(mở rộng theo Gói D — thêm node runtime + sandbox host, biên-theo-vai)_ (rơi đúng van **driver polyglot** trần đã mở — contract Apache 2.0); **không lan vào tầng điều phối** — nếu lan, đội n=1+AI gánh 3 ngôn ngữ ở lõi.
- **Rủi ro có van**: webview parity 3 OS (WebView2/WKWebView/WebKitGTK) → QA attended theo OS trong CI nightly; IPC chỉ bind localhost + token node identity, không mở cổng.
- Không ràng buộc ADR-0003 (engine) — desktop-native ngả Rust ở lớp shell không quyết ngôn ngữ engine/node-runtime.

## ADR-0006 — User-code đa runtime: tối thiểu JS/TS + Python + Go ✅ CHỐT

- **Cam kết**: mọi cửa user-code chạy TRONG hệ (execution sandbox — rule filler code, tool exec, custom code block) hỗ trợ **taxonomy runtime MỞ, tối thiểu 3**: **JS/TS** (phổ biến + LLM tốt), **Python** (LLM tốt + token gọn — quan trọng vì người viết code block nhiều nhất về lâu dài là AI Drafter → token = chi phí vận hành trực tiếp), **Go** (hiệu năng/concurrency). **Rust: không cam kết** — cửa driver/extension polyglot đã phục vụ nhu cầu đó; thêm runtime sau = thêm adapter (K4), không đổi cơ chế.
- **Điều kiện cứng**: **Python native-runtime trong sandbox, CẤM đường Pyodide/WASM** — án văn: C-extensions (numpy/pandas/requests) vỡ trên WASM; tiền lệ 2 chiều: n8n Python-Pyodide bị chê, Dify Python-native thắng.
- **Cơ chế**: sandbox executor theo hình thái (nhất quán ADR-0002): nhỏ = process-isolation; K8s/SaaS = container/microVM pool (gVisor/Firecracker — K8s runtime class). **Runtime image = artifact có version phân phối qua Hub** (trust class); **mỗi code block = filler có identity → calibration bám như mọi filler** — đối xứng giữ trọn, 0 cơ chế mới.
- **Thứ tự ship**: JS/TS → Python → Go (theo phễu: wedge dev-solo → AI crowd → power user). Milestone do spec `runtime sandbox` (Track S) quyết, và spec đó đã mang nó — ADR này là ràng buộc đầu vào của spec đó.

## ADR-0007 — VitePress cho bề mặt doctrine

**Bối cảnh**: bộ trần được công bố cần một bề mặt tĩnh, mount tại `ecoma.io/doctrine`, đọc `shared/libs/doctrine` lúc build. Đây là **mệnh lệnh công nghệ** nên phải là ADR, không được lẻn vào một PR code (playbook giao hàng (không công bố) §5c).

**Quyết định**: **VitePress**.

**Án văn** — ba ràng buộc đã có, không phải sở thích:

| Ràng buộc đã tồn tại                                                                                                      | VitePress trả thế nào                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **ADR-0004 chốt frontend Vue**; toolchain đã là Vite; `core-ui` là Vue + Tailwind v4 qua Vite                             | Vue-native, chạy trên chính Vite của workspace — không thêm một runtime frontend thứ hai vào repo               |
| Web charter §3b: `/design` là **SSG theo release**; doctrine cùng lớp (nội dung đổi theo lần cắt tag, không theo sự kiện) | SSG mặc định; không cần ISR, không cần server                                                                   |
| Nội dung là **markdown thuần**, và nav phải **dẫn xuất** (Rule 14) chứ không liệt tay                                     | Config là TypeScript ⇒ `import { buildNav } from "@ecoma-io/doctrine"` là cạnh Nx thật, `nx affected` nhìn thấy |

**Các phương án bị bác, bằng cơ chế**:

| Phương án                        | Vì sao không                                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Docusaurus / Starlight**       | Kéo React (hoặc Astro) vào một workspace đã chốt Vue — hai hệ component cho hai bề mặt tài liệu (`/design` Storybook-Vue, `/doctrine` React) là **hai nhà cho cùng một loại việc** |
| **Nhét vào Storybook `/design`** | Storybook render **design system**; doctrine là văn bản. Gộp lại thì một trong hai phải giả vờ là loại kia, và `check-e2e-story-coverage` sẽ đo sai thứ                            |
| **Tự viết SSG**                  | Rule 2 — nấc thang đơn giản: có thư viện làm đúng việc này, tự viết là nợ vận hành vĩnh viễn đổi lấy 0 năng lực                                                                    |

**Chi phí đã khai**: thêm một dependency lớn; theme mặc định của VitePress không dùng token của `core-ui`, nên bề mặt doctrine sẽ **không** giống hệt `/design` cho tới khi (và nếu) ta viết theme riêng. Chấp nhận: doctrine là văn bản để đọc, không phải sản phẩm để bán — thống nhất thương hiệu ở đây là mong muốn, không phải cơ chế.

**Điều kiện đảo ngược**: nội dung là markdown thuần và nav là hàm thuần trong `shared/libs/doctrine`; đổi SSG = viết lại một app, **không** đụng một dòng nội dung nào. Đây là lý do lib tách khỏi app ngay từ đầu.

- **Điều kiện `supports_dry_run`**: mọi adapter/sandbox executor **khai được năng lực `dry_run`** (chạy nhưng không phát effect ra ngoài) hoặc khai **không hỗ trợ** — thiếu khai/không hỗ trợ thì contract `dry_run` resolve về `forbidden` (Handoff §3, Test Harness §5). Ràng buộc đầu vào của spec `runtime sandbox`.
- Chi phí SaaS: code-exec = CPU đo được → metering (M0) + quota (spec treo) ôm trọn.

## Nhật ký

| ADR                                                                                                                 | Trạng thái      |
| ------------------------------------------------------------------------------------------------------------------- | --------------- |
| 0001 durable execution                                                                                              | ✅ chốt         |
| 0002 storage ports + default-theo-hình-thái                                                                         | ✅ chốt         |
| 0003 ngôn ngữ hạ tầng — Gói D biên-theo-vai                                                                         | ✅ chốt         |
| 0004 frontend Vue                                                                                                   | ✅ chốt (owner) |
| 0005 desktop Tauri+Rust (tách runtime/UI)                                                                           | ✅ chốt (owner) |
| 0006 user-code đa runtime (JS/TS·Python·Go, Python-native)                                                          | ✅ chốt         |
| **0007 VitePress cho bề mặt doctrine**                                                                              | ✅ chốt         |
| 0005 bổ sung 3 biên cứng của lớp UI attended · 0002 điều kiện key-store backend · 0006 điều kiện `supports_dry_run` | ✅ ghi nhận     |
