# Contributing

Thanks for helping improve ZipLyne Lens.

## Development

```bash
pnpm install
pnpm lint
pnpm test
pnpm typecheck
pnpm build
cd apps/desktop/src-tauri
cargo fmt --check
cargo check --locked
cargo clippy --locked --all-targets -- -D warnings
```

## Rules

- Do not commit local usage logs, transcripts, prompts, `.env` files, or client config.
- Add tests for parser and aggregation changes.
- Keep new files under 400 lines unless generated or explicitly justified.
- Preserve local-first privacy. New telemetry must be opt-in and documented.
- Keep cost math explicit and easy to audit.

## Pull Requests

Include:

- What changed
- Why it changed
- How it was tested
- Any cost-accounting or privacy implications
