"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Logo } from "@/components/layout/logo";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { getSupabase } from "@/lib/supabase/client";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(
    params.get("error") ? { kind: "error", text: "That sign-in link is invalid or expired." } : null,
  );

  const next = (() => {
    const n = params.get("next");
    return n && n.startsWith("/") && !n.startsWith("//") ? n : "/transactions";
  })();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const sb = getSupabase();
    try {
      if (mode === "signin") {
        const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        router.replace(next);
        router.refresh();
      } else {
        const { data, error } = await sb.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
        });
        if (error) throw error;
        if (data.session) {
          router.replace("/settings/import");
          router.refresh();
        } else {
          setMessage({ kind: "info", text: "Check your email to confirm your account, then sign in." });
          setMode("signin");
        }
      }
    } catch (err) {
      const msg = (err as { message?: string }).message ?? "";
      setMessage({
        kind: "error",
        text: /invalid login/i.test(msg)
          ? "Email or password is incorrect."
          : /already registered/i.test(msg)
            ? "An account with that email already exists. Sign in instead."
            : /password/i.test(msg)
              ? msg
              : "Could not sign in. Try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-paper px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1>
            <Logo className="mx-auto h-11" priority />
          </h1>
          <p className="mt-1 text-sm text-ink-2">A private record of your finances.</p>
        </div>
        <form onSubmit={submit} className="rounded-lg border border-line bg-surface p-6">
          <Segmented
            ariaLabel="Mode"
            className="mb-5 flex w-full [&>button]:flex-1"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setMessage(null);
            }}
            options={[
              { value: "signin", label: "Sign in" },
              { value: "signup", label: "Create account" },
            ]}
          />
          <div className="space-y-4">
            <Field label="Email" htmlFor="email">
              <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password" htmlFor="password" hint={mode === "signup" ? "At least 8 characters." : undefined}>
              <Input
                id="password"
                type="password"
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                required
                minLength={mode === "signup" ? 8 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          </div>
          {message ? (
            <p role={message.kind === "error" ? "alert" : "status"} className={`mt-4 text-sm ${message.kind === "error" ? "text-brick" : "text-sage"}`}>
              {message.text}
            </p>
          ) : null}
          <Button type="submit" variant="primary" className="mt-5 w-full" disabled={busy}>
            {busy ? "One moment…" : mode === "signin" ? "Sign in" : "Create account"}
          </Button>
        </form>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
