#!/bin/sh
# Entrypoint của WIC container (transactional-mail-deploy) — chạy HAI worker
# `wrangler dev`:
#
#   1. ecoma-transactional-mail       (apps/transactional-mail)       -> HTTP :4206 (--port)
#   2. ecoma-transactional-mailer-job (apps/transactional-mailer-job) -> HTTP :4207 (--port)
#
# Container chạy trên platform network:
#   - Repo mount READ-ONLY tại /repo: bundle `dist/` (build trên host, mount
#     bind ro vào đúng vị trí) + wrangler.jsonc là input; KHÔNG gì ghi được
#     xuống đây.
#   - Volume RW duy nhất tại /state ($PERSIST_DIR): state wrangler
#     (`--persist-to` của HAI worker), thư mục runtime per-app, dev registry.
#   - Biến môi trường do Pulumi container `envs` cấp (kênh container env):
#     registry credential của control plane, secret cặp consumer<->control
#     plane, keyring/quarantine — chỉ qua env, không argv, không label, không
#     log.
#
# Thứ tự boot: control plane TRƯỚC consumer, CÓ readiness gate — entrypoint
# poll `/health` của control plane tới 200 rồi mới spawn consumer. Hai lý do:
# (1) binding TRANSACTIONAL_MAIL_SERVICE của consumer chỉ `[connected]` khi
# control plane đã đăng ký registry entry (spike §2); (2) hai worker chia cùng
# persist dir nên boot đồng thời hai workerd lần đầu mở metadata SQLite chung
# của miniflare là SQLITE_BUSY chết control plane (boot-proof đã chứng minh) —
# gate bảo đảm consumer chỉ mở persist dir sau khi control plane serve HTTP.
#
# KHÁC auth entrypoint ở HAI điểm:
#   1. `--port` tường minh cho TỪNG process: hai wrangler.jsonc của mail KHÔNG
#      khai `dev.port`, không flag thì CẢ HAI bind mặc định 8787 — process sau
#      chết `Address already in use`. Control plane là port account gọi tới
#      (NUXT_MAIL_SERVICE_URL) nên đã được Pulumi program ghim 4206.
#   2. `--ip 0.0.0.0` cho CẢ HAI: miniflare mặc định bind `localhost`
#      (127.0.0.1) — loopback-only trong netns của container, alias network
#      `ecoma-mail` không với tới được. Consumer bind 0.0.0.0 vô hại (không
#      publish port, không route Traefik; cả container chỉ nghe trong network
#      nội bộ).
#
# Shell Signals: `sh` là PID 1, hai wrangler chạy background; trap SIGTERM/SIGINT
# chuyển tiếp cho cả hai rồi chờ — `docker stop` tắt được CẢ HAI worker thay vì
# để orphan cầm dev registry + persist dir.

set -u

REPO=/repo
MAIL_DIR=$REPO/apps/transactional-mail
JOB_DIR=$REPO/apps/transactional-mailer-job
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

# ---------------------------------------------------------------------------
# Chuẩn bị cây runtime RW.
#
# Vì sao không chạy wrangler thẳng trong /repo: `.wrangler/tmp` per-app là
# đường ghi bắt buộc của wrangler dev (`getWranglerTmpDir` hard-code
# `<projectRoot>/.wrangler/tmp`), mà repo mount RO chặn CẢ HAI cách "mở lỗ":
# mount rw-point riêng (runc mkdirat fail trên read-only rootfs TRƯỚC khi
# container chạy) và symlink lúc runtime (`ln` trên bind mount RO là EROFS).
#
# Cấu trúc được mirror: wrangler resolve module bằng chuỗi cha-đi-lên từ cwd —
# `apps/transactional-mail` cần `node_modules` CỦA app (pnpm isolated: các lib
# workspace nằm ở `apps/<app>/node_modules`) RỒI node_modules gốc workspace.
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
# của Nx trên host. Cả hai app đều có node_modules riêng (workspace deps) nên
# tầng per-app luôn được symlink.
# ---------------------------------------------------------------------------
rm -rf "$RUNTIME_TREE"
mkdir -p "$RUNTIME_TREE/apps" || exit 1
ln -s "$REPO/node_modules" "$RUNTIME_TREE/node_modules" || exit 1

for app_dir in "$MAIL_DIR" "$JOB_DIR"; do
  app_name=$(basename "$app_dir")
  runtime_app="$RUNTIME_TREE/apps/$app_name"
  mkdir -p "$runtime_app" || exit 1
  cp "$app_dir/wrangler.jsonc" "$runtime_app/wrangler.jsonc" || exit 1
  cp -r "$app_dir/dist" "$runtime_app/dist" || exit 1
  if [ -d "$app_dir/node_modules" ]; then
    ln -s "$app_dir/node_modules" "$runtime_app/node_modules" || exit 1
  fi
done

# Registry dùng chung cho HAI process wrangler: service binding
# TRANSACTIONAL_MAIL_SERVICE của consumer resolve control plane qua registry —
# cả hai phải trỏ cùng một thư mục registry thì binding mới "connected"
# cross-process (spike §2).
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
# bọc `pulumi.secret` ở Pulumi program → container envs — không qua đường khác.
export CLOUDFLARE_INCLUDE_PROCESS_ENV=true

