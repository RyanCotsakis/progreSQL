# ProgreSQL

A private workout journal built with React, TypeScript, Tailwind/shadcn-style UI components, Cloudflare Workers, and D1. The deployed app has no Streamlit or Python dependency.

## Run locally

Requires Node.js 22.12+ (Node 24 recommended).

```powershell
npm ci
npm run build
npm run db:migrate
npm run dev
```

Open http://127.0.0.1:5173. The UI uses Vite, and the API runs on port 8787. Local authentication is bypassed only when the explicit development flag is enabled and the request uses a loopback hostname. Production requires each user's username, password, and authenticator code. Local bypass resolves to user 1; account management still requires real credentials. To test that login locally, prepare the credentials as described in the deployment guide, then run Wrangler without the `LOCAL_DEV` flag.

For a preview of the production bundle, run `npm run preview` and open http://127.0.0.1:8787.

## Features

- Calendar, session logging, notes, historical session details, and session deletion.
- Exercise library, prescribed weights/reps/sets, dated changes, and weight progression.
- Workouts with dated exercise membership and ordering.
- Archiving that preserves history and prevents archiving exercises still in active workouts.
- Private user accounts with invitation links, authenticator enrollment, and admin-assisted recovery.
- Admin Users tab for roles, username changes, and permanent account deletion.
- Admin table editor, owner filters, administrative inserts, and JSON data exports.
- Responsive layouts, keyboard-accessible dialogs, loading states, and validation feedback.

Only workout completion and prescribed settings are tracked. Individual performed sets, actual repetitions, and RPE are not tracked.

## Preserve historical behavior

The TypeScript service in `worker/service.ts` ports the rules from `app/services.py`. Both prescriptions and workout composition use inclusive start dates and exclusive end dates. Backdated edits split periods; future changes do not apply early; same-day corrections intentionally update sessions on that day. Multi-statement changes use atomic D1 batches. The original Python tests remain the reference implementation.

## Migrate PostgreSQL data

```powershell
.venv/Scripts/python.exe scripts/export_to_d1.py
```

The exporter reads `DATABASE_URL`, falling back to `database_url` in your local `.streamlit/secrets.toml`. PostgreSQL is opened in a read-only, repeatable-read transaction. It writes a new ignored `exports/<timestamp>/` directory containing:

- `snapshot.sqlite`: all five tables with preserved primary keys, relationships, and timestamps.
- `import.sql`: SQLite-compatible inserts for D1, guarded against importing into a populated database.
- `manifest.json`: row counts and the import file checksum.

It verifies row counts, foreign keys, SQLite integrity, and replay of the exact SQL file. Credentials and row contents are never printed. Existing export directories are never overwritten.

The exporter targets the legacy `0001` schema. Do not import its SQL directly into the current multi-user schema. Existing D1 data is migrated in place by `0003_users.sql`; follow the deployment guide for the one-time credential import.

Do not commit snapshots or SQL exports. For production migration and authentication setup, see [Cloudflare deployment](docs/deployment.md).

## Verify changes

```powershell
npm run build
npm test
npm run test:browser
.venv/Scripts/python.exe -m pytest
```

Browser tests require `npx playwright install chromium`, or on Windows use the installed Edge browser:

```powershell
$env:PW_CHROMIUM_CHANNEL = 'msedge'
npm run test:browser
```

Browser tests use an isolated local D1 database under `.wrangler/e2e`, never the live database. `npm test` covers temporal behavior, transaction rollback, concurrency, constraints, API validation, password verification, TOTP replay prevention, session expiry/revocation, CSRF protection, login throttling, user isolation, invitations/recovery, admin permissions, deletion rollback, and populated schema migration. `npm run format` formats the TypeScript application.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/` | React UI and reusable shadcn-style/Radix components |
| `shared/` | Types, validation schemas, and date resolution |
| `worker/` | Password/TOTP authentication and D1 API |
| `migrations/` | D1 schema migrations |
| `scripts/export_to_d1.py` | Read-only PostgreSQL migration exporter |
| `tests-web/` | D1, authentication, and browser tests |
| `app/`, `alembic/`, `tests/` | Preserved Python reference and rollback path |

The old app remains archived as a reference. It does not support multiple users. Its setup instructions are in [Legacy Streamlit](docs/legacy-streamlit.md).
