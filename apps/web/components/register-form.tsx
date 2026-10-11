"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export function RegisterForm() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [actionUrl, setActionUrl] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setMessage("");
    setActionUrl("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(`${apiUrl}/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.get("name"), email: form.get("email"), password: form.get("password"), organizationName: form.get("organizationName"), organizationType: form.get("organizationType") })
      });
      const body = await response.json() as { message?: string; developmentActionUrl?: string; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Registration could not be completed.");
      setMessage(body.message ?? "Check your inbox to verify your email.");
      setActionUrl(body.developmentActionUrl ?? "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Registration could not be completed.");
    } finally {
      setPending(false);
    }
  }

  return <form className="login-form" onSubmit={submit}>
    <h1>Create your workspace.</h1>
    <p className="muted">Set up your account, then verify your email to sign in.</p>
    <div className="field"><label htmlFor="name">Your name</label><input className="input" id="name" name="name" autoComplete="name" minLength={2} maxLength={120} required /></div>
    <div className="field"><label htmlFor="email">Work email</label><input className="input" id="email" name="email" type="email" autoComplete="email" required /></div>
    <div className="field"><label htmlFor="organizationName">Workspace name</label><input className="input" id="organizationName" name="organizationName" minLength={2} maxLength={120} required /></div>
    <div className="field"><label htmlFor="organizationType">Workspace type</label><select className="input" id="organizationType" name="organizationType" defaultValue="EMPLOYER"><option value="EMPLOYER">Employer</option><option value="AGENCY">Recruiting agency</option><option value="UNIVERSITY">University</option></select></div>
    <div className="field"><label htmlFor="password">Password</label><input className="input" id="password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /><span className="muted" style={{ fontSize: 12 }}>Use at least 12 characters.</span></div>
    {error && <p role="alert" className="form-error">{error}</p>}
    {message && <p role="status" className="notice account-notice">{message}</p>}
    {actionUrl && <a className="account-development-link" href={actionUrl}>Open development verification link</a>}
    <button className="button button-primary" type="submit" disabled={pending} style={{ width: "100%", marginTop: 18 }}>{pending ? "Creating workspace…" : "Create workspace"}</button>
    <p className="muted" style={{ fontSize: 13, textAlign: "center" }}>Already have an account? <Link href="/login" style={{ textDecoration: "underline" }}>Sign in</Link></p>
  </form>;
}
