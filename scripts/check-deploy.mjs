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
  for (const key of ["AUTH_PEPPER", "AUTH_ENCRYPTION_KEY"]) {
    if (typeof secrets[key] !== "string" || !secrets[key])
      errors.push(`Missing ${key} in the local secrets file.`);
  }
  if (!/^[a-f0-9]{64}$/.test(secrets.AUTH_ENCRYPTION_KEY || ""))
    errors.push("AUTH_ENCRYPTION_KEY must contain 64 hexadecimal characters.");
} catch {
  errors.push(
    "Run scripts/bootstrap-users.mjs to prepare the multi-user authentication secrets.",
  );
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("Deployment configuration and authentication secrets are present.");
