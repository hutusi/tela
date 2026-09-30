# The relay: built with Bun, run on Node 24 LTS. Build context is the repository root:
#   docker build -f apps/relay/Dockerfile -t tela-relay .
# Run with RELAY_SECRET (and RELAY_SECRET_PREVIOUS while rotating) behind a TLS proxy.

FROM oven/bun:1.4 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter @tela/relay build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/apps/relay/dist ./dist
COPY --from=build /app/apps/relay/package.json ./package.json
USER node
EXPOSE 8787
CMD ["node", "dist/main.js"]
