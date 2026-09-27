import type { Identity, UserAction, UserSummary } from "../shared/users";
import {
  AuthError,
  decryptSecret,
  encryptSecret,
  matchTotp,
  newParameters,
  nowSeconds,
  randomToken,
  sha256,
  verifier,
  type Env,
  type UserRecord,
} from "./auth";

export async function listUsers(env: Env) {
  return (
    await env.DB.prepare(
      "SELECT user_id,username,is_admin,status,created_at FROM users ORDER BY username",
    ).all<UserSummary>()
  ).results;
}
function newTotpSecret() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (b) => alphabet[b & 31],
  ).join("");
}
export async function manageUser(
  env: Env,
  actor: Identity,
  action: UserAction,
) {
  if (!actor.is_admin) throw new AuthError("Admin access required.", 403);
  const q = (sql: string, ...args: (string | number | null)[]) =>
    env.DB.prepare(sql).bind(...args);
  if (action.action === "create") {
    const token = randomToken();
    const results = await env.DB.batch([
      q(
        "INSERT INTO users(username) VALUES (?) RETURNING user_id",
        action.username,
      ),
      q(
        "INSERT INTO auth_token(token_hash,user_id,kind,expires_at,password_parameters,totp_secret) VALUES (?,last_insert_rowid(),'invite',?,?,?)",
        await sha256(token),
        nowSeconds() + 86400,
        JSON.stringify(newParameters()),
        await encryptSecret(env, newTotpSecret()),
      ),
    ]);
    return {
      token,
      user_id: (results[0].results[0] as { user_id: number }).user_id,
    };
  }
  const user = await q(
    "SELECT * FROM users WHERE user_id=?",
    action.user_id,
  ).first<UserRecord>();
  if (!user) throw new AuthError("User not found.", 404);
  if (action.action === "update") {
    if (actor.user_id === user.user_id && !action.is_admin)
      throw new AuthError("You cannot remove your own admin access.", 400);
    // Invalidate existing sessions after username or role changes.
    await env.DB.batch([
      q(
        "UPDATE users SET username=?,is_admin=?,credential_version=credential_version+1 WHERE user_id=?",
        action.username,
        Number(action.is_admin),
        user.user_id,
      ),
      q("DELETE FROM auth_session WHERE user_id=?", user.user_id),
    ]);
    return { ok: true };
  }
  if (action.action === "delete") {
    if (actor.user_id === user.user_id)
      throw new AuthError("You cannot delete your own account.", 400);
    if (action.confirmation !== user.username)
      throw new AuthError("Type the username to confirm deletion.", 400);
    // The last-admin trigger rolls back this entire batch if concurrent role changes
    // made this user the last remaining admin.
    await env.DB.batch([
      ...[
        "workout_session",
        "workout_exercise",
        "exercise_settings_history",
        "workout",
        "exercise",
      ].map((t) => q(`DELETE FROM ${t} WHERE user_id=?`, user.user_id)),
      q("DELETE FROM users WHERE user_id=?", user.user_id),
    ]);
    return { ok: true };
  }
  if ((action.kind === "invite") !== (user.status === "pending"))
    throw new AuthError(
      "Use an invitation for a pending user and recovery for an enrolled user.",
      400,
    );
  const token = randomToken();
  await env.DB.batch([
    q(
      "UPDATE users SET status=?,credential_version=credential_version+1 WHERE user_id=?",
      action.kind === "invite" ? "pending" : "recovery",
      user.user_id,
    ),
    q("DELETE FROM auth_session WHERE user_id=?", user.user_id),
    q("DELETE FROM auth_token WHERE user_id=?", user.user_id),
    q(
      "INSERT INTO auth_token(token_hash,user_id,kind,expires_at,password_parameters,totp_secret) VALUES (?,?,?,?,?,?)",
      await sha256(token),
      user.user_id,
      action.kind,
      nowSeconds() + (action.kind === "invite" ? 86400 : 3600),
      JSON.stringify(newParameters()),
      action.kind === "password"
        ? null
        : await encryptSecret(env, newTotpSecret()),
    ),
  ]);
  return { token };
}
interface SetupToken {
  token_hash: string;
  user_id: number;
  kind: "invite" | "password" | "recover";
  expires_at: number;
  password_parameters: string;
  totp_secret: string | null;
  username: string;
  current_totp: string | null;
  last_totp_step: number;
  credential_version: number;
}
async function setupToken(env: Env, token: string) {
  const row = await env.DB.prepare(
    `SELECT t.*,u.username,u.totp_secret AS current_totp,u.last_totp_step,u.credential_version FROM auth_token t JOIN users u USING(user_id)
    WHERE token_hash=? AND consumed_nonce IS NULL AND expires_at>? AND ((t.kind='invite' AND u.status='pending') OR (t.kind<>'invite' AND u.status='recovery'))`,
  )
    .bind(await sha256(token), nowSeconds())
    .first<SetupToken>();
  if (!row)
    throw new AuthError(
      "This link has expired or was already used. Ask an admin for a new link.",
      400,
    );
  return row;
}
export async function inspectSetup(env: Env, token: string) {
  const row = await setupToken(env, token);
  const secret = row.totp_secret
    ? await decryptSecret(env, row.totp_secret)
    : undefined;
  return {
    username: row.username,
    kind: row.kind,
    parameters: JSON.parse(row.password_parameters),
    secret,
    otpauth: secret
      ? `otpauth://totp/${encodeURIComponent(`ProgreSQL:${row.username}`)}?secret=${secret}&issuer=ProgreSQL&algorithm=SHA1&digits=6&period=30`
      : undefined,
  };
}
export async function completeSetup(
  env: Env,
  token: string,
  proof: string,
  code: string,
) {
  const row = await setupToken(env, token);
  const secret = row.kind === "password" ? row.current_totp : row.totp_secret;
  if (!secret) throw new AuthError("Authenticator setup is unavailable.", 400);
  const step = await matchTotp(await decryptSecret(env, secret), code);
  if (
    step === undefined ||
    (row.kind === "password" && step <= row.last_totp_step)
  )
    throw new AuthError("Use a fresh authenticator code and try again.", 400);
  const nonce = randomToken();
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE auth_token SET consumed_nonce=? WHERE token_hash=? AND consumed_nonce IS NULL AND expires_at>?
      AND EXISTS(SELECT 1 FROM users WHERE user_id=auth_token.user_id AND credential_version=?) RETURNING user_id`,
    ).bind(nonce, row.token_hash, nowSeconds(), row.credential_version),
    env.DB.prepare(
      `UPDATE users SET password_parameters=?,password_verifier=?,totp_secret=?,status='active',last_totp_step=?,credential_version=credential_version+1
      WHERE user_id=? AND EXISTS(SELECT 1 FROM auth_token WHERE token_hash=? AND consumed_nonce=?)`,
    ).bind(
      row.password_parameters,
      await verifier(env, proof),
      secret,
      step,
      row.user_id,
      row.token_hash,
      nonce,
    ),
    env.DB.prepare(
      "DELETE FROM auth_session WHERE user_id=? AND EXISTS(SELECT 1 FROM auth_token WHERE token_hash=? AND consumed_nonce=?)",
    ).bind(row.user_id, row.token_hash, nonce),
    env.DB.prepare(
      "DELETE FROM auth_token WHERE token_hash=? AND consumed_nonce=?",
    ).bind(row.token_hash, nonce),
  ]);
  if (!result[0].results.length)
    throw new AuthError("This link has expired or was already used.", 400);
  return { ok: true };
}
