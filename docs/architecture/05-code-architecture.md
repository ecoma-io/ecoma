# 05 — Code Architecture

> **Phạm vi:** Nx project taxonomy, Bounded Context trong code, DDD layer structure, dependency direction, contract project
> và architecture enforcement.
> Không chứa: topology, data ownership, invariant → `01-architecture.md` · CI/CD, migration, cách chạy test → `02-delivery.md` ·
> kiến trúc test → `06-testing.md` · catalog bounded context, context map, ngôn ngữ domain → `README.md` ·
> design chi tiết của một service → `applications/<name>/`.

---

## 1. Principles

1. **Bounded Context first, layer second.** `libs/<bc>-*` là coding structure của một bounded context: layer là hậu tố của thư mục đó, không phải cây thư mục riêng. Bounded context chỉ là khái niệm code cho `libs/<bc>-*` — `apps/`, `system-tests/`, `docs/` không phải bounded context.
2. **`apps/` là runtime / composition / deploy boundary.** Mỗi app là composition root và là deploy unit độc lập.
3. **Business logic thuộc `libs/`.** App wire library lại với nhau; app không chứa domain logic.
4. **`libs/` giữ flat.** Không có nested directory và không có generic cross-domain layer.
5. **Không có generic `libs/domain`, `libs/application`, `libs/infrastructure`, `libs/contracts`.** Domain model của một context
   không được dùng chung bởi context khác.
6. **Một Bounded Context sở hữu code của chính nó.** Consumer đi qua contract, không import implementation của provider.

## 2. Canonical Nx structure

```text
apps/
  <runtime-project>              # Worker / web / composition root của một deploy unit runtime
    tests/
      integrations/ contracts/ databases/ browser/   # purpose subdirs, chi tiết → 06-testing.md

deploys/
  platform-deploy                # tầng platform hạ tầng mà mọi deployment project khác phụ thuộc
  <unit>-deploy                  # Pulumi deployment project của một deploy unit

libs/
  <bc>-domain                    # entities · value objects · domain services · domain errors
  <bc>-application               # use cases · ports · orchestration
  <bc>-infrastructure            # adapters · repositories · external clients
  <bc>-contracts                 # boundary artifact, KHÔNG phải DDD layer

system-tests/                    # mỗi suite executable là một Nx project riêng
  e2e/                           # system E2E liên dịch vụ
  performance/
  resilience/
  smoke/
```

`libs/<bc>-*` và `deploys/<unit>-deploy` là naming convention canonical; mục đích từng thư mục test và target contract của
từng tầng test → [`06-testing.md`](./06-testing.md).

```text
✗  libs/domain            libs/application            libs/contracts
✗  libs/<bc>/domain       libs/<bc>/application        libs/<bc>/infrastructure
```

Bounded Context **không** bắt buộc có đủ 4 library. Chỉ tạo layer khi context thực sự cần layer đó; một `-contracts` chỉ tồn tại
khi context đó có boundary thật sự với bên ngoài.

### 2.1 Nhóm deployment — `deploys/`

`deploys/` là nhóm project **thứ hai** cạnh `apps/`, và nó **không** phải một bounded context: `deploys/` không chứa domain
logic, use case hay adapter — nó chứa **Pulumi deployment project**, tức phần khai báo cách một deploy unit được
provision.

| Project                 | Sở hữu việc gì                                                            |
| ----------------------- | ------------------------------------------------------------------------- |
| `platform-deploy`       | Tài nguyên hạ tầng dùng chung cho mọi deploy unit của một environment     |
| `deploys/<unit>-deploy` | Tài nguyên hạ tầng riêng của một deploy unit; phụ thuộc `platform-deploy` |

