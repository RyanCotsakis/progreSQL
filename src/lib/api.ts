import type { PasswordParameters } from "../../shared/auth";
const pending = new Set<AbortController>();
let generation = 0;
let expectedUser: number | undefined;
const channel =
  typeof BroadcastChannel === "undefined"
    ? undefined
    : new BroadcastChannel("progresql-session");
channel?.addEventListener("message", () =>
  window.dispatchEvent(new Event("session-expired")),
);
export function clearRequests() {
  generation++;
  expectedUser = undefined;
  for (const controller of pending) controller.abort();
  pending.clear();
}
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const version = generation;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  pending.add(controller);
  try {
    const response = await fetch(path, {
      signal: controller.signal,
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    const data = await response.json();
    if (
      response.status === 401 &&
      ((data as { code?: string }).code === "session_expired" ||
        ![
          "/api/auth/login",
          "/api/auth/setup",
          "/api/auth/complete",
          "/api/admin/users",
        ].includes(path))
    )
      window.dispatchEvent(new Event("session-expired"));
    if (version !== generation || controller.signal.aborted)
      throw new DOMException("Request cancelled", "AbortError");
    if (!response.ok)
      throw new Error((data as { error?: string }).error || "Request failed.");
    const owner = response.headers.get("X-ProgreSQL-User");
    const sessionUser =
      path === "/api/auth/session"
        ? (data as { user_id: number }).user_id
        : undefined;
    if (
      expectedUser !== undefined &&
      ((owner !== null && Number(owner) !== expectedUser) ||
        (sessionUser !== undefined && sessionUser !== expectedUser))
    ) {
      window.dispatchEvent(new Event("session-expired"));
      throw new DOMException("Account changed", "AbortError");
    }
    if (sessionUser !== undefined) expectedUser = sessionUser;
    if (path === "/api/auth/login" || path === "/api/auth/logout")
      channel?.postMessage("changed");
    return data as T;
  } finally {
    pending.delete(controller);
    signal?.removeEventListener("abort", abort);
  }
}
export async function passwordProof(
  password: string,
  params: PasswordParameters,
) {
  const { argon2id } = await import("hash-wasm");
  return argon2id({
    password,
    salt: Uint8Array.from(atob(params.salt), (c) => c.charCodeAt(0)),
    iterations: params.iterations,
    memorySize: params.memorySize,
    parallelism: params.parallelism,
    hashLength: params.hashLength,
    outputType: "hex",
  });
}
