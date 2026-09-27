import type { PasswordParameters } from "../shared/auth";
import type { Identity, UserSummary } from "../shared/users";
import { codeSchema, proofSchema } from "../shared/users";
export type Env = Cloudflare.Env & { LOCAL_DEV?: string };
const encoder = new TextEncoder();
const cookieName = "__Host-progresql";
const localCookieName = "progresql-local";
export class AuthError extends Error {
  constructor(
    message: string,
    public status = 401,
  ) {
    super(message);
  }
}
export const isLoopback = (request: Request) =>
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(request.url).hostname);
export const localBypass = (request: Request, env: Env) =>
  env.LOCAL_DEV === "enabled" && isLoopback(request);
export const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(bytes instanceof Uint8Array ? bytes : bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
export const unhex = (value: string) =>
  Uint8Array.from(value.match(/.{2}/g) || [], (byte) => parseInt(byte, 16));
export async function sha256(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
export async function pepperKey(env: Env) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(env.AUTH_PEPPER),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify", "sign"],
  );
}
function sessionToken(request: Request) {
  const name = isLoopback(request) ? localCookieName : cookieName;
  const token = request.headers
    .get("Cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(name + "="))
    ?.slice(name.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
function cookie(request: Request, token: string, age: number) {
  const local = isLoopback(request);
  return `${local ? localCookieName : cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${local ? "" : "; Secure"}`;
}
function decodeBase32(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0,
    buffer = 0;
  const result: number[] = [];
  for (const char of value.toUpperCase().replace(/=+$/, "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("Invalid authenticator configuration.");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      result.push((buffer >>> bits) & 255);
    }
  }
  return new Uint8Array(result);
}
// RFC 6238 / RFC 4226, matching pyotp's SHA-1, six digits, 30s period.
export async function totpAt(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase32(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const input = new ArrayBuffer(8);
  new DataView(input).setBigUint64(0, BigInt(step));
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, input));
  const offset = digest[digest.length - 1] & 15;
  const binary = new DataView(digest.buffer).getUint32(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}
export function equal(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
export async function logout(request: Request, env: Env): Promise<string> {
  const token = sessionToken(request);
  if (token)
    await env.DB.prepare("DELETE FROM auth_session WHERE token_hash=?")
      .bind(await sha256(token))
      .run();
  return cookie(request, "", 0);
}

export interface UserRecord extends UserSummary {
  password_parameters: string | null;
  password_verifier: string | null;
  totp_secret: string | null;
  credential_version: number;
  last_totp_step: number;
}
export const randomToken = () =>
  hex(crypto.getRandomValues(new Uint8Array(32)));
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export function configured(env: Env) {
  return !!(env.AUTH_PEPPER && env.AUTH_ENCRYPTION_KEY);
}
export const identity = (u: Identity): Identity => ({
  user_id: u.user_id,
  username: u.username,
  is_admin: u.is_admin,
});
export async function authorize(
  request: Request,
  env: Env,
): Promise<Identity | null> {
  if (localBypass(request, env)) {
    const user = await env.DB.prepare(
      "SELECT user_id,username,is_admin FROM users WHERE user_id=1",
    ).first<Identity>();
    return user ? identity(user) : null;
  }
  if (!configured(env)) return null;
  const token = sessionToken(request);
  if (!token) return null;
  const user = await env.DB.prepare(
    `SELECT u.user_id,u.username,u.is_admin FROM auth_session s
    JOIN users u ON u.user_id=s.user_id WHERE s.token_hash=? AND s.expires_at>?
    AND u.status='active' AND s.credential_version=u.credential_version`,
  )
    .bind(await sha256(token), nowSeconds())
    .first<Identity>();
  return user ? identity(user) : null;
}
async function encryptionKey(env: Env) {
  if (!/^[a-f0-9]{64}$/.test(env.AUTH_ENCRYPTION_KEY || ""))
    throw new AuthError("Login is not configured yet.", 503);
  return crypto.subtle.importKey(
    "raw",
    unhex(env.AUTH_ENCRYPTION_KEY),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
export async function encryptSecret(env: Env, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    encoder.encode(value),
  );
  return `${hex(iv)}:${hex(encrypted)}`;
}
export async function decryptSecret(env: Env, value: string) {
  const [iv, data] = value.split(":");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unhex(iv) },
      await encryptionKey(env),
      unhex(data),
    ),
  );
}
export function newParameters(): PasswordParameters {
  return {
    algorithm: "argon2id",
    salt: btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
    ),
    iterations: 3,
    memorySize: 65536,
    parallelism: 4,
    hashLength: 32,
  };
}
export async function parameters(
  env: Env,
  username: string,
): Promise<PasswordParameters> {
  if (!configured(env))
    throw new AuthError("Login is not configured yet.", 503);
  const row = await env.DB.prepare(
    "SELECT password_parameters FROM users WHERE username=? AND status='active'",
  )
    .bind(username)
    .first<{ password_parameters: string }>();
  if (row?.password_parameters) return JSON.parse(row.password_parameters);
  // Stable, keyed dummy salt: repeated requests do not distinguish unknown users.
  const salt = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await pepperKey(env),
      encoder.encode(`salt:${username.toLowerCase()}`),
    ),
  ).slice(0, 16);
  return { ...newParameters(), salt: btoa(String.fromCharCode(...salt)) };
}
export async function verifier(env: Env, proof: string) {
  return hex(
    await crypto.subtle.sign("HMAC", await pepperKey(env), unhex(proof)),
  );
}
export async function consumeAttempt(
  request: Request,
  env: Env,
  category = "login",
  account = "",
) {
  if (!configured(env))
    throw new AuthError("Login is not configured yet.", 503);
  const now = nowSeconds();
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const hash = async (s: string) =>
    hex(
      await crypto.subtle.sign("HMAC", await pepperKey(env), encoder.encode(s)),
    );
  const buckets = [
    [await hash(`ip:${ip}:${category}`), 10],
    [await hash(`account:${account.toLowerCase()}:${category}`), 10],
    [`global:${category}`, 100],
  ] as const;
  const result = await env.DB.batch<{ attempts: number }>(
    buckets.map(([key]) =>
      env.DB.prepare(
        `
    INSERT INTO auth_rate_limit(bucket,window_start,attempts) VALUES (?, ?, 1)
    ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN window_start<=excluded.window_start-300 THEN 1 ELSE attempts+1 END,
    window_start=CASE WHEN window_start<=excluded.window_start-300 THEN excluded.window_start ELSE window_start END RETURNING attempts`,
      ).bind(key, now),
    ),
  );
  if (result.some((r, i) => r.results[0].attempts > buckets[i][1]))
    throw new AuthError("Too many attempts. Please wait five minutes.", 429);
}
export async function matchTotp(secret: string, code: string) {
  const step = Math.floor(nowSeconds() / 30);
  const candidates = await Promise.all(
    [step - 1, step, step + 1].map(async (s) => ({
      step: s,
      code: await totpAt(secret, s),
    })),
  );
  return candidates.find((c) => equal(c.code, code))?.step;
}
export async function checkCredentials(
  env: Env,
  username: string,
  proof: string,
  code: string,
) {
  const user = await env.DB.prepare(
    "SELECT * FROM users WHERE username=? AND status='active'",
  )
    .bind(username)
    .first<UserRecord>();
  const validProof = proofSchema.safeParse(proof).success;
  const validCode = codeSchema.safeParse(code).success;
  const passwordOK = await crypto.subtle.verify(
    "HMAC",
    await pepperKey(env),
    unhex(user?.password_verifier || "00".repeat(32)),
    unhex(validProof ? proof : "00".repeat(32)),
  );
  const step = await matchTotp(
    user?.totp_secret
      ? await decryptSecret(env, user.totp_secret)
      : "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    validCode ? code : "000000",
  );
  if (!user || !validProof || !validCode || !passwordOK || step === undefined)
    throw new AuthError("Invalid username, password, or authenticator code.");
  return { user, step };
}
export async function reauthenticate(
  request: Request,
  env: Env,
  actor: Identity,
  proof: string,
  code: string,
) {
  await consumeAttempt(request, env, "verify", actor.username);
  const { user, step } = await checkCredentials(
    env,
    actor.username,
    proof,
    code,
  );
  const row = await env.DB.prepare(
    `UPDATE users SET last_totp_step=? WHERE user_id=? AND is_admin=1 AND status='active'
    AND credential_version=? AND last_totp_step<? RETURNING user_id`,
  )
    .bind(step, actor.user_id, user.credential_version, step)
    .first();
  if (!row)
    throw new AuthError("Use a fresh authenticator code and try again.");
}
export async function login(
  request: Request,
  env: Env,
  input: unknown,
): Promise<string> {
  const body = input as Record<string, unknown> | null;
  const username =
    typeof body?.username === "string" ? body.username.trim() : "";
  await consumeAttempt(request, env, "login", username);
  if (
    !username ||
    username.length > 200 ||
    typeof body?.proof !== "string" ||
    typeof body.code !== "string"
  )
    throw new AuthError("Invalid username, password, or authenticator code.");
  const { user, step } = await checkCredentials(
    env,
    username,
    body.proof,
    body.code,
  );
  const token = randomToken();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET last_totp_step=? WHERE user_id=? AND status='active' AND credential_version=? AND last_totp_step<? RETURNING user_id`,
    ).bind(step, user.user_id, user.credential_version, step),
    env.DB.prepare(
      `INSERT INTO auth_session(token_hash,user_id,credential_version,expires_at) SELECT ?,?,?,? WHERE changes()=1`,
    ).bind(
      await sha256(token),
      user.user_id,
      user.credential_version,
      nowSeconds() + 3600,
    ),
    env.DB.prepare("DELETE FROM auth_session WHERE expires_at<=?").bind(
      nowSeconds(),
    ),
    env.DB.prepare("DELETE FROM auth_rate_limit WHERE window_start<?").bind(
      nowSeconds() - 300,
    ),
  ]);
  if (!results[0].results.length)
    throw new AuthError(
      "This authenticator code was already used. Wait for the next code.",
    );
  return cookie(request, token, 3600);
}
