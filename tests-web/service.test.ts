import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import {
  login,
  logout,
  totpAt,
  hex,
  type Env as AuthEnv,
} from "../worker/auth";
import { mutate, readData } from "../worker/service";
import worker from "../worker/index";
import { authorize, type Env } from "../worker/auth";
import { actionSchema } from "../shared/actions";
import { membersFor, stateFor, type AppData } from "../shared/model";

let mf: Miniflare;
let db: D1Database;
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("test") } }',
      d1Databases: ["DB"],
      compatibilityDate: "2026-09-23",
    }),
  );
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  let schema = readFileSync(
    new URL("../migrations/0001_initial.sql", import.meta.url),
    "utf8",
  );
  schema += readFileSync(
    new URL("../migrations/0002_auth.sql", import.meta.url),
    "utf8",
  );
  await db.batch(
    schema
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
}, 30000);
beforeEach(async () => {
  await db.batch(
    [
      "auth_session",
      "auth_rate_limit",
      "auth_totp",
      "workout_session",
      "workout_exercise",
      "exercise_settings_history",
      "workout",
      "exercise",
    ].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
});
afterAll(async () => {
  await mf?.dispose();
});
const data = async () => (await readData(db)) as unknown as AppData;
async function exercise(name = "Bench", effective_from = "2026-01-01") {
  await mutate(db, {
    action: "exercise.create",
    name,
    effective_from,
    weight: 60,
    max_reps: 10,
    sets: 3,
  });
  return (await data()).exercises.find((e) => e.exercise_name === name)!
    .exercise_id;
}
async function workout() {
  await mutate(db, { action: "workout.create", name: "Push" });
  return (await data()).workouts[0].workout_id;
}
const state = (id: number, effective_from: string, weight: number) =>
  mutate(db, {
    action: "exercise.state",
    id,
    effective_from,
    weight,
    max_reps: 8,
    sets: 3,
  });

describe("D1 service parity with the Python rules", () => {
  it("creates an exercise and its initial prescription atomically", async () => {
    const id = await exercise();
    expect(stateFor(await data(), id, "2026-01-01")?.weight).toBe(60);
    await expect(
      mutate(db, {
        action: "exercise.create",
        name: "Broken",
        effective_from: "2026-01-01",
        weight: 10,
        max_reps: 0,
        sets: 3,
      }),
    ).rejects.toThrow();
    expect((await data()).exercises.map((e) => e.exercise_name)).toEqual([
      "Bench",
    ]);
  });
  it("keeps future changes from applying early and supports changes before the first state", async () => {
    const id = await exercise("Bench", "2026-03-01");
    expect(stateFor(await data(), id, "2026-02-28")).toBeUndefined();
    await state(id, "2026-01-01", 55);
    expect(stateFor(await data(), id, "2026-02-28")?.effective_to).toBe(
      "2026-03-01",
    );
    expect(stateFor(await data(), id, "2026-03-01")?.weight).toBe(60);
  });
  it("splits historical periods and corrects the same date without changing its ID or end", async () => {
    const id = await exercise();
    await state(id, "2026-07-01", 70);
    await state(id, "2026-03-01", 65);
    const original = stateFor(await data(), id, "2026-04-01")!;
    await state(id, "2026-03-01", 66);
    const result = await data();
    expect(stateFor(result, id, "2026-02-01")?.weight).toBe(60);
    expect(stateFor(result, id, "2026-04-01")).toMatchObject({
      weight: 66,
      effective_to: "2026-07-01",
      exercise_settings_id: original.exercise_settings_id,
    });
    expect(stateFor(result, id, "2026-08-01")?.weight).toBe(70);
    await state(id, "2026-07-01", 75);
    expect(stateFor(await data(), id, "2026-08-01")?.effective_to).toBeNull();
  });
  it("retains a covering period’s end even when an administrative edit left a gap", async () => {
    const id = await exercise();
    await db
      .prepare(
        "UPDATE exercise_settings_history SET effective_to=? WHERE exercise_id=?",
      )
      .bind("2026-03-01", id)
      .run();
    await state(id, "2026-02-01", 65);
    expect(stateFor(await data(), id, "2026-02-15")?.effective_to).toBe(
      "2026-03-01",
    );
    expect(stateFor(await data(), id, "2026-03-15")).toBeUndefined();
  });
  it("serializes concurrent changes without overlapping histories", async () => {
    const id = await exercise();
    await Promise.all([
      state(id, "2026-03-01", 65),
      state(id, "2026-02-01", 62.5),
      state(id, "2026-07-01", 70),
    ]);
    const history = (await data()).prescriptions;
    expect(history.map((p) => [p.effective_from, p.effective_to])).toEqual([
      ["2026-01-01", "2026-02-01"],
      ["2026-02-01", "2026-03-01"],
      ["2026-03-01", "2026-07-01"],
      ["2026-07-01", null],
    ]);
  });
  it("resolves workout order and prescriptions on the session date, including same-day corrections", async () => {
    const bench = await exercise();
    const squat = await exercise("Squat");
    const id = await workout();
    await mutate(db, {
      action: "workout.members",
      id,
      exercise_ids: [bench],
      effective_from: "1900-01-01",
    });
    await mutate(db, { action: "session.log", id, workout_date: "2026-01-15" });
    await mutate(db, {
      action: "workout.members",
      id,
      exercise_ids: [squat, bench],
      effective_from: "2026-01-15",
    });
    await state(bench, "2026-03-01", 70);
    const snapshot = await data();
    expect(
      membersFor(snapshot, id, "2026-01-14").map((m) => m.exercise_id),
    ).toEqual([bench]);
    expect(
      membersFor(snapshot, id, snapshot.sessions[0].workout_date).map(
        (m) => m.exercise_id,
      ),
    ).toEqual([squat, bench]);
    expect(
      stateFor(snapshot, bench, snapshot.sessions[0].workout_date)?.weight,
    ).toBe(60);
    await mutate(db, {
      action: "workout.members",
      id,
      exercise_ids: [bench, squat],
      effective_from: "2026-01-15",
    });
    expect(
      membersFor(await data(), id, "2026-01-15").map((m) => m.exercise_id),
    ).toEqual([bench, squat]);
  });
  it("preserves scheduled membership boundaries and rolls back invalid replacements", async () => {
    const bench = await exercise();
    const squat = await exercise("Squat");
    const id = await workout();
    for (const [date, ids] of [
      ["2026-01-01", [bench]],
      ["2026-07-01", [squat]],
      ["2026-03-01", [bench, squat]],
    ] as const) {
      await mutate(db, {
        action: "workout.members",
        id,
        effective_from: date,
        exercise_ids: [...ids],
      });
    }
    expect(
      membersFor(await data(), id, "2026-07-01").map((m) => m.exercise_id),
    ).toEqual([squat]);
    const before = (await data()).memberships;
    await expect(
      mutate(db, {
        action: "workout.members",
        id,
        effective_from: "2026-03-01",
        exercise_ids: [999999],
      }),
    ).rejects.toThrow();
    expect((await data()).memberships).toEqual(before);
    await mutate(db, {
      action: "workout.members",
      id,
      effective_from: "2026-03-01",
      exercise_ids: [],
    });
    expect(membersFor(await data(), id, "2026-04-01")).toEqual([]);
  });
  it("blocks duplicate workout logs, and deleting a session leaves its workout intact", async () => {
    const id = await workout();
    await mutate(db, { action: "session.log", id, workout_date: "2026-01-15" });
    await expect(
      mutate(db, { action: "session.log", id, workout_date: "2026-01-15" }),
    ).rejects.toThrow();
    await mutate(db, {
      action: "session.delete",
      id: (await data()).sessions[0].workout_session_id,
    });
    expect((await data()).sessions).toHaveLength(0);
    expect((await data()).workouts).toHaveLength(1);
  });
  it("protects active membership and retains archived entities in history", async () => {
    const bench = await exercise();
    const id = await workout();
    await mutate(db, {
      action: "workout.members",
      id,
      exercise_ids: [bench],
      effective_from: "2026-01-01",
    });
    await mutate(db, { action: "session.log", id, workout_date: "2026-01-15" });
    await expect(
      mutate(db, { action: "exercise.archive", id: bench }),
    ).rejects.toThrow("active workouts");
    await mutate(db, { action: "workout.archive", id });
    await mutate(db, { action: "exercise.archive", id: bench });
    const snapshot = await data();
    expect(snapshot.exercises[0].is_active).toBe(0);
    expect(snapshot.workouts[0].is_active).toBe(0);
    expect(
      membersFor(snapshot, id, snapshot.sessions[0].workout_date)[0]
        .exercise_id,
    ).toBe(bench);
  });
  it("allows archiving an exercise after its open membership ends", async () => {
    const bench = await exercise();
    const id = await workout();
    await mutate(db, {
      action: "workout.members",
      id,
      exercise_ids: [bench],
      effective_from: "2026-01-01",
    });
    await mutate(db, {
      action: "workout.members",
      id,
      exercise_ids: [],
      effective_from: "2026-02-01",
    });
    await mutate(db, { action: "exercise.archive", id: bench });
    expect((await data()).exercises[0].is_active).toBe(0);
  });
  it("rolls back an entire admin batch if a deletion violates a foreign key", async () => {
    const first = await exercise("First");
    const second = await exercise("Second");
    await db
      .prepare("DELETE FROM exercise_settings_history WHERE exercise_id=?")
      .bind(first)
      .run();
    await expect(
      mutate(db, {
        action: "admin.save",
        table: "exercise",
        rows: [],
        deleted: [first, second],
      }),
    ).rejects.toThrow();
    expect((await data()).exercises).toHaveLength(2);
  });
});

describe("API security and validation", () => {
  const env = () => ({ DB: db, LOCAL_DEV: "enabled" }) as Env;
  it("fails closed without login configuration, and never enables the local bypass on a public host", async () => {
    expect(
      await authorize(
        new Request("https://progresql.cotsakis.com/api/data"),
        env(),
      ),
    ).toBe(false);
    expect(
      await authorize(new Request("http://127.0.0.1/api/data"), {} as Env),
    ).toBe(false);
    expect(
      (
        await worker.fetch(
          new Request("https://progresql.cotsakis.com/api/data"),
          env(),
        )
      ).status,
    ).toBe(401);
  });
  it("rejects cross-site mutations and malformed JSON", async () => {
    const req = (origin: string, body: string) =>
      new Request("http://127.0.0.1:8787/api/actions", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body,
      });
    expect(
      (await worker.fetch(req("https://evil.example", "{}"), env())).status,
    ).toBe(403);
    expect(
      (await worker.fetch(req("http://127.0.0.1:5173", "{"), env())).status,
    ).toBe(400);
    const response = await worker.fetch(
      req(
        "http://127.0.0.1:5173",
        JSON.stringify({ action: "workout.create", name: "API workout" }),
      ),
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("rejects invalid dates, negative weights, fractional reps, duplicate members, and arbitrary tables", () => {
    expect(
      actionSchema.safeParse({
        action: "session.log",
        id: 1,
        workout_date: "2026-02-30",
      }).success,
    ).toBe(false);
    expect(
      actionSchema.safeParse({
        action: "exercise.state",
        id: 1,
        effective_from: "2026-01-01",
        weight: -1,
        max_reps: 8,
        sets: 3,
      }).success,
    ).toBe(false);
    expect(
      actionSchema.safeParse({
        action: "exercise.state",
        id: 1,
        effective_from: "2026-01-01",
        weight: 1,
        max_reps: 8.5,
        sets: 3,
      }).success,
    ).toBe(false);
    expect(
      actionSchema.safeParse({
        action: "workout.members",
        id: 1,
        effective_from: "2026-01-01",
        exercise_ids: [1, 1],
      }).success,
    ).toBe(false);
    expect(
      actionSchema.safeParse({
        action: "admin.insert",
        table: "sqlite_master",
        row: {},
      }).success,
    ).toBe(false);
  });
});

const testSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const proof = "ab".repeat(32);
async function authEnv(): Promise<AuthEnv> {
  const pepper = "test-only-pepper-with-at-least-32-characters";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const verifier = hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      Uint8Array.from({ length: 32 }, () => 0xab),
    ),
  );
  return {
    DB: db,
    AUTH_USERNAME: "Private",
    AUTH_PASSWORD_PARAMETERS: JSON.stringify({
      algorithm: "argon2id",
      salt: "MTIzNDU2Nzg",
      iterations: 2,
      memorySize: 1024,
      parallelism: 1,
      hashLength: 32,
    }),
    AUTH_PASSWORD_VERIFIER: verifier,
    AUTH_PEPPER: pepper,
    AUTH_TOTP_SECRET: testSecret,
  } as AuthEnv;
}
const authRequest = (
  body: unknown,
  path = "/api/auth/login",
  cookie?: string,
) =>
  new Request("https://progresql.cotsakis.com" + path, {
    method: "POST",
    headers: {
      Origin: "https://progresql.cotsakis.com",
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
const credentials = async () => ({
  username: "private",
  proof,
  code: await totpAt(testSecret, Math.floor(Date.now() / 30000)),
});
describe("Password, authenticator, and sessions", () => {
  it("matches RFC 6238 TOTP vectors and rejects wrong credentials", async () => {
    expect(await totpAt(testSecret, 1)).toBe("287082");
    const env = await authEnv();
    const body = await credentials();
    for (const change of [
      { username: "other" },
      { proof: "cd".repeat(32) },
      { code: "nototp" },
    ]) {
      const response = await worker.fetch(
        authRequest({ ...body, ...change }),
        env,
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }
    expect(
      (await db.prepare("SELECT * FROM auth_session").all()).results,
    ).toHaveLength(0);
  });
  it("creates a secure cookie, stores only its hash, and revokes it on logout", async () => {
    const env = await authEnv();
    const response = await worker.fetch(authRequest(await credentials()), env);
    expect(response.status).toBe(200);
    const cookie = response.headers.get("Set-Cookie")!;
    expect(cookie).toContain("__Host-progresql=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=3600");
    const request = new Request("https://progresql.cotsakis.com/api/data", {
      headers: { Cookie: cookie },
    });
    expect(await authorize(request, env)).toBe(true);
    const stored = await db
      .prepare("SELECT token_hash FROM auth_session")
      .first<{ token_hash: string }>();
    expect(cookie).not.toContain(stored!.token_hash);
    const signedOut = await worker.fetch(
      authRequest({}, "/api/auth/logout", cookie),
      env,
    );
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(await authorize(request, env)).toBe(false);
  });
  it("expires sessions and invalidates them after a credential change", async () => {
    const env = await authEnv();
    const cookie = await login(authRequest({}), env, await credentials());
    const request = new Request("https://progresql.cotsakis.com/api/data", {
      headers: { Cookie: cookie },
    });
    expect(
      await authorize(request, {
        ...env,
        AUTH_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
      }),
    ).toBe(false);
    await db.prepare("UPDATE auth_session SET expires_at=0").run();
    expect(await authorize(request, env)).toBe(false);
  });
  it("allows exactly one concurrent login with a given authenticator code", async () => {
    const env = await authEnv();
    const body = await credentials();
    const results = await Promise.all([
      worker.fetch(authRequest(body), env),
      worker.fetch(authRequest(body), env),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(
      (await db.prepare("SELECT * FROM auth_session").all()).results,
    ).toHaveLength(1);
  });
  it("rate limits sign-in attempts and rejects cross-origin login/logout", async () => {
    const env = await authEnv();
    for (let i = 0; i < 10; i++)
      expect((await worker.fetch(authRequest({}), env)).status).toBe(401);
    const response = await worker.fetch(authRequest({}), env);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("300");
    for (const path of ["/api/auth/login", "/api/auth/logout"]) {
      const req = new Request("https://progresql.cotsakis.com" + path, {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect((await worker.fetch(req, env)).status).toBe(403);
    }
  });
  it("publishes only password derivation parameters, never the verifier or MFA secret", async () => {
    const env = await authEnv();
    const response = await worker.fetch(
      new Request("https://progresql.cotsakis.com/api/auth/config"),
      env,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body).algorithm).toBe("argon2id");
    for (const value of [
      env.AUTH_PASSWORD_VERIFIER,
      env.AUTH_TOTP_SECRET,
      env.AUTH_PEPPER,
      env.AUTH_USERNAME,
    ])
      expect(body).not.toContain(value);
  });
});