**Bản đồ ownership canonical.** Câu hỏi "app/runtime này do deployment unit nào sở hữu" có đúng một nguồn sự thật:
`DEPLOYMENT_MAP` trong `tools/dx/src/architecture/deployment-map.ts` — mỗi app trong `apps/` đúng một entry
(`owner`, `status: implemented | scaffold | absorbed | none`), kèm entry `platform-deploy` loại `platform`
(prerequisite, không owner app nào). Quy tắc cấu trúc đi kèm: `apps/` chỉ chứa project có đường triển khai
production — bây giờ hoặc theo kế hoạch (status `implemented`/`scaffold`); project local-only/internal-only
(shim, worker chỉ chạy trong topology local platform, script nội bộ) sống ở `tools/` và không thuộc bản đồ
(vd `tools/account-bridge` được provision bên trong `auth-deploy`). Trường hợp đặc biệt còn lại trong `apps/`:
`apps/auth-nonce-prune-job` không có deploy project (cron Worker, wrangler-only — `none`); entry
`absorbed`/`none` bắt buộc có `reason`. Đối chiếu
hai chiều với đĩa: mỗi `deploys/<unit>-deploy` mang marker machine-readable `ecoma.deployment.status`
(`implemented`/`scaffold`) trong `package.json`, và `pnpm dx arch-check` fail khi marker lệch map, owner trỏ
project không tồn tại, deploy project không sở hữu app nào, hoặc map thiếu/thừa entry so với `apps/`.

**Ranh giới provisioning ↔ application release.** Đây là ranh giới quan trọng nhất của nhóm này, và nó **không** nằm ở
tầng code mà ở tầng vòng đời:

- **Provisioning** (Pulumi, project trong `deploys/`) **tạo/cập nhật/xoá tài nguyên hạ tầng**: Worker identity, binding,
  D1/KV/R2/Queue, DNS, Hyperdrive. Nó **không** build, **không** version, **không** phát hành release.
- **Application release** (Nx Release + Wrangler, project trong `apps/`) **build và deploy Worker version**. Nó
  **không** tạo tài nguyên hạ tầng.
- **Database migration** (migration runner, CI job) áp schema; nó là **chủ sở hữu thứ ba**, không thuộc cả hai vế trên.

Một application release **không** chạy `pulumi up`: đổi hạ tầng và phát hành ứng dụng là hai workflow tách biệt, với
ownership tách biệt → bảng sở hữu từng loại resource ở `02-delivery.md` §9.1.

**Prerequisite platform.** Mọi `deploys/<unit>-deploy` **bắt buộc** phụ thuộc `platform-deploy`, và đó là hướng phụ thuộc
được phép duy nhất giữa các deployment project. `platform-deploy` **không** được phụ thuộc ngược lại bất kỳ
`deploys/<unit>-deploy` nào — nếu không, tầng platform sẽ kéo theo vòng đời của từng deploy unit và platform prerequisite
biến thành cycle. Cấm luôn cả edge giữa hai deployment unit khác nhau: một deploy unit phụ thuộc deploy unit khác là cách duy
nhất để hai stack Pulumi trở thành một chu trình lifecycle, nên `validateDeploymentGraph` (`tools/dx/src/architecture/arch-tags.ts`) báo
`cross-unit-deploy-dependency`.

⚠️ **Bất biến vị trí ⇔ tag.** Một project đặt trong `deploys/` phải mang `type:deployment`, và một project mang
`type:deployment` phải đặt trong `deploys/`. Nếu chỉ kiểm tag thì `deploys/` chỉ là quy ước đặt tên: một project trong
`deploys/` mà gắn tag khác sẽ đi vòng qua mọi lượt kiểm deployment. Lượt này (`misplaced-deployment-project`) là duy nhất có
thể nhìn thấy điều đó, và nó chạy trước mọi lượt khác trong `validateDeploymentGraph`.

⚠️ **Phụ thuộc trên Nx project graph ≠ thứ tự chạy task.** Khai `platform-deploy` là prerequisite là khai quan hệ trên
**project graph** — nó cho biết cái gì phụ thuộc cái gì, và là điều kiện để kiểm tra được trước khi apply. Nó **không** tự
sắp thứ tự `pulumi up` giữa các stack. Thứ tự thực thi, approval, và việc reconcile bao nhiêu stack trong một lần chạy là
**execution contract** của workflow, và nó **chưa** được hiện thực (`02-delivery.md` §7.4.1 · §12). Đừng đọc quan hệ
project graph thành một cam kết về thứ tự.

