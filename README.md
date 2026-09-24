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

Open http://127.0.0.1:5173. The UI uses Vite, and the API runs on port 8787. Local authentication is bypassed only when the explicit development flag is enabled and the request uses a loopback hostname. Production requires the existing username, password, and Authenticator code. To test that login locally, prepare the credentials as described in the deployment guide, then run Wrangler without the `LOCAL_DEV` flag.

For a preview of the production bundle, run `npm run preview` and open http://127.0.0.1:8787.

## Features

- Calendar, session logging, notes, historical session details, and session deletion.
- Exercise library, prescribed weights/reps/sets, dated changes, and weight progression.
- Workouts with dated exercise membership and ordering.
- Archiving that preserves history and prevents archiving exercises still in active workouts.
- Table editor, administrative inserts, and a JSON data export.
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

Apply the schema first, then import into an empty local database:

```powershell
npm run db:migrate
npx wrangler d1 execute progresql --local --file exports/<timestamp>/import.sql
```

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

Browser tests use an isolated local D1 database under `.wrangler/e2e`, never the live database. `npm test` covers temporal behavior, transaction rollback, concurrency, constraints, API validation, password verification, TOTP replay prevention, session expiry/revocation, CSRF protection, and login throttling. `npm run format` formats the TypeScript application.

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

The old app remains available for rollback until the production migration is accepted. Its setup instructions are in [Legacy Streamlit](docs/legacy-streamlit.md).
