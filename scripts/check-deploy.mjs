import { readFileSync } from "node:fs";
import ts from "typescript";
const parsed = ts.parseConfigFileTextToJson(
  "wrangler.jsonc",
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
if (parsed.error) {
  console.error("Could not parse wrangler.jsonc.");
  process.exit(1);
}
const config = parsed.config;
const errors = [];
if (
  !config.d1_databases?.[0]?.database_id ||
  config.d1_databases[0].database_id === "00000000-0000-0000-0000-000000000000"
)
  errors.push(
    "Create the Cloudflare D1 database and set database_id in wrangler.jsonc.",
  );
if (config.vars?.LOCAL_DEV)
  errors.push("Remove LOCAL_DEV from the production configuration.");
try {
  const secrets = JSON.parse(
    readFileSync(new URL("../.env.auth-upload.json", import.meta.url), "utf8"),
  );
  for (const key of [
    "AUTH_USERNAME",
    "AUTH_PASSWORD_PARAMETERS",
    "AUTH_PASSWORD_VERIFIER",
    "AUTH_PEPPER",
    "AUTH_TOTP_SECRET",
  ]) {
    if (typeof secrets[key] !== "string" || !secrets[key])
      errors.push(`Missing ${key} in the local secrets file.`);
  }
} catch {
  errors.push(
    "Run scripts/prepare_worker_auth.py to prepare the ignored authentication secrets file.",
  );
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("Deployment configuration and authentication secrets are present.");
