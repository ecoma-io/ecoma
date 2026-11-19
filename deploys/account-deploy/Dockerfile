# Image Docker cho `apps/account` ở LAN LOCAL deployment.
#
# (#386) Image KHÔNG còn build Nuxt trong image — build stage cũ (corepack,
# `pnpm install --frozen-lockfile`, cache mount pnpm store, `nuxt build
# --preset=node-server`) đã bị xoá toàn bộ. Nguồn sự thật của image là
# artifact `build:development` mà Nx build trước trong worktree:
#
#   pnpm nx run @ecoma-io/account:build:development
#
# — preset `node-server` (khối `$env['node-docker']` trong `nuxt.config.ts`),
# artifact `.output-node/` standalone: `server/index.mjs` + traced runtime
# deps nằm NGAY TRONG artifact (`server/node_modules/`, được mở lại tường
# minh trong `.dockerignore` vì blacklist `**/node_modules` gốc cắt nó).
# Target `local-build` của deploy project chạy lệnh trên trước khi image
# build; nó là `dependsOn` của `local-up` nên Nx ghim thứ tự.
#
# Build context vẫn là REPO ROOT: Dockerfile nằm ở `deploys/account-deploy`
# nhưng mọi path COPY là path tương đối với context root. Thiếu artifact
# phải ĐỎ ngay ở docker build (`RUN test -f`), không phải lúc container chạy.
#
# Preset Nitro `cloudflare-module` của app (`apps/account/nitro.config.ts`) là
# đường staging/production trên Cloudflare Workers — image này KHÔNG đụng
# tới và artifact `.output` của nó không vào image.

# Ghim theo DIGEST, không theo tag — cùng lý do với Traefik/PostgreSQL trong
# `deploys/platform-deploy/index.ts`: tag trôi biến thay đổi toolchain thành
# thay đổi hạ tầng ngoài ý muốn, image không tái lập được.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE}

WORKDIR /app

# Artifact đã build trước: entrypoint + static assets + traced deps.
COPY apps/account/.output-node/ ./

# Fail-loud khi artifact thiếu/chưa build: đỏ tại docker build, không chờ boot.
RUN test -f ./server/index.mjs

ENV NODE_ENV=production
ENV PORT=3000

# Không `EXPOSE` cổng host nào: container chỉ nghe trong Docker network của
# platform, Traefik route tới nó qua alias. `EXPOSE` chỉ là tài liệu metadata.
EXPOSE 3000

# `node:24` đã có user `node` (uid 1000) sẵn; chạy non-root để container không
# cần quyền ghi gì ngoài filesystem của chính nó.
USER node

CMD ["node", "/app/server/index.mjs"]
