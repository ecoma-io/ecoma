---
title: "ADR-0008 — Cấu trúc subsystem"
status: design-end-state
gate: G0
frozen-scope: "§4 phạm vi các suite; các boundary rule của §3 và bản kiểm kê project của §2 là phần hiện thực hóa, không phải phần đóng băng"
canonical-sha: da4f71de5af6
---

# ADR-0008 — Cấu trúc subsystem

> **Trạng thái freeze.** Tài liệu này mang freeze ◆G0 cùng với những tài liệu
> giữ chính các giao diện — schema entry của Event Log, giao diện CAS của
> Artifact Store, Lease của Working Data và Principal của Tenant & Identity. Nó
> **không** mở rộng cái mà ◆G0 đóng băng (roadmap §1b giữ nguyên định nghĩa
> đó); nó trả lời cái nửa của luật #7 mà một văn bản đơn thuần không trả lời
> được: **suite nào trọng tài cổng này, và phạm vi trọn vẹn của suite đó là
> gì.** Việc lật `status: frozen` là một hành vi riêng, land trong pull request
> làm `conformance-g0` xanh — đóng băng trước khi suite tồn tại chính là cái
> "cổng giấy" mà luật #7 gọi tên, và executor sẽ fail nó.

## 1. Quyết định

Area Platform mọc lên thành thư mục top-level `platform/`, chứa `apps/` và
`libs/`. Engine của nó được cắt theo trục tầng hexagonal thay vì theo feature,
mỗi gate đã khởi động có đúng một conformance suite, và contract runtime
liên-domain sống ngoài mọi domain, trong `shared/packages/`.

**Về từ vựng area.** Thư mục top-level là area (North Star §8), và tập hợp
này là **mở** chứ không phải bộ ba Platform · RPA · Hub: `website/` đã là area
thứ tư trong cây. Ba tầng một area _được phép_ chứa — `apps/`, `libs/`,
`packages/` — là một từ vựng, không phải mệnh lệnh tạo đủ cả ba: `website/`
chỉ có `apps/`, và `platform/` sinh ra với `apps/` và `libs/`. Nó có
`packages/` khi có một đơn vị mà bên thứ ba nhận, và không sớm hơn.

## 2. Các project — phần hiện thực hóa, không phải phần đóng băng

Chỉ liệt kê project **mới**. Đã giao và không bị quyết định này đụng tới:
Storybook `/design` và `core-ui` (roadmap E.3), cây doctrine cùng site của nó,
area `website/`, và bộ tooling của workspace.

| Project             | Đường dẫn                          | Ngôn ngữ              | Tags                                                                    | Sinh tại   |
| ------------------- | ---------------------------------- | --------------------- | ----------------------------------------------------------------------- | ---------- |
| `engine-domain`     | `platform/libs/engine-domain`      | Go                    | `type:lib` `scope:platform` `license:sul` `layer:domain`                | Tầng 0     |
| `engine-ports`      | `platform/libs/engine-ports`       | Go                    | `type:lib` `scope:platform` `license:sul` `layer:port`                  | Tầng 0     |
| `engine-adapters`   | `platform/libs/engine-adapters`    | Go                    | `type:lib` `scope:platform` `license:sul` `layer:adapter`               | Tầng 0     |
| `conformance-g0`    | `platform/libs/conformance-g0`     | Go                    | `type:lib` `scope:platform` `license:sul` `gate:G0`                     | Tầng 0     |
| `runtime-protocol`  | `shared/packages/runtime-protocol` | schema + Go           | `type:lib` `scope:shared` `license:apache` `layer:port`                 | ◆G1        |
| `conformance-g1`    | `platform/libs/conformance-g1`     | Go                    | `type:lib` `scope:platform` `license:sul` `gate:G1`                     | ◆G1        |
| `engine`            | `platform/libs/engine`             | Go                    | `type:lib` `scope:platform` `license:sul` `layer:app`                   | ◆G1        |
| `engine-server`     | `platform/apps/engine-server`      | Go                    | `type:app` `scope:platform` `license:sul` — **không mang tag `layer:`** | ◆G3        |
| `conformance-g3`    | `platform/libs/conformance-g3`     | Go                    | `type:lib` `scope:platform` `license:sul` `gate:G3`                     | ◆G3        |
| `conformance-g4`    | `platform/libs/conformance-g4`     | Go                    | `type:lib` `scope:platform` `license:sul` `gate:G4`                     | ◆G4        |
| `read-api-contract` | `platform/libs/read-api-contract`  | TypeScript, sinh code | `type:lib` `scope:platform` `license:sul` `layer:domain`                | ◆G4 bước 1 |
| `human-surface`     | `platform/libs/human-surface`      | Vue/TS                | `type:lib` `scope:platform` `license:sul` `layer:view`                  | ◆G4        |
| `work-surface`      | `platform/apps/work-surface`       | Vue/TS                | `type:app` `scope:platform` `license:sul` — **không mang tag `layer:`** | ◆G4        |
| `work-surface-e2e`  | `platform/apps/work-surface-e2e`   | TS/Playwright         | `type:e2e` `scope:platform` `license:sul`                               | ◆G4        |

