"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

type LoginResult = {
  user: { id: string; name: string; email: string };
  organizations: Array<{ id: string; name: string; slug: string; type: string; role: string }>;
};

const productionBuild = process.env.NODE_ENV === "production";

export function LoginForm() {
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [email, setEmail] = useState(productionBuild ? "" : "owner@acmeworks.test");
  const [password, setPassword] = useState(productionBuild ? "" : "NorthstarDemo!");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/v1/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const result = await response.json() as LoginResult | { error?: { message?: string } };
      if (!response.ok || !("organizations" in result)) {
        throw new Error("error" in result ? result.error?.message : "Sign-in failed");
      }
      const organization = result.organizations[0];
      if (!organization) throw new Error("This account has no workspace access.");
      window.localStorage.setItem("northstar.organizationId", organization.id);
      router.push(organization.role === "STUDENT" ? "/practice" : organization.type === "UNIVERSITY" ? "/workspace/university" : "/workspace");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The sign-in request failed.");
    } finally {
      setPending(false);
    }
  }

  return <form className="login-form" onSubmit={submit}>
    <h1>Welcome back.</h1>
    <p className="muted">Sign in to continue to your workspace.</p>
    {!productionBuild && <><div className="divider">Local demo sign-in</div></>}
    <div className="field"><label htmlFor="email">Email address</label><input className="input" id="email" name="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>
    <div className="field"><label htmlFor="password">Password</label><input className="input" id="password" name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required /></div>
    {error && <p role="alert" style={{ color: "#a83224", fontSize: 13, lineHeight: 1.5 }}>{error}</p>}
    <button className="button button-primary" type="submit" disabled={!hydrated || pending} style={{ width: "100%", marginTop: 24 }}>{pending ? "Signing in…" : "Sign in"}</button>
    {productionBuild ? <p className="muted" style={{ fontSize: 12, textAlign: "center", marginTop: 18 }}>Use the account provided by your organization administrator.</p> : <p className="muted" style={{ fontSize: 12, textAlign: "center", marginTop: 18 }}>Demo credentials are prefilled for local development only.</p>}
  </form>;
}
