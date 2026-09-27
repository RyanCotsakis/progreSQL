import { readFileSync, readdirSync } from "node:fs";
import {
  encryptSecret,
  newParameters,
  verifier,
  type Env,
} from "../worker/auth";
import type { Identity } from "../shared/users";

export const admin: Identity = { user_id: 1, username: "Private", is_admin: 1 };
export const testSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
export const proof = "ab".repeat(32);
export function migrationStatements(name: string) {
  const sql = readFileSync(
    new URL(`../migrations/${name}`, import.meta.url),
    "utf8",
  ).replace(/--[^\n]*/g, "");
  return sql
    .split(/;\s*(?=CREATE|INSERT|DROP|ALTER|UPDATE|PRAGMA|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}
export async function migrate(db: D1Database) {
  for (const name of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await db.batch(migrationStatements(name).map((sql) => db.prepare(sql)));
}
export async function testEnv(db: D1Database): Promise<Env> {
  const env: Env = {
    DB: db,
    AUTH_PEPPER: "test-only-pepper-with-at-least-32-characters",
    AUTH_ENCRYPTION_KEY: "12".repeat(32),
    ASSETS: {
      fetch: async () => new Response("assets"),
      connect: () => {
        throw new Error("Unused test binding");
      },
    },
  };
  await db
    .prepare(
      "UPDATE users SET username='Private',status='active',password_parameters=?,password_verifier=?,totp_secret=?,last_totp_step=-1 WHERE user_id=1",
    )
    .bind(
      JSON.stringify(newParameters()),
      await verifier(env, proof),
      await encryptSecret(env, testSecret),
    )
    .run();
  return env;
}
