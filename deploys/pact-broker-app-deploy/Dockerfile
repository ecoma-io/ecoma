# Image Docker cho `apps/pact-broker-app` ở LAN LOCAL deployment.
#
# Preset Nitro của app là `cloudflare-module` (`apps/pact-broker-app/nitro
# config.ts`) — đường deploy staging/production trên Cloudflare Workers qua
# Wrangler, và file Dockerfile này KHÔNG đụng tới nó. Local deployment chạy app
# trong Docker với preset `node-server`: override qua **build-time flag**
# `--preset=node-server` của Nuxt CLI (thắng giá trị `preset` trong config
# file), không sửa `nitro.config.ts` — cùng cách `home-deploy`,
# `backoffice-deploy` và `account-deploy` đã làm.
#
# Build context là REPO ROOT (không phải thư mục chứa Dockerfile): monorepo
# pnpm workspace có `libs/ui-app-shell` và `libs/ui-ecoma-logo` là workspace
# dependency của app, và `pnpm-workspace.yaml` + `pnpm-lock.yaml` + `patches/`
# đều nằm ở root. `deploys/pact-broker-app-deploy` sở hữu việc đóng gói image
# nhưng mọi path COPY bên dưới là path tương đối với context root.
#
# Closure của app (đối chiếu `.dockerignore` ở root và spec
# `tools/dx/src/docker-context.spec.ts`): `libs/ui-app-shell` (alias
# `@ecoma-io/ui-app-shell` trong `nuxt.config.ts` trỏ thẳng vào
# `src/index.ts`; CSS entry `src/styles/app-shell.css` được import qua
# relative path từ `app/assets/css/styles.css`) và `libs/ui-ecoma-logo`
# (alias `@ecoma-io/ui-ecoma-logo` + `@source` của Tailwind). Hai lib này là
# LÁ — không tham chiếu workspace package nào khác.
#
# Hai stage:
#   1. `build` — cài dependency, build Nuxt ra `.output`.
#   2. `runtime` — chỉ copy `.output` sang image slim, không mang
#      `node_modules`, toolchain hay source. Bề mặt tấn công ở runtime hẹp.

# --- Stage 1: build ---------------------------------------------------------
# Ghim theo DIGEST — cùng digest mà `deploys/home-deploy/Dockerfile` và
# `deploys/account-deploy/Dockerfile` ghim (tag `24-bookworm-slim` tại thời
# điểm ghim): tag trôi biến thay đổi toolchain thành thay đổi hạ tầng ngoài ý
# muốn. ARG để một nơi duy nhất cho cả hai stage.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE} AS build

# pnpm là package manager của repo (field `packageManager` trong package.json).
# `corepack` đi kèm image Node và tự ĐỌC `packageManager` từ package.json đã
# COPY ở dưới — không hard-code version pnpm ở đây.
RUN corepack enable

WORKDIR /repo

# Lớp cache đầu chỉ copy manifest: đổi source không làm mất `pnpm install`.
# `patches/` phải có mặt TRƯỚC install vì `pnpm-workspace.yaml` khai
# `patchedDependencies` trỏ vào nó — thiếu thì `pnpm install --frozen-lockfile`
# fail vì config lệch lockfile.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY patches/ ./patches/
COPY tools/dx/package.json ./tools/dx/
COPY apps/pact-broker-app/package.json ./apps/pact-broker-app/
COPY apps/pact-broker-app/.npmrc ./apps/pact-broker-app/.npmrc
COPY libs/ui-app-shell/package.json ./libs/ui-app-shell/
COPY libs/ui-ecoma-logo/package.json ./libs/ui-ecoma-logo/

# `apps/pact-broker-app/.npmrc` (`shamefully-hoist`) phải CÓ MẶT TRƯỚC
# `pnpm install` (đã COPY ở khối manifest phía trên) — cùng lý do với
# `apps/home/.npmrc`: config chỉ có tác dụng đúng lúc install đọc config và
# dựng layout `node_modules`.
#
# Cache mount + cờ install: giữ nguyên contract của `home-deploy` —
# `--ignore-scripts` khớp allowlist `allowBuilds` trong `pnpm-workspace.yaml`,
# `--trust-lockfile` bỏ bước verify thuần CPU đã chạy ở máy developer và CI.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --trust-lockfile

# Nguồn app đầy đủ + hai workspace package mà app import qua alias trong
# `nuxt.config.ts` (`@ecoma-io/ui-app-shell`, `@ecoma-io/ui-ecoma-logo`).
# Test và config test bị `.dockerignore` loại ở tầng context (mục
# `apps/pact-broker-app/tests`), không cần exclude lại ở đây.
COPY apps/pact-broker-app/ ./apps/pact-broker-app/
COPY libs/ui-app-shell/ ./libs/ui-app-shell/
COPY libs/ui-ecoma-logo/ ./libs/ui-ecoma-logo/

# CHỈ copy `tsconfig.base.json`, KHÔNG copy `tsconfig.json` ở root — cùng lý
# do với `home-deploy`: `tsconfig.json` ở root là manifest project references
# của monorepo, copy vào là Vite dừng ở `/repo/tsconfig.json` rồi thử nạp từng
# project được tham chiếu mà image không chứa, build fail. `nuxt.config.ts`
# khai `typescript.tsConfig.extends: '../../../tsconfig.base.json'` nên base
# là thứ duy nhất app cần.
COPY tsconfig.base.json ./

# Override preset `cloudflare-module` của `nitro.config.ts`: cờ `--preset`
# truyền thành `overrides.nitro.preset`, thắng giá trị trong config file.
# `NODE_ENV=production` để Nuxt build theo chế độ production.
ENV NODE_ENV=production
RUN cd apps/pact-broker-app && pnpm exec nuxt build --preset=node-server

# --- Stage 2: runtime -------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

WORKDIR /app

# `node:24` đã có user `node` (uid 1000) sẵn; chạy non-root.
COPY --from=build --chown=node:node /repo/apps/pact-broker-app/.output/ ./

ENV NODE_ENV=production
ENV PORT=3000

# Không publish cổng host nào: container chỉ nghe trong Docker network của
# platform, Traefik route tới nó qua alias. `EXPOSE` chỉ là tài liệu metadata.
EXPOSE 3000

USER node

CMD ["node", "/app/server/index.mjs"]
