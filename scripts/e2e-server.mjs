import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";
import ts from "typescript";
import { argon2id } from "hash-wasm";

const cli = "node_modules/wrangler/bin/wrangler.js";
const persist = ".wrangler/e2e";
const params = {
  algorithm: "argon2id",
  salt: Buffer.from("test-salt-1234567").toString("base64"),
  iterations: 3,
  memorySize: 65536,
  parallelism: 4,
  hashLength: 32,
};
const proof = await argon2id({
  password: "browser-test-password",
  salt: Buffer.from(params.salt, "base64"),
  iterations: params.iterations,
  memorySize: params.memorySize,
  parallelism: params.parallelism,
  hashLength: params.hashLength,
  outputType: "hex",
});
const pepper = "test-pepper-no-production-secrets-used";
const config = ts.parseConfigFileTextToJson(
  "wrangler.jsonc",
  readFileSync("wrangler.jsonc", "utf8"),
).config;
config.name = "progresql-browser-test";
config.routes = [];
config.main = resolve("worker/index.ts");
config.assets.directory = resolve("dist");
config.d1_databases[0].migrations_dir = resolve("migrations");
config.vars = {
  AUTH_USERNAME: "browser-test-user",
  AUTH_PASSWORD_PARAMETERS: JSON.stringify(params),
  AUTH_PASSWORD_VERIFIER: createHmac("sha256", pepper)
    .update(Buffer.from(proof, "hex"))
    .digest("hex"),
  AUTH_PEPPER: pepper,
  AUTH_TOTP_SECRET: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
};
delete config.secrets;
mkdirSync(".wrangler", { recursive: true });
const configPath = ".wrangler/e2e-config.json";
writeFileSync(configPath, JSON.stringify(config, null, 2));
const base = ["--config", configPath, "--persist-to", persist];
execFileSync(
  process.execPath,
  [cli, "d1", "migrations", "apply", "progresql", "--local", ...base],
  { stdio: "inherit" },
);
execFileSync(
  process.execPath,
  [
    cli,
    "d1",
    "execute",
    "progresql",
    "--local",
    ...base,
    "--command",
    "DELETE FROM auth_session; DELETE FROM auth_totp; DELETE FROM auth_rate_limit;",
  ],
  { stdio: "inherit" },
);
const child = spawn(
  process.execPath,
  [
    cli,
    "dev",
    ...base,
    "--ip",
    "127.0.0.1",
    "--local-upstream",
    "127.0.0.1",
    "--upstream-protocol",
    "http",
    "--port",
    "8788",
  ],
  { stdio: "inherit" },
);
for (const event of ["SIGINT", "SIGTERM"])
  process.on(event, () => child.kill());
child.on("exit", (code) => process.exit(code ?? 1));