`conformance-g2` vắng mặt có chủ ý: Track D chưa khởi động, và executor coi một
gate chưa ai bắt đầu là một trạng thái chứ không phải một fault.

**Ba project không mang tag `layer:`, mỗi cái vì một lý do và không cái nào là
gọn gàng.** `engine-server` là composition root — nó ráp adapter vào port, thứ
mà `layer:app` cấm thẳng, nên gán tag đó là giết chính project có nhiệm vụ ráp.
`work-surface` cùng hình dạng ấy ở phía Vue. Một suite `conformance-*` phải với
tới adapter để chạy contract của port trên cả hai stack, nên bất kỳ tag tầng
nào cũng cấm đúng việc nó sinh ra để làm.

## 3. Các boundary rule

1. **Một area là một thư mục top-level.** Tag scope của nó được tạo trong chính
   thay đổi land project đầu tiên của nó, không bao giờ tạo trước để chờ.
2. **Một library mang nhiều nhất một tầng**, và chiều là
   util → domain → port → adapter → view → app. `layer:app` không bao giờ import
   một adapter; composition root, thứ có import, không mang tag tầng.
3. **Một domain không bao giờ import domain khác.** Một contract hai domain
   dùng chung sống ngoài cả hai, dưới `shared/packages/`, license Apache 2.0 —
   và đó cũng là nhà duy nhất mà cả `scope:platform` lẫn một `scope:rpa` tương
   lai được phép phụ thuộc.
4. **Chiều license là một chiều**: SUL được tiêu thụ Apache, Apache chỉ được
   tiêu thụ Apache. Một schema mà bindings của nó là Apache thì bản thân nó
   phải là Apache, nên schema của node protocol sống cùng bindings thay vì nằm
   trong server.
5. **Từ vựng domain và contract trên dây là hai thứ khác nhau.** `engine-domain`
   sở hữu khái niệm Filler; `runtime-protocol` sở hữu contract trên dây của
   Filler; `engine` ánh xạ giữa hai bên. `engine-domain` không bao giờ import
   protocol — `layer:domain` chỉ được với tới domain và util, và hạn chế đó là
   luật, không phải tai nạn của việc gán tag.
6. **Một suite không bao giờ sống bên trong project nó trọng tài.**
7. **Tăng trưởng là additive và mọi sự trì hoãn đều đặt tên seam của nó** (§7).

## 4. Các cổng, freeze của chúng và suite của chúng

### 4.1 Cái gì mang mỗi freeze

Văn bản freeze của ◆G0 là của roadmap §1b, không đổi: schema entry của Event Log
cộng các giao diện subsystem. Nó được năm tài liệu mang, mỗi tài liệu khai
`status: frozen`, `gate: G0` và phần của chính nó bị đóng băng:

| Tài liệu                  | `frozen-scope`                              |
| ------------------------- | ------------------------------------------- |
| `spec/event-log.md`       | schema entry                                |
| `spec/artifact-store.md`  | giao diện CAS `put / get / exists / delete` |
| `spec/working-data.md`    | §3 Lease                                    |
| `spec/tenant-identity.md` | §1 Principal                                |
| chính tài liệu này        | §4                                          |

