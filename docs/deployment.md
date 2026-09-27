# Cloudflare deployment and user migration

Target: **progresql.cotsakis.com**, Worker **progresql**, D1 database **progresql** (`34ba2cfc-f847-4cf2-aa0a-403490e164d7`). Invitations are sent manually. No email service, OAuth provider, or paid-plan setup is introduced.

## Authentication and account management

Every user signs in with a username, password, and authenticator code. The browser derives an Argon2id proof; the Worker verifies its peppered HMAC and the TOTP. Treat the proof like a password. Never log request bodies, tokens, QR codes, or credentials.

Worker secrets are now `AUTH_PEPPER` (preserve the existing value) and `AUTH_ENCRYPTION_KEY` (32 random bytes encoded as 64 lowercase hexadecimal characters). Password verifiers and AES-GCM encrypted authenticator secrets live in D1. Back up both Worker secrets securely alongside database backups. Changing either secret without migrating credentials will break authentication.

Sessions last one hour and use Secure, HttpOnly, SameSite=Strict cookies in production. D1 stores only session/token hashes. Credential and role changes revoke sessions. Authenticator codes may be used once per user and time step; after signing in or confirming an admin action, wait for the next code. Requests require a same-origin JSON POST for mutations. Each authentication category permits 10 attempts per IP/account and 100 globally per five minutes.

Admins use **Users** to create accounts, edit usernames/roles, issue recovery links, or permanently delete an account. Sensitive actions require the admin's password and a fresh authenticator code. Self-deletion and self-demotion are blocked, and SQL guards protect the last admin. Deletion removes the account and all workout records in one transaction.

- **Invitation:** expires in 24 hours. The recipient chooses a password and scans a QR code generated in their browser, then confirms a code. New libraries are empty.
- **Reset password:** expires in one hour. The recipient chooses a password and confirms their existing authenticator.
- **Recover account:** expires in one hour. The recipient chooses a password and enrolls a new authenticator.

Copy the link and send it yourself after verifying the recipient. Links are single-use and held in URL fragments; opening one clears the fragment from browser history without consuming the token. Reloading requires reopening the original link. Reissuing invalidates the previous link. Recovery ends existing sessions immediately and blocks login until completion. Passwords have a 12-character minimum in the setup UI. Recovery of your own account opens the setup flow immediately.

Data manager is admin-only. It edits and exports the five workout tables, supports an owner filter, and requires `user_id` for inserts. Existing ownership cannot change. Authentication tables and secrets are never returned through this screen. Ordinary app views always show the signed-in user's own records.

## One-time migration from the existing single account

This is a coordinated schema and code cutover. Do not deploy the old Worker against the new schema or roll back only the code. Production deployment is a separate release operation.

1. Run the local checks below. Rehearse on a populated copy; tests also compare every migrated row and exercise the real D1 runtime.
2. Schedule a maintenance window and block public traffic at the edge during the cutover. Stop workout edits. Save a D1 export, record the database's Time Travel bookmark, the current Worker version, the old code, and the old authentication secrets in secure storage. Compare all five tables before/after migration, not only their counts.
3. Prepare the credential import locally from the existing ignored `.env.auth-upload.json`:

   ```powershell
   node scripts/bootstrap-users.mjs
   ```

   This creates `exports/users-bootstrap-<timestamp>/bootstrap.sql`, backs up the legacy authentication JSON in the same ignored directory, and rewrites `.env.auth-upload.json` and `.dev.vars` with the two required Worker secrets. It does not contact Cloudflare or change a database. It preserves your existing password verifier, username, and authenticator enrollment, and encrypts the authenticator secret. Do not print or commit these files. The script refuses a converted input. Reuse its output after a failed cutover; do not generate a new key.

   If the legacy JSON is missing, `scripts/prepare_worker_auth.py` can derive it from the original Streamlit secrets **before** conversion. That tool refuses to overwrite converted credentials.

4. While traffic is blocked, apply the migrations and the prepared SQL to the existing database:

   ```powershell
   npx wrangler d1 migrations apply progresql --remote
   npx wrangler d1 execute progresql --remote --file exports/users-bootstrap-<timestamp>/bootstrap.sql
   ```

   `0003_users.sql` creates user 1, assigns all existing workout records to it, preserves keys/timestamps/relationships and ID sequences, and expires old sessions. It stages all copies before dropping child tables to avoid cascade-related data loss. `0004_user_guards.sql` prevents ownership changes and removal of the last admin. The credential import activates user 1 as the admin and has a one-time marker plus placeholder checks. Reapplying it cannot overwrite an enrolled account or restore old credentials.

5. Verify row comparisons, `PRAGMA foreign_key_check`, user 1's active/admin status, and the bootstrap marker without selecting secret columns. Deploy the tested code with the new secret file using the normal release process. Old per-user Worker secrets can be removed after the migration is accepted; the new code ignores them.
6. Verify HTTPS login with your existing credentials, all original records, logout/revocation, and unauthenticated API rejection. Verify isolation using dedicated temporary accounts only if authorized for that release. Reopen traffic after checks pass. Monitor Worker errors, authentication failures, and D1 usage; application error logs omit credentials and row contents.

If a step fails before reopening traffic, restore the pre-cutover database and the matching old Worker code/secrets together. If new data has been written, export and reconcile it before restoring. Keep the legacy Streamlit app archived; it does not support multiple users and must not serve the shared application.

Cloudflare references: [foreign keys and migrations](https://developers.cloudflare.com/d1/sql-api/foreign-keys/), [D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/), [generated Worker types](https://developers.cloudflare.com/workers/languages/typescript/).

## Local setup and checks

```powershell
npm ci
npm run db:migrate
npm run dev
```

The explicit `LOCAL_DEV` flag bypasses login only on loopback and resolves to database user 1. This is enough to develop workout screens. To exercise account administration with real credentials, prepare/import the bootstrap SQL into the **local** database and run Wrangler without `LOCAL_DEV`:

```powershell
npx wrangler d1 execute progresql --local --file exports/users-bootstrap-<timestamp>/bootstrap.sql
npm run build
npx wrangler dev --ip 127.0.0.1 --local-upstream 127.0.0.1 --upstream-protocol http --port 8787
```

Never enable `LOCAL_DEV` in production. The predeploy check rejects it and requires both authentication secrets. Future deployments reuse the same secrets; they do not run the bootstrap import.

```powershell
npm run typegen
npm test
npm run build
$env:PW_CHROMIUM_CHANNEL = 'msedge'
npm run test:browser
.venv/Scripts/python.exe -m pytest
```

Browser tests create fake credentials and users in `.wrangler/e2e`, apply all migrations, and use the real login/enrollment flows. They never contact the live database. On platforms without Edge, install Playwright Chromium and omit the channel variable.

The Python PostgreSQL exporter remains a legacy single-user tool targeting migration `0001`. Its SQL cannot be imported directly into the new owned tables. Existing production D1 records migrate in place; do not rerun the old PostgreSQL import during this cutover.
