import { useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import type { PasswordParameters } from "../../shared/auth";
import { api, passwordProof } from "../lib/api";
import { Button } from "./ui/button";
import { Card, Field } from "./ui/fields";

interface SetupInfo {
  username: string;
  kind: string;
  parameters: PasswordParameters;
  secret?: string;
  otpauth?: string;
}
export function Setup({
  token,
  onDone,
}: {
  token: string;
  onDone: () => void;
}) {
  const [info, setInfo] = useState<SetupInfo>();
  const [qr, setQr] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const data = await api<SetupInfo>(
          "/api/auth/setup",
          { token },
          controller.signal,
        );
        const image = data.otpauth
          ? await QRCode.toDataURL(data.otpauth, { width: 240, margin: 2 })
          : "";
        if (!controller.signal.aborted) {
          setInfo(data);
          setQr(image);
        }
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      }
    })();
    return () => controller.abort();
  }, [token]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!info) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    if (values.get("password") !== values.get("confirm")) {
      setError("Passwords must match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const proof = await passwordProof(
        String(values.get("password")),
        info.parameters,
      );
      await api("/api/auth/complete", {
        token,
        proof,
        code: values.get("code"),
      });
      form.reset();
      setInfo(undefined);
      setQr("");
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-lg px-5 py-12">
      <Card>
        <h1 className="text-2xl font-semibold">
          {done ? "Account ready" : "Set up your account"}
        </h1>
        {error && (
          <p role="alert" className="my-4 text-destructive">
            {error}
          </p>
        )}
        {done ? (
          <>
            <p className="my-4">
              Sign in with your password and the next authenticator code.
            </p>
            <Button onClick={onDone}>Go to sign in</Button>
          </>
        ) : info ? (
          <form className="mt-5 space-y-4" onSubmit={submit}>
            <p>
              Username: <strong>{info.username}</strong>
            </p>
            <Field
              label="New password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={1024}
              required
            />
            <Field
              label="Confirm password"
              name="confirm"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={1024}
              required
            />
            {qr ? (
              <>
                <p>Scan this QR code in your authenticator app.</p>
                <img
                  src={qr}
                  alt="Authenticator setup QR code"
                  width={240}
                  height={240}
                />
                <details>
                  <summary>Enter a setup key manually</summary>
                  <code className="break-all">{info.secret}</code>
                </details>
              </>
            ) : (
              <p>Enter a code from your existing authenticator.</p>
            )}
            <Field
              label="Authenticator code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              required
            />
            <Button disabled={busy} type="submit">
              {busy ? "Saving…" : "Complete setup"}
            </Button>
          </form>
        ) : (
          !error && <p className="mt-4">Opening setup…</p>
        )}
      </Card>
    </main>
  );
}
