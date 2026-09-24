# Cloudflare deployment

Target: **progresql.cotsakis.com**, using Workers Free and D1 Free. The app keeps the original username, password, and existing Authenticator entry. No Cloudflare Zero Trust, Microsoft identity provider, paid plan, or payment-card setup is part of this deployment.

## Resources

- Account: `b21e7fde43919fa4af4e5ccdf3a32d90`
- Zone: `cotsakis.com`
- D1: `progresql`, ID `34ba2cfc-f847-4cf2-aa0a-403490e164d7`, Western Europe
- Worker: `progresql`

The original PostgreSQL source and Streamlit app are retained for rollback. Public `workers.dev` and preview URLs are disabled. Never enable `LOCAL_DEV` in production.

The Worker runs before static assets and redirects HTTP requests to HTTPS before serving the login form or processing authentication. HTTPS responses include HSTS. This is required for browsers to retain the Secure session cookie; loopback development remains available over HTTP.

## Verified deployment

Deployed on 24 September 2026 as Worker version `fbf833f2-43f2-498c-af12-50db67c795d8`. The read-only source export at `exports/20260924-205437/` matched the earlier imported snapshot exactly. All 109 application rows were compared against the live authenticated API: 16 exercises, 3 workouts, 41 prescriptions, 31 memberships, and 18 sessions. D1 foreign-key checks passed.

Validation included 20 TypeScript service/authentication tests, 17 Python reference/export/credential-conversion tests, desktop and mobile browser flows, a production build and deployment dry run, and live HTTPS login/logout with the preserved credentials and TOTP. The live check did not change workout data. No paid plan was enabled.

Desktop/mobile browser tests passed locally. The live HTTPS checks used a public DNS answer because this machine cached the pre-deployment NXDOMAIN. Direct live Edge navigation timed out from this environment, so that browser check remains unverified; the live homepage, authenticated API, complete data comparison, and logout were verified over certificate-validated HTTPS.

## Authentication

Prepare credentials from the existing local `.streamlit/secrets.toml`:

```powershell
.venv/Scripts/python.exe scripts/prepare_worker_auth.py
```

This creates ignored `.env.auth-upload.json` and `.dev.vars` files. It preserves the username and TOTP secret and converts the existing Argon2id hash without needing the plaintext password. Do not commit, share, or print these files. `npm run deploy` supplies the five values as Worker secrets through Wrangler's `--secrets-file` option.

The browser performs the original Argon2id calculation with the public salt and parameters. Over HTTPS it sends the resulting password-equivalent proof, username, and six-digit authenticator code. The Worker checks a peppered HMAC of the proof and the TOTP. Only the salt and work parameters are public; the original hash, pepper, verifier, and authenticator secret are never returned to the browser. Keeping the expensive Argon2 calculation in the browser avoids exhausting Workers Free's CPU allowance. Treat the transmitted proof as sensitive, just like a password; never log request bodies or store it in browser storage.

Sessions last one hour. A secure, HttpOnly, SameSite=Strict cookie holds a random token; D1 stores only its SHA-256 hash. Logout revokes the session, and credential changes invalidate existing sessions. Mutations require a matching Origin. Login attempts are limited to 10 per IP and 30 globally in a five-minute window. Each authenticator time step can be used only once, including concurrent requests; after signing out, wait for the next code before signing in again. The TOTP settings match the old app: SHA-1, six digits, 30-second period, and a one-step clock allowance.

For real local login, build and migrate first, then run:

```powershell
npx wrangler dev --ip 127.0.0.1 --local-upstream 127.0.0.1 --upstream-protocol http --port 8787
```

The normal `dev` and `preview` scripts explicitly bypass login on loopback for convenience. Browser tests instead use fake credentials and exercise the real login flow against an isolated local database.

## Data migration

Stop making changes in the old app during final export/cutover, then create a snapshot:

```powershell
.venv/Scripts/python.exe scripts/export_to_d1.py
```

The export is read-only against PostgreSQL. It preserves all five tables, primary keys, relationships, and timestamps. The ignored export directory includes SQLite, SQL, and a manifest with counts and checksum. The exporter validates foreign keys, integrity, and replay of the SQL.

For an empty destination database:

```powershell
npx wrangler d1 migrations apply progresql --remote
npx wrangler d1 execute progresql --remote --file exports/<timestamp>/import.sql
```

The import deliberately fails against populated application tables. Do not rerun it into a live populated database. If PostgreSQL receives writes after the snapshot, coordinate a new cutover instead of assuming the copy is current. Subsequent schema migrations are safe to apply separately and include the three authentication tables.

Verify the application counts against the manifest and check foreign keys:

```powershell
npx wrangler d1 execute progresql --remote --command "SELECT 'exercise' AS name, COUNT(*) AS rows FROM exercise UNION ALL SELECT 'workout',COUNT(*) FROM workout UNION ALL SELECT 'exercise_settings_history',COUNT(*) FROM exercise_settings_history UNION ALL SELECT 'workout_exercise',COUNT(*) FROM workout_exercise UNION ALL SELECT 'workout_session',COUNT(*) FROM workout_session"
npx wrangler d1 execute progresql --remote --command "PRAGMA foreign_key_check"
```

## Publish and verify

```powershell
npx wrangler login
npm ci
npm test
npm run test:browser
npx wrangler deploy --dry-run --secrets-file .env.auth-upload.json
npm run deploy
```

The custom-domain route provisions the hostname and TLS. Check for an existing application at that hostname before attaching it. Deployment never upgrades the account plan. The predeploy check requires authentication secrets and rejects a production local bypass.

Check that an incognito visit shows the login form, unauthenticated `/api/data` returns 401, existing credentials plus an Authenticator code open the journal, historical sessions match the migration, and logout revokes access. Worker logs omit credentials and workout row contents.

Free-tier quotas still apply; review [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) as usage grows. No paid upgrade is necessary for this implementation.

The app fetches the five-table dataset in one authenticated request and resolves browsing/date changes locally. Mutations refresh that snapshot. If the journal grows substantially, add pagination and targeted reads. Administrative saves allow at most 45 changed/deleted rows per request to stay within free-plan query limits.

Use D1 exports/Time Travel for ongoing backups. The UI JSON export is a convenient data copy, not a replacement for a database backup. Keep the original source until the migration is accepted. After new D1 writes, export and reconcile them before rolling back to PostgreSQL.
