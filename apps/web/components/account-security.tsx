"use client";

import { useEffect, useState, type FormEvent } from "react";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Status = { enabled: boolean; recoveryCodesRemaining: number };

export function AccountSecurity() {
  const [status, setStatus] = useState<Status | null>(null);
  const [secret, setSecret] = useState("");
  const [uri, setUri] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function call(path: string, payload?: Record<string, string>) {
    const response = await fetch(`${apiUrl}${path}`, { method: payload ? "POST" : "GET", credentials: "include", ...(payload ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {}) });
    const body = await response.json() as Status & { secret?: string; otpauthUri?: string; recoveryCodes?: string[]; message?: string; error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message ?? "Account security could not be updated.");
    return body;
  }

  async function refresh() {
    try { setStatus(await call("/v1/auth/mfa/status")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not read MFA settings."); }
  }

  useEffect(() => { void refresh(); }, []);

  async function beginEnrollment() {
    setPending(true); setError(""); setMessage("");
    try {
      const result = await call("/v1/auth/mfa/enroll", {});
      setSecret(result.secret ?? ""); setUri(result.otpauthUri ?? ""); setMessage(result.message ?? "Enrollment started.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not begin MFA enrollment."); }
    finally { setPending(false); }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError("");
    try {
      const result = await call("/v1/auth/mfa/confirm", { code });
      setRecoveryCodes(result.recoveryCodes ?? []); setMessage(result.message ?? "MFA enabled."); setSecret(""); setUri(""); setCode(""); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not confirm MFA."); }
    finally { setPending(false); }
  }

  async function disable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError("");
    try {
      const result = await call("/v1/auth/mfa/disable", { password, code });
      setMessage(result.message ?? "MFA disabled."); setRecoveryCodes([]); setCode(""); setPassword(""); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not disable MFA."); }
    finally { setPending(false); }
  }

  return <section className="card panel" style={{ marginTop: 20 }}>
    <div className="panel-head"><div><h2>Account security</h2><p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>Two-factor authentication and account recovery.</p></div><span className="tag">{status ? status.enabled ? "MFA enabled" : "MFA disabled" : "Loading…"}</span></div>
    {error && <p role="alert" className="form-error">{error}</p>}{message && <p role="status" className="notice account-notice">{message}</p>}
    {status && !status.enabled && !secret && <button className="button button-primary" type="button" onClick={beginEnrollment} disabled={pending}>{pending ? "Starting…" : "Set up authenticator"}</button>}
    {secret && <><p>Add this account to your authenticator app by entering the setup key below:</p><p><strong>Setup key</strong><br /><code>{secret}</code></p><details><summary>Advanced: authenticator setup URI</summary><p style={{ overflowWrap: "anywhere" }}>{uri}</p></details><form className="account-form" onSubmit={confirm}><label className="field"><span>Six-digit authenticator code</span><input className="input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} required /></label><button className="button button-primary" disabled={pending}>Confirm and enable MFA</button></form></>}
    {status?.enabled && <><p className="muted">{status.recoveryCodesRemaining} unused recovery code(s) remain. Each code works once.</p><form className="account-form" onSubmit={disable}><label className="field"><span>Password</span><input className="input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label><label className="field"><span>Authenticator or recovery code</span><input className="input" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} minLength={6} maxLength={20} required /></label><button className="button button-light" disabled={pending}>Disable MFA</button></form></>}
    {recoveryCodes.length > 0 && <div className="notice account-notice"><strong>Save these codes now. They are shown only once.</strong><div className="recovery-codes">{recoveryCodes.map((value) => <code key={value}>{value}</code>)}</div></div>}
  </section>;
}