Các bản dịch của một tài liệu đã đóng băng mirror đủ frontmatter freeze —
`status`, `gate` và `frozen-scope` — bởi executor quét **mọi** file Markdown
trong cây doctrine, bản dịch hay bản canonical như nhau: một bản dịch bị bỏ lại
sẽ hoặc mâu thuẫn với canonical của nó về một sự kiện, hoặc làm executor fault.
Vì vậy sổ đếm cả canonical lẫn bản dịch.

### 4.2 Phạm vi suite, chốt tại lúc freeze

Phạm vi của một suite là một phần của cái được đóng băng — suite của một gate
được version hóa cùng gate, và đổi nó là breaking — nên nó được viết ở đây trọn
vẹn thay vì được phát hiện dần về sau. Tăng trưởng **sau** freeze là breaking;
tăng trưởng đã khai ở đây thì không.

| Suite            | Phạm vi, trọn vẹn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conformance-g0` | (1) schema entry của Event Log — các trường bắt buộc, khóa thứ tự, phân loại entry, các trường crypto-shred; (2) contract của port log-store trên stack reference (Postgres) và small stack (SQLite); (3) contract blob-CAS `put / get / exists / delete` trên **cả hai** backend blob — filesystem store mà small stack ship và S3-compatible store mà stack reference ship; (4) contract Lease — acquire, renew, hết hạn, TTL bắt buộc, và việc không tồn tại lock nào ngoài nó; (5) Principal identity — schema principal và phạm vi tenant của nó. Không gì khác, không bao giờ, dưới cổng này |
| `conformance-g1` | giao diện Filler và effect Session, drive qua bindings `runtime-protocol` sinh ra, với một internal filler và một external filler stub trên cùng một đường                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `conformance-g3` | **pha một, đóng băng khi M0 có nó chạy**: Trigger — đủ mọi type đã bật (webhook, schedule, manual, form) cộng `response_mode: sync`, black-box qua HTTP. **pha hai, khai ngay bây giờ và tới khi M2 mở**: Channel, Party và external filler                                                                                                                                                                                                                                                                                                                                                        |
| `conformance-g4` | read-API projection, black-box qua HTTP, cộng contract TypeScript sinh ra khớp với schema nó được sinh từ đó                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Về backend blob.** ADR-0002 gọi tên một blob store trong cả hai stack nhưng
không nói mỗi stack ship backend nào; spec Artifact Store liệt kê filesystem,
S3-compatible và cloud blob là họ adapter. Quyết định này gán chúng: small stack
ship filesystem store, stack reference ship S3-compatible store, và **cả hai
adapter tồn tại từ Tầng 0** để contract CAS chạy trên backend thật thay vì một
backend đeo hai cái tên.

### 4.3 Trọng tài không phải trọng tài của gate

Exit litmus của M0 gọi tên hành vi storage-port mà ◆G0 không đóng băng: SQL-read,
metrics-projection và key-store. Chúng có nhà đặt tên rõ và **cố ý không** có
target `conformance` — luật của executor là một suite trọng tài một gate có tên
hoặc không trọng tài gì cả, còn những thứ này trọng tài một litmus của milestone
(§1b luật #2 đo exit tại điểm hợp lưu, không tại một gate). Theo ADR-0002, mỗi
contract port dưới đây chạy trên **cả** stack reference lẫn small stack.

| Trọng tài                                                                                            | Nhà               | Target                           |
| ---------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------- |
| contract port SQL-read, cả hai stack                                                                 | `engine-adapters` | `test` (`*_integration_test.go`) |
| contract port metrics-projection, cả hai stack                                                       | `engine-adapters` | `test`                           |
| contract key-store, gồm cả sự từ chối mà ADR-0002 đòi khi `destroy` không phải là không-thể-phục-hồi | `engine-adapters` | `test`                           |
| `kill -9` giữa chừng rồi replay; metering và cost projection dựng lại từ log                         | `engine-server`   | `test` (`*_integration_test.go`) |

Hàng cuối là chỗ đề xuất buộc phải dời: những test đó cần adapter thật, mà
`engine` là `layer:app`, thứ không được chạm adapter. Composition root là nhà duy
nhất không làm mờ ranh giới.

`conformance-g0` là **self-hosting** — nó drive port và adapter trực tiếp và
không phụ thuộc application service nào, bởi nó phải chạy tại ◆G0, trước khi
`engine` tồn tại. Test harness với tới các cổng bằng hai nửa: nửa executor là
`dev-cli conformance` và đã tồn tại; chế độ `run_kind: test` của engine tới cùng
`engine` tại ◆G1 và phục vụ các cổng sau.

## 5. Nhà của schema và chiều license

| Schema                                                                          | Nhà                                    | License    | Sinh ra                                           |
| ------------------------------------------------------------------------------- | -------------------------------------- | ---------- | ------------------------------------------------- |
| HTTP API — command API, read-API projection, BaaS sync, webhook và form ingress | `platform/apps/engine-server/openapi/` | SUL        | type Go phía server; contract TypeScript bên dưới |
| Node protocol — giao diện Filler và effect Session                              | `shared/packages/runtime-protocol/`    | Apache 2.0 | bindings Go, trong cùng package                   |

Hai tài liệu, một format (OpenAPI 3.1, REST/JSON). Chúng không gộp vì chiều
license cấm: bindings của node protocol là thứ bên thứ ba nhận dưới Apache 2.0,
và một schema giữ trong server SUL sẽ biến chúng thành phái sinh của văn bản
SUL; còn đưa trọn bề mặt API sản phẩm vào package Apache thì lại là cho không
contract của server.

**Bản TypeScript sinh ra của read-API** là `read-api-contract`: một library
`layer:domain` chứa type sinh code, tạo bởi chính target `codegen` của nó từ
`platform/apps/engine-server/openapi/`, với output **được commit**. Ba hệ quả,
mỗi cái đều chịu lực: một library `layer:view` được phép import domain nên
`human-surface` được contract gán type mà không cần một type viết tay phía
client; output đã commit nghĩa là không có phụ thuộc build-time từ một project
Vue lên một application Go; và cạnh schema-tới-client được khai bằng một mục
`implicitDependencies` trên `engine-server` để `nx affected` sinh lại khi schema
đổi — một cạnh của graph, không phải một import, và đó là lý do nó không vượt
ranh giới `type:lib`. Target `codegen` chạy ở **bước 1 của ◆G4**, trước dòng đầu
tiên của `human-surface` hay `work-surface`.

## 6. Cái gì máy giữ, và cái gì chỉ review giữ

Một lần chạy xanh không được ngụ ý nhiều hơn cái nó đã kiểm.

| Luật                                                                                                                                                                | Ai giữ                                                | Nấc                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| mọi project khai một tag `type:`, `scope:`, `license:`                                                                                                              | `require-project-tags` và `check-project-conventions` | máy                                          |
| tag `license:` khớp đường dẫn; một carve-out mang LICENSE riêng                                                                                                     | `license-scope` qua `check-project-conventions`       | máy                                          |
| chiều import qua trục tầng và license, **chỉ TypeScript và Vue**                                                                                                    | `@nx/enforce-module-boundaries`                       | máy                                          |
| chiều import qua trục tầng và license, **Go**                                                                                                                       | không gì parse Go                                     | **chỉ review**                               |
| seam giữa các primitive bên trong `engine-domain`                                                                                                                   | không gì                                              | **chỉ review**                               |
| một suite gọi tên một gate; một freeze gọi tên một gate; một gate đã đóng băng có suite                                                                             | `dev-cli conformance`                                 | máy                                          |
| từ vựng của trục `gate:` — `require-project-tags` chỉ soi năm prefix nó biết, nên một tag gate viết sai chính tả lọt im lặng; chỉ executor conformance đọc trục này | không gì                                              | **chỉ review**                               |
| **đúng một** tag `gate:G#` trên một suite                                                                                                                           | `dev-cli conformance`                                 | máy                                          |
| `frozen-scope` còn mô tả đúng văn bản đã đóng băng                                                                                                                  | không dòng code nào đọc trường này, kể cả để in ra    | **chỉ review**                               |
| cạnh liên-project Go, Rust và Python cho `nx affected`                                                                                                              | `nx-polyglot-graph`                                   | máy cho affectedness, không gì cho ranh giới |

