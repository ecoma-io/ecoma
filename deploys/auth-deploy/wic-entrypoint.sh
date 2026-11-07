#!/bin/sh
# Entrypoint của WIC container (auth-deploy) — chạy HAI worker `wrangler dev`:
#
#   1. ecoma-auth                (apps/auth)                -> HTTP :4203 (dev.port của wrangler.jsonc)
#   2. ecoma-account-bridge      (tools/account-bridge)     -> HTTP :4204 (dev.port của wrangler.jsonc)
#
# Container chạy trên platform network (02-account-auth.md §Database access):
#   - Repo mount READ-ONLY tại /repo: bundle `dist/` (build trên host, mount
#     bind ro vào đúng vị trí) + wrangler.jsonc là input; KHÔNG gì ghi được
#     xuống đây.
#   - Volume RW duy nhất tại /state ($PERSIST_DIR): state wrangler
#     (`--persist-to` của HAI worker), thư mục runtime per-app, dev registry.
#   - Biến môi trường do Pulumi container `envs` cấp (kênh container env):
#     * CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE (PF3) —
#       connection string db-auth với sslmode=disable (PF4: workerd dial thẳng).
#     * Secrets Worker của auth (AUTH_SIGNING_KEY...): chỉ qua env, không argv,
#       không label, không log.
#     * BRIDGE_TARGET_ORIGIN cho shim — ở runtime WIC, shim KHÔNG đi qua
#       `local-worker-up` của host (orchestration injection của tools/dx chỉ áp
#       cho đường host), nên biến này được cấp tại đây cùng kênh envs.
#
# Shell Signals: `sh` là PID 1, hai wrangler chạy background; trap SIGTERM/SIGINT
# chuyển tiếp cho cả hai rồi chờ — `docker stop` tắt được CẢ HAI worker thay vì
# để orphan cầm dev registry + connection pool.

set -u

REPO=/repo
AUTH_DIR=$REPO/apps/auth
# account-bridge sống ở tools/ (local-only, không có đường deploy production
# riêng) nhưng vẫn được mirror vào $RUNTIME_TREE/apps/account-bridge — thư mục
# runtime chỉ cần tự nhất quán, không cần khớp vị trí source trên host.
BRIDGE_DIR=$REPO/tools/account-bridge
WRANGLER=$REPO/node_modules/.bin/wrangler
PERSIST_DIR=${WIC_PERSIST_DIR:-/state}
# Cây runtime RW mà wrangler chạy trong đó — MIRROR cấu trúc per-app của repo
# dưới một cây `apps/` duy nhất (giải thích ở khối chuẩn bị dưới đây).
RUNTIME_TREE=$PERSIST_DIR/runtime

# HOME/XDG cô lập trong volume RW — wrangler đọc/ghi OAuth cache + registry dưới
# home; để trỏ về home của developer là rò trạng thái giữa các namespace.
export HOME=${WIC_WRANGLER_HOME:-$PERSIST_DIR/.wrangler-home}
export XDG_CONFIG_HOME=$HOME
mkdir -p "$HOME" "$PERSIST_DIR" || exit 1

