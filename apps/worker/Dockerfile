# Build with Bun (bundles workspace TypeScript), run on Node 22 LTS.
# Build context is the repository root:
#   docker build -f apps/worker/Dockerfile -t tela-worker .

FROM oven/bun:1.3 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter @tela/worker build
# Prune to production dependencies for the runtime image.
RUN rm -rf node_modules && bun install --frozen-lockfile --production

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/worker/dist ./dist
COPY --from=build /app/apps/worker/package.json ./package.json
USER node
CMD ["node", "dist/index.js"]