**Sai lệch cần biết:** tag `type:deployment` (dưới đây) phân biệt deployment project với **adapter implementation**, chứ
không phân biệt deployment project với **infrastructure adapter của một service**. `platform-deploy` và một
`deploys/<unit>-deploy` thuộc trục _deployment_; `libs/<bc>-infrastructure` thuộc trục _implementation trong ứng dụng_. Deploy
project không import implementation của service, và service không import deploy project — dependency đi một chiều từ
deployment sang **khai báo nhu cầu hạ tầng**, không phải sang code ứng dụng.

## 3. Dependency direction

Mũi tên `↑` = "phụ thuộc vào" — project ở dưới phụ thuộc project ở trên:

```text
<bc>-domain
    ↑
<bc>-application
    ↑
<bc>-infrastructure
```

`apps/<runtime-project>` là composition root: nó **phụ thuộc các library cần thiết** để compose context, không nằm trong chuỗi
phụ thuộc nội bộ của một context.

| Project                 | Được phụ thuộc                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| `<bc>-domain`           | Không `application`, không `infrastructure`, không Nx project khác |
| `<bc>-application`      | `<bc>-domain`                                                      |
| `<bc>-infrastructure`   | `<bc>-application`, `<bc>-domain`                                  |
| runtime / app           | Library của các context mà nó compose                              |
| `deploys/<unit>-deploy` | `platform-deploy` — không phụ thuộc `apps/` hay `libs/`            |
| `platform-deploy`       | Không `deploys/<unit>-deploy`, không `apps/`/`libs/`               |
| service A               | **Không** import implementation của service B                      |
| service B               | Chỉ qua boundary / interface / contract được phép của B            |

`<bc>-contracts` đứng ngoài chuỗi này: nó là artifact mà provider **publish** và consumer **depend on**, không phải một tầng để
import theo hướng trên.

**Lib deployment dùng chung — `libs/deployment` (`@ecoma-io/deployment`, `type:tooling` + `scope:shared` +
`runtime:native`).** Helper/contract lifecycle local mà nhiều deploy unit cùng dùng (entry foundation:
resolve context/passphrase, `pulumi up`/`destroy` với config chuẩn lane; namespace + ownership labels;
contract outputs; secret primitives dùng chung; shell/SQL quoting) sống ở lib này. `deploys/*` và `tools/dx`
import nó qua TÊN PACKAGE (workspace dependency, không import tương đối); ranh giới là MỘT CHIỀU — lib
KHÔNG được import `tools/dx` hay `deploys/*` (contract test của lib chặn), còn `deploys/*` KHÔNG được
import `tools/dx`. Code lifecycle chỉ có MỘT consumer sống ngay tại owner của nó (vd `platform-down` +
xoá volume PostgreSQL ở `deploys/platform-deploy`, smoke script ở `system-tests/local-smoke`); lib không
nhận code chỉ để cho import compile. Cạnh `deploys/* → libs/deployment` không nằm trong
`validateDeploymentGraph` theo cùng chuẩn `deploys/<unit>-deploy → platform-deploy`: nó là Tooling dùng
chung thời gian chạy, không phải prerequisite lifecycle giữa hai stack.

## 4. Contracts

`<bc>-contracts` là **boundary project/artifact**, không phải DDD layer:

- **Provider-owned** — contract thuộc về một provider (context sở hữu nó) và provider chịu trách nhiệm về nó.
- **Độc lập với implementation** — consumer phụ thuộc contract thay vì provider implementation.
- **Không** chứa domain implementation, **không** chứa business logic.
- **Nhiều consumers depend vào cùng một provider contract là bình thường** (kể cả consumers từ các context khác nhau).
- **Không** trở thành shared domain model — contract không được tồn tại như model domain dùng chung giữa nhiều bounded contexts; nếu nhiều context cùng phụ thuộc vào model dữ liệu chung thay vì API của một provider, contract đó đang lệch vai trò.
- Một protocol nền tảng dùng chung nhiều BC có **đúng một** contract project owning nó (khác context sở hữu bất kỳ consumer nào), tag `scope:platform`; consumer chéo BC import thẳng project đó, không import contracts của BC khác. Với scope nguồn có entry trong bản đồ `CONTRACT_EDGE_OWNERSHIP` của `pnpm dx arch-check` (§8), validator chặn dependency vượt tập {self, platform}; tính "đúng một project" là quy ước đặt tên, không được validator kiểm.

