"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

type LoginResult = {
  user: { id: string; name: string; email: string };
  organizations: Array<{ id: string; name: string; slug: string; type: string; role: string }>;
};
type LoginFailure = { error?: { code?: string; message?: string } };

const productionBuild = process.env.NODE_ENV === "production";

export function LoginForm() {
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [email, setEmail] = useState(productionBuild ? "" : "owner@acmeworks.test");
  const [password, setPassword] = useState(productionBuild ? "" : "NorthstarDemo!");
  const [error, setError] = useState<string | null>(null);
  const [verificationRequired, setVerificationRequired] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setVerificationRequired(false);
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/v1/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, ...(mfaRequired ? { mfaCode } : {}) })
      });
      const result = await response.json() as LoginResult | LoginFailure;
      if (response.status === 202 && "mfaRequired" in result && result.mfaRequired) {
        setMfaRequired(true);
        return;
      }
      if (!response.ok || !("organizations" in result)) {
        setVerificationRequired("error" in result && result.error?.code === "email_not_verified");
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
    {mfaRequired && <div className="field"><label htmlFor="mfaCode">Authenticator or recovery code</label><input className="input" id="mfaCode" name="mfaCode" autoComplete="one-time-code" value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} minLength={6} maxLength={20} required /><span className="muted" style={{ fontSize: 12 }}>Enter your six-digit authenticator code or one unused recovery code.</span></div>}
    {error && <p role="alert" style={{ color: "#a83224", fontSize: 13, lineHeight: 1.5 }}>{error}{verificationRequired && <> <Link href="/login/resend-verification" style={{ textDecoration: "underline" }}>Resend verification email</Link></>}</p>}
    <button className="button button-primary" type="submit" disabled={!hydrated || pending} style={{ width: "100%", marginTop: 24 }}>{pending ? "Signing in…" : mfaRequired ? "Verify and sign in" : "Sign in"}</button>
    {productionBuild ? <p className="muted" style={{ fontSize: 12, textAlign: "center", marginTop: 18 }}>Use the account provided by your organization administrator.</p> : <p className="muted" style={{ fontSize: 12, textAlign: "center", marginTop: 18 }}>Demo credentials are prefilled for local development only.</p>}
  </form>;
}
