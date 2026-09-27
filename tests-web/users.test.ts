import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  admin,
  migrate,
  migrationStatements,
  proof,
  testEnv,
  testSecret,
} from "./helpers";
import {
  authorize,
  decryptSecret,
  encryptSecret,
  login,
  parameters,
  sha256,
  totpAt,
  type Env,
} from "../worker/auth";
import {
  completeSetup,
  inspectSetup,
  listUsers,
  manageUser,
} from "../worker/users";
import { mutate, readData } from "../worker/service";
import type { Identity } from "../shared/users";
import type { Action } from "../shared/actions";
import type { AppData } from "../shared/model";
import worker from "../worker/index";
import { bootstrapSQL } from "../scripts/bootstrap-users.mjs";

let mf: Miniflare, db: D1Database, env: Env;
const friend: Identity = { user_id: 2, username: "Friend", is_admin: 0 };
const secondAdmin: Identity = { user_id: 3, username: "Second", is_admin: 1 };
const origin = "https://progresql.cotsakis.com";
const step = () => Math.floor(Date.now() / 30000);
const request = (path: string, body?: unknown, cookie?: string) =>
  new Request(origin + path, {
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
  });
async function session(user: Identity) {
  const token = String(user.user_id).padStart(64, "0");
  await db
    .prepare(
      "INSERT OR REPLACE INTO auth_session(token_hash,user_id,credential_version,expires_at) SELECT ?,user_id,credential_version,? FROM users WHERE user_id=?",
    )
    .bind(
      await sha256(token),
      Math.floor(Date.now() / 1000) + 3600,
      user.user_id,
    )
    .run();
  return `__Host-progresql=${token}`;
}
const snapshot = async (user: Identity) =>
  (await readData(db, user)) as unknown as AppData;
