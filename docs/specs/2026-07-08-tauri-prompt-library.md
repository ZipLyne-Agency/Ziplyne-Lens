# ZipLyne Lens Tauri And Prompt Library Spec

## Goal

Turn ZipLyne Lens into a macOS desktop app with a menu bar presence, live local-server connection state, and prompt-level intelligence for client work. The app should remain open-source and local-first while giving consultants a reliable view of spend, prompts, and client/project context.

## Constraints

- The desktop app uses Tauri v2 and reuses the existing React dashboard, Hono local API, and core parser package.
- Prompt content is sensitive client data. Full prompt indexing must be opt-in and local-only.
- Redacted prompt previews and prompt metadata may be available by default.
- No transcript data leaves the machine.
- Unknown prompts or spend attribution must remain visible in an unassigned queue.
- The Tauri app should start its bundled local API sidecar automatically on a free loopback port.
- Browser/device automation still requires explicit permission before use.

## Data Granularity

- Claude Code logs can provide user message content, assistant content, timestamps, cwd, git branch, session id, model, token usage, and cost fields when present.
- Codex logs can provide session/turn metadata, some plaintext user and assistant records, token usage, cwd, model, and encrypted reasoning/content records. Encrypted Codex content cannot be indexed as text unless a supported local decryption path exists.
- ZipLyne Lens should expose prompt records with source, timestamp, session, cwd/project, client attribution, model, token/cost linkage where available, privacy state, redacted preview, tags, and optional full prompt text when local full indexing is enabled.

## Acceptance Criteria

1. The repo includes a Tauri v2 desktop app package with macOS menu bar/tray integration.
2. The desktop app can open/focus the main dashboard from the menu bar.
3. The desktop app starts the bundled local API sidecar automatically without depending on a fixed port.
4. The web dashboard shows local API connection state and auto-refreshes while connected.
5. The API exposes prompt-library endpoints that return prompt metadata and redacted previews.
6. Prompt extraction supports representative Claude Code user messages and Codex plaintext user messages.
7. Full prompt text is not returned unless an explicit query/config flag asks for it.
8. Prompt rows include client attribution and project matching using the existing client rules.
9. The UI includes a Prompts workspace with search, source filter, client filter, privacy status, and a prompt detail inspector.
10. Tests cover prompt extraction, redaction, and API validation behavior.
11. `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.

## Non-Goals

- Cloud sync.
- Hosted auth.
- Production code signing and notarization.
- Publishing or pushing to GitHub before explicit confirmation.
- Reading encrypted Codex content without a supported local decryption path.
- Server-side semantic embedding search.

## Stack Rationale

Tauri v2 is the right desktop shell because it gives ZipLyne Lens a native macOS menu bar presence while preserving the existing React dashboard and TypeScript parser work. The first implementation should keep the local API boundary so transcript parsing remains testable and publishable.