Có thể chứa, khi bounded context thực sự cần: `OpenAPI`, `Pact`, `JSON Schema`, `AsyncAPI`-compatible schema, DB schema
contract. Nội dung và tooling của từng contract → `02-delivery.md` §3.

## 5. Chế độ dữ liệu khi serve (serve-mode data policy)

Khi serve một app, nguồn dữ liệu không phải lựa chọn tuỳ ý — nó được quyết định theo chế độ serve, theo ba chính sách dưới
đây. Đây là chính sách runtime của frontend app (không phải policy test); chính sách áp dụng cho mọi frontend app; cách cài
đặt cụ thể của từng app → `docs/applications/<name>/`.

| Chế độ serve                     | Nguồn dữ liệu                        | Điều kiện                                                                                                                          |
| -------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Mock data (UI preview)           | mock adapter in-app                  | Chỉ `nuxt dev`; artifact build KHÔNG được có đường mock (fail-closed: chọn mock ⇒ boot fail / readiness 503); auth flows luôn thật |
| Contract mocking (dịch vụ ngoài) | Pact mock provider sinh từ pact file | Consumer test; provider verify ngược lại trên broker — không mock thủ công từng call                                               |
| Real (mặc định artifact)         | Backend thật qua BFF/binding         | Mọi artifact đã build; e2e và manual test chạy ở đây                                                                               |

**Vì sao fail-closed ở artifact.** Một artifact đã build chỉ được có đúng một đường dữ liệu: real. Nếu mock chỉ bị **tắt mặc
định** thay vì bị **gỡ khỏi bundle**, một cấu hình sai ở production sẽ bật fixture mà không có tín hiệu lỗi nào — app vẫn boot,
vẫn xanh, chỉ là đang trình bày dữ liệu giả. Vì vậy đường mock phải vắng mặt khỏi artifact hẳn: chọn mock ở artifact ⇒ boot
fail / readiness 503. Đây là hệ quả trực tiếp của nguyên tắc no fake success: e2e hay manual test xanh trên mock data không
chứng minh gì về sản phẩm, nên không được phép tồn tại trạng thái "xanh trên mock" mà người chạy không biết. Khi app chạy
lai — một phần adapter thật, một phần còn mock — cơ chế trung thực bắt buộc là banner "preview data" trong UI, như cờ
`isPreview` mà lớp dữ liệu của `account` đặt để shell hiện banner ở mọi trang; banner nói lên trạng thái, không giấu nó.

**Đặt tên mode theo tiền lệ hiện có, tránh chữ "preview".** Tên cấu hình mode đi theo mẫu của `NITRO_PUBLIC_BACKOFFICE_DATA_MODE`
(`backofficeDataMode` trong `runtimeConfig.public`, giá trị `prototype`/`disabled`, fail-closed về `unavailable` khi cấu hình
thiếu hay sai). Đừng đặt tên mode là `preview`: chữ đó đã bị chiếm bởi hai khái niệm khác — banner `isPreview` (sự thật UI về
tỷ lệ mock/real của app) và Preview environment (môi trường deploy riêng, `02-delivery.md` §5) — và dùng lại nó cho chế độ dữ
liệu sẽ khiến cả ba đọc như một.

## 6. Nx tags

Mọi Nx project phải có **đúng một tag mỗi dimension** — `scope:*`, `type:*`, `runtime:*`. Tag schema được validate bởi
`pnpm dx arch-check` (§8).

### 6.1 `type` — trách nhiệm kiến trúc

`type` nói project **chịu trách nhiệm gì về kiến trúc**, không nói ngôn ngữ, framework, deployment format hay project kind của
Nx (`projectType` app/library vẫn là cấu hình Nx riêng, không liên quan).

| Tag                   | Trách nhiệm                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `type:domain`         | Domain models, business invariants, domain services, domain errors |
| `type:application`    | Use cases, orchestration, ports                                    |
| `type:infrastructure` | Adapters, implementations của framework/external system            |
| `type:contracts`      | Boundary artifact và protocol/schema contract, không logic         |
| `type:composition`    | Deployable apps, BFF, Workers, entrypoint compose dependencies     |
| `type:deployment`     | Infrastructure provisioning/deployment orchestration (`deploys/`)  |
| `type:tooling`        | Developer tooling, DX automation, repository utilities             |