log() {
  # Mỗi dòng một JSON; KHÔNG có giá trị env nào đi vào log.
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

# deps check fail-loud: thiếu binary là lỗi image/mount, chạy tiếp chỉ để hai
# process chết với thông điệp mơ hồ.
if [ ! -x "$WRANGLER" ]; then
  log '{"event":"wic.fatal","reason":"wrangler_binary_missing"}'
  exit 1
fi

# deps check fail-loud: bundle `dist/` phải có thật trên mount repo. Rỗng hay
# thiếu là lỗi chuỗi build upstream (target `build` của Nx chưa chạy — #247),
# không phải trạng thái wrangler tự phục hồi được: copy dist rỗng để wrangler
# chết với "entry-point not found" rồi restart loop là che mất nguyên nhân.
if [ ! -f "$AUTH_DIR/dist/main.js" ] || [ ! -f "$BRIDGE_DIR/dist/main.js" ]; then
  log '{"event":"wic.fatal","reason":"dist_missing"}'
  exit 1
fi

# ---------------------------------------------------------------------------
# Chuẩn bị cây runtime RW.
#
# Vì sao không chạy wrangler thẳng trong /repo: `.wrangler/tmp` per-app là
# đường ghi bắt buộc của wrangler dev (`getWranglerTmpDir` hard-code
# `<projectRoot>/.wrangler/tmp` — đo nguồn wrangler 4.152), mà repo mount RO
# chặn CẢ HAI cách "mở lỗ": mount rw-point riêng (runc mkdirat fail trên
# read-only rootfs TRƯỚC khi container chạy — đo thật) và symlink lúc runtime
# (`ln` trên bind mount RO là EROFS — đo thật).
#
# Cấu trúc được mirror: wrangler resolve module bằng chuỗi cha-đi-lên từ cwd —
# `apps/auth` cần `node_modules` CỦA app (pnpm isolated: `oidc-provider` nằm ở
# `apps/auth/node_modules`) RỒI node_modules gốc workspace. Cây mirror tái tạo
# đúng hai tầng đó bằng symlink vào repo RO (chỉ ĐỌC):
#
#   $RUNTIME_TREE/node_modules                  -> /repo/node_modules
#   $RUNTIME_TREE/apps/<app>/node_modules       -> <app dir>/node_modules
#   $RUNTIME_TREE/apps/<app>/wrangler.jsonc     (copy — `main: dist/main.js`
#                                                tương đối với config path)
#   $RUNTIME_TREE/apps/<app>/dist/              (copy — wrangler cần GHI metadata
#                                                cạnh bundle khi dev)
#
# `<app dir>` là vị trí source thật trên repo mount (auth: `apps/auth`, bridge:
# `tools/account-bridge`) — cây runtime đặt mọi worker dưới `apps/` dù source
# không cùng một thư mục gốc. Copy mỗi lần boot — stateless; source of truth
# của bundle là target `build` của Nx trên host. Nếu app không có node_modules
# riêng (bridge: toàn bộ dependency hoist ở root) thì tầng đó bị bỏ qua — đúng
# như repo.
# ---------------------------------------------------------------------------
rm -rf "$RUNTIME_TREE"
mkdir -p "$RUNTIME_TREE/apps" || exit 1
ln -s "$REPO/node_modules" "$RUNTIME_TREE/node_modules" || exit 1

for app_dir in "$AUTH_DIR" "$BRIDGE_DIR"; do
  app_name=$(basename "$app_dir")
  runtime_app="$RUNTIME_TREE/apps/$app_name"
  mkdir -p "$runtime_app" || exit 1
  cp "$app_dir/wrangler.jsonc" "$runtime_app/wrangler.jsonc" || exit 1
  cp -r "$app_dir/dist" "$runtime_app/dist" || exit 1
  if [ -d "$app_dir/node_modules" ]; then
    ln -s "$app_dir/node_modules" "$runtime_app/node_modules" || exit 1
  fi
done

# Registry dùng chung cho HAI process wrangler (PF6/PF7): service binding
# ACCOUNT_SERVICE của auth resolve shim qua registry — cả hai phải trỏ cùng một
# thư mục registry thì binding mới "connected" cross-process.
export WRANGLER_REGISTRY_PATH=$PERSIST_DIR/registry
export WRANGLER_SEND_METRICS=false
# CI mode: tắt telemetry prompt/progress UI, log ra stdout thuần cho docker logs.
export CI=true
# Cache `Request.cf` của miniflare: mặc định `node_modules/.mf` theo cwd — qua
# symlink là repo RO nên miniflare không mkdir được (warn + fallback placeholder
# mỗi boot). Trỏ sang điểm ghi của WIC để cache được ghi một lần rồi dùng lại.
export MINIFLARE_CACHE_DIR=$PERSIST_DIR/cache
# Secrets của worker đi vào QUA CONTAINER ENVS (kênh duy nhất của WIC — không
# argv/labels/log): wrangler dev mặc định KHÔNG đưa process env thành binding;
# biến này bảo wrangler nạp `process.env` vào bindings của worker. Giá trị được
# sinh ở tầng orchestration (`local-deploy`) bằng `pulumi.secret` → container
# envs của resource Docker — không qua đường nào khác.
export CLOUDFLARE_INCLUDE_PROCESS_ENV=true

AUTH_PID=""
BRIDGE_PID=""
SHUTDOWN=0

on_signal() {
  if [ "$SHUTDOWN" -eq 1 ]; then
    return
  fi
  SHUTDOWN=1
  log '{"event":"wic.shutdown","signal":"SIGTERM"}'
  for pid in "$BRIDGE_PID" "$AUTH_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  # Chờ bounded: hard-exit sau 20s nếu process con nào còn treo (workerd con
  # có thể cần thời gian; 20s là hào phóng so với default stop grace 10s →
  # stop_timeout của container là 30s ở Pulumi program, không cắt ngắn).
  waited=0
  while [ "$waited" -lt 20 ]; do
    alive=0
    for pid in "$BRIDGE_PID" "$AUTH_PID"; do
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        alive=1
      fi
    done
    [ "$alive" -eq 0 ] && break
    sleep 1
    waited=$((waited + 1))
  done
  for pid in "$BRIDGE_PID" "$AUTH_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  exit 0
}

trap on_signal TERM INT

# --- account-bridge (shim) lên TRƯỚC auth -------------------------------------
# Thứ tự bên trong WIC: shim trước, auth sau — auth đỏ `/ready` qua probe
# ACCOUNT_SERVICE cho tới khi shim đăng ký entry vào dev registry; đóng gói
# "shim trước" ở đây giúp cửa sổ đỏ ngắn nhất (thứ tự up GIỮA các stack —
# account trước auth — là việc của orchestration `local-deploy`).
# Output: hai process con kế thừa stdout/stderr của entrypoint (docker logs gộp
# chung, mỗi dòng wrangler tự mang bối cảnh tên worker) — KHÔNG redirect qua
# /proc/1/fd (fd 1 của PID 1 không ghi được bởi user node trên image slim).
# Hai process khởi động đồng thời, mỗi cái dò port inspector từ 9229
# (memoizeGetPort(9229)) rồi giao `InspectorProxyWorker` (workerIndex 1,
# `unsafeDirectSockets` entrypoint "default") bind — race TOCTOU: cả hai thấy
# 9229 trống rồi cùng bind, worker sau chết với
# `Address already in use (socket "direct:1:default")`. Ghim sẵn một port
# inspector khác nhau cho mỗi process (`--inspector-port`) bỏ dò port khỏi
# phương trình; WIC không cần debugger.
# Bind address KHÁC NHAU giữa hai worker (#267): miniflare mặc định bind
# localhost (127.0.0.1) — loopback-only trong netns của container. Worker
# `ecoma-auth` (4203) bind `--ip 0.0.0.0` vì router Traefik `Host(auth.fbi.com)`
# trỏ tới nó QUA Docker network (alias network không với tới loopback-only —
# thiếu flag thì mọi request ngoài vào là 502 trong khi healthcheck nội bộ vẫn
# xanh, lỗi vô hình qua health gate). Shim `ecoma-account-bridge` (4204) GIỮ
# bind mặc định loopback: chỉ auth worker gọi nó qua service binding nội bộ
# workerd (cùng container), không có poller nào ngoài network cần tới.
log '{"event":"wic.starting","worker":"ecoma-account-bridge"}'
(cd "$RUNTIME_TREE/apps/account-bridge" && exec "$WRANGLER" dev \
  --config "$RUNTIME_TREE/apps/account-bridge/wrangler.jsonc" \
  --persist-to "$PERSIST_DIR" \
  --inspector-port 9233 \
  ) &
BRIDGE_PID=$!

# --- auth ---------------------------------------------------------------------
log '{"event":"wic.starting","worker":"ecoma-auth"}'
(cd "$RUNTIME_TREE/apps/auth" && exec "$WRANGLER" dev \
  --config "$RUNTIME_TREE/apps/auth/wrangler.jsonc" \
  --ip 0.0.0.0 \
  --persist-to "$PERSIST_DIR" \
  --inspector-port 9234 \
  ) &
AUTH_PID=$!

log '{"event":"wic.started","workers":2}'

# Khi MỘT process chết, container phải chết để restart policy của Docker dựng
# lại cả cặp (readiness đỏ của một worker là trạng thái TẠM THỜI của stack;
# một nửa chết vĩnh viễn là trạng thái container SỐNG nhưng vô dụng — tình
# trạng tồi tệ hơn chết: mọi poller đều thấy shim xanh và tin vào auth).
while [ "$SHUTDOWN" -eq 0 ]; do
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    log '{"event":"wic.worker_exited","worker":"ecoma-account-bridge"}'
    exit 1
  fi
  if ! kill -0 "$AUTH_PID" 2>/dev/null; then
    log '{"event":"wic.worker_exited","worker":"ecoma-auth"}'
    exit 1
  fi
  sleep 2
done