Mọi library quyết định này tạo ở Tầng 0 đều là Go. **Trục tầng vì thế là
review-enforced cho toàn bộ engine**, và một pull request đụng vào nó phải nói
thẳng ra thay vì để một lần chạy xanh ngụ ý điều ngược lại.

## 7. Các seam đã đặt tên

| Bị hoãn                                                                                       | Seam, đặt tên ngay bây giờ                                                                                                                                                                                                              | Tới khi                                             |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| port vector — M0 khai thẳng "không có module Knowledge, Memory hay DataTable" (roadmap §4 M0) | `engine-ports/vector` cộng adapter của nó và case của nó trong test contract của storage port                                                                                                                                           | M3, cùng Knowledge — người tiêu thụ đầu tiên của nó |
| tách `engine-domain`                                                                          | ranh giới package Go: `eventlog`, `role`, `task`, `checkpoint`, `handoff`, `escalation`, `calibration`, `composition`, `tenant`, `lease`, `keytree`, `artifact`. Một lần tách nâng một package thành một library giữ nguyên import path | khi một package có người tiêu thụ độc lập           |
| một client read-API thứ hai (bề mặt diff-Judgment của UI attended, ADR-0005)                  | `platform/libs/read-api-client`, `layer:adapter`, sinh từ cùng schema                                                                                                                                                                   | khi người tiêu thụ thứ hai đó tồn tại               |
| công bố contract read-API cho bên thứ ba                                                      | nó chuyển sang `platform/packages/`, license Apache 2.0, dưới release train                                                                                                                                                             | khi có lời hứa cho một người tiêu thụ bên ngoài     |
| `conformance-g2`                                                                              | project được tạo khi Track D khởi động                                                                                                                                                                                                  | M4                                                  |

