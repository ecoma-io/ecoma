# Image WIC (worker-in-container) của cặp `push-notification` +
# `web-push-notification-job` ở LAN LOCAL deployment.
#
# Container này KHÔNG build code: nó chạy `wrangler dev` (local mode) từ mount
# read-only của repo — build bundle là việc của target `build` Nx trên host
# (bundle `dist/` mount vào lúc container start). Image phái sinh từ Node pin
# của repo + `ca-certificates` (PF2 — workerd fail khởi động service `internet`
# khi thiếu CA hệ thống).
#
# Mirror `deploys/transactional-mail-deploy/Dockerfile`: image "mỏng" — image
# môi trường chạy (repo sống ngoài image qua mount), KHÔNG phải image runtime
# đóng gói artifact.
#
# NOTE: file này KHÔNG vào build context (`.dockerignore` chặn `deploys/*`,
# re-include đúng MỘT file entrypoint) — docker build đọc nó từ đường tường
# minh mà Pulumi program truyền (`dockerfile: { location: ... }`), không qua
# context send.

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE}

# PF2: workerd đòi CA hệ thống; thiếu là lỗi khởi động tường minh.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Entrypoint giữ PID 1 để nhận SIGTERM và chuyển xuống cả hai process wrangler
# (control plane + consumer) — docker stop phải tắt được CẢ HAI worker, không
# để orphan giữ dev registry + persist dir.
COPY deploys/push-notification-deploy/wic-entrypoint.sh /usr/local/bin/wic-entrypoint.sh
RUN chmod +x /usr/local/bin/wic-entrypoint.sh

# Chạy bằng user `node` có sẵn của image — mount repo của developer không bị
# ghi bằng root (repo mount read-only; root-owned file giữa cây của developer
# là ô nhiễm thư mục thật). Volume /state được init container chown 1000:1000
# trước khi container này lên.
USER node

ENTRYPOINT ["/usr/local/bin/wic-entrypoint.sh"]