**`type:deployment` khác `type:infrastructure` ở đâu, và vì sao phải tách.** Cả hai đều nằm ngoài bounded context, nhưng
trả lời hai câu hỏi khác nhau: `type:infrastructure` là **adapter trong ứng dụng** (một `libs/<bc>-infrastructure` chạy
_trong_ tiến trình Worker, gọi Postgre qua Hyperdrive), còn `type:deployment` là **orchestration hạ tầng** (một project
Pulumi _ngoài_ ứng dụng, gọi Cloudflare API để tạo/cập nhật/xoá tài nguyên). Gộp chúng sẽ cho phép một deploy project import
adapter của service — đúng cách lách ranh giới ownership mà `01-architecture.md` invariant 7 chặn.

### 6.2 `runtime` — ràng buộc môi trường thực thi

`runtime` nói project **chạy ở đâu được**, không nói ngôn ngữ (không tag theo Rust/JS).

| Tag                 | Ý nghĩa                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `runtime:edge`      | Cloudflare Workers — Web API, không Node builtin, không OS process              |
| `runtime:browser`   | Browser-only (DOM, window) — không chạy trên edge                               |
| `runtime:native`    | OS process: Rust executable, Node.js CLI tool                                   |
| `runtime:universal` | **Cam kết tương thích** — dependency của project cho phép chạy mọi runtime trên |

`runtime:universal` không phải default cho library: đó là một lời cam kết hai chiều — project chỉ được phụ thuộc project
`universal` khác, vì dependency quyết định nơi project chạy được. Cấp `universal` khi dependency thật sự cho phép (vd
một thư viện pure string logic, zero dependency).

Deployment project trong `deploys/` mang `runtime:native`: Pulumi program chạy như một tiến trình Node.js CLI ngoài
Worker, cùng hàng với `type:tooling` — đây là lý do chúng nằm ngoài ma trận compatibility của edge/browser.

### 6.3 `scope` — ownership / dependency boundary

`scope` nói project thuộc **sở hữu của ai**: một bounded context hoặc một vùng ownership chia sẻ.

Trục ownership có hai tầng nền: `scope:shared` là **đáy** — chỉ được phụ thuộc `scope:shared` (không platform, không
implementation, không contract của scope nghiệp vụ nào — `onlyDependOnLibsWithTags` khớp bất kỳ tag nào trong allowlist nên
đưa `type:contracts` vào đây là mở `shared → contracts của scope bất kỳ`, đảo chiều tầng đáy) — còn
`scope:platform` được phép phụ thuộc thêm `shared` và `type:contracts` của scope bất kỳ. Chiều ngược lại (`shared` → `platform`)
bị chặn chủ đích: platform đã phụ thuộc shared, mở chiều ngược là mời dependency cycle giữa hai tầng nền.

Bounded context/product scope (`account`, `auth`, `backoffice`, `llm-consumer`, `llm-seller`, `llm-shared`, `payment`, …) được phụ thuộc **toàn bộ implementation** của
hai tầng nền — đó là vai trò foundation layer, khác hẳn dependency chéo scope nghiệp vụ: giữa các scope nghiệp vụ ngang hàng,
chỉ được phụ thuộc qua `type:contracts` của provider, không bao giờ import implementation của scope khác.

Scope dùng: `public`, `shared`, `platform`, `account`, `auth`, `backoffice`, `llm-consumer`, `llm-seller`, `llm-shared`, `payment`, `messaging`, `notifications`,
`local`. Scope `account`/`auth` là hai scope của hai bounded context tách biệt — trước issue #324 cả hai cùng nằm trong một
scope `identity` đã bị xoá. Scope mới thêm vào phải được khai báo trong constraint của `.oxlintrc.json` và `KNOWN_SCOPES` của
`tools/dx/src/architecture/arch-tags.ts` — hai nguồn này được test ràng buộc đồng bộ hai chiều: scope nào thiếu constraint, constraint
nào nhắm scope lạ, hay runtime constraint lệch ma trận compatibility đều bị test bắt.

