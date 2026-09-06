# 0001 — Bun workspaces monorepo; Bun for tooling, Node 24 for the worker runtime

Status: accepted (2026-09-04). Amended 2026-09-07: the worker runtime moves from Node 22 LTS to
Node 24 LTS, and TypeScript to the native 7.x compiler. The decision — Bun for tooling, the
current Node LTS for the worker — is unchanged; these are the versions it names moving with it.

## Context

Tela has a web app, a background worker, and shared packages that must stay in lockstep. The
worker relies on pg-boss, whose stated support is Node ≥ 22.12; Bun is not mentioned.

## Decision

- One repository with Bun workspaces (`apps/*`, `packages/*`), TypeScript strict, Biome.
- Bun is the package manager, script runner, test runner, and bundler for the worker.
- The worker runs on Node 24 LTS in production (`apps/worker/Dockerfile`: Bun builds, Node runs).
- Workspace packages export TypeScript source; consumers (Next.js `transpilePackages`, Bun) compile it.
- No `Bun.*` APIs in shared code so the runtime can change with a Dockerfile edit.

## Consequences

- One lockfile, one lint/format config, cross-package types without a build step.
- Local `bun run dev:worker` runs on Bun while production runs on Node; integration tests run
  against the bundled output in CI to catch drift.
- TypeScript is on the native 7.x compiler. It typechecks every workspace and Next's own pass
  dropped from 3.3s to under a second; `apps/web` needed an explicit `types` in its tsconfig,
  which every other workspace already had.
- Moving the runtime major is a Dockerfile edit plus the four other pins that must agree with it
  (`.node-version`, `engines`, the CI `node-version`, and `@types/node`). `test/docs.test.ts`
  holds them together, because @types/node had already drifted two majors ahead of the runtime
  once — which typechecks APIs the deployed Node does not have.
