# Image WIC (worker-in-container) của `apps/auth` ở LAN LOCAL deployment.
#
# Container này KHÔNG build code: nó chạy `wrangler dev` (local mode) từ mount
# read-only của repo — build bundle là việc của `wrangler dev` lúc khởi động,
# đúng đường code canonical mà local worker runtime (`tools/dx`) dùng cho mọi
# worker khác. 02-account-auth.md §Database access: image phái sinh từ Node pin của
# repo + `ca-certificates` (PF2 — workerd fail khởi động service `internet`
# khi thiếu CA hệ thống).
#
# Vì sao image "mỏng" khác `account-deploy/Dockerfile`: account là image runtime
# (artifact build đi vào image); auth là image môi trường chạy (repo sống ngoài
# image qua mount). Version pnpm/corepack theo `packageManager` của repo.

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE}

# PF2: workerd đòi CA hệ thống; thiếu là lỗi khởi động tường minh.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Corepack để chạy đúng pnpm ghim trong `packageManager` của repo (pnpm 12.x
# cần cho workspace install --offline bên trong container — không cài pnpm bằng
# npm -g để tránh trôi version khỏi ghim của repo).
RUN corepack enable

WORKDIR /repo

# Entrypoint giữ PID 1 để nhận SIGTERM và chuyển xuống cả hai process wrangler
# (auth + account-bridge) — docker stop phải tắt được CẢ HAI worker, không để
# orphan giữ dev registry + persist dir.
COPY deploys/auth-deploy/wic-entrypoint.sh /usr/local/bin/wic-entrypoint.sh
RUN chmod +x /usr/local/bin/wic-entrypoint.sh

# Chạy bằng user `node` có sẵn của image — mount repo của developer không bị
# ghi bằng root (repo mount read-only, nhưng node_modules mount rw cho wrangler
# ghi cache; root-owned file giữa cây của developer là ô nhiễm thư mục thật).
USER node

ENTRYPOINT ["/usr/local/bin/wic-entrypoint.sh"]