**Ba scope LLM là ba phía ownership, không phải một trục duy nhất.** `scope:llm-consumer` (Consumer tenant, Consumer routing),
`scope:llm-seller` (Seller tenant, Seller governance, marketplace, Seller pricing) và `scope:llm-shared` (inference, usage,
financial) thay `scope:llm` đã bị xoá. Chúng **loại trừ lẫn nhau ở mức tag**, chặt hơn chính sách mặc định giữa các scope
nghiệp vụ: mỗi scope LLM chỉ được phụ thuộc chính nó cùng `scope:shared`/`scope:platform`, **không** có ngoại lệ
`type:contracts` xuyên phía, vì ADR-0019 cấm Consumer và Seller phụ thuộc nhau kể cả transitively. Quyết định và điều kiện
đảo ngược → [ADR-0019](../domains/llm-consumer-tenant/adr/0019-llm-scope-ownership-and-dependency-matrix.md).

⚠️ **Tag không phân biệt bounded context bên trong một scope.** `llm-marketplace-domain` và `llm-seller-governance-domain`
cùng mang `scope:llm-seller`, nên `onlyDependOnLibsWithTags` cho chúng import lẫn nhau. Ranh giới đó do
`validateLlmBoundaries` trong `pnpm dx arch-check` kiểm trên project graph: chỉ cạnh được liệt kê tường minh trong
`LLM_INTER_CONTEXT_EDGES` mới hợp lệ (hiện chỉ có `llm-seller-governance-domain → llm-seller-tenant-domain`), mọi cạnh khác
giữa hai LLM domain project là vi phạm, và một entry trỏ project không tồn tại cũng là vi phạm.

**Một scope có thể có nhiều app.** Scope là trục **ownership**, không phải trục deploy unit: `pact-broker` là một bounded
context với hai deploy unit `pact-broker-api` và `pact-broker-app` (`01` §2.1); cả hai app mang
`type:composition` + `scope:pact` + `runtime:edge` — cùng scope, cùng tag, không có tag riêng cho từng deploy unit.
Ranh giới giữa chúng **không** do tag Nx enforce: constraint `type:composition` cấm app import app, và đó là ranh giới
duy nhất mà tag đảm bảo. Ranh giới protocol/UI giữa hai app là quyết định kiến trúc, enforce bằng review và
contract test — không phải bằng tag mới.

