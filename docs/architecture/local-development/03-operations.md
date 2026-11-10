# Local Platform — Operations

> Kiến trúc và bất biến: [`./01-platform.md`](./01-platform.md).

## Prerequisites

- Docker daemon đang chạy (rootful lẫn rootless đều được; rootless được tự động nhận qua `DOCKER_HOST` — Traefik cần bind-mount đúng socket, chương trình tự suy theo thứ tự `DOCKER_SOCKET_PATH` > `DOCKER_HOST` > `/var/run/docker.sock`, và **fail sớm** nếu không tìm thấy socket nào tồn tại thật thay vì mount nhầm path).
- `pulumi` CLI trên `PATH` — **bản đã xác minh cho luồng này là `3.270.0`** (CLI pin trong repo, `node_modules/.bin/pulumi`; stack reference format `organization/<project>/<stack>` chỉ được kiểm chứng từ bản này — xem `../04-platform-facts.md` §2.16 PU12). CLI cũ hơn trên `PATH` có thể fail với lỗi rối khó chẩn đoán.
- **Passphrase Pulumi** — **không cần developer tự đặt.** Pulumi CLI 3.270 trên DIY backend `file://` bắt buộc passphrase cho mọi thao tác nạp stack config; luồng này giải bằng cách **công cụ tự sinh** một passphrase ngẫu nhiên (32 byte `randomBytes`, `base64url`) cho từng worktree, lưu ở `<worktree>/.pulumi-local-passphrase` (quyền `0600`, **ngoài Git** — `.gitignore` chặn tường minh). Developer không cần `export PULUMI_CONFIG_PASSPHRASE` cho stack local mới. Nếu môi trường đã có passphrase (`PULUMI_CONFIG_PASSPHRASE`/`PULUMI_CONFIG_PASSPHRASE_FILE`), giá trị đó được ưu tiên và ghi vào file để stack tự chứa từ lần chạy sau; stack cũ tạo bằng passphrase của developer vẫn giải được khi cung cấp lại đúng passphrase đó. Worktree đã deploy bằng passphrase khác thì cung cấp lại qua biến môi trường (không có đường reset không mất dữ liệu). Giữ file `.pulumi-local-passphrase` ổn định cho từng worktree — mất file mà state còn thì passphrase không khôi phục được.

- Certificate `fbi.com` ở `deploys/platform-deploy/local-certs/` (đường dẫn đầy đủ từ root repo; đã có trong repo). ⚠️ **Đường an toàn là trust scoped**: smoke đã làm đúng kiểu đó — trust certificate **cho đúng request** (tham số `ca` scoped), không đụng trust store hệ điều hành. Chỉ khi cần browser chấp nhận TLS thì mới trust thủ công, và phải hiểu hệ quả: cert này mang `CA:TRUE` (`keyCertSign`) — cài vào trust store là biến nó thành CA được toàn máy tin, tức **mọi certificate ký bằng khoá này cho bất kỳ hostname nào** cũng được chấp nhận. Khoá nằm vĩnh viễn trong Git history (không bị `.gitignore` loại) nên ai đọc được repo đều giữ được khoá — với trust store đầy máy, người đó có thể cấp cert giả cho domain bất kỳ trên máy của developer. Nếu bắt buộc trust ở mức máy, làm trên máy thử nghiệm rồi **tái sinh cert/key khi repo chuyển sang public**. Không bao giờ tắt TLS verification toàn cục. Khoá này **chỉ dùng cho local**, không tái sử dụng ở staging/production.

## Cách ly worktree (Pulumi CLI/backend)

Mọi lệnh Pulumi của luồng này chạy với `PULUMI_BACKEND_URL=file://<worktree>/.pulumi-local-state` và `--stack organization/<project>/<stack>` tường minh (`libs/deployment/src/pulumi-context.ts` (`@ecoma-io/deployment`)) — không `pulumi login`, nên không backend toàn cục nào bị chọn. `stack init`/`stack select` của `ensureStack` vẫn ghi stack hiện tại vào workspace file `~/.pulumi/workspaces/<project>-<sha1(Pulumi.yaml)>-workspace.json`, nhưng file đó key theo đường dẫn project (PU13) nên hai worktree không đụng file của nhau; các lệnh đọc/ghi state khác đều truyền `--stack` tường minh nên không phụ thuộc giá trị được ghi đó. `~/.pulumi` còn dùng chung cho plugin cache. Chi tiết platform đã đo: `../04-platform-facts.md` §2.16 PU12–PU13.

