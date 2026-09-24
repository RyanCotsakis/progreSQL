import { actionSchema } from "../shared/actions";
import {
  authorize,
  AuthError,
  login,
  logout,
  parameters,
  type Env,
} from "./auth";
import { mutate, readData, ValidationError } from "./service";

const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
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
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method === "GET" && url.pathname === "/api/auth/config") {
      try {
        return json(parameters(env));
      } catch {
        return json({ error: "Login is not configured yet." }, 503);
      }
    }
    const authMutation = ["/api/auth/login", "/api/auth/logout"].includes(
      url.pathname,
    );
    if (!authMutation && !(await authorize(request, env)))
      return json({ error: "Your session has expired. Please sign in." }, 401);
    if (request.method === "GET" && url.pathname === "/api/auth/session")
      return json({ authenticated: true });
    if (request.method === "GET" && url.pathname === "/api/data") {
      try {
        return json(await readData(env.DB));
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
      (!authMutation && url.pathname !== "/api/actions")
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
      await mutate(env.DB, result.data);
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
      if (message.includes("UNIQUE constraint"))
        return json(
          {
            error: "That name, effective date, or workout log already exists.",
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