⚠️ **Nx scope ≠ catalog bounded context.** Scope là trục sở hữu **code**; catalog bounded context là trục sở hữu
**nghiệp vụ và dữ liệu**, canonical ở [`domains/README.md`](../domains/README.md) §2. Hai trục phần lớn trùng tên
(`account`, `auth`, `backoffice`, `payment`) nhưng không đồng nhất: ba scope `llm-*` gộp **hai đến bốn** bounded context
mỗi scope, nên tên scope không phải tên context; `messaging` (transactional-mail) và `notifications`
(push-notification) là bounded context nghiệp vụ mang scope chia sẻ theo chức năng; `local`, `public`, `shared`,
`platform` là scope hạ tầng/chia sẻ, không phải bounded context; `pact-broker` là bounded context mang scope `pact`; và
`backoffice` là scope của một composition/UI + BFF — bounded context ngày nay theo A21, nhưng việc `staff-access` tiếp quản
đã được chốt ([ADR-0013](../domains/staff-access/adr/0013-staff-access-ownership-transfer.md)); sau khi phần việc còn lại của
`staff-access` hoàn tất (#44 đường ghi staff, enforcement permission và wiring BFF `createStaffAssignment`/`revokeStaffAssignment`; #46 đường recovery), `backoffice` chỉ còn composition (catalog → [`domains/README.md`](../domains/README.md) §2/§3).
Danh sách scope trong mục này mô tả cấu trúc code — **không** phải một bản catalog thứ hai của bounded context.

**Scope của deployment project là ranh giới provisioning, không phải bounded context.** Một `deploys/<unit>-deploy` mang
`scope` của deploy unit mà nó provision (cùng scope với app tương ứng), vì nó sở hữu **hạ tầng** của unit đó chứ không
sở hữu một context nghiệp vụ mới. Hệ quả cần nói rõ: deployment project **không** được phép phụ thuộc `libs/<bc>-*` của
scope khác — nó khai báo hạ tầng, không gọi implementation của service. Đây là ranh giới ở tầng **provisioning ownership**,
tách khỏi ranh giới ở tầng **service dependency** mà contract test bảo vệ.

⚠️ **Khoảng trống enforcement thật, cần biết khi debug:** tag Nx **không** chặn được việc một app chạm database của
app khác — mọi app mang `type:composition`, và constraint của type đó không đọc database nào. Việc thêm Hyperdrive
binding trỏ sang `db-auth` trong `apps/account` đi qua mọi lượt kiểm ở §7. Vì `account` và `auth` là hai bounded
context với hai database owner riêng (`01` §2.1, §4), ranh giới database giữa chúng được enforce ở tầng **grant mức
database** (`REVOKE CONNECT` chéo, `applications/account/03-operations.md` §3.1) chứ không ở tầng module graph — cấu hình
không đủ, phải có credential không cho phép. Ranh giới chéo scope còn lại được chặn ở tầng tag: constraint
`type:composition` cấm app import app, và giữa hai scope nghiệp vụ chỉ `type:contracts` của provider được phụ thuộc.

## 7. Dependency rules

Hai lượt kiểm với cơ chế khác nhau, bổ sung cho nhau:

**Lượt direct + transitive theo tag — Oxlint module boundaries** (`@nx/enforce-module-boundaries` trong `.oxlintrc.json`):

| Source                   | Quy tắc                                                                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type:domain`            | Không phụ thuộc `application`/`infrastructure`/`composition`/`tooling` — **transitive**                                                                                                                                                                     |
| `type:application`       | Không phụ thuộc `infrastructure`/`composition`/`tooling` — **transitive**                                                                                                                                                                                   |
| `type:infrastructure`    | Chỉ phụ thuộc `domain`/`application`/`contracts`/`infrastructure`                                                                                                                                                                                           |
| `type:contracts`         | Không phụ thuộc bất kỳ type implementation nào — **transitive**                                                                                                                                                                                             |
| `type:composition`       | Chỉ compose `domain`/`application`/`infrastructure`/`contracts` — app không import app                                                                                                                                                                      |
| `type:deployment`        | Chỉ phụ thuộc `type:deployment` (cụ thể là `platform-deploy`), `type:contracts`, `type:infrastructure`, `type:tooling`; không compose code ứng dụng — allowlist khớp `.oxlintrc.json`, và ngoại lệ `deploys/*-deploy → tools/dx` ở §3 là edge `tooling` này |
| `type:tooling`           | Chỉ phụ thuộc `type:tooling`                                                                                                                                                                                                                                |
| bounded context scope    | Được dùng implementation của tầng nền (`shared`, `platform`); scope nghiệp vụ khác chỉ qua `type:contracts`                                                                                                                                                 |
| `scope:shared`           | Chỉ phụ thuộc `scope:shared` — không contract của scope khác (đáy của trục ownership)                                                                                                                                                                       |
| `scope:platform`         | Chỉ phụ thuộc `scope:platform`/`scope:shared` + `type:contracts`                                                                                                                                                                                            |
| composition edge/browser | Chỉ phụ thuộc lib `runtime:edge`/`universal` (tương ứng `browser`) — lượt direct                                                                                                                                                                            |

`notDependOnLibsWithTags` là **transitive**: domain không chạm application kể cả qua chuỗi lib trung gian. `onlyDependOnLibsWithTags`
khớp **bất kỳ tag nào** trong danh sách nên allowlist scope đọc theo vai trò: tầng nền có mặt trong allowlist của bounded
context là vì chúng là foundation layer được dùng trọn vẹn, không phải ngoại lệ chéo scope; implementation của scope nghiệp
vụ khác không có mặt trong allowlist nào, và kể khi một edge import trượt vào allowlist, constraint `type:*` phía trên vẫn
chặn hướng đó. Contracts được phép chéo scope (consumer phụ thuộc contract của provider) nhưng không bao giờ chạm
implementation của provider — constraint `type:contracts` transitive chặn hướng đó. Allowlist `type:composition` cố ý
KHÔNG chứa `type:composition` lẫn `type:tooling`: một deploy unit không bao giờ import trực tiếp deploy unit khác (app là
composition root, không phải implementation cho app khác), và tooling là dev lane không làm lib runtime; các combo runtime
dưới đây cũng không có hai type đó ở lượt direct — import chéo app không trượt qua được lượt nào.

**Lượt graph-wide — `pnpm dx arch-check`** (`tools/dx`):

- Tag schema: đúng một `scope:*`, `type:*`, `runtime:*` mỗi project; value thuộc allowlist; không còn value legacy
  (`type:web`, `type:service`, `type:lib`, `type:tool`, `runtime:node`, và **mọi** tag mang prefix `layer:*` — dimension đã
  bị xoá nên bị chặn theo prefix, không theo danh sách value).
- Runtime compatibility **transitive trên project graph**: `edge` không được chạm `native`/`browser` qua bất kỳ chuỗi
  dependency nào (và đối ứng cho `browser`/`native`); `universal` chỉ được phụ thuộc `universal`.

**Prerequisite platform được kiểm ở tầng nào.** Quan hệ `deploys/<unit>-deploy` → `platform-deploy` là quan hệ trên
project graph, nên nó thuộc phạm vi của `arch-check` (lượt graph-wide) chứ không phải lượt Oxlint direct: một deployment
project khai sai tên prerequisite, hoặc `platform-deploy` nào đó lỡ phụ thuộc ngược một `<unit>-deploy`, đều lộ ra ở lượt
đọc graph. Đây là kiểm **cấu trúc prerequisite**, không phải kiểm **thứ tự chạy** — xem §2.1.

Lượt graph-wide cần thiết vì Node builtin import không tạo graph edge trong Nx — guard builtin (không `node:*` trong
`apps/**`/`libs/**`) vẫn do override `no-restricted-imports` + `import/no-nodejs-modules` của Oxlint theo directory glob;
cấm import một _project native_ thì phải đọc tag trên graph.

## 8. Architecture enforcement

| Cơ chế                                   | Chặn cái gì                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Oxlint module boundaries (`@nx/*`)       | Dependency direction theo `type`, scope boundary, runtime direct edge, Node builtin |
| `pnpm dx arch-check` (CI, unconditional) | Tag schema ba dimension, runtime compatibility transitive trên graph                |

`arch-check` chạy trên **toàn workspace** chứ không theo `nx affected`: một tag sai ở project không đổi file nào vẫn phải đỏ.

## 9. Rust toolchain

Workspace sẵn sàng cho crate tương lai; hiện chưa có Cargo project nên không có Nx target Rust nào được đăng ký.

- Toolchain pin ở `rust-toolchain.toml` (workspace root) — rustup áp theo directory, dùng chung local và CI; convention
  cùng họ với `.node-version`.
- Khi crate đầu tiên xuất hiện (`libs/<bc>-infrastructure` hoặc `tools/*`), đăng ký target per-project dùng executor
  `nx:run-commands` gọi `cargo fmt --check` / `cargo clippy` / `cargo test` / `cargo build`, cache inputs gồm
  `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml` và sources; `target-dir` riêng per-project khi cần tránh cache
  artifact đè nhau.
- **Không dùng `@monodon/rust`:** phiên bản hiện (3.0.0) khai báo dependency cứng `@nx/devkit ^22.0.0` trong khi workspace
  chạy Nx 23.3.0; các bản 2.x cũng chỉ hỗ trợ tới Nx < 21. Plugin còn yêu cầu `cargo metadata` chạy lúc build graph. Khi
  chưa có crate nào, plugin không infer được target nào — chi phí cài không đổi lại rủi ro version drift với Nx. Đánh giá
  lại khi Nx và plugin tương thích, hoặc khi số crate đủ nhiều để explicit targets thành gánh nặng.
- CI cài Rust toolchain **chỉ khi** workspace có Cargo project (kiểm sự tồn tại `**/Cargo.toml`), tránh mọi PR JS trả phí
  cài đặt không cần thiết.