## Luồng deploy — Nx điều phối, mỗi deploy project sở hữu lifecycle của mình

Điều phối thuộc Nx Task Graph: mỗi deploy project khai target `local-up`/`local-down` (và `platform-deploy` thêm `local-smoke`) với configuration `local` trong `package.json` của mình, thực thi entry colocated `deploys/<project>/local.ts` (`npx tsx local.ts up|down|smoke`, cwd là thư mục project). Thứ tự toàn cục là dữ liệu khai báo của chính các project — target `dependsOn` — mà Nx đọc để dựng task graph; entry không biết thứ tự của project khác và không gọi lệnh DX nào.

```bash
pnpm nx run-many -t local-up -c local             # up cả 13 lane project theo đúng thứ tự phụ thuộc
pnpm nx run platform-deploy:local-smoke -c local  # smoke HTTPS của home qua Traefik (tự up home trước)
pnpm nx run-many -t local-down -c local           # down từng project, KHÔNG có thứ tự teardown toàn cục
pnpm dx local-status                              # namespace, stack, resource names, trạng thái platform
```

Lane gồm **13 project**: platform, home, backoffice, account, auth, pact-broker-api, pact-broker-app, transactional-mail, push-notification, staff-access, remote-cache-api, llm-console, llm-seller. Hai project job-deploy (`transactional-mailer-job-deploy`, `web-push-notification-job-deploy`) không có target local — cặp worker mail đã chạy trong MỘT WIC container của `transactional-mail-deploy`, và worker web-push chạy trong WIC của `push-notification-deploy`.

Hình dạng graph `local-up` (nguồn sự thật là `dependsOn` trong `package.json` của từng project, không phải mục này): `platform-deploy:local-up` là node gốc duy nhất (network, Traefik, PostgreSQL) — mọi lane project đọc outputs platform qua StackReference; `auth` và `transactional-mail` phụ thuộc thêm `account-deploy` (secret cross-stack, xem bất biến dưới đây); `pact-broker-app` phụ thuộc thêm `pact-broker-api-deploy` (machine token); `backoffice` phụ thuộc thêm `staff-access-deploy`; `home`, `account`, `staff-access`, `pact-broker-api`, `push-notification`, `remote-cache-api`, `llm-console`, `llm-seller` phụ thuộc duy nhất `platform-deploy`. Build image/app của từng unit là task dependency của `local-up` unit đó. `platform-deploy:local-smoke` phụ thuộc duy nhất `home-deploy:local-up` — smoke kiểm chuỗi redirect `/` → `/en` của home qua Traefik, nên home là prerequisite thật; các unit khác không được kéo vào vì smoke không đo chúng.

Mỗi entry `local.ts up` làm hai việc, tự chứa trong project của mình:

1. Chuẩn bị bảng secret của project mình (`pulumi config set`, giá trị qua stdin).
2. `pulumi up` stack của chính nó.

Readiness thuộc container resource, không thuộc DX: mỗi container long-running khai `wait: true` + `waitTimeout` cùng healthcheck Docker do deploy unit định nghĩa (`traefik healthcheck`, `pg_isready`, `/ready`, `/health`, HTTP probe...), nên provider Pulumi chỉ báo container thành công khi healthcheck đã chuyển `healthy` — `pulumi up` xanh là bằng chứng serving, và mọi resource phụ thuộc (outputs, unit kế tiếp qua StackReference) chỉ bắt đầu sau đó. Container một-shot init (`rm: true`, `mustRun: false`) không khai healthcheck lẫn `wait` — Pulumi chỉ chờ chúng thoát. DX không biết Docker health tồn tại: không có health polling hay `docker inspect` health nào trong lifecycle.

Lifecycle KHÔNG có khóa lane toàn cục: serialization thật của cùng một stack là state lock của chính Pulumi (`pulumi up`/`destroy` trên cùng stack tự chặn nhau), hai stack khác nhau thì độc lập trong namespace Docker riêng của worktree.

