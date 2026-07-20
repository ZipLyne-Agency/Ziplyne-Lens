# ZipLyne Lens Product Spec

## Goal

Build an open-source, local-first dashboard that shows how much AI coding usage costs by client, project, model, source, and session. The product must start useful on a local workstation with Claude Code and Codex logs, while staying safe to publish publicly under the ZipLyne organization.

## Constraints

- The first release is local-first. It reads local usage logs and does not upload transcripts.
- The dashboard must work without provider credentials.
- Source code must be publishable under an open-source license.
- Costs are estimates unless a provider log contains an official cost field.
- Unknown usage must not disappear. It goes to an unassigned queue.
- The parser must avoid reading prompt text unless needed for structured usage metadata.
- The app must be useful for client accounting, not just personal curiosity.

## Acceptance Criteria

1. The repo is a pnpm monorepo with a web dashboard, local API, and shared parser package.
2. The core parser can ingest representative Claude Code and Codex JSONL entries.
3. Usage events normalize source, timestamp, session, cwd/project, model, token categories, and estimated or recorded cost.
4. Aggregation returns totals by client, project, source, model, day, and unassigned usage.
5. Client attribution supports explicit path matching and a safe fallback to unassigned usage.
6. The API exposes health, summary, sources, and demo summary endpoints.
7. The web app renders an actual usable dashboard with overview KPIs, client table, project table, trend chart, model mix, source mix, and unassigned queue.
8. The UI includes filters for date range, source, and client.
9. The repo includes README, license, contribution guide, code of conduct, security policy, and env examples suitable for open source.
10. Tests cover parser normalization, cost calculation, attribution, and aggregation behavior.
11. `pnpm test`, `pnpm typecheck`, and `pnpm build` pass.

## Non-Goals For The First Release

- Cloud sync across machines.
- GitHub org repository creation or push before explicit confirmation.
- Billing-provider reconciliation.
- Transcript search or prompt content analytics.
- Multi-user auth.

## Stack Decision

Use Vite React for the dashboard and Hono for the local API. TanStack Start remains a good future option for a hosted product, but the local collector needs file-system access behind a simple local HTTP boundary. This keeps the open-source install path clearer and avoids server-rendering complexity that does not help the first release.

