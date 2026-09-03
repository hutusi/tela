# 0001 — Bun workspaces monorepo; Bun for tooling, Node 22 for the worker runtime

Status: accepted (2026-09-04)

## Context

Tela has a web app, a background worker, and shared packages that must stay in lockstep. The
worker relies on pg-boss, whose stated support is Node ≥ 22.12; Bun is not mentioned.

## Decision

- One repository with Bun workspaces (`apps/*`, `packages/*`), TypeScript strict, Biome.
- Bun is the package manager, script runner, test runner, and bundler for the worker.
- The worker runs on Node 22 LTS in production (`apps/worker/Dockerfile`: Bun builds, Node runs).
- Workspace packages export TypeScript source; consumers (Next.js `transpilePackages`, Bun) compile it.
- No `Bun.*` APIs in shared code so the runtime can change with a Dockerfile edit.

## Consequences

- One lockfile, one lint/format config, cross-package types without a build step.
- Local `bun run dev:worker` runs on Bun while production runs on Node; integration tests run
  against the bundled output in CI to catch drift.
- TypeScript stays on 5.9 until the ecosystem settles on the native 7.x compiler.