Task `local-up` của platform tự ghi `.env` của worktree (đúng ba key sở hữu `ROOT_HOST`/`ROOT_DOMAIN`/`POSTGRES_PASSWORD`, giữ nguyên byte các dòng khác) ngay sau khi `pulumi up` xanh — mọi unit kế tiếp đọc `ROOT_HOST` từ file đó và fail rõ ràng kèm hướng dẫn khi file/key chưa có.

### `local-down` — teardown của từng project

`local.ts down` của mỗi project = `pulumi destroy --yes` trên stack của chính nó. Target `local-down` KHÔNG có `dependsOn`: không thứ tự teardown toàn cục — mỗi project tự xoá resource của mình trong namespace của worktree, `pulumi destroy` tự serialize trên stack state, và Docker không còn phụ thuộc vòng sống giữa các resource sau khi down. Idempotent: worktree chưa từng deploy là no-op exit 0; lỗi destroy thật là exit 1.

Volume PostgreSQL sống độc lập với vòng đời stack (`retainOnDelete`) — destroy trực tiếp không xoá volume. Down của platform xoá volume **mọi lần chạy** sau khi destroy (in cảnh báo, mất dữ liệu vĩnh viễn — không có tuỳ chọn giữ dữ liệu local nào); down chạy hai lần liền vẫn idempotent vì volume vắng mặt được chấp nhận như đã xoá. Lỗi destroy và lỗi xoá volume được báo và phản ánh vào exit code riêng biệt — lỗi nào cũng là exit 1, không lỗi nào bị nuốt:

```bash
pnpm nx run platform-deploy:local-down -c local   # down riêng platform — xoá cả volume PostgreSQL
```

### `local-down` không yêu cầu thứ tự ngược

Target `local-down` KHÔNG có `dependsOn` — các project down song song, mỗi project tự xoá resource của mình trong namespace của worktree. Bảo vệ xung đột không nằm ở cạnh task graph:

- `pulumi destroy` tự serialize trên stack state của chính nó; hai stack khác nhau không chia resource nào trừ network Docker namespace-scoped của platform.
- Destroy platform khi container unit còn gắn vào network là fail-loud ("has active endpoints") — chạy lại `platform-deploy:local-down` sau khi các unit đã down là xanh; idempotent theo thiết kế, không cần thứ tự ngược toàn cục.

Các bất biến cross-stack thể hiện trực tiếp trong graph qua `dependsOn` và cơ chế persist/read-lại stack config (một giá trị chia hai stack; bên ghi là entry up của producer, bên đọc là entry up của consumer):

- account → auth: account tự sinh internal HMAC secret vào stack config của mình (`namespace:internalHmacSecret`) mà auth đọc lại khi up (`namespace:internalSecret`).
- account → transactional-mail: cùng cơ chế với `namespace:mailInternalAuthSecret` (receiver mail giữ làm credential `MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT`).
- pact-broker-api → pact-broker-app: machine token plaintext do api persist (`namespace:machineToken`), BFF đọc lại làm `NITRO_PACT_BROKER_API_TOKEN`; api chỉ seed HASH SHA-256 vào DB. pact-broker-app gọi api qua alias nội bộ `ecoma-pact-api:4204` (port contract giữa hai unit).
- staff-access → backoffice: staff-access tự sinh internal HMAC secret vào stack config của mình (`namespace:internalHmacSecret`); backoffice đọc lại bằng `pulumi config get`, ghi bản sao vào stack config của nó, và mỗi stack truyền giá trị đó thành `AUTH_INTERNAL_SECRET` cho container của mình — đây là credential duy nhất ký/verify envelope của management API. backoffice gọi staff-access qua alias nội bộ `ecoma-staff-access:4206`; readiness của unit này là healthcheck `/ready` (config nạp được + DB trả lời bằng credential runtime). `local-up` xanh chứng minh container staff-access tự phục vụ `/ready`; đường gọi **có chữ ký** từ backoffice được chứng minh bởi `backoffice-access-control-e2e:system-test`, không phải bởi healthcheck. Secret được sinh lại mỗi lần `staff-access-deploy:local-up`, nên up lại **riêng** unit này làm lệch container backoffice đang chạy cho tới khi `backoffice-deploy:local-up` chạy lại — chạy cả lane (`nx run-many -t local-up -c local`) giữ hai bên khớp.
- platform → pact-broker-api / push-notification: network + StackReference.

