# One image definition for all NTrack services. Build with:
#   docker build -f infra/docker/Dockerfile --build-arg APP=api -t ntrack-api .
#   (APP = api | tracker | workers; workers also pass --build-arg ENTRY=index.js)
ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS build
WORKDIR /repo
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci
RUN npx prisma generate --schema packages/db/prisma/schema.prisma
ARG APP
RUN npm run build -w @ntrack/${APP}

FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
RUN apk add --no-cache openssl tini && addgroup -S ntrack && adduser -S ntrack -G ntrack
ENV NODE_ENV=production
ARG APP
ARG ENTRY=server.js
ENV APP_ENTRY=${ENTRY}
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/db ./packages/db
COPY --from=build /repo/packages/analytics/migrations ./packages/analytics/migrations
# Cloud provider IP ranges for the tracker's datacenter_ip flag (refresh with scripts/update-datacenter-ranges.mjs).
COPY --from=build /repo/packages/shared/data ./packages/shared/data
COPY --from=build /repo/apps/${APP}/dist ./dist
USER ntrack
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "exec node dist/${APP_ENTRY}"]
