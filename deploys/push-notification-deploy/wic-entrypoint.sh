#!/bin/sh
# Entrypoint của WIC container (push-notification-deploy) — chạy HAI worker
# `wrangler dev`:
#
#   1. ecoma-push-notification        (apps/push-notification)        -> HTTP :4208 (--port)
#   2. ecoma-web-push-notification-job (apps/web-push-notification-job) -> HTTP :4209 (--port)
#
# Copy-adapt từ `deploys/transactional-mail-deploy/wic-entrypoint.sh` (pattern
# WIC hai worker của wave 2, issue #264). Container chạy trên platform network:
#   - Repo mount READ-ONLY tại /repo: bundle `dist/` (build trên host, mount
#     bind ro vào đúng vị trí) + wrangler.jsonc là input; KHÔNG gì ghi được
#     xuống đây.
#   - Volume RW duy nhất tại /state ($PERSIST_DIR): state wrangler
#     (`--persist-to` của HAI worker), thư mục runtime per-app, dev registry.
#   - Biến môi trường do Pulumi container `envs` cấp (kênh container env):
#     secret cặp control plane<->consumer, token Admin/Application, root key
#     credential — chỉ qua env, không argv, không label, không log.
#
# Thứ tự boot: control plane TRƯỚC consumer, CÓ readiness gate. Hai lý do
# (cùng lập luận mail): (1) binding PUSH_NOTIFICATION_SERVICE của consumer chỉ
# `[connected]` khi control plane đã đăng ký registry entry; (2) hai worker
# chia cùng persist dir nên boot đồng thời hai workerd lần đầu mở metadata
# SQLite chung của miniflare là SQLITE_BUSY chết control plane — gate bảo đảm
# consumer chỉ mở persist dir sau khi control plane serve HTTP.
#
# KHÁC mail ở readiness gate: control plane push KHÔNG có route `/health`
# (src/main.ts chỉ có /v1/notifications, /internal/**, /admin/v1/**) nên poll
# HTTP sẽ timeout vĩnh viễn. Gate ở đây đọc stdout của wrangler control plane
# và chờ banner `Ready on http` (cùng readiness declaration `log-banner` mà
# `apps/push-notification/local-worker.jsonc` khai cho host lane) — wrangler in
# banner SAU khi workerd bind HTTP, nên gate bảo đảm đúng điều kiện "serve
# được HTTP" mà poll `/health` của mail bảo đảm.
#
# Giống mail: `--port` tường minh cho TỪNG process (4208/4209 — hai
# wrangler.jsonc của push không khai dev.port, không flag thì cả hai bind
# 8787), `--ip 0.0.0.0` cho CẢ HAI (alias network không với tới loopback-only),
# `--inspector-port` khác nhau (9235/9236 — race TOCTOU dò port từ 9229).
#
# Shell Signals: `sh` là PID 1, hai wrangler chạy background; trap
# SIGTERM/SIGINT chuyển tiếp cho cả hai rồi chờ — `docker stop` tắt được CẢ HAI
# worker thay vì để orphan cầm dev registry + persist dir.

set -u

REPO=/repo
PUSH_DIR=$REPO/apps/push-notification
JOB_DIR=$REPO/apps/web-push-notification-job
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
# Chuẩn bị cây runtime RW — cùng lý do và cùng cấu trúc với mail entrypoint:
# `.wrangler/tmp` per-app là đường ghi bắt buộc của wrangler dev, repo mount RO
# chặn mọi cách "mở lỗ"; cây mirror tái tạo hai tầng node_modules (app +
# workspace) bằng symlink vào repo RO, copy `wrangler.jsonc` + `dist/`.
#
#   $RUNTIME_TREE/node_modules                              -> /repo/node_modules
#   $RUNTIME_TREE/apps/<app>/node_modules                   -> <app dir>/node_modules
#   $RUNTIME_TREE/apps/<app>/wrangler.jsonc                 (copy)
#   $RUNTIME_TREE/apps/<app>/dist/                          (copy)
#
# Bundle `dist/` là input bắt buộc (build trên host bởi target `build` của Nx)
# — thiếu là fail-loud `dist_missing` thay vì wrangler chết sau với lỗi mơ hồ.
# ---------------------------------------------------------------------------
rm -rf "$RUNTIME_TREE"
mkdir -p "$RUNTIME_TREE/apps" || exit 1
ln -s "$REPO/node_modules" "$RUNTIME_TREE/node_modules" || exit 1

for app_dir in "$PUSH_DIR" "$JOB_DIR"; do
  app_name=$(basename "$app_dir")
  runtime_app="$RUNTIME_TREE/apps/$app_name"
  mkdir -p "$runtime_app" || exit 1
  cp "$app_dir/wrangler.jsonc" "$runtime_app/wrangler.jsonc" || exit 1
  if [ ! -d "$app_dir/dist" ] || [ ! -f "$app_dir/dist/main.js" ]; then
    log "{\"event\":\"wic.fatal\",\"reason\":\"dist_missing\",\"app\":\"$app_name\"}"
    exit 1
  fi
  cp -r "$app_dir/dist" "$runtime_app/dist" || exit 1
  if [ -d "$app_dir/node_modules" ]; then
    ln -s "$app_dir/node_modules" "$runtime_app/node_modules" || exit 1
  fi