⚠️ **KHÔNG dùng `nx run-many --dry-run` để kiểm tra lane này**: trên Nx 23.3.0 `--dry-run` KHÔNG chặn thực thi lệnh executor (`nx:run-commands` vẫn chạy thật — `pulumi up` thật, Docker thật). Xác minh cấu trúc graph dùng duy nhất `--graph=stdout` (chỉ in JSON, không thực thi): `nx run-many -t local-up -c local --graph=stdout` rồi đọc `graph.dependencies`.

Lần chạy đầu trên stack mới, password PostgreSQL được sinh ngẫu nhiên (24 byte `randomBytes`, `base64url`) và lưu ở **Pulumi stack config plaintext** (`postgres:password`) của local stack — đây là nguồn sự thật canonical; cùng giá trị được ghi vào `.env` (`POSTGRES_PASSWORD`) để E2E/dev tools dùng. Passphrase chỉ là encryption material của state Pulumi local, không đóng vai trò bảo vệ password. Entry up của platform tái dùng mật khẩu đã có trong config cho mọi lần chạy sau; `.env` bị xoá thì được khôi phục từ config mà không xoay password. Nếu volume PostgreSQL đã tồn tại nhưng config mất password, entry up fail với hướng dẫn thay vì sinh password mới (tránh khoá người dùng ra khỏi dữ liệu cũ).

Hai chi tiết CLI 3.270 đã đo thật, cả hai đều bắt buộc để password được lưu đúng: `pulumi config set` **từ chối** giá trị "trông như secret" (key `postgres:password` + chuỗi ngẫu nhiên) với exit 1 và lời khuyên dùng `--secret`/`--plaintext` — nên luồng luôn truyền `--plaintext`; và giá trị được ghi qua **stdin** (`--raw`, không có argument value) thay vì argv, vì argv của process khác đọc được qua `/proc/<pid>/cmdline` và `ps`.

## `local-status` — đọc trạng thái

Read-only. Phân biệt năm trạng thái, mỗi trạng thái một dòng:

- `chưa có stack trong backend` — worktree này chưa từng deploy (exit 0; passphrase được tool quản lý — file `.pulumi-local-passphrase` hoặc passphrase của developer trong môi trường).
- `stack có sẵn nhưng chưa up (outputs rỗng)` — `stack init` đã chạy nhưng chưa `up` thành công lần nào (exit 0).
- `platform outputs: {...}` — deployed, in outputs (exit 0).
- `[local-status] lỗi Pulumi/backend: ...` — backend không đọc được, sai passphrase — **exit != 0**; "lỗi thật" không bao giờ được nuốt thành "chưa deploy".
- `[local-status] outputs platform không parse được JSON: ...` — backend trả dữ liệu nhưng stdout không phải JSON — **exit != 0**.

## URL và smoke

Port thật nằm trong `.env` (`ROOT_HOST=fbi.com:<port>`) và trong output `traefikHostPort` của platform stack. Xác minh end-to-end bằng target smoke (đọc `ROOT_HOST` từ `.env`, chỉ chạy HTTPS): smoke phụ thuộc `home-deploy:local-up` nên Nx tự up platform + home trước, rồi kiểm chuỗi redirect `/` → `/en` qua Traefik — bằng chứng serving path ngoài internet hoạt động; smoke không đo unit nào khác.

```bash
pnpm nx run platform-deploy:local-smoke -c local
```

Kiểm thử nhanh một hostname cụ thể, không cần trust certificate:

```bash
node system-tests/local-smoke/src/local-smoke.mjs fbi.com:<port>
```

Smoke xác nhận đúng hành vi ứng dụng qua Traefik, không chỉ "server còn sống": `GET /` (kèm header `Accept: text/html`) phải **302 → `/en`**, sau đó `GET /en` phải **200 HTML** chứa title của home. Retry chỉ áp dụng cho dấu hiệu "chưa sẵn sàng" (`ECONNREFUSED`, `ECONNRESET`, `EPIPE`, `ETIMEDOUT`, 404/502/503/504 — 404 là cửa sổ registration router khi container bị recreate) trong budget mặc định 90s; 4xx còn lại/500, lỗi TLS/cert, redirect sai đích hay thiếu title là fail ngay. TLS bắt buộc hợp lệ — script chỉ trust certificate local **cho đúng request này** (tham số `ca` scoped), không đụng trust store hệ điều hành, không tắt verification. Cờ tuỳ chọn cho test: `--connect <host:port>` (dial địa chỉ khác hostname), `--budget-ms`, `--request-timeout-ms`.

