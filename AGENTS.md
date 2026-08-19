# Agent Instructions

Read `docs/TECHNICAL_DESIGN.md` before changing architecture or public contracts.
Treat `docs/REQUIREMENTS_BASELINE.md` as the product boundary and
`docs/IMPLEMENTATION_PLAN.md` as the delivery contract.

- Use pnpm and TypeScript ESM.
- Target Node.js `^22.19.0 || >=24.0.0`.
- Keep all DSH-specific imports and event wiring under `src/dsh-adapter/` and
  `src/plugin/`; domain modules must remain independently testable.
- Governor never calls provider HTTP APIs directly and never stores provider
  credentials.
- Do not weaken access, quota, fallback, usage, or routing acceptance criteria.
- Do not publish to npm, push a remote, or mutate a real DSH profile without
  explicit human authorization.
- Tests must use fake adapters, temporary DSH homes, and temporary SQLite files.