async function library(user: Identity) {
  await mutate(
    db,
    {
      action: "exercise.create",
      name: "Bench",
      effective_from: "2026-01-01",
      weight: 50,
      max_reps: 10,
      sets: 3,
    },
    user,
  );
  await mutate(db, { action: "workout.create", name: "Push" }, user);
  const d = await snapshot(user);
  const e = d.exercises[0].exercise_id,
    w = d.workouts[0].workout_id;
  await mutate(
    db,
    {
      action: "workout.members",
      id: w,
      effective_from: "2026-01-01",
      exercise_ids: [e],
    },
    user,
  );
  await mutate(
    db,
    { action: "session.log", id: w, workout_date: "2026-01-02" },
    user,
  );
  return { e, w, s: (await snapshot(user)).sessions[0].workout_session_id };
}
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("test")}}',
      d1Databases: ["DB", "MIGRATION"],
      compatibilityDate: "2026-09-23",
    }),
  );
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await migrate(db);
}, 30000);
beforeEach(async () => {
  await db.batch(
    [
      "auth_session",
      "auth_token",
      "auth_rate_limit",
      "workout_session",
      "workout_exercise",
      "exercise_settings_history",
      "workout",
      "exercise",
    ].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
  await db.prepare("UPDATE users SET is_admin=1 WHERE user_id=1").run();
  await db.prepare("DELETE FROM users WHERE user_id<>1").run();
  env = await testEnv(db);
  for (const user of [friend, secondAdmin])
    await db
      .prepare(
        `INSERT INTO users(user_id,username,is_admin,status,password_parameters,password_verifier,totp_secret)
    SELECT ?,?,?,'active',password_parameters,password_verifier,totp_secret FROM users WHERE user_id=1`,
      )
      .bind(user.user_id, user.username, user.is_admin)
      .run();
});
afterAll(async () => {
  await mf?.dispose();
});

describe("private workout records", () => {
  it("allows duplicate names between users and scopes every table and API response", async () => {
    await library(admin);
    await library(friend);
    for (const user of [admin, friend]) {
      const data = await snapshot(user);
      for (const rows of Object.values(data)) {
        expect(rows).toHaveLength(1);
        expect(rows[0].user_id).toBe(user.user_id);
      }
      const response = await worker.fetch(
        request("/api/data", undefined, await session(user)),
        env,
      );
      expect(await response.json()).toEqual(data);
    }
    const all = await readData(db, admin, true);
    expect(all.exercises).toHaveLength(2);
    await expect(readData(db, friend, true)).rejects.toThrow("Admin");
  });
  it("rejects foreign IDs for all mutations, including mixed exercise memberships", async () => {
    const a = await library(admin),
      f = await library(friend);
    const before = await snapshot(admin);
    const attempts: Action[] = [
      { action: "exercise.update", id: a.e, name: "stolen" },
      { action: "exercise.archive", id: a.e },
      {
        action: "exercise.state",
        id: a.e,
        effective_from: "2026-02-01",
        weight: 10,
        max_reps: 10,
        sets: 3,
      },
      { action: "workout.update", id: a.w, name: "stolen" },
      { action: "workout.archive", id: a.w },
      {
        action: "workout.members",
        id: a.w,
        effective_from: "2026-02-01",
        exercise_ids: [f.e],
      },
      {
        action: "workout.members",
        id: f.w,
        effective_from: "2026-02-01",
        exercise_ids: [f.e, a.e],
      },
      { action: "session.log", id: a.w, workout_date: "2026-03-01" },
      { action: "session.delete", id: a.s },
    ];
    for (const action of attempts)
      await expect(mutate(db, action, friend)).rejects.toThrow(
        "Record not found",
      );
    expect(await snapshot(admin)).toEqual(before);
    const cookie = await session(friend);
    const response = await worker.fetch(
      request(
        "/api/actions",
        { action: "workout.create", name: "Mine", user_id: 1 },
        cookie,
      ),
      env,
    );
    expect(response.status).toBe(200);
    expect(
      (await snapshot(friend)).workouts.find((w) => w.workout_name === "Mine")
        ?.user_id,
    ).toBe(2);
  });
  it("enforces ownership in SQL and admin editing, and rejects non-admin endpoints", async () => {
    const a = await library(admin),
      f = await library(friend);
    await expect(
      db
        .prepare(
          "INSERT INTO workout_exercise(user_id,workout_id,exercise_id,exercise_order,effective_from) VALUES(2,?,?,2,'2026-04-01')",
        )
        .bind(f.w, a.e)
        .run(),
    ).rejects.toThrow("FOREIGN KEY");
    await expect(
      db
        .prepare("UPDATE workout SET user_id=1 WHERE workout_id=?")
        .bind(f.w)
        .run(),
    ).rejects.toThrow("ownership");
    await expect(
      mutate(
        db,
        {
          action: "admin.save",
          table: "workout",
          rows: [{ workout_id: f.w, user_id: 1, workout_name: "Other" }],
          deleted: [],
        },
        admin,
      ),
    ).rejects.toThrow("ownership");
    await mutate(
      db,
      {
        action: "admin.save",
        table: "workout",
        rows: [{ workout_id: f.w, user_id: 2, workout_name: "Updated" }],
        deleted: [],
      },
      admin,
    );
    expect((await snapshot(friend)).workouts[0].workout_name).toBe("Updated");
    await expect(
      mutate(
        db,
        {
          action: "admin.insert",
          table: "workout",
          row: { workout_name: "Missing owner" },
        },
        admin,
      ),
    ).rejects.toThrow("owner");
    const cookie = await session(friend);
    for (const path of ["/api/admin/users", "/api/admin/data"])
      expect(
        (await worker.fetch(request(path, undefined, cookie), env)).status,
      ).toBe(403);
    expect(
      (
        await worker.fetch(
          request(
            "/api/actions",
            {
              action: "admin.save",
              table: "workout",
              rows: [],
              deleted: [a.w],
            },
            cookie,
          ),
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (await worker.fetch(request("/api/admin/users", {}, cookie), env)).status,
    ).toBe(403);
  });
});

describe("enrollment and recovery", () => {
  it("encrypts authenticator secrets and exposes no credentials through user summaries", async () => {
    const encrypted = await encryptSecret(env, testSecret);
    expect(encrypted).not.toContain(testSecret);
    expect(await decryptSecret(env, encrypted)).toBe(testSecret);
    const users = await listUsers(env);
    expect(Object.keys(users[0]).sort()).toEqual([
      "created_at",
      "is_admin",
      "status",
      "user_id",
      "username",
    ]);
    const first = await parameters(env, "unknown");
    expect(await parameters(env, "UNKNOWN")).toEqual(first);
    expect(Object.keys(first).sort()).toEqual(
      Object.keys(await parameters(env, "Private")).sort(),
    );
  });
  it("requires fresh admin credentials and consumes a verification code once", async () => {
    const cookie = await session(admin),
      code = await totpAt(testSecret, step());
    const operation = { action: "create", username: "Invited" };
    expect(
      (
        await worker.fetch(
          request(
            "/api/admin/users",
            { operation, proof: "cd".repeat(32), code },
            cookie,
          ),
          env,
        )
      ).status,
    ).toBe(401);
    const result = await worker.fetch(
      request("/api/admin/users", { operation, proof, code }, cookie),
      env,
    );
    expect(result.status).toBe(200);
    expect(
      (
        await worker.fetch(
          request(
            "/api/admin/users",
            { operation: { ...operation, username: "Another" }, proof, code },
            cookie,
          ),
          env,
        )
      ).status,
    ).toBe(401);
  });
  it("redeems invitations atomically once and preserves ordinary login afterward", async () => {
    const invite = await manageUser(env, admin, {
      action: "create",
      username: "NewFriend",
    });
    const token = invite.token!;
    expect(
      JSON.stringify(
        (await db.prepare("SELECT * FROM auth_token").all()).results,
      ),
    ).not.toContain(token);
    const info = await inspectSetup(env, token);
    expect(info.otpauth).toContain("otpauth://totp/");
    expect((await inspectSetup(env, token)).secret).toBe(info.secret);
    const code = await totpAt(info.secret!, step());
    const results = await Promise.allSettled([
      completeSetup(env, token, proof, code),
      completeSetup(env, token, proof, code),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(inspectSetup(env, token)).rejects.toThrow("expired");
    const cookie = await login(request("/api/auth/login"), env, {
      username: "NewFriend",
      proof,
      code: await totpAt(info.secret!, step() + 1),
    });
    const identity = await authorize(
      request("/api/data", undefined, cookie),
      env,
    );
    expect(identity?.username).toBe("NewFriend");
    for (const rows of Object.values(await snapshot(identity!)))
      expect(rows).toHaveLength(0);
  });
  it("expires/reissues links and validates codes without consuming a valid token", async () => {
    const invite = await manageUser(env, admin, {
      action: "create",
      username: "Invited",
    });
    const u = (await listUsers(env)).find((u) => u.username === "Invited")!;
    const next = await manageUser(env, admin, {
      action: "link",
      user_id: u.user_id,
      kind: "invite",
    });
    await expect(inspectSetup(env, invite.token!)).rejects.toThrow("expired");
    const info = await inspectSetup(env, next.token!);
    const actual = await totpAt(info.secret!, step());
    const wrong = String((Number(actual) + 123456) % 1000000).padStart(6, "0");
    await expect(completeSetup(env, next.token!, proof, wrong)).rejects.toThrow(
      "code",
    );
    expect((await inspectSetup(env, next.token!)).username).toBe("Invited");
    await db.prepare("UPDATE auth_token SET expires_at=0").run();
    await expect(
      completeSetup(env, next.token!, proof, actual),
    ).rejects.toThrow("expired");
  });
  it("password recovery revokes sessions, blocks login, and retains the authenticator", async () => {
    const cookie = await session(friend);
    const before = await db
      .prepare("SELECT totp_secret FROM users WHERE user_id=2")
      .first<{ totp_secret: string }>();
    const link = await manageUser(env, admin, {
      action: "link",
      user_id: 2,
      kind: "password",
    });
    expect(
      await authorize(request("/api/data", undefined, cookie), env),
    ).toBeNull();
    await expect(
      login(request("/api/auth/login"), env, {
        username: "Friend",
        proof,
        code: await totpAt(testSecret, step()),
      }),
    ).rejects.toThrow("Invalid");
    const info = await inspectSetup(env, link.token!);
    expect(info.secret).toBeUndefined();
    await completeSetup(
      env,
      link.token!,
      "cd".repeat(32),
      await totpAt(testSecret, step()),
    );
    expect(
      await db.prepare("SELECT totp_secret FROM users WHERE user_id=2").first(),
    ).toEqual(before);
    const result = await login(request("/api/auth/login"), env, {
      username: "Friend",
      proof: "cd".repeat(32),
      code: await totpAt(testSecret, step() + 1),
    });
    expect(
      await authorize(request("/api/data", undefined, result), env),
    ).toEqual(friend);
  });
  it("full recovery replaces both credentials and can be reissued after expiry", async () => {
    const link = await manageUser(env, admin, {
      action: "link",
      user_id: 2,
      kind: "recover",
    });
    const info = await inspectSetup(env, link.token!);
    expect(info.secret).not.toBe(testSecret);
    await db.prepare("UPDATE auth_token SET expires_at=0").run();
    const next = await manageUser(env, admin, {
      action: "link",
      user_id: 2,
      kind: "recover",
    });
    const replacement = await inspectSetup(env, next.token!);
    expect(replacement.secret).not.toBe(info.secret);
    await completeSetup(
      env,
      next.token!,
      "cd".repeat(32),
      await totpAt(replacement.secret!, step()),
    );
    const stored = await db
      .prepare("SELECT totp_secret FROM users WHERE user_id=2")
      .first<{ totp_secret: string }>();
    expect(await decryptSecret(env, stored!.totp_secret)).toBe(
      replacement.secret,
    );
  });
  it("rate limits setup completion and rejects cross-origin token redemption", async () => {
    for (let i = 0; i < 10; i++)
      expect(
        (
          await worker.fetch(
            request("/api/auth/complete", {
              token: "00".repeat(32),
              proof,
              code: "123456",
            }),
            env,
          )
        ).status,
      ).toBe(400);
    expect(
      (
        await worker.fetch(
          request("/api/auth/complete", {
            token: "00".repeat(32),
            proof,
            code: "123456",
          }),
          env,
        )
      ).status,
    ).toBe(429);
    const foreign = new Request(origin + "/api/auth/setup", {
      method: "POST",
      headers: {
        Origin: "https://other.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: "00".repeat(32) }),
    });
    expect((await worker.fetch(foreign, env)).status).toBe(403);
  });
});

describe("account administration", () => {
  it("allows only one of two concurrent demotions of the remaining admins", async () => {
    await db.prepare("UPDATE users SET is_admin=0 WHERE user_id=3").run();
    await db.prepare("UPDATE users SET is_admin=1 WHERE user_id=2").run();
    const result = await Promise.allSettled([
      manageUser(env, admin, {
        action: "update",
        user_id: 2,
        username: "Friend",
        is_admin: false,
      }),
      manageUser(
        env,
        { ...friend, is_admin: 1 },
        { action: "update", user_id: 1, username: "Private", is_admin: false },
      ),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await listUsers(env)).filter((u) => u.is_admin)).toHaveLength(1);
  });
  it("revokes sessions on role/username changes and rejects self-demotion and deletion", async () => {
    const cookie = await session(friend);
    await manageUser(env, admin, {
      action: "update",
      user_id: 2,
      username: "Renamed",
      is_admin: true,
    });
    expect(
      await authorize(request("/api/data", undefined, cookie), env),
    ).toBeNull();
    expect((await listUsers(env)).find((u) => u.user_id === 2)).toMatchObject({
      username: "Renamed",
      is_admin: 1,
    });
    await expect(
      manageUser(env, admin, {
        action: "update",
        user_id: 1,
        username: "Private",
        is_admin: false,
      }),
    ).rejects.toThrow("own admin");
    await expect(
      manageUser(env, admin, {
        action: "delete",
        user_id: 1,
        confirmation: "Private",
      }),
    ).rejects.toThrow("own account");
  });
  it("deletes all account data and leaves other users intact", async () => {
    await library(admin);
    await library(friend);
    const before = await snapshot(admin),
      cookie = await session(friend);
    await manageUser(env, admin, {
      action: "link",
      user_id: 2,
      kind: "recover",
    });
    await expect(
      manageUser(env, admin, {
        action: "delete",
        user_id: 2,
        confirmation: "wrong",
      }),
    ).rejects.toThrow("Type the username");
    await manageUser(env, admin, {
      action: "delete",
      user_id: 2,
      confirmation: "Friend",
    });
    expect(await snapshot(admin)).toEqual(before);
    for (const rows of Object.values(await snapshot(friend)))
      expect(rows).toHaveLength(0);
    for (const table of ["users", "auth_session", "auth_token"])
      expect(
        await db.prepare(`SELECT 1 FROM ${table} WHERE user_id=2`).first(),
      ).toBeNull();
    expect(
      await authorize(request("/api/data", undefined, cookie), env),
    ).toBeNull();
  });
  it("protects the last admin inside SQL and rolls back prior deletions", async () => {
    await library(secondAdmin);
    await db.prepare("UPDATE users SET is_admin=0 WHERE user_id=1").run();
    const before = await snapshot(secondAdmin);
    await expect(
      db.prepare("UPDATE users SET is_admin=0 WHERE user_id=3").run(),
    ).rejects.toThrow("Keep at least one admin");
    // Simulate a previously authorized request racing a demotion: the database guard
    // must undo the entire delete, including its already executed child deletes.
    await expect(
      manageUser(env, admin, {
        action: "delete",
        user_id: 3,
        confirmation: "Second",
      }),
    ).rejects.toThrow("Keep at least one admin");
    expect(await snapshot(secondAdmin)).toEqual(before);
  });
});

it("migrates populated legacy tables without losing IDs, relationships, or timestamps", async () => {
  const legacy = (await mf.getD1Database("MIGRATION")) as unknown as D1Database;
  for (const name of ["0001_initial.sql", "0002_auth.sql"])
    await legacy.batch(migrationStatements(name).map((s) => legacy.prepare(s)));
  await legacy.batch([
    legacy.prepare(
      "INSERT INTO exercise(exercise_id,exercise_name,created_at) VALUES(42,'Original','2020-01-01')",
    ),
    legacy.prepare(
      "INSERT INTO workout(workout_id,workout_name) VALUES(17,'Original workout')",
    ),
    legacy.prepare(
      "INSERT INTO exercise_settings_history(exercise_settings_id,exercise_id,effective_from,weight,max_reps,sets) VALUES(10,42,'2020-01-01',40,8,3)",
    ),
    legacy.prepare(
      "INSERT INTO workout_exercise(workout_exercise_id,workout_id,exercise_id,exercise_order,effective_from) VALUES(11,17,42,1,'2020-01-01')",
    ),
    legacy.prepare(
      "INSERT INTO workout_session(workout_session_id,workout_id,workout_date) VALUES(12,17,'2020-01-02')",
    ),
    legacy.prepare("INSERT INTO auth_session VALUES('old','old',9999999999)"),
  ]);
  const tables = [
    "exercise",
    "workout",
    "exercise_settings_history",
    "workout_exercise",
    "workout_session",
  ];
  const before = await Promise.all(
    tables.map((t) => legacy.prepare(`SELECT * FROM ${t}`).all()),
  );
  for (const name of ["0003_users.sql", "0004_user_guards.sql"])
    await legacy.batch(migrationStatements(name).map((s) => legacy.prepare(s)));
  for (let i = 0; i < tables.length; i++)
    expect(
      (await legacy.prepare(`SELECT * FROM ${tables[i]}`).all()).results,
    ).toEqual(before[i].results.map((r) => ({ ...(r as object), user_id: 1 })));
  expect(
    (await legacy.prepare("PRAGMA foreign_key_check").all()).results,
  ).toEqual([]);
  expect(
    (await legacy.prepare("SELECT * FROM auth_session").all()).results,
  ).toEqual([]);
  const source = {
    AUTH_USERNAME: "Preserved",
    AUTH_PASSWORD_PARAMETERS: JSON.stringify(await parameters(env, "Private")),
    AUTH_PASSWORD_VERIFIER: (await db
      .prepare("SELECT password_verifier FROM users WHERE user_id=1")
      .first<{ password_verifier: string }>())!.password_verifier,
    AUTH_TOTP_SECRET: testSecret,
    AUTH_PEPPER: env.AUTH_PEPPER,
  };
  const sql = bootstrapSQL(source, env.AUTH_ENCRYPTION_KEY);
  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  await legacy.batch(statements.map((s) => legacy.prepare(s)));
  const migratedEnv = { ...env, DB: legacy };
  const cookie = await login(request("/api/auth/login"), migratedEnv, {
    username: "Preserved",
    proof,
    code: await totpAt(testSecret, step()),
  });
  expect(
    await authorize(request("/api/data", undefined, cookie), migratedEnv),
  ).toEqual({ ...admin, username: "Preserved" });
  await legacy
    .prepare(
      "UPDATE users SET username='Changed',credential_version=credential_version+1 WHERE user_id=1",
    )
    .run();
  await legacy.batch(statements.map((s) => legacy.prepare(s)));
  expect(
    (
      await legacy
        .prepare("SELECT username FROM users WHERE user_id=1")
        .first<{ username: string }>()
    )?.username,
  ).toBe("Changed");
});