## Vòng đời dữ liệu

- Down là việc của từng project (`nx run-many -t local-down -c local` hoặc down từng project một); không có thứ tự teardown toàn cục. Lỗi destroy của một project không cản trở project khác — mỗi `local-down` độc lập, exit 1 chỉ của chính project lỗi.
- Volume được khai `retainOnDelete` nên `pulumi destroy` trực tiếp không xoá volume; đường xoá volume duy nhất trong luồng lifecycle là down platform (mục `local-down` ở trên) — vô điều kiện mỗi lần chạy. `local-cleanup` xoá volume chỉ với resource mồ côi đủ điều kiện.
- ⚠️ Đừng chạy `pulumi stack rm` trên stack local: nó xoá stack config (trong đó có `postgres:password`) trong khi volume còn lại — hai nửa lệch tuổi, Postgres kế tiếp không vào được dữ liệu old. Đó cũng là lý do down không dùng `destroy --remove`. Khi phát hiện tình huống này, entry up của platform **fail với hướng dẫn** (không sinh mật khẩu mới): khôi phục mật khẩu cũ vào stack config, hoặc chạy `pnpm nx run platform-deploy:local-down -c local` (xoá volume, bắt đầu lại từ dữ liệu rỗng) rồi chạy lại lane `local-up`.
- ⚠️ Đừng đổi `postgres:password` trong stack config sau khi volume đã init: `POSTGRES_PASSWORD` chỉ có tác dụng lúc `initdb` trên volume rỗng. Pulumi sẽ thay container (envs nằm trong diff) nhưng Postgres không chạy lại initdb — superuser trong volume vẫn giữ mật khẩu cũ, kết nối bằng giá trị mới nhận `password authentication failed` trong khi healthcheck `pg_isready` vẫn xanh (nó không xác thực mật khẩu). Nguyên tắc: mật khẩu và volume phải cùng tuổi.
- Healthcheck `pg_isready` không kiểm password; khi nghi ngờ lệch password (vd. đã `stack rm` ngoài luồng), kiểm bằng auth TCP thật hoặc tạo lại volume qua down platform rồi chạy lại lane `local-up`.
- **Mật khẩu PostgreSQL local lưu plaintext** trong Pulumi stack config (`.pulumi-local-state/`) và trong `.env` của worktree — cả hai đều ngoài Git (`.gitignore` chặn `.pulumi-local-state/`, `Pulumi.*.yaml`, `.env*`). Đây là đánh đổi **có chủ đích cho môi trường local development**, không phải khuôn mẫu cho staging/production: ở đó secret vẫn phải là secret của Cloudflare Worker. Mật khẩu không bao giờ được in ra log/stdout, không nằm trong Pulumi outputs, không nằm trong URL, và PostgreSQL không publish host port.

## Migration legacy `postgres:password` (secure/`[secret]`)

Luồng hiện tại lưu `postgres:password` dạng **plaintext** trong Pulumi stack config local (`postgres:password`, không `secure:`), vì vậy `pulumi config get` đọc được giá trị thật. Các stack tạo trước (legacy) có thể đã lưu nó dạng secret (`secure:`) — khi đó `pulumi config get` chỉ trả masking `[secret]`, không phải mật khẩu thật.

**Không được** tự sinh mật khẩu mới hay tự convert secret nếu không có mật khẩu gốc: làm vậy sẽ phá quyền truy cập vào volume PostgreSQL đã init. Luồng fail closed và in hướng dẫn migration thay vì đoán.

### Khi nào cần migration

Entry up của platform báo lỗi đọc `postgres:password` (luồng fail closed và không sinh mật khẩu mới). Trigger thật trên CLI 3.270:

- `error: passphrase must be set` hoặc `error: incorrect passphrase` — stack legacy lưu `postgres:password` dạng secret (`secure:`) nhưng CLI không có passphrase đúng để giải mã. Cung cấp passphrase qua `PULUMI_CONFIG_PASSPHRASE`.
- `error: could not decrypt configuration value` — blob secret bị hỏng.
- `error: could not open state directory` / backend không đọc được.

