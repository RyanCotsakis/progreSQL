import type { PasswordParameters } from "../shared/auth";
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
export function configured(env: Env) {
  return !!(
    env.AUTH_USERNAME &&
    env.AUTH_PASSWORD_PARAMETERS &&
    env.AUTH_PASSWORD_VERIFIER &&
    env.AUTH_PEPPER &&
    env.AUTH_TOTP_SECRET
  );
}
export function parameters(env: Env): PasswordParameters {
  if (!configured(env))
    throw new AuthError("Login is not configured yet.", 503);
  return JSON.parse(env.AUTH_PASSWORD_PARAMETERS);
}
export const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(bytes instanceof Uint8Array ? bytes : bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
export const unhex = (value: string) =>
  Uint8Array.from(value.match(/.{2}/g) || [], (byte) => parseInt(byte, 16));
export async function sha256(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
async function pepperKey(env: Env) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(env.AUTH_PEPPER),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify", "sign"],
  );
}
async function credentialVersion(env: Env) {
  return sha256(
    JSON.stringify([
      env.AUTH_USERNAME,
      env.AUTH_PASSWORD_VERIFIER,
      env.AUTH_TOTP_SECRET,
    ]),
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
export async function authorize(request: Request, env: Env): Promise<boolean> {
  if (localBypass(request, env)) return true;
  if (!configured(env)) return false;
  const token = sessionToken(request);
  if (!token) return false;
  const row = await env.DB.prepare(
    "SELECT 1 FROM auth_session WHERE token_hash=? AND expires_at>? AND credential_version=?",
  )
    .bind(
      await sha256(token),
      Math.floor(Date.now() / 1000),
      await credentialVersion(env),
    )
    .first();
  return !!row;
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
function equal(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
async function consumeAttempt(request: Request, env: Env, now: number) {
  // CF supplies this header at the edge. Never trust user-supplied forwarding headers.
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const bucket = hex(
    await crypto.subtle.sign("HMAC", await pepperKey(env), encoder.encode(ip)),
  );
  const results = await env.DB.batch<{ attempts: number }>(
    [bucket, "global"].map((key) =>
      env.DB.prepare(
        `
    INSERT INTO auth_rate_limit(bucket,window_start,attempts) VALUES (?1,?2,1)
    ON CONFLICT(bucket) DO UPDATE SET
      attempts=CASE WHEN window_start<=?2-300 THEN 1 ELSE attempts+1 END,
      window_start=CASE WHEN window_start<=?2-300 THEN ?2 ELSE window_start END
    RETURNING attempts`,
      ).bind(key, now),
    ),
  );
  if (
    Number(results[0].results[0].attempts) > 10 ||
    Number(results[1].results[0].attempts) > 30
  )
    throw new AuthError(
      "Too many sign-in attempts. Please wait five minutes.",
      429,
    );
}
export async function login(
  request: Request,
  env: Env,
  input: unknown,
): Promise<string> {
  const params = parameters(env);
  const now = Math.floor(Date.now() / 1000);
  await consumeAttempt(request, env, now);
  const body = input as Record<string, unknown> | null;
  if (
    !body ||
    typeof body.username !== "string" ||
    body.username.length > 200 ||
    typeof body.proof !== "string" ||
    body.proof.length !== params.hashLength * 2 ||
    !/^[a-f0-9]+$/.test(body.proof) ||
    typeof body.code !== "string" ||
    !/^\d{6}$/.test(body.code)
  )
    throw new AuthError("Invalid username, password, or authenticator code.");
  const passwordOK = await crypto.subtle.verify(
    "HMAC",
    await pepperKey(env),
    unhex(env.AUTH_PASSWORD_VERIFIER),
    unhex(body.proof),
  );
  const step = Math.floor(now / 30);
  const candidates = await Promise.all(
    [step - 1, step, step + 1].map(async (s) => ({
      step: s,
      code: await totpAt(env.AUTH_TOTP_SECRET, s),
    })),
  );
  const match = candidates.find((c) => equal(c.code, body.code as string));
  if (
    !passwordOK ||
    !equal(body.username.toLowerCase(), env.AUTH_USERNAME.toLowerCase()) ||
    !match
  )
    throw new AuthError("Invalid username, password, or authenticator code.");
  const version = await credentialVersion(env);
  // A code can be consumed only once, even across concurrent requests or edge locations.
  const used = await env.DB.prepare(
    `INSERT INTO auth_totp(credential_version,last_step) VALUES (?,?)
    ON CONFLICT(credential_version) DO UPDATE SET last_step=excluded.last_step
    WHERE auth_totp.last_step<excluded.last_step RETURNING last_step`,
  )
    .bind(version, match.step)
    .all();
  if (!used.results.length)
    throw new AuthError(
      "This authenticator code was already used. Wait for the next code.",
    );
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM auth_session WHERE expires_at<=? OR credential_version<>?",
    ).bind(now, version),
    env.DB.prepare("DELETE FROM auth_rate_limit WHERE window_start<?").bind(
      now - 300,
    ),
    env.DB.prepare(
      "INSERT INTO auth_session(token_hash,credential_version,expires_at) VALUES (?,?,?)",
    ).bind(await sha256(token), version, now + 3600),
  ]);
  return cookie(request, token, 3600);
}
export async function logout(request: Request, env: Env): Promise<string> {
  const token = sessionToken(request);
  if (token)
    await env.DB.prepare("DELETE FROM auth_session WHERE token_hash=?")
      .bind(await sha256(token))
      .run();
  return cookie(request, "", 0);
}
