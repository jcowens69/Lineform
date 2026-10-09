import { useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { authClient } from "@/lib/auth/client";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  const [mode, setMode] = useState<"in" | "up">("up");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (mode === "up" && password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    const result =
      mode === "up"
        ? await authClient.signUp.email({
            name: name || email,
            email,
            password,
          })
        : await authClient.signIn.email({
            email,
            password,
          });
    setBusy(false);
    if (result.error) {
      setError(result.error.message || "Could not sign in.");
      return;
    }
    window.location.href = "/#plans";
  }

  return (
    <main className="grid min-h-screen place-items-center bg-paper px-6 text-ink">
      <div className="w-full max-w-sm">
        <a href="/" className="font-display text-xl font-semibold">
          Lineform
        </a>
        <h1 className="font-display mt-6 text-4xl font-medium">{mode === "up" ? "Create account" : "Sign in"}</h1>
        <form className="mt-6 grid gap-3" onSubmit={submit}>
          {mode === "up" ? (
            <label className="grid gap-1 text-sm">
              Name
              <input
                className="min-h-11 rounded-full border border-line bg-card px-4"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
              />
            </label>
          ) : null}
          <label className="grid gap-1 text-sm">
            Email
            <input
              type="email"
              required
              className="min-h-11 rounded-full border border-line bg-card px-4"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
            />
          </label>
          <label className="grid gap-1 text-sm">
            Password
            <input
              type="password"
              required
              minLength={8}
              className="min-h-11 rounded-full border border-line bg-card px-4"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "up" ? "new-password" : "current-password"}
            />
          </label>
          {mode === "up" ? (
            <label className="grid gap-1 text-sm">
              Confirm password
              <input
                type="password"
                required
                minLength={8}
                className="min-h-11 rounded-full border border-line bg-card px-4"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
              />
            </label>
          ) : null}
          {error ? <p className="text-sm text-amber">{error}</p> : null}
          <button type="submit" disabled={busy} className="min-h-11 rounded-full bg-field px-4 font-semibold text-cream disabled:opacity-40">
            {busy ? "Working…" : mode === "up" ? "Create account" : "Sign in"}
          </button>
        </form>
        <button
          type="button"
          className="mt-4 text-sm text-muted"
          onClick={() => {
            setMode(mode === "up" ? "in" : "up");
            setError("");
          }}
        >
          {mode === "up" ? "Already have an account? Sign in" : "Need an account? Create one"}
        </button>
      </div>
    </main>
  );
}