**Lưu ý quan trọng**: khi cung cấp **đúng** passphrase, `pulumi config get postgres:password` trả về **plaintext** (không trả `[secret]`). Chuỗi masking `[secret]` chỉ xuất hiện ở lệnh `pulumi config` (list) và ở Automation API `stack output --json` không có `--show-secrets` — **không** phải ở `config get`, nên **không** dùng `[secret]` làm tiêu chí phát hiện legacy.

### Thủ tục phục hồi (được hỗ trợ)

1. Cung cấp passphrase Pulumi đúng cho stack qua biến môi trường:

   ```bash
   export PULUMI_CONFIG_PASSPHRASE='<passphrase-đúng-của-stack>'
   ```

2. Kiểm tra đọc được mật khẩu:

   ```bash
   pulumi config get postgres:password --stack organization/platform-deploy/<stack> \
     --cwd deploys/platform-deploy
   ```

   Với passphrase đúng, lệnh này trả **plaintext** (đã kiểm trên CLI 3.270, kể cả khi giá trị được lưu dạng `secure:`) — entry up của platform đọc được mật khẩu đang dùng và tái dùng nó, không sinh mới.

3. Chạy lại lane `pnpm nx run-many -t local-up -c local` để deploy lại với mật khẩu khớp volume.

Nếu passphrase gốc không còn: không có đường phục hồi tự động —

### Nếu không khôi phục được passphrase gốc

Không có đường convert an toàn. Cách duy nhất là bắt đầu lại từ dữ liệu rỗng:

```bash
pnpm nx run platform-deploy:local-down -c local   # XOÁ dữ liệu vĩnh viễn — cân nhắc kỹ
pnpm nx run-many -t local-up -c local
```

Down platform xoá volume PostgreSQL mọi lần chạy (không có đường xoá nào khác trong luồng lifecycle).
Cleanup (`pnpm dx local-cleanup`) xoá volume chỉ với resource mồ côi đủ điều kiện.

### Lưu ý về plaintext config

Lưu `postgres:password` plaintext trong Pulumi stack config local là đánh đổi **có chủ ý cho môi trường local development** — cả `.pulumi-local-state/` và `Pulumi.*.yaml` đều nằm ngoài Git (`.gitignore`). Đây **không** phải khuôn mẫu cho staging/production: ở đó secret vẫn phải là secret của Cloudflare Worker, và không được áp dụng plaintext config. Mật khẩu không bao giờ được in ra log/stdout, không nằm trong Pulumi outputs, không nằm trong URL.

## `local-cleanup` — dọn resource mồ côi

Worktree xoá là Docker resource còn lại: container/network/volume mang tên `ecoma-<namespace>-<kind>` không ai quản lý. `pnpm dx local-cleanup` tìm và xoá resource mồ côi đó — worktree sở hữu nó không còn trên đĩa.

```bash
pnpm dx local-cleanup                       # dọn thật, xoá cả volume PostgreSQL của resource mồ côi đủ điều kiện
pnpm dx local-cleanup --dry-run             # chỉ báo cáo, không có lệnh destructive nào
pnpm dx local-cleanup --worktree-root <dir> # lọc báo cáo theo worktree (diagnostics, không nới ràng buộc)
```

**Cleanup phát hiện và xoá những gì**: resource Docker mà luồng local deployment tạo — network platform, container Traefik, container PostgreSQL, container home/backoffice/account/pact-app, WIC containers và images của auth/pact-api/mail/push, volume PostgreSQL và các volume state WIC (`CLEANUP_KINDS` trong `tools/dx/src/deployment/local-platform/local-cleanup.ts` (CLI adapter; classification từ `@ecoma-io/deployment`)). Cleanup KHÔNG có teardown theo thứ tự phụ thuộc: worktree biến mất thì không resource nào còn phụ thuộc vòng sống vào nhau; Docker chấp nhận lệnh `rm` trực tiếp từng resource.

### Labels ownership — bằng chứng "của ai"

Mọi resource local deployment được gắn bốn label (`deploys/platform-deploy`, `deploys/home-deploy`; định nghĩa một bản duy nhất ở `libs/deployment/src/deploy-labels.ts` (`@ecoma-io/deployment`)):

