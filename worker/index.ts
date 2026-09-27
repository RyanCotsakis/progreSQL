import {
  adminRequestSchema,
  setupRequestSchema,
  completeRequestSchema,
} from "../shared/users";
import { manageUser, listUsers, inspectSetup, completeSetup } from "./users";
import { actionSchema } from "../shared/actions";
import {
  authorize,
  AuthError,
  login,
  logout,
  parameters,
  isLoopback,
  type Env,
  consumeAttempt,
  reauthenticate,
} from "./auth";
import { mutate, readData, ValidationError } from "./service";

const json = (data: unknown, status = 200, userId?: number) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(userId === undefined ? {} : { "X-ProgreSQL-User": String(userId) }),
    },
  });

async function readLimitedBody(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > 1_000_000) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
const app = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method === "GET" && url.pathname === "/api/auth/config") {
      try {
        const username = (url.searchParams.get("username") || "").slice(0, 200);
        await consumeAttempt(request, env, "config", username);
        return json(await parameters(env, username));
      } catch (error) {
        return json(
          {
            error:
              error instanceof AuthError
                ? error.message
                : "Login is not configured yet.",
          },
          error instanceof AuthError ? error.status : 503,
        );
      }
    }
    const authMutation = [
      "/api/auth/login",
      "/api/auth/logout",
      "/api/auth/setup",
      "/api/auth/complete",
    ].includes(url.pathname);
    const user = authMutation ? null : await authorize(request, env);
    if (!authMutation && !user)
      return json(
        {
          error: "Your session has expired. Please sign in.",
          code: "session_expired",
        },
        401,
      );
    if (request.method === "GET" && url.pathname === "/api/auth/session")
      return json(user);
    const adminRoute = url.pathname.startsWith("/api/admin/");
    if (adminRoute && !user?.is_admin)
      return json({ error: "Admin access required." }, 403);
    if (request.method === "GET" && url.pathname === "/api/admin/users")
      return json(await listUsers(env), 200, user!.user_id);
    if (
      request.method === "GET" &&
      ["/api/data", "/api/admin/data"].includes(url.pathname) &&
      user
    ) {
      try {
        return json(
          await readData(env.DB, user, adminRoute),
          200,
          user.user_id,
        );
      } catch {
        return json(
          {
            error:
              "The database is unavailable. Check that migrations have been applied.",
          },
          503,
        );
      }
    }
    if (
      request.method !== "POST" ||
      (!authMutation &&
        !["/api/actions", "/api/admin/users"].includes(url.pathname))
    )
      return json({ error: "Not found." }, 404);
    // No cross-origin mutations, including requests with an absent Origin header.
    const origin = request.headers.get("Origin");
    const localOrigin =
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:8787",
        "http://127.0.0.1:8788",
      ].includes(origin || "");
    if (origin !== url.origin && !localOrigin)
      return json({ error: "Invalid request origin." }, 403);
    if (!request.headers.get("Content-Type")?.startsWith("application/json"))
      return json({ error: "Expected JSON." }, 415);
    if (Number(request.headers.get("Content-Length")) > 1_000_000)
      return json({ error: "Request is too large." }, 413);
    try {
      const text = await readLimitedBody(request);
      if (text === null) return json({ error: "Request is too large." }, 413);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return json({ error: "Invalid JSON." }, 400);
      }
      if (["/api/auth/setup", "/api/auth/complete"].includes(url.pathname)) {
        const parsed = setupRequestSchema.safeParse(body);
        if (!parsed.success)
          return json({ error: "Invalid setup request." }, 400);
        await consumeAttempt(
          request,
          env,
          url.pathname.endsWith("/complete") ? "complete" : "setup",
          parsed.data.token,
        );
        if (url.pathname.endsWith("/complete")) {
          const complete = completeRequestSchema.safeParse(body);
          if (!complete.success)
            return json({ error: "Invalid setup request." }, 400);
          return json(
            await completeSetup(
              env,
              complete.data.token,
              complete.data.proof,
              complete.data.code,
            ),
          );
        }
        return json(await inspectSetup(env, parsed.data.token));
      }
      if (url.pathname === "/api/admin/users" && user) {
        const parsed = adminRequestSchema.safeParse(body);
        if (!parsed.success)
          return json({ error: parsed.error.issues[0].message }, 400);
        await reauthenticate(
          request,
          env,
          user,
          parsed.data.proof,
          parsed.data.code,
        );
        return json(await manageUser(env, user, parsed.data.operation));
      }
      if (authMutation) {
        const cookie =
          url.pathname === "/api/auth/login"
            ? await login(request, env, body)
            : await logout(request, env);
        const response = json({ ok: true });
        response.headers.set("Set-Cookie", cookie);
        return response;
      }
      const result = actionSchema.safeParse(body);
      if (!result.success)
        return json({ error: result.error.issues[0].message }, 400);
      if (!user) throw new AuthError("Please sign in.");
      await mutate(env.DB, result.data, user);
      return json({ ok: true });
    } catch (error) {
      if (error instanceof AuthError) {
        const response = json({ error: error.message }, error.status);
        if (error.status === 429) response.headers.set("Retry-After", "300");
        return response;
      }
      if (error instanceof ValidationError)
        return json({ error: error.message }, 400);
      const message = error instanceof Error ? error.message : "";
      if (message.includes("Keep at least one admin."))
        return json({ error: "Keep at least one admin." }, 400);
      if (message.includes("UNIQUE constraint"))
        return json(
          {
            error:
              "That username, name, effective date, or workout log already exists.",
          },
          409,
        );
      if (message.includes("FOREIGN KEY constraint"))
        return json(
          {
            error:
              "This record is missing or still referenced by other records.",
          },
          409,
        );
      if (
        message.includes("CHECK constraint") ||
        message.includes("NOT NULL constraint")
      )
        return json(
          { error: "The values do not meet the table constraints." },
          400,
        );
      console.error(
        JSON.stringify({
          event: "database_operation_failed",
          path: url.pathname,
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      return json(
        { error: "Could not save your changes. Please try again." },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const local = isLoopback(request);
    // Run before assets and authentication: a Secure session cookie cannot be
    // stored by a browser visiting the login form over plain HTTP.
    if (!local && url.protocol === "http:") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 308);
    }
    const response = await app.fetch(request, env);
    if (local) return response;
    const secured = new Response(response.body, response);
    secured.headers.set("Strict-Transport-Security", "max-age=31536000");
    return secured;
  },
} satisfies ExportedHandler<Env>;
