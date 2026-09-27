import { createCipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
export function bootstrapSQL(legacy, encryptionKey) {
  for (const key of [
    "AUTH_USERNAME",
    "AUTH_PASSWORD_PARAMETERS",
    "AUTH_PASSWORD_VERIFIER",
    "AUTH_TOTP_SECRET",
    "AUTH_PEPPER",
  ])
    if (typeof legacy[key] !== "string" || !legacy[key])
      throw new Error(`Missing legacy ${key}.`);
  if (!/^[a-f0-9]{64}$/.test(encryptionKey))
    throw new Error("Expected a 32-byte encryption key in hexadecimal.");
  const params = JSON.parse(legacy.AUTH_PASSWORD_PARAMETERS);
  if (params.algorithm !== "argon2id" || params.hashLength !== 32)
    throw new Error("Expected an Argon2id credential with a 32-byte digest.");
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(encryptionKey, "hex"),
    iv,
  );
  const encrypted = Buffer.concat([
    cipher.update(legacy.AUTH_TOTP_SECRET, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const secret = `${iv.toString("hex")}:${encrypted.toString("hex")}`;
  return `UPDATE users SET username=${quote(legacy.AUTH_USERNAME)},password_parameters=${quote(legacy.AUTH_PASSWORD_PARAMETERS)},password_verifier=${quote(legacy.AUTH_PASSWORD_VERIFIER)},totp_secret=${quote(secret)},status='active',credential_version=credential_version+1 WHERE user_id=1 AND username='__bootstrap__' AND status='pending' AND NOT EXISTS(SELECT 1 FROM auth_bootstrap);\nINSERT INTO auth_bootstrap(id) SELECT 1 WHERE changes()=1;\n`;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (
      existsSync(".env.auth-upload.json") &&
      JSON.parse(readFileSync(".env.auth-upload.json", "utf8"))
        .AUTH_ENCRYPTION_KEY
    )
      throw new Error("The current encryption key must not be overwritten.");
    const source = resolve(process.argv[2] || ".env.auth-upload.json");
    const legacy = JSON.parse(readFileSync(source, "utf8"));
    if (legacy.AUTH_ENCRYPTION_KEY)
      throw new Error(
        "Already converted. Use the previously prepared bootstrap SQL; do not reset the encryption key.",
      );
    const key = randomBytes(32).toString("hex");
    const sql = bootstrapSQL(legacy, key);
    const directory = resolve("exports", `users-bootstrap-${Date.now()}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      resolve(directory, "legacy-auth.json"),
      JSON.stringify(legacy, null, 2) + "\n",
      { flag: "wx" },
    );
    writeFileSync(resolve(directory, "bootstrap.sql"), sql, { flag: "wx" });
    const secrets = {
      AUTH_PEPPER: legacy.AUTH_PEPPER,
      AUTH_ENCRYPTION_KEY: key,
    };
    writeFileSync(
      ".env.auth-upload.json",
      JSON.stringify(secrets, null, 2) + "\n",
    );
    writeFileSync(
      ".dev.vars",
      Object.entries(secrets)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join("\n") + "\n",
    );
    console.log(
      `Prepared ${directory}/bootstrap.sql and the two Worker secrets. Keep both securely. No database was changed.`,
    );
  } catch {
    console.error(
      "Credential preparation failed. Check that the input is valid legacy authentication JSON. If already converted, reuse the existing bootstrap SQL and encryption key. No credentials are printed.",
    );
    process.exitCode = 1;
  }
}
