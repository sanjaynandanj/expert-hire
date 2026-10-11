"use client";

import { useEffect, useState, type FormEvent } from "react";

type Invitation = { id: string; email: string; role: string; expiresAt: string; createdAt: string };
type ApiFailure = { error?: { message?: string } };
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function memberRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const organizationId = window.localStorage.getItem("northstar.organizationId");
  if (!organizationId) throw new Error("Sign in to manage workspace members.");
  const response = await fetch(`${apiUrl}/v1${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-Organization-Id": organizationId, ...init?.headers }
  });
  const body = await response.json().catch(() => null) as T | ApiFailure | null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? body.error?.message : null;
    throw new Error(message ?? "The member request failed.");
  }
  return body as T;
}

export function WorkspaceMembers() {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("RECRUITER");
  const [previewUrl, setPreviewUrl] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function refresh() {
    try { setInvitations(await memberRequest<Invitation[]>("/invitations")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Invitations could not be loaded."); }
  }

  useEffect(() => { void refresh(); }, []);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setPreviewUrl("");
    try {
      const result = await memberRequest<Invitation & { developmentActionUrl?: string }>("/invitations", { method: "POST", body: JSON.stringify({ email, role }) });
      setInvitations((current) => [result, ...current.filter((item) => item.email.toLowerCase() !== result.email.toLowerCase())]);
      setEmail("");
      setPreviewUrl(result.developmentActionUrl ?? "");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Invitation could not be sent."); }
    finally { setPending(false); }
  }

  async function revoke(id: string) {
    try {
      await memberRequest<void>(`/invitations/${encodeURIComponent(id)}`, { method: "DELETE" });
      setInvitations((current) => current.filter((item) => item.id !== id));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Invitation could not be revoked."); }
  }

  return <section className="card panel member-panel">
    <div className="panel-head"><div><h2>Invite a workspace member</h2><span className="muted" style={{ fontSize: 12 }}>Links expire after seven days. Invites are sent to the address entered.</span></div></div>
    <form className="member-invite-form" onSubmit={invite}>
      <label className="field"><span>Email address</span><input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
      <label className="field"><span>Workspace role</span><select className="input" value={role} onChange={(event) => setRole(event.target.value)}><option value="ADMIN">Administrator</option><option value="HIRING_MANAGER">Hiring manager</option><option value="RECRUITER">Recruiter</option><option value="INTERVIEWER">Interviewer</option><option value="PLACEMENT_COORDINATOR">Placement coordinator</option><option value="VIEWER">Viewer</option><option value="STUDENT">Student</option><option value="CANDIDATE">Candidate</option></select></label>
      <button className="button button-primary" disabled={pending}>{pending ? "Sending…" : "Send invitation"}</button>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}
    {previewUrl && <div className="notice member-preview"><strong>Development invitation link</strong><a href={previewUrl}>{previewUrl}</a></div>}
    <h3 className="member-list-title">Pending invitations <span className="tag">{invitations.length}</span></h3>
    {invitations.map((invitation) => <div className="member-invitation" key={invitation.id}><div><strong>{invitation.email}</strong><span className="muted">{invitation.role.replaceAll("_", " ")} · expires {new Date(invitation.expiresAt).toLocaleDateString()}</span></div><button className="button button-light" type="button" onClick={() => void revoke(invitation.id)}>Revoke</button></div>)}
    {!invitations.length && <p className="muted">There are no pending invitations.</p>}
  </section>;
}
