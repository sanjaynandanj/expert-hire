"use client";

import { BriefcaseBusiness, CalendarDays, CheckCircle2, Filter, MapPin, Plus, Search, UsersRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

type ApiError = { error?: { message?: string } };
type Candidate = {
  id: string;
  name: string;
  email: string;
  headline: string | null;
  candidateJobs: Array<{ id: string; score: number | null; job: { title: string }; stage: { id: string; name: string } }>;
};
type CandidateNote = { id: string; content: string; createdAt: string; author: { id: string; name: string } };
type Meeting = { id: string; title: string; startsAt: string; durationMinutes: number; status: string; location: string | null; candidate: { id: string; name: string } | null; job: { id: string; title: string } | null; organizer: { name: string } };
type AnalyticsSummary = { generatedAt: string; candidates: number; openJobs: number; assessments: number; completedAssessments: number; assessmentCompletionRate: number; clients: number; pipeline: Array<{ stage: string; count: number }> };
type Job = {
  id: string;
  title: string;
  location: string | null;
  description?: string;
  status: string;
  rounds: Array<{ id: string; retiredAt?: string | null; title: string; sequence?: number; type?: string; durationMinutes?: number; difficulty?: string; proctoringEnabled?: boolean; desktopRequired?: boolean; promotionScore?: number | null; rejectionScore?: number | null; questions?: unknown }>;
  requirements: Array<{ id: string; name: string; weight: number }>;
};
type RoundDraft = { id?: string; retiredAt?: string | null; sequence: number; title: string; type: "RESUME_SCREEN" | "AI_INTERVIEW" | "HUMAN_INTERVIEW" | "CODING_TEST" | "PROMPT_ASSESSMENT"; durationMinutes: number; difficulty: "EASY" | "MEDIUM" | "HARD"; proctoringEnabled: boolean; desktopRequired: boolean; promotionScore: number | null; rejectionScore: number | null; questions: string[] };

function roundDraft(sequence: number): RoundDraft {
  return { sequence, title: `Round ${sequence}`, type: "HUMAN_INTERVIEW", durationMinutes: 30, difficulty: "MEDIUM", proctoringEnabled: false, desktopRequired: false, promotionScore: null, rejectionScore: null, questions: [] };
}

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

function organizationId() {
  return window.localStorage.getItem("northstar.organizationId");
}

async function workspaceRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const organization = organizationId();
  if (!organization) throw new Error("Sign in to connect this workspace to live data.");
  const response = await fetch(`${apiUrl}/v1${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-Organization-Id": organization, ...init?.headers }
  });
  const body = await response.json().catch(() => null) as T | ApiError | null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? body.error?.message : null;
    throw new Error(message ?? "The workspace request failed.");
  }
  return body as T;
}

const demoCandidates: Candidate[] = [
  { id: "demo-maya", name: "Maya Chen", email: "maya@candidate.test", headline: "Platform engineer", candidateJobs: [{ id: "demo-link-maya", score: 84, job: { title: "Senior Platform Engineer" }, stage: { id: "stage-new", name: "New signal" } }] },
  { id: "demo-jules", name: "Jules Park", email: "jules@candidate.test", headline: "Backend engineer", candidateJobs: [{ id: "demo-link-jules", score: 77, job: { title: "Senior Platform Engineer" }, stage: { id: "stage-review", name: "Human review" } }] },
  { id: "demo-nina", name: "Nina Okafor", email: "nina@candidate.test", headline: "Data engineer", candidateJobs: [{ id: "demo-link-nina", score: 81, job: { title: "Senior Platform Engineer" }, stage: { id: "stage-interview", name: "Interview" } }] },
  { id: "demo-omar", name: "Omar Saleh", email: "omar@candidate.test", headline: "Solutions architect", candidateJobs: [{ id: "demo-link-omar", score: 73, job: { title: "Senior Platform Engineer" }, stage: { id: "stage-decision", name: "Decision" } }] }
];

const demoJobs: Job[] = [
  { id: "demo-job", title: "Senior Platform Engineer", location: "Remote · India", status: "OPEN", rounds: [{ id: "r1", title: "Resume evidence", sequence: 1, type: "RESUME_SCREEN", durationMinutes: 15 }, { id: "r2", title: "Systems coding", sequence: 2, type: "CODING_TEST", durationMinutes: 45 }, { id: "r3", title: "Adaptive technical", sequence: 3, type: "AI_INTERVIEW", durationMinutes: 30 }, { id: "r4", title: "Team panel", sequence: 4, type: "HUMAN_INTERVIEW", durationMinutes: 60 }], requirements: [{ id: "req1", name: "Distributed systems", weight: 90 }] }
];

type Client = {
  id: string;
  name: string;
  industry: string | null;
  status: "PROSPECT" | "BRIEFING" | "ACTIVE" | "PAUSED";
  feeType: "PERCENTAGE" | "FLAT" | null;
  feeAmount: string | number | null;
  currency: string;
  guaranteeDays: number | null;
  billingEmail: string | null;
  _count?: { jobs: number };
};

type StaffingPlacement = {
  id: string;
  startDate: string;
  salary: string | number;
  salaryCurrency: string;
  feeAmount: string | number;
  feeCurrency: string;
  feeType: "PERCENTAGE" | "FLAT";
  feeRate: string | number;
  guaranteeUntil: string | null;
  guaranteeResolvedAt: string | null;
  client: { id: string; name: string; billingEmail: string | null };
  job: { id: string; title: string };
  candidateJob: { id: string; candidate: { id: string; name: string; email: string } };
  invoice: { id: string; invoiceNumber: string; amount: string | number; currency: string; status: "DRAFT" | "ISSUED" | "PAID" | "VOID"; dueAt: string | null; paidAt: string | null } | null;
};

const demoClients: Client[] = [
  { id: "demo-client-aster", name: "Aster Labs", industry: "Software", status: "ACTIVE", feeType: "PERCENTAGE", feeAmount: 18, currency: "USD", guaranteeDays: 90, billingEmail: "finance@aster.test", _count: { jobs: 4 } },
  { id: "demo-client-kindred", name: "Kindred Cloud", industry: "Cloud infrastructure", status: "BRIEFING", feeType: "FLAT", feeAmount: 12000, currency: "USD", guaranteeDays: 60, billingEmail: "ap@kindred.test", _count: { jobs: 2 } }
];

function useWorkspaceCollection<T>(path: string, fallback: T[]) {
  const [data, setData] = useState<T[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!organizationId()) {
      setData(fallback);
      setConnected(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await workspaceRequest<{ data: T[] }>(path);
      setData(result.data);
      setConnected(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Live data could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => { void refresh(); }, [refresh]);
  return { data, setData, connected, loading, error, refresh };
}

function DataState({ connected, loading, error }: { connected: boolean; loading: boolean; error: string | null }) {
  return <span className="tag">{loading ? "Refreshing…" : connected ? <><CheckCircle2 size={13} /> Live PostgreSQL data</> : error ?? "Interactive demo data"}</span>;
}

export function LiveCandidates() {
  const { data, connected, loading, error, refresh } = useWorkspaceCollection<Candidate>("/candidates", demoCandidates);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<Candidate | null>(null);
  const [notes, setNotes] = useState<CandidateNote[]>([]);
  const [noteError, setNoteError] = useState<string | null>(null);
  const filtered = useMemo(() => data.filter((candidate) => `${candidate.name} ${candidate.email} ${candidate.headline ?? ""}`.toLowerCase().includes(query.toLowerCase())), [data, query]);

  async function selectCandidate(candidate: Candidate) {
    setSelectedCandidate(candidate);
    setNoteError(null);
    try { setNotes(await workspaceRequest<CandidateNote[]>(`/candidates/${candidate.id}/notes`)); }
    catch (reason) { setNoteError(reason instanceof Error ? reason.message : "Notes could not be loaded."); }
  }

  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCandidate) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const note = await workspaceRequest<CandidateNote>(`/candidates/${selectedCandidate.id}/notes`, { method: "POST", body: JSON.stringify({ content: form.get("content") }) });
      setNotes((current) => [note, ...current]);
      formElement.reset();
      setNoteError(null);
    } catch (reason) { setNoteError(reason instanceof Error ? reason.message : "Note could not be saved."); }
  }

  async function createCandidate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFormError(null);
    try {
      await workspaceRequest("/candidates", {
        method: "POST",
        body: JSON.stringify({ name: form.get("name"), email: form.get("email"), headline: form.get("headline"), source: "MANUAL" })
      });
      setCreating(false);
      await refresh();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Candidate could not be created.");
    } finally {
      setPending(false);
    }
  }

  return <><div className="page-title"><div><p className="eyebrow muted" style={{ margin: "0 0 8px" }}>Recruiting</p><h1>Talent pool</h1><span className="muted">People, evidence, ownership, and every role they are connected to.</span></div><button className="button button-primary" onClick={() => setCreating((value) => !value)}>{creating ? <X size={16} /> : <Plus size={16} />}{creating ? "Close" : "Add candidate"}</button></div>
    {creating && <form className="card panel workspace-form" onSubmit={createCandidate}><div className="panel-head"><div><h2>Add to talent pool</h2><span className="muted" style={{ fontSize: 12 }}>The API enforces tenant scope and records an audit event.</span></div></div><div className="form-grid"><div className="field"><label htmlFor="candidate-name">Full name</label><input className="input" id="candidate-name" name="name" minLength={2} required /></div><div className="field"><label htmlFor="candidate-email">Email</label><input className="input" id="candidate-email" name="email" type="email" required /></div><div className="field"><label htmlFor="candidate-headline">Headline</label><input className="input" id="candidate-headline" name="headline" placeholder="e.g. Platform engineer" /></div></div>{formError && <p role="alert" className="form-error">{formError}</p>}<button className="button button-primary" disabled={pending}>{pending ? "Adding…" : "Add candidate"}</button></form>}
    <section className="card panel"><div className="panel-head"><div style={{ display: "flex", alignItems: "center", gap: 9 }}><Search size={17} /><input aria-label="Search talent pool" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, email, or skill" className="table-search" /></div><DataState connected={connected} loading={loading} error={error} /></div><div style={{ overflowX: "auto" }}><table className="table"><thead><tr><th>Candidate</th><th>Headline</th><th>Role</th><th>Stage</th><th>Evidence</th><th>Notes</th></tr></thead><tbody>{filtered.map((candidate) => { const placement = candidate.candidateJobs[0]; return <tr key={candidate.id}><td><div className="person"><div className="avatar">{candidate.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</div><div><strong>{candidate.name}</strong><div className="muted" style={{ fontSize: 11 }}>{candidate.email}</div></div></div></td><td>{candidate.headline ?? "—"}</td><td>{placement?.job.title ?? "Talent pool"}</td><td><span className="tag">{placement?.stage.name ?? "Unassigned"}</span></td><td><span className="score">{placement?.score ?? "—"}</span></td><td><button className="button button-light" style={{ minHeight: 34 }} onClick={() => void selectCandidate(candidate)}>View notes</button></td></tr>; })}</tbody></table></div></section>
    {selectedCandidate && <section className="card panel" style={{ marginTop: 14 }}><div className="panel-head"><div><h2>Private notes · {selectedCandidate.name}</h2><span className="muted" style={{ fontSize: 12 }}>Visible only to authorized workspace members.</span></div><button className="button button-light" onClick={() => setSelectedCandidate(null)}>Close</button></div><form onSubmit={addNote}><label className="field"><span>Add a note</span><textarea name="content" className="input form-textarea" minLength={1} maxLength={10000} required /></label>{noteError && <p role="alert" className="form-error">{noteError}</p>}<button className="button button-primary" style={{ marginTop: 10 }}>Save note</button></form>{notes.map((note) => <article key={note.id} style={{ borderTop: "1px solid var(--line)", marginTop: 14, paddingTop: 14 }}><p style={{ whiteSpace: "pre-wrap" }}>{note.content}</p><small className="muted">{note.author.name} · {new Date(note.createdAt).toLocaleString()}</small></article>)}</section>}</>;
}

export function LiveMeetings() {
  const { data, connected, loading, error, refresh } = useWorkspaceCollection<Meeting>("/meetings", []);
  const { data: candidates } = useWorkspaceCollection<Candidate>("/candidates", []);
  const { data: jobs } = useWorkspaceCollection<Job>("/jobs", []);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function createMeeting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setPending(true); setFormError(null);
    try {
      await workspaceRequest("/meetings", { method: "POST", body: JSON.stringify({ title: form.get("title"), startsAt: new Date(String(form.get("startsAt"))).toISOString(), durationMinutes: Number(form.get("durationMinutes")), candidateId: form.get("candidateId") || undefined, jobId: form.get("jobId") || undefined, location: form.get("location") || undefined }) });
      formElement.reset(); await refresh();
    } catch (reason) { setFormError(reason instanceof Error ? reason.message : "Meeting could not be scheduled."); }
    finally { setPending(false); }
  }
  async function setStatus(meeting: Meeting, status: string) {
    try { await workspaceRequest(`/meetings/${meeting.id}`, { method: "PATCH", body: JSON.stringify({ status }) }); await refresh(); }
    catch (reason) { setFormError(reason instanceof Error ? reason.message : "Meeting could not be updated."); }
  }
  return <><div className="page-title"><div><p className="eyebrow muted" style={{ margin: "0 0 8px" }}>Recruiting</p><h1>Meetings</h1><span className="muted">Schedule candidate conversations and record outcomes.</span></div><DataState connected={connected} loading={loading} error={error} /></div>
    <form className="card panel workspace-form" onSubmit={createMeeting}><div className="panel-head"><div><h2>Schedule meeting</h2><span className="muted" style={{ fontSize: 12 }}>Calendar invitations are not sent yet; copy the meeting details to your calendar.</span></div><CalendarDays size={18} /></div><div className="form-grid"><label className="field"><span>Title</span><input className="input" name="title" minLength={2} required /></label><label className="field"><span>Date and time</span><input className="input" type="datetime-local" name="startsAt" required /></label><label className="field"><span>Duration</span><select className="input" name="durationMinutes"><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="60">60 minutes</option><option value="90">90 minutes</option></select></label><label className="field"><span>Candidate (optional)</span><select className="input" name="candidateId"><option value="">No candidate</option>{candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label><label className="field"><span>Job (optional)</span><select className="input" name="jobId"><option value="">No job</option>{jobs.map((job) => <option key={job.id} value={job.id}>{job.title}</option>)}</select></label><label className="field"><span>Location or video link</span><input className="input" name="location" /></label></div>{formError && <p role="alert" className="form-error">{formError}</p>}<button className="button button-primary" disabled={pending}>{pending ? "Scheduling…" : "Schedule meeting"}</button></form>
    <section className="card panel" style={{ marginTop: 14 }}><div className="panel-head"><h2>Workspace schedule</h2><span className="tag">{data.length} meetings</span></div>{data.length === 0 ? <p className="muted">No meetings yet. Your scheduled conversations will appear here.</p> : data.map((meeting) => <article key={meeting.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, borderTop: "1px solid var(--line)", padding: "16px 0" }}><div><strong>{meeting.title}</strong><div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{new Date(meeting.startsAt).toLocaleString()} · {meeting.durationMinutes} min{meeting.candidate ? ` · ${meeting.candidate.name}` : ""}{meeting.job ? ` · ${meeting.job.title}` : ""}{meeting.location ? ` · ${meeting.location}` : ""}</div></div><select className="input" aria-label={`Update ${meeting.title} status`} value={meeting.status} onChange={(event) => void setStatus(meeting, event.target.value)}>{["SCHEDULED", "COMPLETED", "CANCELLED", "NO_SHOW"].map((status) => <option key={status}>{status}</option>)}</select></article>)}</section></>;
}

export function LiveAnalytics() {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const refresh = useCallback(async () => {
    if (!organizationId()) return;
    setLoading(true); setError(null);
    try { setSummary(await workspaceRequest<AnalyticsSummary>("/analytics/summary")); setConnected(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Analytics could not be loaded."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return <><div className="page-title"><div><p className="eyebrow muted" style={{ margin: "0 0 8px" }}>Workspace intelligence</p><h1>Analytics</h1><span className="muted">Live counts from this workspace, with no cross-tenant aggregation.</span></div><DataState connected={connected} loading={loading} error={error} /></div>
    {summary ? <><section className="stats-grid">{[["Candidates", summary.candidates], ["Open jobs", summary.openJobs], ["Assessments", summary.assessments], ["Clients", summary.clients]].map(([label, value]) => <article className="card stat-card" key={label}><span className="muted">{label}</span><strong>{value}</strong></article>)}</section><section className="card panel" style={{ marginTop: 14 }}><div className="panel-head"><div><h2>Assessment completion</h2><span className="muted" style={{ fontSize: 12 }}>{summary.completedAssessments} of {summary.assessments} assessments completed</span></div><strong>{summary.assessmentCompletionRate}%</strong></div><div className="mini-bar"><span style={{ width: `${summary.assessmentCompletionRate}%`, background: "var(--pine)" }} /></div></section><section className="card panel" style={{ marginTop: 14 }}><div className="panel-head"><div><h2>Active pipeline</h2><span className="muted" style={{ fontSize: 12 }}>Current candidate placements by stage</span></div></div>{summary.pipeline.length ? summary.pipeline.map((item) => <div key={item.stage} style={{ display: "flex", justifyContent: "space-between", padding: "13px 0", borderTop: "1px solid var(--line)" }}><span>{item.stage}</span><strong>{item.count}</strong></div>) : <p className="muted">No active candidate placements yet.</p>}</section><p className="muted" style={{ fontSize: 11, marginTop: 12 }}>Snapshot generated {new Date(summary.generatedAt).toLocaleString()}. Historical trends and conversion cohorts are not included yet.</p></> : <section className="card panel"><p className="muted">{error ?? "Loading live workspace analytics…"}</p></section>}
  </>;
}

export function LiveClients() {
  const { data, setData, connected, loading, error, refresh } = useWorkspaceCollection<Client>("/clients", demoClients);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [editingClient, setEditingClient] = useState<Client | null>(null);

  async function createClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const feeAmount = String(form.get("feeAmount") ?? "");
    setPending(true);
    setFormError(null);
    try {
      await workspaceRequest("/clients", {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          industry: form.get("industry") || undefined,
          billingEmail: form.get("billingEmail") || undefined,
          status: form.get("status"),
          feeType: form.get("feeType"),
          feeAmount: Number(feeAmount),
          currency: form.get("currency"),
          guaranteeDays: Number(form.get("guaranteeDays"))
        })
      });
      setCreating(false);
      await refresh();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Client account could not be created.");
    } finally {
      setPending(false);
    }
  }

  async function updateStatus(client: Client, status: Client["status"]) {
    setRowError(null);
    try {
      await workspaceRequest(`/clients/${encodeURIComponent(client.id)}`, { method: "PATCH", body: JSON.stringify({ status }) });
      setData((current) => current.map((item) => item.id === client.id ? { ...item, status } : item));
    } catch (reason) {
      setRowError(reason instanceof Error ? reason.message : "Client account could not be updated.");
    }
  }

  async function updateClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingClient) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setRowError(null);
    try {
      await workspaceRequest(`/clients/${encodeURIComponent(editingClient.id)}`, { method: "PATCH", body: JSON.stringify({
        name: form.get("name"), industry: form.get("industry") || null, status: form.get("status"),
        feeType: form.get("feeType"), feeAmount: Number(form.get("feeAmount")), currency: form.get("currency"),
        guaranteeDays: Number(form.get("guaranteeDays")), billingEmail: form.get("billingEmail") || null
      }) });
      setEditingClient(null);
      await refresh();
    } catch (reason) {
      setRowError(reason instanceof Error ? reason.message : "Client terms could not be updated.");
    } finally {
      setPending(false);
    }
  }

  return <><div className="page-title"><div><p className="eyebrow muted" style={{ margin: "0 0 8px" }}>Agency operations</p><h1>Clients</h1><span className="muted">Accounts, fee terms, billing contacts, and guarantee periods.</span></div><button className="button button-primary" onClick={() => setCreating((value) => !value)}>{creating ? "Close" : "Add client"}</button></div>
    {creating && <form className="card panel workspace-form" onSubmit={createClient}><div className="panel-head"><div><h2>New client account</h2><span className="muted" style={{ fontSize: 12 }}>Terms are stored with the client and remain editable by workspace admins.</span></div></div><div className="form-grid"><div className="field"><label htmlFor="client-name">Client name</label><input className="input" id="client-name" name="name" minLength={2} required /></div><div className="field"><label htmlFor="client-industry">Industry</label><input className="input" id="client-industry" name="industry" /></div><div className="field"><label htmlFor="client-status">Status</label><select className="input" id="client-status" name="status"><option value="PROSPECT">Prospect</option><option value="BRIEFING">Briefing</option><option value="ACTIVE">Active</option><option value="PAUSED">Paused</option></select></div><div className="field"><label htmlFor="client-fee-type">Fee model</label><select className="input" id="client-fee-type" name="feeType"><option value="PERCENTAGE">Percentage of salary</option><option value="FLAT">Flat fee</option></select></div><div className="field"><label htmlFor="client-fee-amount">Fee amount</label><input className="input" id="client-fee-amount" name="feeAmount" type="number" min="0" step="0.01" required /></div><div className="field"><label htmlFor="client-currency">Currency</label><select className="input" id="client-currency" name="currency"><option>USD</option><option>INR</option><option>EUR</option><option>GBP</option></select></div><div className="field"><label htmlFor="client-guarantee">Guarantee period (days)</label><input className="input" id="client-guarantee" name="guaranteeDays" type="number" min="0" max="730" defaultValue="90" required /></div><div className="field"><label htmlFor="client-billing-email">Billing email</label><input className="input" id="client-billing-email" name="billingEmail" type="email" /></div></div>{formError && <p role="alert" className="form-error">{formError}</p>}<button className="button button-primary" disabled={pending}>{pending ? "Saving…" : "Save client"}</button></form>}
    {editingClient && <form className="card panel workspace-form" onSubmit={updateClient}><div className="panel-head"><div><h2>Edit {editingClient.name}</h2><span className="muted" style={{ fontSize: 12 }}>Commercial terms apply to future placements.</span></div><button className="button button-light" type="button" onClick={() => setEditingClient(null)}>Cancel</button></div><div className="form-grid"><div className="field"><label htmlFor="edit-client-name">Client name</label><input className="input" id="edit-client-name" name="name" defaultValue={editingClient.name} minLength={2} required /></div><div className="field"><label htmlFor="edit-client-industry">Industry</label><input className="input" id="edit-client-industry" name="industry" defaultValue={editingClient.industry ?? ""} /></div><div className="field"><label htmlFor="edit-client-status">Status</label><select className="input" id="edit-client-status" name="status" defaultValue={editingClient.status}>{["PROSPECT", "BRIEFING", "ACTIVE", "PAUSED"].map((status) => <option key={status} value={status}>{status}</option>)}</select></div><div className="field"><label htmlFor="edit-client-fee-type">Fee model</label><select className="input" id="edit-client-fee-type" name="feeType" defaultValue={editingClient.feeType ?? "PERCENTAGE"}><option value="PERCENTAGE">Percentage of salary</option><option value="FLAT">Flat fee</option></select></div><div className="field"><label htmlFor="edit-client-fee-amount">Fee amount</label><input className="input" id="edit-client-fee-amount" name="feeAmount" type="number" min="0" step="0.01" defaultValue={editingClient.feeAmount ?? 0} required /></div><div className="field"><label htmlFor="edit-client-currency">Currency</label><select className="input" id="edit-client-currency" name="currency" defaultValue={editingClient.currency}>{["USD", "INR", "EUR", "GBP"].map((currency) => <option key={currency}>{currency}</option>)}</select></div><div className="field"><label htmlFor="edit-client-guarantee">Guarantee period (days)</label><input className="input" id="edit-client-guarantee" name="guaranteeDays" type="number" min="0" max="730" defaultValue={editingClient.guaranteeDays ?? 90} required /></div><div className="field"><label htmlFor="edit-client-billing-email">Billing email</label><input className="input" id="edit-client-billing-email" name="billingEmail" type="email" defaultValue={editingClient.billingEmail ?? ""} /></div></div><button className="button button-primary" disabled={pending}>{pending ? "Saving…" : "Save changes"}</button></form>}
    <section className="card panel"><div className="panel-head"><h2>Client accounts</h2><DataState connected={connected} loading={loading} error={error} /></div>{rowError && <p role="alert" className="form-error">{rowError}</p>}<div style={{ overflowX: "auto" }}><table className="table"><thead><tr><th>Client</th><th>Open roles</th><th>Placement fee</th><th>Guarantee</th><th>Status</th><th>Terms</th></tr></thead><tbody>{data.map((client) => <tr key={client.id}><td><strong>{client.name}</strong><div className="muted" style={{ fontSize: 11 }}>{client.industry ?? client.billingEmail ?? "Client account"}</div></td><td>{client._count?.jobs ?? 0}</td><td>{client.feeType === "PERCENTAGE" ? `${client.feeAmount}%` : client.feeAmount == null ? "Not set" : `${client.currency} ${Number(client.feeAmount).toLocaleString()}`}</td><td>{client.guaranteeDays == null ? "Not set" : `${client.guaranteeDays} days`}</td><td><select aria-label={`Change ${client.name} status`} className="input" value={client.status} onChange={(event) => void updateStatus(client, event.target.value as Client["status"])}>{["PROSPECT", "BRIEFING", "ACTIVE", "PAUSED"].map((status) => <option key={status} value={status}>{status[0]}{status.slice(1).toLowerCase()}</option>)}</select></td><td><button className="button button-light" onClick={() => setEditingClient(client)}>Edit terms</button></td></tr>)}</tbody></table></div></section></>;
}

export function LiveStaffingPlacements() {
  const { data: placements, connected, loading, error, refresh } = useWorkspaceCollection<StaffingPlacement>("/staffing/placements", []);
  const { data: candidates } = useWorkspaceCollection<Candidate>("/candidates", []);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function recordStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await workspaceRequest("/staffing/placements", { method: "POST", body: JSON.stringify({
        candidateJobId: form.get("candidateJobId"),
        startDate: new Date(`${String(form.get("startDate"))}T00:00:00.000Z`).toISOString(),
        salary: Number(form.get("salary")), salaryCurrency: form.get("salaryCurrency")
      }) });
      setNotice("Start recorded. A draft invoice was created using the current client terms.");
      formElement.reset();
      await refresh();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "The start could not be recorded.");
    } finally {
      setPending(false);
    }
  }

  async function updateInvoice(placement: StaffingPlacement, status: "ISSUED" | "PAID" | "VOID") {
    if (!placement.invoice) return;
    setActionError(null);
    try {
      const dueAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
      await workspaceRequest(`/staffing/invoices/${encodeURIComponent(placement.invoice.id)}`, { method: "PATCH", body: JSON.stringify({ status, ...(status === "ISSUED" ? { dueAt } : {}) }) });
      await refresh();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Invoice status could not be updated.");
    }
  }

  async function resolveGuarantee(placement: StaffingPlacement) {
    setActionError(null);
    try {
      await workspaceRequest(`/staffing/placements/${encodeURIComponent(placement.id)}/guarantee`, { method: "PATCH", body: JSON.stringify({ resolved: !placement.guaranteeResolvedAt }) });
      await refresh();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Guarantee status could not be updated.");
    }
  }

  const assignments = candidates.flatMap((candidate) => candidate.candidateJobs.map((assignment) => ({ ...assignment, candidate })));
  return <>
    <div className="page-title"><div><p className="eyebrow muted" style={{ margin: "0 0 8px" }}>Agency operations</p><h1>Placements</h1><span className="muted">Record actual starts, calculate agreed fees, issue draft invoices, and track guarantee windows.</span></div><DataState connected={connected} loading={loading} error={error} /></div>
    <form className="card panel workspace-form" onSubmit={recordStart}><div className="panel-head"><div><h2>Record a candidate start</h2><span className="muted" style={{ fontSize: 12 }}>Fee terms are snapshotted from the linked client/job when the start is recorded.</span></div></div><div className="form-grid"><label className="field"><span>Candidate · role</span><select className="input" name="candidateJobId" required defaultValue=""><option value="" disabled>Select an attributed role</option>{assignments.map((assignment) => <option key={assignment.id} value={assignment.id}>{assignment.candidate.name} · {assignment.job.title}</option>)}</select></label><div className="field"><label htmlFor="placement-start-date">Start date</label><input className="input" id="placement-start-date" name="startDate" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} /></div><div className="field"><label htmlFor="placement-salary">Annual salary</label><input className="input" id="placement-salary" name="salary" type="number" min="0.01" step="0.01" required /></div><label className="field"><span>Salary currency</span><select className="input" name="salaryCurrency"><option>USD</option><option>INR</option><option>EUR</option><option>GBP</option></select></label></div>{notice && <p role="status" className="muted">{notice}</p>}{actionError && <p role="alert" className="form-error">{actionError}</p>}<button className="button button-primary" disabled={pending || !assignments.length}>{pending ? "Recording…" : "Record start"}</button>{!assignments.length && <p className="muted" style={{ fontSize: 12 }}>Add candidates to a role before recording a placement.</p>}</form>
    <section className="card panel"><div className="panel-head"><h2>Placement and invoice ledger</h2><span className="tag">{placements.length} starts</span></div>{actionError && <p role="alert" className="form-error">{actionError}</p>}{placements.length ? <div style={{ overflowX: "auto" }}><table className="table"><thead><tr><th>Candidate · role</th><th>Client · start</th><th>Fee snapshot</th><th>Invoice</th><th>Guarantee</th></tr></thead><tbody>{placements.map((placement) => <tr key={placement.id}><td><strong>{placement.candidateJob.candidate.name}</strong><div className="muted" style={{ fontSize: 11 }}>{placement.job.title}</div></td><td>{placement.client.name}<div className="muted" style={{ fontSize: 11 }}>{new Date(placement.startDate).toLocaleDateString()}</div></td><td>{placement.feeCurrency} {Number(placement.feeAmount).toLocaleString()}<div className="muted" style={{ fontSize: 11 }}>{placement.feeType === "PERCENTAGE" ? `${placement.feeRate}% of ${placement.salaryCurrency} ${Number(placement.salary).toLocaleString()}` : "Flat fee"}</div></td><td>{placement.invoice && <><strong>{placement.invoice.invoiceNumber}</strong><div className="muted" style={{ fontSize: 11 }}>{placement.invoice.status} · {placement.invoice.currency} {Number(placement.invoice.amount).toLocaleString()}</div>{placement.invoice.status === "DRAFT" && <button className="button button-light" onClick={() => void updateInvoice(placement, "ISSUED")}>Issue · due 30 days</button>}{placement.invoice.status === "ISSUED" && <button className="button button-light" onClick={() => void updateInvoice(placement, "PAID")}>Mark paid</button>}</>}</td><td>{placement.guaranteeUntil ? <>{placement.guaranteeResolvedAt ? "Resolved" : new Date(placement.guaranteeUntil).toLocaleDateString()}<div><button className="button button-light" onClick={() => void resolveGuarantee(placement)}>{placement.guaranteeResolvedAt ? "Reopen" : "Resolve"}</button></div></> : "Not set"}</td></tr>)}</tbody></table></div> : <p className="muted">No starts recorded yet. Draft invoices will appear here when a placement is created.</p>}</section>
  </>;
}

function RoundPlanEditor({ rounds, onChange, onAdd, onRemove, onRetire }: { rounds: RoundDraft[]; onChange: (index: number, patch: Partial<RoundDraft>) => void; onAdd: () => void; onRemove: (index: number) => void; onRetire: (index: number) => void }) {
  return <section className="card panel"><div className="panel-head"><div><h3>Assessment rounds</h3><span className="muted" style={{ fontSize: 12 }}>Coding rounds remain disabled until an isolated runner is configured. Saved rounds can only be removed when they have no assessment history. Removing a saved round takes effect immediately.</span></div><button className="button button-light" type="button" onClick={onAdd} disabled={rounds.length >= 20}>Add round</button></div>{rounds.length ? rounds.map((round, index) => <article className="configuration-create" key={round.id ?? `draft-${round.sequence}`}><div className="panel-head"><strong>Round {round.sequence}{round.retiredAt ? " · retired" : ""}{round.id ? " · saved" : " · draft"}</strong>{round.id && <button className="button button-light" type="button" onClick={() => onRetire(index)}>{round.retiredAt ? "Restore round" : "Retire round"}</button>}{<button className="button button-light" type="button" onClick={() => onRemove(index)}>{round.id ? "Remove saved round" : "Remove draft"}</button>}</div><div className="form-grid"><label className="field"><span>Round title</span><input className="input" value={round.title} onChange={(event) => onChange(index, { title: event.target.value })} minLength={2} maxLength={120} required /></label><label className="field"><span>Assessment type</span><select className="input" value={round.type} onChange={(event) => onChange(index, { type: event.target.value as RoundDraft["type"] })}>{[["RESUME_SCREEN", "Resume screen"], ["AI_INTERVIEW", "AI interview"], ["HUMAN_INTERVIEW", "Human interview"], ["CODING_TEST", "Coding test (sandbox required)"], ["PROMPT_ASSESSMENT", "Prompt assessment"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field"><span>Duration (minutes)</span><input className="input" type="number" min="0" max="240" value={round.durationMinutes} onChange={(event) => onChange(index, { durationMinutes: Number(event.target.value) })} /></label><label className="field"><span>Difficulty</span><select className="input" value={round.difficulty} onChange={(event) => onChange(index, { difficulty: event.target.value as RoundDraft["difficulty"] })}><option>EASY</option><option>MEDIUM</option><option>HARD</option></select></label><label className="field"><span>Promotion score</span><input className="input" type="number" min="0" max="100" value={round.promotionScore ?? ""} onChange={(event) => onChange(index, { promotionScore: event.target.value === "" ? null : Number(event.target.value) })} /></label><label className="field"><span>Rejection score</span><input className="input" type="number" min="0" max="100" value={round.rejectionScore ?? ""} onChange={(event) => onChange(index, { rejectionScore: event.target.value === "" ? null : Number(event.target.value) })} /></label><label className="configuration-active"><input type="checkbox" checked={round.proctoringEnabled} onChange={(event) => onChange(index, { proctoringEnabled: event.target.checked })} /> Record integrity context</label><label className="configuration-active"><input type="checkbox" checked={round.desktopRequired} onChange={(event) => onChange(index, { desktopRequired: event.target.checked })} /> Require desktop</label><div className="field form-wide"><label>Questions (one prompt per line)</label><textarea className="input form-textarea" value={round.questions.join("\n")} onChange={(event) => onChange(index, { questions: event.target.value.split("\n") })} placeholder="Describe a difficult trade-off you made…" /></div></div></article>) : <p className="muted">No assessment rounds are defined yet.</p>}</section>;
}

export function LiveJobs() {
  const { data, setData, connected, loading, error, refresh } = useWorkspaceCollection<Job>("/jobs", demoJobs);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [roundDrafts, setRoundDrafts] = useState<RoundDraft[]>([]);

  async function createJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const requirement = String(form.get("requirement") ?? "");
    setPending(true);
    setFormError(null);
    try {
      await workspaceRequest("/jobs", {
        method: "POST",
        body: JSON.stringify({
          title: form.get("title"),
          location: form.get("location"),
          description: form.get("description"),
          language: "English",
          workflowEnabled: true,
          requirements: [{ name: requirement, weight: 100 }]
        })
      });
      setCreating(false);
      await refresh();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Role could not be created.");
    } finally {
      setPending(false);
    }
  }

  async function updateJobStatus(job: Job, status: Job["status"]) {
    setRowError(null);
    try {
      if (connected) {
        await workspaceRequest(`/jobs/${encodeURIComponent(job.id)}`, { method: "PATCH", body: JSON.stringify({ status }) });
        await refresh();
      } else setData((current) => current.map((item) => item.id === job.id ? { ...item, status } : item));
    } catch (reason) {
      setRowError(reason instanceof Error ? reason.message : "Role status could not be updated.");
    }
  }

  async function updateJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingJob) return;
    const form = new FormData(event.currentTarget);
    const names = String(form.get("requirements") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
    if (!names.length) {
      setRowError("Add at least one role requirement.");
      return;
    }
    const baseWeight = Math.floor(100 / names.length);
    const requirements = names.map((name, index) => ({ name, weight: index === names.length - 1 ? 100 - baseWeight * (names.length - 1) : baseWeight }));
    setPending(true);
    setRowError(null);
    try {
      await workspaceRequest(`/jobs/${encodeURIComponent(editingJob.id)}`, { method: "PATCH", body: JSON.stringify({
        title: form.get("title"), location: form.get("location") || null, description: form.get("description"), requirements,
        rounds: roundDrafts.map((round) => ({ ...round, questions: round.questions.filter((label) => label.trim()).map((label, index) => ({ id: `q-${round.sequence}-${index + 1}`, label: label.trim() })) }))
      }) });
      setEditingJob(null);
      setRoundDrafts([]);
      await refresh();
    } catch (reason) {
      setRowError(reason instanceof Error ? reason.message : "Role details could not be updated.");
    } finally {
      setPending(false);
    }
  }

  function editJob(job: Job) {
    setEditingJob(job);
    setRoundDrafts(job.rounds.map((round, index) => {
      const questions = Array.isArray(round.questions) ? round.questions as Array<{ label?: string }> : [];
      return {
        id: round.id,
        retiredAt: round.retiredAt ?? null,
        sequence: round.sequence ?? index + 1,
        title: round.title,
        type: (round.type ?? "HUMAN_INTERVIEW") as RoundDraft["type"],
        durationMinutes: round.durationMinutes ?? 30,
        difficulty: (round.difficulty ?? "MEDIUM") as RoundDraft["difficulty"],
        proctoringEnabled: round.proctoringEnabled ?? false,
        desktopRequired: round.desktopRequired ?? false,
        promotionScore: round.promotionScore ?? null,
        rejectionScore: round.rejectionScore ?? null,
        questions: questions.map((question) => question.label ?? "").filter(Boolean)
      };
    }));
  }

  function changeRound(index: number, patch: Partial<RoundDraft>) {
    setRoundDrafts((current) => current.map((round, roundIndex) => roundIndex === index ? { ...round, ...patch } : round));
  }

  async function removeRound(index: number) {
    const round = roundDrafts[index];
    if (!round || pending) return;
    if (!round.id) {
      setRoundDrafts((current) => current.filter((_, roundIndex) => roundIndex !== index));
      return;
    }
    if (!editingJob || !connected) {
      setRowError("Sign in to remove a saved assessment round.");
      return;
    }
    if (!window.confirm(`Remove saved round “${round.title}” immediately? This is only allowed when it has no assessment history.`)) return;
    setPending(true);
    setRowError(null);
    try {
      await workspaceRequest(`/jobs/${encodeURIComponent(editingJob.id)}/rounds/${encodeURIComponent(round.id)}`, { method: "DELETE" });
      setRoundDrafts((current) => current.filter((item) => item.id !== round.id));
      await refresh();
    } catch (reason) {
      setRowError(reason instanceof Error ? reason.message : "Assessment round could not be removed.");
    } finally {
      setPending(false);
    }
  }

  async function toggleRoundRetirement(index: number) {
    const round = roundDrafts[index];
    if (!round?.id || !editingJob || pending) return;
    if (!connected) { setRowError("Sign in to retire or restore a saved round."); return; }
    const retired = !round.retiredAt;
    if (!window.confirm(`${retired ? "Retire" : "Restore"} round “${round.title}” immediately? Existing assessments and reports will be preserved.`)) return;
    setPending(true);
    setRowError(null);
    try {
      const updated = await workspaceRequest<{ retiredAt: string | null }>(`/jobs/${encodeURIComponent(editingJob.id)}/rounds/${encodeURIComponent(round.id)}/retirement`, { method: "PATCH", body: JSON.stringify({ retired, expectedRetired: !!round.retiredAt }) });
      setRoundDrafts((current) => current.map((item) => item.id === round.id ? { ...item, retiredAt: updated.retiredAt } : item));
      await refresh();
    } catch (reason) {
      setRowError(reason instanceof Error ? reason.message : "Round retirement could not be changed.");
    } finally { setPending(false); }
  }

  return <><div className="page-title"><div><p className="eyebrow muted" style={{ margin: "0 0 8px" }}>Recruiting</p><h1>Jobs</h1><span className="muted">Build the rubric first. Every round stays anchored to it.</span></div><button className="button button-primary" onClick={() => setCreating((value) => !value)}>{creating ? <X size={16} /> : <Plus size={16} />}{creating ? "Close" : "Create role"}</button></div>
    {creating && <form className="card panel workspace-form" onSubmit={createJob}><div className="panel-head"><div><h2>Create a scored role</h2><span className="muted" style={{ fontSize: 12 }}>Start with one decisive requirement; add the full round plan after creation.</span></div></div><div className="form-grid"><div className="field"><label htmlFor="job-title">Role title</label><input className="input" id="job-title" name="title" minLength={2} required /></div><div className="field"><label htmlFor="job-location">Location</label><input className="input" id="job-location" name="location" /></div><div className="field"><label htmlFor="job-requirement">Primary requirement</label><input className="input" id="job-requirement" name="requirement" required /></div><div className="field form-wide"><label htmlFor="job-description">Description</label><textarea className="input form-textarea" id="job-description" name="description" minLength={100} required /></div></div>{formError && <p role="alert" className="form-error">{formError}</p>}<button className="button button-primary" disabled={pending}>{pending ? "Creating…" : "Create role"}</button></form>}
    {editingJob && <form className="card panel workspace-form" onSubmit={updateJob}><div className="panel-head"><div><h2>Edit {editingJob.title}</h2><span className="muted" style={{ fontSize: 12 }}>Rubric weights are split evenly across the listed requirements.</span></div><button className="button button-light" type="button" onClick={() => { setEditingJob(null); setRoundDrafts([]); }}>Cancel</button></div><div className="form-grid"><div className="field"><label htmlFor="edit-job-title">Role title</label><input className="input" id="edit-job-title" name="title" defaultValue={editingJob.title} minLength={2} required /></div><div className="field"><label htmlFor="edit-job-location">Location</label><input className="input" id="edit-job-location" name="location" defaultValue={editingJob.location ?? ""} /></div><div className="field form-wide"><label htmlFor="edit-job-requirements">Requirements (comma separated)</label><input className="input" id="edit-job-requirements" name="requirements" defaultValue={editingJob.requirements.map((item) => item.name).join(", ")} required /></div><div className="field form-wide"><label htmlFor="edit-job-description">Description</label><textarea className="input form-textarea" id="edit-job-description" name="description" defaultValue={editingJob.description ?? ""} minLength={100} required /></div></div><RoundPlanEditor rounds={roundDrafts} onChange={changeRound} onAdd={() => setRoundDrafts((current) => [...current, roundDraft(Math.max(0, ...current.map((round) => round.sequence)) + 1)])} onRemove={(index) => void removeRound(index)} onRetire={(index) => void toggleRoundRetirement(index)} /><button className="button button-primary" disabled={pending}>{pending ? "Saving…" : "Save role and rounds"}</button></form>}
    <section className="card panel"><div className="panel-head"><h2>Current roles</h2><DataState connected={connected} loading={loading} error={error} /></div>{rowError && <p role="alert" className="form-error">{rowError}</p>}<div style={{ overflowX: "auto" }}><table className="table"><thead><tr><th>Role</th><th>Status</th><th>Requirements</th><th>Assessment plan</th><th>Details</th></tr></thead><tbody>{data.map((job) => <tr key={job.id}><td><div style={{ display: "flex", gap: 12, alignItems: "center" }}><div className="stat-icon"><BriefcaseBusiness size={17} /></div><div><strong>{job.title}</strong><div className="muted" style={{ fontSize: 12, marginTop: 3 }}><MapPin size={11} style={{ display: "inline" }} /> {job.location ?? "Location flexible"}</div></div></div></td><td><select aria-label={`Change ${job.title} status`} className="input" value={job.status} onChange={(event) => void updateJobStatus(job, event.target.value)}>{["DRAFT", "OPEN", "PAUSED", "CLOSED"].map((status) => <option key={status} value={status}>{status}</option>)}</select></td><td>{job.requirements.map((item) => item.name).join(", ")}</td><td>{job.rounds.length ? `${job.rounds.length} rounds` : "Plan required"}</td><td><button className="button button-light" onClick={() => editJob(job)}>Edit role</button></td></tr>)}</tbody></table></div></section></>;
}

export function LivePipeline() {
  const { data, setData, connected, loading, error, refresh } = useWorkspaceCollection<Candidate>("/candidates", demoCandidates);
  const [query, setQuery] = useState("");
  const [stages, setStages] = useState([{ id: "stage-new", name: "New signal" }, { id: "stage-review", name: "Human review" }, { id: "stage-interview", name: "Interview" }, { id: "stage-decision", name: "Decision" }]);
  const [stageError, setStageError] = useState<string | null>(null);
  const [addingStage, setAddingStage] = useState(false);
  const [newStageName, setNewStageName] = useState("");
  const [stagePending, setStagePending] = useState(false);
  const [editingStageId, setEditingStageId] = useState<string | null>(null);
  const [stageDraftName, setStageDraftName] = useState("");
  useEffect(() => {
    if (!organizationId()) return;
    void workspaceRequest<{ data: Array<{ id: string; name: string }> }>("/pipeline/stages")
      .then((result) => setStages(result.data))
      .catch(() => undefined);
  }, []);
  const filtered = data.filter((candidate) => `${candidate.name} ${candidate.email}`.toLowerCase().includes(query.toLowerCase()));
  async function move(candidate: Candidate, stageId: string) {
    setStageError(null);
    try {
      const stage = stages.find((item) => item.id === stageId);
      if (!stage) return;
      const assignment = candidate.candidateJobs[0];
      if (connected && assignment && !assignment.id.startsWith("demo-")) {
        await workspaceRequest(`/candidate-jobs/${encodeURIComponent(assignment.id)}/stage`, {
          method: "PATCH",
          body: JSON.stringify({ stageId })
        });
        await refresh();
        return;
      }
      setData((current) => current.map((item) => item.id !== candidate.id ? item : {
        ...item,
        candidateJobs: item.candidateJobs.map((candidateJob, index) => index ? candidateJob : { ...candidateJob, stage: { ...candidateJob.stage, id: stage.id, name: stage.name } })
      }));
    } catch (reason) {
      setStageError(reason instanceof Error ? reason.message : "The pipeline stage could not be changed.");
    }
  }

  async function addStage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newStageName.trim();
    if (name.length < 2) return;
    setStagePending(true);
    setStageError(null);
    try {
      if (connected) {
        const result = await workspaceRequest<{ id: string; name: string }>("/pipeline/stages", { method: "POST", body: JSON.stringify({ name }) });
        setStages((current) => [...current, result]);
      } else {
        setStages((current) => [...current, { id: `demo-${Date.now()}`, name }]);
      }
      setNewStageName("");
      setAddingStage(false);
    } catch (reason) {
      setStageError(reason instanceof Error ? reason.message : "The pipeline stage could not be added.");
    } finally {
      setStagePending(false);
    }
  }

  async function saveStage(stageId: string) {
    const name = stageDraftName.trim();
    if (name.length < 2) return;
    setStagePending(true);
    setStageError(null);
    try {
      if (connected) {
        const updated = await workspaceRequest<{ id: string; name: string }>(`/pipeline/stages/${encodeURIComponent(stageId)}`, { method: "PATCH", body: JSON.stringify({ name }) });
        setStages((current) => current.map((stage) => stage.id === stageId ? updated : stage));
        await refresh();
      } else setStages((current) => current.map((stage) => stage.id === stageId ? { ...stage, name } : stage));
      setEditingStageId(null);
    } catch (reason) {
      setStageError(reason instanceof Error ? reason.message : "The pipeline stage could not be updated.");
    } finally {
      setStagePending(false);
    }
  }

  async function deleteStage(stageId: string) {
    if (!window.confirm("Delete this stage? Stages with candidates cannot be deleted.")) return;
    setStagePending(true);
    setStageError(null);
    try {
      if (connected) await workspaceRequest(`/pipeline/stages/${encodeURIComponent(stageId)}`, { method: "DELETE" });
      setStages((current) => current.filter((stage) => stage.id !== stageId));
    } catch (reason) {
      setStageError(reason instanceof Error ? reason.message : "The pipeline stage could not be deleted.");
    } finally {
      setStagePending(false);
    }
  }

  async function reorderStage(index: number, direction: -1 | 1) {
    if (stagePending || index + direction < 0 || index + direction >= stages.length) return;
    const reordered = [...stages];
    [reordered[index], reordered[index + direction]] = [reordered[index + direction]!, reordered[index]!];
    setStagePending(true);
    setStageError(null);
    try {
      if (connected) {
        const result = await workspaceRequest<{ data: Array<{ id: string; name: string }> }>("/pipeline/stages/order", {
          method: "PATCH", body: JSON.stringify({ stageIds: reordered.map((stage) => stage.id), expectedStageIds: stages.map((stage) => stage.id) })
        });
        setStages(result.data);
      } else setStages(reordered);
    } catch (reason) {
      setStageError(reason instanceof Error ? reason.message : "Pipeline stages could not be reordered.");
      if (connected) {
        try {
          const latest = await workspaceRequest<{ data: Array<{ id: string; name: string }> }>("/pipeline/stages");
          setStages(latest.data);
        } catch { /* Keep the error visible; do not replace known stages with an empty list. */ }
      }
    } finally {
      setStagePending(false);
    }
  }

  return <><div className="page-title"><div><p className="eyebrow muted" style={{ margin: "0 0 8px" }}>Recruiting</p><h1>Pipeline</h1><span className="muted">Every candidate in motion, across every active role.</span></div><div style={{ display: "flex", gap: 10, alignItems: "center" }}><DataState connected={connected} loading={loading} error={error} /><button className="button button-primary" onClick={() => setAddingStage((value) => !value)}>Add stage</button></div></div>{addingStage && <form className="card panel workspace-form" onSubmit={addStage}><div className="form-grid"><div className="field"><label htmlFor="pipeline-stage-name">Stage name</label><input className="input" id="pipeline-stage-name" value={newStageName} onChange={(event) => setNewStageName(event.target.value)} minLength={2} maxLength={64} required /></div><div className="field" style={{ alignSelf: "end" }}><button className="button button-primary" disabled={stagePending}>{stagePending ? "Adding…" : "Add stage"}</button></div></div></form>}<div className="card" style={{ padding: 12, marginBottom: 14, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Search size={17} className="muted" /><input aria-label="Search candidates" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or email" className="table-search" /></div><button className="button button-light" style={{ minHeight: 36 }}><Filter size={15} /> Filters</button></div>{stageError && <p role="alert" className="form-error">{stageError}</p>}<section className="card panel"><div className="panel-head"><div><h2>Manage stages</h2><span className="muted" style={{ fontSize: 12 }}>Move stages earlier or later without moving candidates. Stages with candidates are protected from deletion.</span></div></div><div className="configuration-list">{stages.map((stage, index) => <div className="configuration-row" key={stage.id}><div className="configuration-row-main">{editingStageId === stage.id ? <input className="input" aria-label={`Rename ${stage.name}`} value={stageDraftName} onChange={(event) => setStageDraftName(event.target.value)} maxLength={64} /> : <strong>{stage.name}</strong>}</div><div className="configuration-row-actions"><button className="button button-light" aria-label={`Move ${stage.name} earlier`} disabled={stagePending || index === 0} onClick={() => void reorderStage(index, -1)}>Earlier</button><button className="button button-light" aria-label={`Move ${stage.name} later`} disabled={stagePending || index === stages.length - 1} onClick={() => void reorderStage(index, 1)}>Later</button>{editingStageId === stage.id ? <><button className="button button-primary" disabled={stagePending} onClick={() => void saveStage(stage.id)}>Save</button><button className="button button-light" onClick={() => setEditingStageId(null)}>Cancel</button></> : <><button className="button button-light" onClick={() => { setEditingStageId(stage.id); setStageDraftName(stage.name); }}>Rename</button><button className="button button-light" disabled={stages.length <= 1 || stagePending} onClick={() => void deleteStage(stage.id)}>Delete</button></>}</div></div>)}</div></section><section className="kanban">{stages.map((stage) => { const people = filtered.filter((candidate) => candidate.candidateJobs[0]?.stage.id === stage.id); return <div className="kanban-column" key={stage.id}><div className="kanban-head"><span>{stage.name}</span><span className="tag">{people.length}</span></div>{people.map((candidate) => { const placement = candidate.candidateJobs[0]; return <article className="candidate-card" key={candidate.id}><h3>{candidate.name}</h3><p>{candidate.headline ?? placement?.job.title ?? "Candidate"}</p><div className="candidate-meta"><span className="muted" style={{ fontSize: 11 }}>{placement?.job.title ?? "Talent pool"}</span><span className="score">{placement?.score ?? "—"}</span></div>{placement && <label className="candidate-stage"><span>Move to</span><select aria-label={`Move ${candidate.name} to stage`} className="input" value={placement.stage.id} onChange={(event) => void move(candidate, event.target.value)}>{stages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}</article>; })}</div>; })}</section></>;
}

export function LiveDashboardMetrics() {
  const [summary, setSummary] = useState({ jobs: 12, candidates: 248, assessments: 176, clients: 0 });
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!organizationId()) return;
    workspaceRequest<typeof summary>("/dashboard").then((result) => { setSummary(result); setConnected(true); }).catch(() => undefined);
  }, []);
  return <section className="stats-grid" aria-label="Workspace metrics">{[
    { label: "Active roles", value: summary.jobs, delta: connected ? "Live workspace" : "+2 this month", icon: BriefcaseBusiness },
    { label: "Candidates", value: summary.candidates, delta: connected ? "Live workspace" : "+31 this week", icon: UsersRound },
    { label: "Assessments", value: summary.assessments, delta: connected ? "All states" : "82% completion", icon: CheckCircle2 },
    { label: "Clients", value: summary.clients, delta: connected ? "Tenant scoped" : "Employer workspace", icon: UsersRound }
  ].map(({ label, value, delta, icon: Icon }) => <article className="card stat-card" key={label}><div className="stat-top"><div className="stat-icon"><Icon size={18} /></div><span className="delta">{delta}</span></div><div className="metric">{value}</div><div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{label}</div></article>)}</section>;
}
