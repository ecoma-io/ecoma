# Image Docker cho `apps/backoffice` ở LAN LOCAL deployment.
#
# Preset Nitro của app là `cloudflare-module` (staging/production trên
# Cloudflare Workers). Local deployment chạy preset `node-server`: override qua
# build-time flag `--preset=node-server` của Nuxt CLI, không sửa nitro.config.ts.
#
# Build context là REPO ROOT. Hai stage: build + runtime slim.

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE} AS build

RUN corepack enable

WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY patches/ ./patches/
COPY tools/dx/package.json ./tools/dx/
COPY apps/backoffice/package.json ./apps/backoffice/
COPY apps/backoffice/.npmrc ./apps/backoffice/.npmrc
COPY libs/account-contracts/package.json ./libs/account-contracts/
COPY libs/internal-auth-contracts/package.json ./libs/internal-auth-contracts/
COPY libs/backoffice-domain/package.json ./libs/backoffice-domain/
COPY libs/backoffice-application/package.json ./libs/backoffice-application/
COPY libs/backoffice-infrastructure/package.json ./libs/backoffice-infrastructure/
COPY libs/ui-app-shell/package.json ./libs/ui-app-shell/
COPY libs/ui-ecoma-logo/package.json ./libs/ui-ecoma-logo/
COPY libs/staff-access-contracts/package.json ./libs/staff-access-contracts/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --trust-lockfile

COPY apps/backoffice/ ./apps/backoffice/
COPY libs/account-contracts/ ./libs/account-contracts/
COPY libs/internal-auth-contracts/ ./libs/internal-auth-contracts/
COPY libs/backoffice-domain/ ./libs/backoffice-domain/
COPY libs/backoffice-application/ ./libs/backoffice-application/
COPY libs/backoffice-infrastructure/ ./libs/backoffice-infrastructure/
COPY libs/ui-app-shell/ ./libs/ui-app-shell/
COPY libs/ui-ecoma-logo/ ./libs/ui-ecoma-logo/
COPY libs/staff-access-contracts/ ./libs/staff-access-contracts/
COPY tsconfig.base.json ./

ENV NODE_ENV=production
RUN cd apps/backoffice && pnpm exec nuxt build --preset=node-server

FROM ${NODE_IMAGE} AS runtime

WORKDIR /app

COPY --from=build --chown=node:node /repo/apps/backoffice/.output/ ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node

CMD ["node", "/app/server/index.mjs"]
