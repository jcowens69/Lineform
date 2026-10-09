import { createFileRoute } from "@tanstack/react-router";
import { GROK_PROVIDERS, authEnabled, signIn } from "@/lib/auth/client";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  return (
    <main className="grid min-h-screen place-items-center bg-paper px-6 text-ink">
      <div className="w-full max-w-sm">
        <a href="/" className="font-display text-xl font-semibold">
          Lineform
        </a>
        <h1 className="font-display mt-6 text-4xl font-medium">Sign in</h1>
        <p className="mt-2 text-muted">A plan removes the watermark and unlocks the clean SVG.</p>
        <div className="mt-6 grid gap-2">
          {authEnabled ? (
            GROK_PROVIDERS.map((provider) => (
              <button
                key={provider.providerId}
                type="button"
                onClick={() => signIn(provider.providerId, { callbackURL: "/#plans" })}
                className="min-h-11 cursor-pointer rounded-full border border-line bg-card px-4 font-semibold"
              >
                Continue with {provider.label}
              </button>
            ))
          ) : (
            <p className="text-sm text-muted">Sign-in is disabled.</p>
          )}
        </div>
      </div>
    </main>
  );
}
