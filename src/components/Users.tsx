import { useEffect, useState, type FormEvent } from "react";
import type { Identity, UserAction, UserSummary } from "../../shared/users";
import type { PasswordParameters } from "../../shared/auth";
import { api, passwordProof } from "../lib/api";
import { Button } from "./ui/button";
import { Card, Field, Input } from "./ui/fields";
import { Dialog } from "./ui/dialog";

export function Users({ user }: { user: Identity }) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [operation, setOperation] = useState<UserAction>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  useEffect(() => {
    const c = new AbortController();
    void api<UserSummary[]>("/api/admin/users", undefined, c.signal)
      .then(setUsers)
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, []);
  function choose(action: UserAction) {
    setLink("");
    setError("");
    setOperation(action);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!operation) return;
    const values = new FormData(event.currentTarget);
    let action: UserAction = operation;
    if (action.action === "create")
      action = { ...action, username: String(values.get("username")) };
    if (action.action === "update")
      action = {
        ...action,
        username: String(values.get("username")),
        is_admin: values.get("admin") === "on",
      };
    if (action.action === "delete")
      action = { ...action, confirmation: String(values.get("confirmation")) };
    setBusy(true);
    setError("");
    try {
      const params = await api<PasswordParameters>(
        `/api/auth/config?username=${encodeURIComponent(user.username)}`,
      );
      const proof = await passwordProof(String(values.get("password")), params);
      const result = await api<{ token?: string }>("/api/admin/users", {
        operation: action,
        proof,
        code: values.get("code"),
      });
      setOperation(undefined);
      if (result.token) setLink(`${location.origin}/#setup=${result.token}`);
      if (
        (action.action === "update" || action.action === "link") &&
        action.user_id === user.user_id
      ) {
        window.dispatchEvent(new Event("session-expired"));
        // Recovery of your own account opens immediately so the link isn't lost on logout.
        if (result.token) location.assign(`/#setup=${result.token}`);
        return;
      }
      setUsers(await api<UserSummary[]>("/api/admin/users"));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Users</h1>
          <p className="text-sm text-muted-foreground">
            Invite friends and manage account access.
          </p>
        </div>
        <Button onClick={() => choose({ action: "create", username: "" })}>
          Create user
        </Button>
      </div>
      {error && !operation && (
        <p role="alert" className="my-4 text-destructive">
          {error}
        </p>
      )}
      {link && (
        <Card className="mb-6">
          <p className="mb-3">
            Send this private setup link to the user. Invitations expire in 24
            hours; recovery links expire in one hour.
          </p>
          <Input aria-label="Setup link" readOnly value={link} />
          <div className="mt-3 flex gap-3">
            <Button
              onClick={() =>
                void navigator.clipboard
                  .writeText(link)
                  .catch(() =>
                    setError("Select the link and copy it manually."),
                  )
              }
            >
              Copy link
            </Button>
            <Button variant="outline" onClick={() => setLink("")}>
              Dismiss
            </Button>
          </div>
        </Card>
      )}
      <div className="space-y-3">
        {users.map((u) => (
          <Card key={u.user_id}>
            <div className="mb-3">
              <strong>{u.username}</strong>
              <span className="ml-3 text-sm text-muted-foreground">
                {u.is_admin ? "Admin" : "User"} · {u.status}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  choose({
                    action: "update",
                    user_id: u.user_id,
                    username: u.username,
                    is_admin: !!u.is_admin,
                  })
                }
              >
                Edit user
              </Button>
              {u.status === "pending" ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    choose({
                      action: "link",
                      user_id: u.user_id,
                      kind: "invite",
                    })
                  }
                >
                  Reissue invitation
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    onClick={() =>
                      choose({
                        action: "link",
                        user_id: u.user_id,
                        kind: "password",
                      })
                    }
                  >
                    Reset password
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      choose({
                        action: "link",
                        user_id: u.user_id,
                        kind: "recover",
                      })
                    }
                  >
                    Recover account
                  </Button>
                </>
              )}
              <Button
                variant="outline"
                disabled={u.user_id === user.user_id}
                onClick={() =>
                  choose({
                    action: "delete",
                    user_id: u.user_id,
                    confirmation: "",
                  })
                }
              >
                Delete user
              </Button>
            </div>
          </Card>
        ))}
      </div>
      {operation && (
        <Dialog
          open
          title={
            operation.action === "create"
              ? "Create user"
              : operation.action === "delete"
                ? "Permanently delete user"
                : operation.action === "update"
                  ? "Edit user"
                  : operation.kind === "invite"
                    ? "Reissue invitation"
                    : operation.kind === "password"
                      ? "Reset password"
                      : "Recover account"
          }
          onClose={() => {
            if (!busy) setOperation(undefined);
          }}
        >
          <form onSubmit={submit} className="space-y-4">
            {(operation.action === "create" ||
              operation.action === "update") && (
              <Field
                label="Username"
                name="username"
                defaultValue={operation.username}
                maxLength={120}
                pattern="[a-zA-Z0-9][a-zA-Z0-9_.@\-]*"
                required
              />
            )}
            {operation.action === "update" && (
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  name="admin"
                  defaultChecked={operation.is_admin}
                  disabled={operation.user_id === user.user_id}
                />
                {operation.user_id === user.user_id && (
                  <input type="hidden" name="admin" value="on" />
                )}
                Admin access
              </label>
            )}
            {operation.action === "delete" && (
              <>
                <p>
                  This permanently removes the account and all workout records.
                </p>
                <Field
                  label={`Type ${users.find((u) => u.user_id === operation.user_id)?.username} to confirm`}
                  name="confirmation"
                  required
                />
                <label className="flex gap-2">
                  <input type="checkbox" required />I understand all this user’s
                  workout data will be deleted.
                </label>
              </>
            )}
            {operation.action === "link" && operation.kind !== "invite" && (
              <p>
                Existing sessions will end immediately. The user must complete
                recovery before signing in again.
                {operation.kind === "recover"
                  ? " They will set up a new authenticator."
                  : " They will keep their existing authenticator."}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Confirm with your own password and a fresh authenticator code.
              After signing in or confirming another action, wait for the next
              code.
            </p>
            <Field
              label="Your password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
            <Field
              label="Your authenticator code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              required
            />
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            <Button disabled={busy} type="submit">
              {busy ? "Saving…" : "Confirm"}
            </Button>
          </form>
        </Dialog>
      )}
    </>
  );
}
