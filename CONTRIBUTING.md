# Contributing to Ledger Finance

Thanks for helping. Bug reports, fixes and focused features are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Never include real financial data, bank credentials, API keys or screenshots of real accounts in issues, pull requests or test fixtures. Use Plaid's sandbox and made-up numbers.

## Setup

Follow the [Quick start](README.md#quick-start) with your own Supabase project (a free one is fine) and Plaid sandbox keys.

## Making a change

1. Branch from `main`.
2. Match the surrounding code: TypeScript, React function components, TanStack Query for server state, Tailwind for styling.
3. Database changes go in a **new** migration file in `supabase/migrations/` (never edit an existing one). Keep row-level security on every table, scope rows by `workspace_id`, and grant functions explicitly. Regenerate `src/lib/database.types.ts` afterwards.
4. Add or update tests for logic you change (`src/lib/__tests__/`).
5. Before opening a pull request, run:
   ```bash
   npm run lint && npm run typecheck && npm test && npm run build
   ```
6. Describe what changed and why, and how you tested it. Screenshots help for UI changes.

## Code of conduct

Be kind and constructive. Harassment or personal attacks aren't tolerated.
