#!/bin/sh
# Entrypoint của WIC container (remote-cache-deploy) — chạy MỘT worker
# `wrangler dev`:
#
#   1. ecoma-remote-cache     (apps/remote-cache)     -> HTTP :4207 (dev.port của wrangler.jsonc)
#
# Copy-adapt từ `deploys/pact-broker-api-deploy/wic-entrypoint.sh` (pattern WIC
# chung, nguồn gần nhất cùng hình MỘT worker); khác auth ở: MỘT worker thay vì
# HAI (không có shim bridge, không cần dev registry cross-process), và KHÔNG có
# readiness container nội bộ — readiness của container do Docker healthcheck
# đảm nhiệm (probe `GET /health` của worker, không chạm DB — thiết kế của app).
#
# Container chạy trên platform network (02-account-auth.md §Database access):
#   - Repo mount READ-ONLY tại /repo: bundle `dist/` (build trên host, mount
#     bind ro vào đúng vị trí) + wrangler.jsonc là input; KHÔNG gì ghi được
#     xuống đây.
#   - Volume RW duy nhất tại /state ($PERSIST_DIR): state wrangler
#     (`--persist-to`), thư mục runtime per-app, dev registry.
#   - Biến môi trường do Pulumi container `envs` cấp (kênh container env):
#     * CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_REMOTE_CACHE (PF3) —
#       connection string db-remote-cache với sslmode=disable (PF4: workerd
#       dial thẳng host:port trong platform network).
#     * Secrets (nếu có sau này) chỉ qua env, không argv, không label, không log.
#
# Shell Signals: `sh` là PID 1, wrangler chạy background; trap SIGTERM/SIGINT
# chuyển tiếp rồi chờ — `docker stop` tắt được worker thay vì để orphan cầm
# dev registry + connection pool PostgreSQL.

set -u

REPO=/repo
API_DIR=$REPO/apps/remote-cache
WRANGLER=$REPO/node_modules/.bin/wrangler
PERSIST_DIR=${WIC_PERSIST_DIR:-/state}
# Cây runtime RW mà wrangler chạy trong đó — mirror cấu trúc per-app của repo
# (giải thích đầy đủ ở khối chuẩn bị dưới đây).
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

# deps check fail-loud: thiếu binary là lỗi image/mount, chạy tiếp chỉ để process
# chết với thông điệp mơ hồ.
if [ ! -x "$WRANGLER" ]; then
  log '{"event":"wic.fatal","reason":"wrangler_binary_missing"}'
  exit 1
fi

# ---------------------------------------------------------------------------
# Chuẩn bị cây runtime RW.
#
# Vì sao không chạy wrangler thẳng trong /repo: `.wrangler/tmp` per-app là
# đường ghi bắt buộc của wrangler dev (`getWranglerTmpDir` hard-code
# `<projectRoot>/.wrangler/tmp`), mà repo mount RO chặn CẢ HAI cách "mở lỗ":
# mount rw-point riêng (runc mkdirat fail trên read-only rootfs) và symlink
# lúc runtime (`ln` trên bind mount RO là EROFS) — đo thật ở auth-deploy.
#
# Cấu trúc được mirror: wrangler resolve module bằng chuỗi cha-đi-lên từ cwd —
# `apps/remote-cache` cần `node_modules` của app (pnpm isolated: `hono`/`pg`
# nằm ở `apps/remote-cache/node_modules`) RỒI node_modules gốc workspace.
# Cây mirror tái tạo đúng hai tầng đó bằng symlink vào repo RO (chỉ ĐỌC):
#
#   $RUNTIME_TREE/node_modules                       -> /repo/node_modules
#   $RUNTIME_TREE/apps/<app>/node_modules            -> <app dir>/node_modules
#   $RUNTIME_TREE/apps/<app>/wrangler.jsonc          (copy — `main: dist/main.js`
#                                                     tương đối với config path)
#   $RUNTIME_TREE/apps/<app>/dist/                   (copy — wrangler cần GHI
#                                                     metadata cạnh bundle khi dev)
#
# Copy mỗi lần boot — stateless; source of truth của bundle là target `build`
# của Nx trên host. Nếu app không có node_modules riêng thì tầng đó bị bỏ qua —
# đúng như repo.
# ---------------------------------------------------------------------------
rm -rf "$RUNTIME_TREE"
mkdir -p "$RUNTIME_TREE/apps" || exit 1
ln -s "$REPO/node_modules" "$RUNTIME_TREE/node_modules" || exit 1

