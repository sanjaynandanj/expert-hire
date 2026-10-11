"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

type Mode = "forgot" | "reset" | "verify" | "verify-request" | "invite";
type InviteDetails = { email: string; organizationName: string; role: string; requiresPassword: boolean };

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export function AccountActionForm({ mode, token = "" }: { mode: Mode; token?: string }) {
  const [details, setDetails] = useState<InviteDetails | null>(null);
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [developmentUrl, setDevelopmentUrl] = useState("");
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (mode !== "invite") return;
    if (!token) {
      setError("This invitation link is missing its token.");
      return;
    }
    void fetch(`${apiUrl}/v1/auth/invitations/${encodeURIComponent(token)}`)
      .then(async (response) => {
        const body = await response.json() as InviteDetails | { error?: { message?: string } };
        if (!response.ok || !("email" in body)) throw new Error("error" in body ? body.error?.message : "Invitation is unavailable.");
        setDetails(body);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Invitation is unavailable."));
  }, [mode, token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setMessage("");
    setDevelopmentUrl("");
    try {
      let path = "";
      let payload: Record<string, string> = {};
      if (mode === "forgot") {
        path = "/v1/auth/password-reset/request";
        payload = { email: new FormData(event.currentTarget).get("email")?.toString() ?? "" };
      } else if (mode === "verify-request") {
        path = "/v1/auth/verification/request";
        payload = { email: new FormData(event.currentTarget).get("email")?.toString() ?? "" };
      } else if (mode === "reset") {
        path = "/v1/auth/password-reset/confirm";
        payload = { token, password };
      } else if (mode === "verify") {
        path = "/v1/auth/verification/confirm";
        payload = { token };
      } else {
        path = `/v1/auth/invitations/${encodeURIComponent(token)}/accept`;
        payload = { ...(name ? { name } : {}), ...(password ? { password } : {}) };
      }
      const response = await fetch(`${apiUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json() as { message?: string; developmentActionUrl?: string; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "The request could not be completed.");
      setMessage(body.message ?? "Request complete.");
      setDevelopmentUrl(body.developmentActionUrl ?? "");
      setComplete(mode === "invite" || mode === "reset" || mode === "verify");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The request could not be completed.");
    } finally {
      setPending(false);
    }
  }

  const headings: Record<Mode, [string, string]> = {
    forgot: ["Reset your password", "We’ll email a secure reset link if the account exists."],
    reset: ["Choose a new password", "Use at least 12 characters. The link expires after 30 minutes."],
    verify: ["Verify your email", "Confirm the email address attached to your account."],
    "verify-request": ["Resend verification email", "We’ll send a fresh verification link if this account needs one."],
    invite: ["Join your workspace", details ? `${details.organizationName} invited ${details.email} as ${details.role.toLowerCase().replaceAll("_", " ")}.` : "Loading invitation details…"]
  };
  const [heading, description] = headings[mode];

  return <main className="account-page"><section className="account-card card panel">
    <Link href="/" className="brand"><span className="brand-mark">N</span>Northstar</Link>
    <h1>{heading}</h1><p className="muted">{description}</p>
    {((mode === "invite" && error) || ((mode === "reset" || mode === "verify") && !token)) && <p role="alert" className="form-error">{error || "This link is missing its token."}</p>}
    {(mode !== "invite" || details) && !((mode === "reset" || mode === "verify") && !token) ? <form className="account-form" onSubmit={submit}>
      {(mode === "forgot" || mode === "verify-request") && <label className="field"><span>Email address</span><input className="input" type="email" name="email" autoComplete="email" required /></label>}
      {mode === "invite" && details?.requiresPassword && <label className="field"><span>Your name</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} minLength={2} autoComplete="name" required /></label>}
      {(mode === "reset" || (mode === "invite" && details?.requiresPassword)) && <label className="field"><span>{mode === "reset" ? "New password" : "Create a password"}</span><input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} maxLength={128} autoComplete="new-password" required /></label>}
      {error && mode !== "invite" && <p role="alert" className="form-error">{error}</p>}
      {message && <p role="status" className="notice account-notice">{message}</p>}
      {developmentUrl && <a className="account-development-link" href={developmentUrl}>Open development link</a>}
      {!(mode === "verify" && !token) && !complete && <button className="button button-primary" disabled={pending || (mode === "invite" && !details)}>{pending ? "Working…" : mode === "forgot" ? "Send reset link" : mode === "verify-request" ? "Send verification link" : mode === "verify" ? "Verify email" : "Accept invitation"}</button>}
    </form> : null}
    <Link href="/login" className="account-back">Back to sign in</Link>
  </section></main>;
}
