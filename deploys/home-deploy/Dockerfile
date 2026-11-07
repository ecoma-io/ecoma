# Image Docker cho `apps/home` ở LAN LOCAL deployment.
#
# Preset Nitro của app là `cloudflare-module` (`apps/home/nitro.config.ts`) — đó
# là đường deploy staging/production trên Cloudflare Workers, và file Dockerfile
# này KHÔNG đụng tới nó. Local deployment chạy app trong Docker với preset
# `node-server`: entrypoint là `node .output/server/index.mjs`, nghe trên `PORT`,
# và serve static assets trong `.output/public` (`serveStatic: true` của preset
# node-server). Vì vậy override preset phải là **build-time flag** của Nuxt CLI
# (`nuxt build --preset=node-server`), không phải sửa `nitro.config.ts`.
#
# Build context là REPO ROOT (không phải `apps/home`): monorepo pnpm workspace có
# `libs/ui-ecoma-logo` là workspace dependency của app, và `pnpm-workspace.yaml`
# + `pnpm-lock.yaml` + `patches/` đều nằm ở root. Dockerfile đặt ở `deploys/
# home-deploy` — nơi sở hữu việc đóng gói image — nhưng mọi path bên dưới là
# path tương đối so với context root, KHÔNG so với thư mục chứa Dockerfile.
#
# Hai stage:
#   1. `build` — cài dependency, build Nuxt ra `.output`.
#   2. `runtime` — chỉ copy `.output` sang image `node:24-bookworm-slim`, không
#      mang `node_modules`, toolchain hay source. Đây là lý do image nhỏ và
#      bề mặt tấn công ở runtime hẹp.

# --- Stage 1: build ---------------------------------------------------------
# Ghim theo DIGEST, không theo tag — cùng lý do với Traefik/PostgreSQL trong
# `deploys/platform-deploy/index.ts`: tag trôi biến thay đổi toolchain thành
# thay đổi hạ tầng ngoài ý muốn, build không tái lập được. ARG để một nơi duy
# nhất cho cả hai stage. Digest này là tag `24-bookworm-slim` tại thời điểm ghim.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE} AS build

# pnpm là package manager của repo (field `packageManager` trong package.json
# ghim `pnpm@12.14.0`). `corepack` đi kèm image Node và tự ĐỌC `packageManager`
# từ package.json đã COPY ở dưới — không hard-code version pnpm ở đây: Renovate
# bump `packageManager` thì image build theo ngay, hai nguồn sự thật là một.
RUN corepack enable

WORKDIR /repo

# Lớp cache đầu chỉ copy manifest: đổi source không làm mất `pnpm install`.
# `patches/` phải có mặt **trước** install vì `pnpm-workspace.yaml` khai
# `patchedDependencies` trỏ vào nó — thiếu thì pnpm không apply patch (và với
# `--frozen-lockfile` còn fail vì config lệch lockfile).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY patches/ ./patches/
COPY tools/dx/package.json ./tools/dx/
COPY apps/home/package.json ./apps/home/
COPY apps/home/.npmrc ./apps/home/.npmrc
COPY libs/ui-ecoma-logo/package.json ./libs/ui-ecoma-logo/

# `apps/home/.npmrc` (`shamefully-hoist`) phải CÓ MẶT **TRƯỚC** `pnpm install`
# (đã COPY ở khối manifest phía trên): `shamefully-hoist` chỉ có tác dụng đúng
# lúc install đọc config và dựng layout `node_modules` — copy sau install là
# file chết, và layout trong image sẽ khác với `pnpm install` chạy trong
# `apps/home` trên máy developer.
#
# Cache mount: giữ pnpm store giữa các build để không phải tải lại 1673
# package từ registry mỗi khi layer bị vô hiệu hoá (đo: 731s → 93s).
# `--trust-lockfile`: bỏ bước verify supply-chain policy của lockfile —
# bước đó thuần CPU, mất 5-9 phút, không phụ thuộc mạng. Lockfile đã được
# verify ở máy developer và bởi CI; build container chỉ cần unpack.
#
# `--ignore-scripts` khớp contract allowlist của repo (`allowBuilds` trong
# `pnpm-workspace.yaml`): pnpm chỉ chạy install script cho package được khai ở
# đó, và các package native của repo đều ship prebuild. Lỗi "package cần script
# mà thiếu" nổ NGAY ở install với ERR_PNPM_IGNORED_BUILDS — không nuốt được
# thành lỗi mờ ở `nuxt build`.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --trust-lockfile

# Nguồn app đầy đủ + workspace package mà app import (`@ecoma-io/ui-ecoma-logo`,
# resolve qua alias trong `nuxt.config.ts` chứ không qua `paths` của tsconfig).
COPY apps/home/ ./apps/home/
COPY libs/ui-ecoma-logo/ ./libs/ui-ecoma-logo/

# CHỈ copy `tsconfig.base.json`, KHÔNG copy `tsconfig.json` ở root.
#
# `nuxt.config.ts` khai `typescript.tsConfig.extends: '../../../tsconfig.base.json'`
# (đường dẫn tương đối so với `.nuxt/`), nên base là thứ duy nhất app cần.
#
# `tsconfig.json` ở root là manifest project references cho **monorepo** — nó trỏ
# tới mọi project `libs/*` và `deploys/*`, mà image này không chứa chúng. Copy
# nó vào là Vite (`resolve.tsconfigPaths: true` trong `nuxt.config.ts`) dừng ở
# `/repo/tsconfig.json` rồi thử nạp từng project được tham chiếu và fail:
#     Error: [postcss] Tsconfig not found /repo/libs/auth-application
# (postcss vì `styles.css` chạy qua PostCSS, nhưng gốc rễ là tsconfig walk của
# Vite.) Giữ manifest monorepo ra khỏi image là cách sửa: build **một** app không
# cần graph của cả workspace.
COPY tsconfig.base.json ./

# Override preset `cloudflare-module` của `nitro.config.ts`: cờ `--preset` của
# `nuxt build` được truyền thành `overrides.nitro.preset`, thắng giá trị
# `preset` trong config file. `NODE_ENV=production` để Nuxt build theo chế độ
# production (bỏ devtools, bật minify).
ENV NODE_ENV=production
RUN cd apps/home && pnpm exec nuxt build --preset=node-server

# --- Stage 2: runtime -------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

WORKDIR /app

# `node:24` đã có user `node` (uid 1000) sẵn; chạy non-root để container không
# cần quyền ghi gì ngoài filesystem của chính nó.
COPY --from=build --chown=node:node /repo/apps/home/.output/ ./

ENV NODE_ENV=production
ENV PORT=3000

# Không `EXPOSE` cổng host nào: container chỉ nghe trong Docker network của
# platform, Traefik route tới nó qua alias. `EXPOSE` chỉ là tài liệu metadata.
EXPOSE 3000

USER node

CMD ["node", "/app/server/index.mjs"]