app_name=$(basename "$API_DIR")
runtime_app="$RUNTIME_TREE/apps/$app_name"
mkdir -p "$runtime_app" || exit 1
cp "$API_DIR/wrangler.jsonc" "$runtime_app/wrangler.jsonc" || exit 1
# Bundle `dist/` là input bắt buộc (build trên host bởi target `build` của Nx).
# Thiếu nó (chưa build, hoặc Docker đã tự tạo bind-mount rỗng trên host) phải
# fail-loud với reason nhận diện được — `cp -r` im lặng trên mount rỗng chỉ để
# wrangler chết sau với lỗi mơ hồ, restart loop không chẩn đoán được.
if [ ! -d "$API_DIR/dist" ] || [ ! -f "$API_DIR/dist/main.js" ]; then
  log '{"event":"wic.fatal","reason":"dist_missing"}'
  exit 1
fi
cp -r "$API_DIR/dist" "$runtime_app/dist" || exit 1
if [ -d "$API_DIR/node_modules" ]; then
  ln -s "$API_DIR/node_modules" "$runtime_app/node_modules" || exit 1
fi

# Registry + telemetry + cache: cùng cơ chế với auth-deploy (WIC không đi qua
# `local-worker-up` của host nên tự set đầy đủ).
export WRANGLER_REGISTRY_PATH=$PERSIST_DIR/registry
export WRANGLER_SEND_METRICS=false
# CI mode: tắt telemetry prompt/progress UI, log ra stdout thuần cho docker logs.
export CI=true
# Cache `Request.cf` của miniflare: mặc định `node_modules/.mf` theo cwd — qua
# symlink là repo RO nên miniflare không mkdir được. Trỏ sang điểm ghi của WIC.
export MINIFLARE_CACHE_DIR=$PERSIST_DIR/cache
# Secrets của worker đi vào QUA CONTAINER ENVS (kênh duy nhất của WIC — không
# argv/labels/log): wrangler dev mặc định KHÔNG đưa process env thành binding;
# biến này bảo wrangler nạp `process.env` vào bindings của worker (PF3: env
# `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_REMOTE_CACHE` trở thành connection
# string của binding Hyperdrive local).
export CLOUDFLARE_INCLUDE_PROCESS_ENV=true

API_PID=""
SHUTDOWN=0

on_signal() {
  if [ "$SHUTDOWN" -eq 1 ]; then
    return
  fi
  SHUTDOWN=1
  log '{"event":"wic.shutdown","signal":"SIGTERM"}'
  if [ -n "$API_PID" ] && kill -0 "$API_PID" 2>/dev/null; then
    kill -TERM "$API_PID" 2>/dev/null || true
  fi
  # Chờ bounded: hard-exit sau 20s nếu process con còn treo (workerd có thể
  # cần thời gian thoát sạch; 20s hào phóng so với default stop grace 10s →
  # stop_timeout của container là 30s ở Pulumi program, không cắt ngắn).
  waited=0
  while [ "$waited" -lt 20 ]; do
    if [ -z "$API_PID" ] || ! kill -0 "$API_PID" 2>/dev/null; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if [ -n "$API_PID" ]; then
    kill -KILL "$API_PID" 2>/dev/null || true
  fi
  exit 0
}

trap on_signal TERM INT

# --- ecoma-remote-cache -----------------------------------------------------
# Output: process con kế thừa stdout/stderr của entrypoint (docker logs gộp
# chung). Wrangler dò port inspector từ 9229 — WIC không cần debugger, ghim
# sẵn một port riêng bỏ dò port khỏi phương trình (cùng lý do auth-deploy).
# `--ip 0.0.0.0` (#267): miniflare mặc định bind localhost (127.0.0.1) —
# loopback-only trong netns của container, mà consumer gọi API này QUA Docker
# network (alias `ecoma-remote-cache`, không với tới loopback-only) — thiếu
# flag thì mọi call của consumer là ECONNREFUSED trong khi healthcheck nội bộ
# (probe 127.0.0.1 trong chính container) vẫn xanh, lỗi vô hình qua health
# gate. Cùng lý giải với `--ip 0.0.0.0` của mail/push WIC. Consumer BFF cố
# định của context này (backoffice) chưa wire ở local (P1.4 chỉ dựng unit —
# wiring BFF thuộc giai đoạn sau), nên alias là contract cho unit tương lai.
log '{"event":"wic.starting","worker":"ecoma-remote-cache"}'
(cd "$RUNTIME_TREE/apps/remote-cache" && exec "$WRANGLER" dev \
  --config "$RUNTIME_TREE/apps/remote-cache/wrangler.jsonc" \
  --ip 0.0.0.0 \
  --persist-to "$PERSIST_DIR" \
  --inspector-port 9235 \
  ) &
API_PID=$!

log '{"event":"wic.started","workers":1}'

# Khi process chết, container phải chết để restart policy của Docker dựng lại
# (exit non-zero -> `unless-stopped` restart).
while [ "$SHUTDOWN" -eq 0 ]; do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    log '{"event":"wic.worker_exited","worker":"ecoma-remote-cache"}'
    exit 1
  fi
  sleep 2
done
