# Security Policy

ZipLyne Lens reads local development-tool usage logs. Treat those logs as sensitive.

## Supported Versions

The current `main` branch receives security fixes.

## Reporting A Vulnerability

Open a private security advisory in GitHub. Please do not include local prompts,
credentials, or usage logs in a public issue.

## Data Handling Principles

- Do not upload transcripts by default.
- Do not log prompt text in API responses.
- Do not commit local config files or environment files.
- Keep client attribution rules local unless the user explicitly syncs them.
- Ship macOS releases with Developer ID signing and Apple notarization.
- Sign in-app update bundles separately; the embedded public key verifies them
  before installation.