done

# Registry dùng chung cho HAI process wrangler: service binding
# PUSH_NOTIFICATION_SERVICE của consumer resolve control plane qua registry —
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

PUSH_PID=""
JOB_PID=""
SHUTDOWN=0

on_signal() {
  if [ "$SHUTDOWN" -eq 1 ]; then
    return
  fi
  SHUTDOWN=1
  log '{"event":"wic.shutdown","signal":"SIGTERM"}'
  for pid in "$JOB_PID" "$PUSH_PID"; do
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
    for pid in "$JOB_PID" "$PUSH_PID"; do
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        alive=1
      fi
    done
    [ "$alive" -eq 0 ] && break
    sleep 1
    waited=$((waited + 1))
  done
  for pid in "$JOB_PID" "$PUSH_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  exit 0
}

trap on_signal TERM INT

# --- control plane (ecoma-push-notification) lên TRƯỚC, ĐỢI banner, rồi
# --- consumer --------------------------------------------------------------
# Readiness gate bằng BANNER (khác mail dùng poll /health — control plane push
# không có route đó): stdout của wrangler control plane được tee vào một FIFO
# để entrypoint vừa giữ log gộp chung vừa dò banner `Ready on http`. Banner
# xuất hiện sau khi workerd bind HTTP — đúng điều kiện "serve được HTTP".
#
# KHÔNG dùng `grep -q` trên pipe trực tiếp: grep thoát ngay khi thấy banner làm
# SIGPIPE về phía wrangler ở lần ghi sau; tee -a vào file log là trạng thái
# vô hại (file nằm trong volume ephemeral), còn grep đọc file theo vòng poll.
log '{"event":"wic.starting","worker":"ecoma-push-notification"}'
BOOT_LOG=$PERSIST_DIR/boot-push.log
: >"$BOOT_LOG"
(cd "$RUNTIME_TREE/apps/push-notification" && exec "$WRANGLER" dev \
  --config "$RUNTIME_TREE/apps/push-notification/wrangler.jsonc" \
  --port 4208 \
  --ip 0.0.0.0 \
  --persist-to "$PERSIST_DIR" \
  --inspector-port 9235 \
  ) 2>&1 | tee -a "$BOOT_LOG" &
PUSH_PID=$!

# Gate: poll boot log tới khi thấy banner Ready của wrangler. Bounded 120s;
# quá hạn là control plane không bao giờ ready → chết fail-loud thay vì spawn
# consumer lên persist dir chưa ổn định. kill -0 giữa chừng: control plane
# chết trong lúc chờ (kể cả pipeline tee) thì khỏi chờ nốt.
log '{"event":"wic.health_wait","worker":"ecoma-push-notification"}'
health_wait=0
until grep -q 'Ready on http' "$BOOT_LOG" 2>/dev/null; do
  if ! kill -0 "$PUSH_PID" 2>/dev/null; then
    log '{"event":"wic.worker_exited","worker":"ecoma-push-notification"}'
    exit 1
  fi
  if [ "$health_wait" -ge 120 ]; then
    log '{"event":"wic.fatal","reason":"control_plane_boot_timeout"}'
    exit 1
  fi
  sleep 1
  health_wait=$((health_wait + 1))
done
log '{"event":"wic.ready","worker":"ecoma-push-notification"}'

# --- consumer --------------------------------------------------------------
log '{"event":"wic.starting","worker":"ecoma-web-push-notification-job"}'
(cd "$RUNTIME_TREE/apps/web-push-notification-job" && exec "$WRANGLER" dev \
  --config "$RUNTIME_TREE/apps/web-push-notification-job/wrangler.jsonc" \
  --port 4209 \
  --ip 0.0.0.0 \
  --persist-to "$PERSIST_DIR" \
  --inspector-port 9236 \
  ) &
JOB_PID=$!

log '{"event":"wic.started","workers":2}'

# Khi MỘT process chết, container phải chết để restart policy của Docker dựng
# lại cả cặp (một nửa chết vĩnh viễn là trạng thái container SỐNG nhưng vô
# dụng — tình trạng tồi tệ hơn chết). Lưu ý pipeline tee: $PUSH_PID là PID của
# tee (process cuối pipeline); wrangler chết → tee hết stdin chết theo trong
# vài giây, và gate `kill -0` bên dưới bắt được điều đó (bounded bởi vòng sleep
# 2s — chưa đủ sớm để cặp worker chết nửa được coi là khoẻ, đủ để không treo
# vĩnh viễn).
while [ "$SHUTDOWN" -eq 0 ]; do
  if ! kill -0 "$PUSH_PID" 2>/dev/null; then
    log '{"event":"wic.worker_exited","worker":"ecoma-push-notification"}'
    exit 1
  fi
  if ! kill -0 "$JOB_PID" 2>/dev/null; then
    log '{"event":"wic.worker_exited","worker":"ecoma-web-push-notification-job"}'
    exit 1
  fi
  sleep 2
done
