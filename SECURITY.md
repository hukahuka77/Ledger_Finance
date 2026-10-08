# Security policy

Ledger Finance handles financial data and bank credentials, so security reports are taken seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private vulnerability reporting instead (the repository's **Security** tab → *Report a vulnerability*). Include steps to reproduce and the impact you expect. You'll get a reply as soon as possible.

## How the app protects data

- **Row-level security** on every table: users only see workspaces they belong to, and only owners and editors can write. The `anon` role has no table access.
- **Bank secrets stay on the server.** Plaid access tokens and Coinbase keys are encrypted with AES-256-GCM (`PLAID_TOKEN_KEY`) and never sent to the browser.
- **Webhooks are verified.** Plaid webhook signatures are checked before any sync runs; the daily job requires `CRON_SECRET`.
- **The service-role key** is only used server-side, for webhooks and the daily job.
- **Privileged database functions check the caller.** Workspace operations that must cross row-level security (creating a workspace, invites, member roles, moving or mirroring an account) are `SECURITY DEFINER` functions. Each one checks the caller's membership and role before doing anything. Supabase's linter lists them as warnings; that's expected. Everything else runs with the caller's own permissions.

## Running it safely

- Turn off public sign-ups in Supabase once your accounts exist; add people through workspace invites.
- Keep `PLAID_TOKEN_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` secret, and never prefix them with `NEXT_PUBLIC_`.
- Serve the app over HTTPS, or keep it on a private network.
- Keep dependencies up to date.