MAIL_PID=""
JOB_PID=""
SHUTDOWN=0

on_signal() {
  if [ "$SHUTDOWN" -eq 1 ]; then
    return
  fi
  SHUTDOWN=1
  log '{"event":"wic.shutdown","signal":"SIGTERM"}'
  for pid in "$JOB_PID" "$MAIL_PID"; do
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
    for pid in "$JOB_PID" "$MAIL_PID"; do
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        alive=1
      fi
    done
    [ "$alive" -eq 0 ] && break
    sleep 1
    waited=$((waited + 1))
  done
  for pid in "$JOB_PID" "$MAIL_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  exit 0
}

trap on_signal TERM INT

# --- control plane (ecoma-transactional-mail) lên TRƯỚC, ĐỢI /health, rồi
# --- consumer ------------------------------------------------------------------
# Thứ tự bên trong WIC MÔ PHỎNG đúng topo boot tuần tự của host orchestration
# (`worker-orchestration.ts` chờ readiness control plane trước khi spawn
# consumer; script e2e cũng vậy): control plane start trước, entrypoint POLL
# `GET /health` tới khi 200 rồi mới spawn consumer.
#
# Vì sao cần readiness gate mà không chỉ thứ tự start: hai worker chia CÙNG
# persist dir (`--persist-to`), tức CÙNG metadata SQLite nội bộ của miniflare
# (`v3/d1/miniflare-D1DatabaseObject/metadata.sqlite`). Boot ĐỒNG THỜI hai
# workerd lần đầu mở chung SQLite đó là SQLITE_BUSY (`database is locked`)
# chết control plane ngay lúc khởi động — chứng minh bằng boot-proof 2 lần.
# Gate `/health` bảo đảm consumer chỉ mở persist dir sau khi control plane đã
# mở xong (wrapper dev của control plane tạo xong storage scope trước khi bind
# HTTP), xoá cửa sổ race.
#
# Output: hai process con kế thừa stdout/stderr của entrypoint (docker logs gộp
# chung, mỗi dòng wrangler tự mang bối cảnh tên worker) — KHÔNG redirect qua
# /proc/1/fd (fd 1 của PID 1 không ghi được bởi user node trên image slim).
# Hai process ghim `--port` KHÁC nhau (4206/4207 — không flag thì cả hai rơi về
# 8787 và process sau chết) và `--inspector-port` khác nhau (9235/9236 — race
# TOCTOU dò port từ 9229 khiến worker sau chết `Address already in use`
# (socket "direct:1:default"); WIC không cần debugger).
log '{"event":"wic.starting","worker":"ecoma-transactional-mail"}'
(cd "$RUNTIME_TREE/apps/transactional-mail" && exec "$WRANGLER" dev \
  --config "$RUNTIME_TREE/apps/transactional-mail/wrangler.jsonc" \
  --port 4206 \
  --ip 0.0.0.0 \
  --persist-to "$PERSIST_DIR" \
  --inspector-port 9235 \
  ) &
MAIL_PID=$!

# Gate: poll /health của control plane (fetch của node — không curl/wget trên
# image slim). Bounded 120s; quá hạn là control plane không bao giờ ready →
# chết fail-loud thay vì spawn consumer lên persist dir chưa ổn định.
# kill -0 giữa chừng: control plane chết trong lúc chờ thì khỏi chờ nốt.
log '{"event":"wic.health_wait","worker":"ecoma-transactional-mail"}'
health_wait=0
until node -e "fetch('http://127.0.0.1:4206/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
  if ! kill -0 "$MAIL_PID" 2>/dev/null; then
    log '{"event":"wic.worker_exited","worker":"ecoma-transactional-mail"}'
    exit 1
  fi
  if [ "$health_wait" -ge 120 ]; then
    log '{"event":"wic.fatal","reason":"control_plane_health_timeout"}'
    exit 1
  fi
  sleep 1
  health_wait=$((health_wait + 1))
done
log '{"event":"wic.ready","worker":"ecoma-transactional-mail"}'

# --- consumer -----------------------------------------------------------------
log '{"event":"wic.starting","worker":"ecoma-transactional-mailer-job"}'
(cd "$RUNTIME_TREE/apps/transactional-mailer-job" && exec "$WRANGLER" dev \
  --config "$RUNTIME_TREE/apps/transactional-mailer-job/wrangler.jsonc" \
  --port 4207 \
  --ip 0.0.0.0 \
  --persist-to "$PERSIST_DIR" \
  --inspector-port 9236 \
  ) &
JOB_PID=$!

log '{"event":"wic.started","workers":2}'

# Khi MỘT process chết, container phải chết để restart policy của Docker dựng
# lại cả cặp (một nửa chết vĩnh viễn là trạng thái container SỐNG nhưng vô
# dụng — tình trạng tồi tệ hơn chết).
while [ "$SHUTDOWN" -eq 0 ]; do
  if ! kill -0 "$MAIL_PID" 2>/dev/null; then
    log '{"event":"wic.worker_exited","worker":"ecoma-transactional-mail"}'
    exit 1
  fi
  if ! kill -0 "$JOB_PID" 2>/dev/null; then
    log '{"event":"wic.worker_exited","worker":"ecoma-transactional-mailer-job"}'
    exit 1
  fi
  sleep 2
done
