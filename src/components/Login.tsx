import { useState, type FormEvent } from "react";
import { Dumbbell, Loader2, LockKeyhole } from "lucide-react";
import { Button } from "./ui/button";
import { Card, Field } from "./ui/fields";
import type { PasswordParameters } from "../../shared/auth";

export function Login({
  loading,
  onSuccess,
  initialError,
}: {
  loading: boolean;
  onSuccess: () => Promise<void>;
  initialError: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const element = event.currentTarget;
    const fields = new FormData(element);
    try {
      const response = await fetch("/api/auth/config");
      if (!response.ok)
        throw new Error("Login is not configured yet. Please try again later.");
      const params: PasswordParameters = await response.json();
      const { argon2id } = await import("hash-wasm");
      const proof = await argon2id({
        password: String(fields.get("password")),
        salt: Uint8Array.from(atob(params.salt), (c) => c.charCodeAt(0)),
        iterations: params.iterations,
        memorySize: params.memorySize,
        parallelism: params.parallelism,
        hashLength: params.hashLength,
        outputType: "hex",
      });
      const login = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: fields.get("username"),
          proof,
          code: fields.get("code"),
        }),
      });
      if (!login.ok) {
        const result = (await login.json()) as { error?: string };
        throw new Error(result.error || "Could not sign in.");
      }
      element.reset();
      await onSuccess();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-white">
            <Dumbbell size={23} />
          </span>
          <span className="text-2xl font-semibold tracking-tight">
            ProgreSQL.
          </span>
        </div>
        <Card>
          <h1 className="text-2xl font-semibold tracking-tight">
            Welcome back
          </h1>
          <p className="mb-6 mt-2 text-sm text-muted-foreground">
            Sign in to your workout journal.
          </p>
          {loading ? (
            <div className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
              <Loader2 className="animate-spin" size={18} />
              Opening your journal…
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <Field
                label="Username"
                name="username"
                autoComplete="username"
                required
                maxLength={200}
              />
              <Field
                label="Password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={1024}
              />
              <Field
                label="Authenticator code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                minLength={6}
                maxLength={6}
                required
                placeholder="000000"
              />
              <p className="text-xs text-muted-foreground">
                Use the current code from your existing Authenticator entry.
              </p>
              {(error ||
                (initialError && !initialError.includes("sign in"))) && (
                <p role="alert" className="text-sm text-destructive">
                  {error || initialError}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <LockKeyhole />}
                {busy ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          )}
        </Card>
      </div>
    </main>
  );
}