**Một danh sách được đính chính — mười hai package, không phải mười một.** Bản
liệt kê ban đầu bỏ sót `artifact`, package giữ content address `sha256:<digest>`
mà payload của một entry Event Log mang khi bytes nằm trong Artifact Store (Event
Log §1, Artifact Store §1). Bỏ sót đó không phải một quyết định: Artifact Store là
subsystem tầng 0 mà chính tài liệu này đã gate ở ◆G0, và address của nó là từ vựng
domain mà schema entry không thể viết ra nếu thiếu. Không có gì về seam thay đổi —
một package vẫn được nâng thành library giữ nguyên import path — chỉ là danh sách
nay đã đủ. Đây là §7, nằm ngoài `frozen-scope` `§4` ở trên, nên hoàn thiện nó không
nới rộng đóng băng nào.

## 8. Những câu hỏi quyết định này chốt

- **Q1** `runtime-protocol` được tạo tại ◆G1, cùng `shared/packages/LICENSE`
  trong cùng một thay đổi.
- **Q2** tách: một schema HTTP API (SUL, trong server) và một schema node
  protocol (Apache, trong package), cả hai OpenAPI 3.1.
- **Q3** port vector hoãn tới M3 sau seam đặt tên ở §7.
- **Q4** một suite cho mỗi gate đã khởi động, không gộp; cộng các trọng tài
  không-phải-gate ở §4.3, vốn là test thường theo cơ chế chứ không theo sở thích.
- **Q5** `human-surface` là library riêng; canvas pair-design là library view thứ
  hai trên cùng trục, không phải lý do để gộp cái này.
- **Q6** bề mặt là **Work Surface**. "console at `/app`" của ADR-0004 và
  "console components" của ADR-0005 được sửa trong lượt này.
- **Q7** REST/JSON.
- **Q8** `work-surface-e2e` là project e2e duy nhất tại M0; bốn câu litmus của
  North Star là integration test Go trong `engine-server`.

## 9. Non-goal

Quyết định này không chọn HTTP framework, không chọn layout module Go dưới mức
package, không chọn schema lưu trữ projection, không chọn topology CI. Nó không
đặt tên area RPA hay Hub — mỗi cái được tạo bởi thay đổi land project đầu tiên
của nó. Nó không mở rộng ◆G0.