| Label                       | Ý nghĩa                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `io.ecoma.managed-by=ecoma` | Đánh dấu resource thuộc hệ thống local deployment của Ecoma (giá trị canonical). Các resource tạo bởi phiên bản cũ mang `managed-by=dx` vẫn được cleanup nhận diện (compatibility có giới hạn). **Không có label này (hoặc giá trị không phải `ecoma`/`dx`) là cleanup không bao giờ đụng**, dù tên có trông giống resource ecoma. |
| `io.ecoma.worktree-path`    | Worktree root đã normalize (`normalizeWorktreeRoot` — realpath, bỏ trailing sep) — cleanup so đường này với worktree còn tồn tại trên đĩa.                                                                                                                                                                                         |
| `io.ecoma.worktree-id`      | Namespace ổn định của worktree (`w` + xxHash64 hex 12, `deploy-namespace.ts`) — cùng giá trị với tên resource.                                                                                                                                                                                                                     |
| `io.ecoma.deployment=local` | Luồng sở hữu — hiện chỉ có `local`.                                                                                                                                                                                                                                                                                                |

Resource thiếu bất kỳ label trong bốn, `worktree-id` sai pattern namespace, hay `worktree-path` không absolute → **metadata không trọn vẹn (malformed) → skip, không xoá**. Quyết định xóa luôn dựa trên metadata hợp lệ, không dựa trên hình dạng tên.

**Volume persistent bị xoá với resource mồ côi đủ điều kiện**: cleanup xoá volume PostgreSQL của resource có labels ownership hợp lệ và worktree confirmed absent. Volume không đủ điều kiện xoá (metadata không trọn vẹn, worktree còn sống) được báo ra entries `kept`/`skipped` với lý do rõ để developer tự quyết.

### An toàn và xử lý lỗi

- **Chưa có thể verify ownership thì không xoá**: `docker inspect` lỗi, JSON sai, label lệch — resource được báo `skipped` trong output (không âm thầm).
- **Docker daemon không phản hồi** (`docker info` fail): cleanup trả lỗi ở stderr với chi tiết, exit 1, **không quét và không xoá gì**.
- **Lỗi `ls` per-kind** (daemon lỗi giữa chừng): kind đó được bỏ với lỗi trong output; các kind khác vẫn xử lý — lệnh exit 1 khi có bất kỳ lỗi nào, không `return 0` nói dối.
- **Worktree filter** (`--worktree-root`) chỉ dành cho diagnostics — nó lọc báo cáo, không thay check ownership/liveness; resource ngoài filter vẫn phải qua đủ check như thường.
- **Phối hợp với lane đang chạy**: lifecycle không có khóa lane toàn cục và cleanup cũng không lấy khóa nào. Quyết định xoá của cleanup dựa trên presence của worktree trên đĩa + labels ownership bắt buộc đủ (mục Labels ownership ở trên) — không dựa trên pha của lane, nên chạy cạnh lane đang chạy chỉ tốn chi phí nhiễu báo cáo (inspect lỗi giữa chừng → `skipped`, behavior fail-safe ở trên), không bao giờ xoá resource một lane đang tạo lại.
- Cleanup chạy không đòi checkout cũ hay thao tác Pulumi nào: nó chỉ nói chuyện Docker + filesystem của worktree path được ghi trong label.

## Giới hạn đã biết

- Host port Traefik đổi mỗi lần container được tạo lại (Docker cấp động) — luôn đọc lại từ `.env`/outputs sau khi up.
- Traefik bind-mount Docker socket read-only: `readOnly` chỉ chặn ghi filesystem, KHÔNG giới hạn Docker API — mount này vẫn là đường leo thang đặc quyền tiềm năng nếu container bị chiếm. Socket proxy GET-only là giảm thiểu đúng nghĩa, chưa có ở đây (chấp nhận rủi ro có chủ ý cho môi trường local).
- Local deployment **không** auto-trust certificate, không backup volume, không monitoring — ngoài phạm vi có chủ ý.
- Preset Nitro của `apps/home` cho staging/production vẫn là `cloudflare-module` (đường Wrangler); Docker chỉ dùng preset `node-server` qua build-time flag, không sửa `nitro.config.ts`.
