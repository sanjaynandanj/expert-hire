"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

type Candidate = { id: string; name: string; email: string };
type Job = { id: string; title: string; rounds: Array<{ id: string; title: string; type: string }> };
type Assessment = {
  id: string;
  status: string;
  score: number | null;
  createdAt: string;
  completedAt: string | null;
  candidate: Candidate;
  round: { id: string; title: string; type: string; job: { id: string; title: string } };
};
type Result = { object: string; data: Assessment[] };

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const org = window.localStorage.getItem("northstar.organizationId");
  if (!org) throw new Error("Sign in to create assessment invitations.");
  const response = await fetch(`${apiUrl}/v1${path}`, { ...init, credentials: "include", headers: { "Content-Type": "application/json", "X-Organization-Id": org, ...init?.headers } });
  const body = await response.json().catch(() => null) as T | { error?: { message?: string } } | null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? body.error?.message : null;
    throw new Error(message ?? "Workspace request failed.");
  }
  return body as T;
}

export function LiveAssessments() {
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [candidateId, setCandidateId] = useState("");
  const [roundId, setRoundId] = useState("");
  const [launchUrl, setLaunchUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [assessmentList, candidateList, jobList] = await Promise.all([
        api<Result>("/assessments"),
        api<{ data: Candidate[] }>("/candidates"),
        api<{ data: Job[] }>("/jobs")
      ]);
      setAssessments(assessmentList.data);
      setCandidates(candidateList.data);
      setJobs(jobList.data);
      setCandidateId((current) => current || candidateList.data[0]?.id || "");
      setRoundId((current) => current || jobList.data[0]?.rounds[0]?.id || "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Assessment data could not be loaded.");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!assessments.some((assessment) => assessment.status === "PROCESSING")) return;
    const timer = window.setInterval(() => {
      void api<Result>("/assessments").then((result) => setAssessments(result.data)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Assessment processing status could not be refreshed."));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [assessments]);

  async function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setLaunchUrl(null);
    try {
      const result = await api<{ launchUrl: string }>("/assessments", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ candidateId, roundId, expiresInHours: 72 })
      });
      setLaunchUrl(result.launchUrl);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Invitation could not be created.");
    } finally {
      setBusy(false);
    }
  }

  const rounds = jobs.flatMap((job) => job.rounds.map((round) => ({ ...round, jobTitle: job.title })));

  return <><div className="page-title"><div><p className="eyebrow muted" style={{ margin: "0 0 8px" }}>Recruiting</p><h1>Assessments</h1><span className="muted">Issue secure one-time links, then review saved evidence.</span></div></div>
    <form className="card panel workspace-form" onSubmit={createInvitation}><div className="panel-head"><div><h2>Invite a candidate</h2><span className="muted" style={{ fontSize: 12 }}>Credits are reserved atomically, and the link expires after 72 hours.</span></div></div><div className="form-grid"><label className="field"><span>Candidate</span><select className="input" value={candidateId} onChange={(event) => setCandidateId(event.target.value)} required>{candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.email}</option>)}</select></label><label className="field"><span>Assessment round</span><select className="input" value={roundId} onChange={(event) => setRoundId(event.target.value)} required>{rounds.map((round) => <option key={round.id} value={round.id}>{round.jobTitle} · {round.title}</option>)}</select></label></div>{error && <p role="alert" className="form-error">{error}</p>}{launchUrl && <div className="notice"><span><strong>Secure invitation created</strong><br/><a href={launchUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "underline", overflowWrap: "anywhere" }}>{launchUrl}</a></span></div>}<button className="button button-primary" disabled={busy || !candidateId || !roundId}>{busy ? "Creating invitation…" : "Create invitation"}</button></form>
    <section className="card panel"><div className="panel-head"><div><h2>Assessment history</h2><span className="muted" style={{ fontSize: 12 }}>Scores stay advisory and remain connected to evidence.</span></div><span className="tag">{assessments.length} records</span></div><div style={{ overflowX: "auto" }}><table className="table"><thead><tr><th>Candidate</th><th>Role and round</th><th>Status</th><th>Evidence score</th><th>Report</th></tr></thead><tbody>{assessments.map((assessment) => <tr key={assessment.id}><td><strong>{assessment.candidate.name}</strong><div className="muted" style={{ fontSize: 11 }}>{assessment.candidate.email}</div></td><td>{assessment.round.job.title}<div className="muted" style={{ fontSize: 11 }}>{assessment.round.title} · {assessment.round.type.replaceAll("_", " ").toLowerCase()}</div></td><td><span className="tag">{assessment.status}</span></td><td>{assessment.score ?? "Awaiting evaluation"}</td><td>{assessment.status === "COMPLETED" ? <Link className="button button-light" style={{ minHeight: 34, paddingInline: 12, fontSize: 12 }} href={`/workspace/reports/${assessment.id}`}>Review report</Link> : "—"}</td></tr>)}</tbody></table></div>{!assessments.length && <p className="muted">No assessment records yet.</p>}</section>
  </>;
}

export function LiveAssessmentReport({ assessmentId }: { assessmentId: string }) {
  const [assessment, setAssessment] = useState<(Assessment & {
    summary: string | null;
    submission: unknown;
    evidence: Array<{ id: string; criterion: string; score: number; weight: number; rationale: string; evidence: string }>;
    integrityEvents: Array<{ id: string; type: string; detail: Record<string, unknown>; occurredAt: string }>;
  }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<{ assessment: NonNullable<typeof assessment>; advisoryOnly: true }>(`/assessments/${encodeURIComponent(assessmentId)}`)
      .then((result) => setAssessment(result.assessment))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Report could not be loaded."));
  }, [assessmentId]);

  if (error) return <section className="card panel"><h1>Report unavailable</h1><p className="form-error" role="alert">{error}</p><Link href="/workspace/assessments">Back to assessments</Link></section>;
  if (!assessment) return <section className="card panel"><h1>Loading report…</h1></section>;

  const answers = assessment.submission && typeof assessment.submission === "object" ? assessment.submission as Record<string, unknown> : {};
  return <><div className="page-title"><div><p className="eyebrow muted" style={{ margin: "0 0 8px" }}>{assessment.round.type.replaceAll("_", " ")} · {assessment.round.title}</p><h1>{assessment.candidate.name}</h1><span className="muted">{assessment.round.job.title} · {assessment.candidate.email}</span></div><div className="report-score"><strong>{assessment.score ?? "—"}</strong><span>Evidence score</span></div></div><div className="notice"><span><strong>{assessment.summary ?? "Evaluation is not complete."}</strong><br/><small>This score is advisory. A qualified reviewer makes the hiring decision.</small></span></div><section className="card panel"><div className="panel-head"><div><h2>Criterion evidence</h2><span className="muted" style={{ fontSize: 12 }}>Scores and rationale remain tied to the submitted answer.</span></div></div>{assessment.evidence.map((item) => <article className="evidence-row" key={item.id}><div className="evidence-heading"><strong>{item.criterion}</strong><span>{item.score} · weight {item.weight}</span></div><div className="mini-bar"><span style={{ width: `${item.score}%`, background: "var(--pine)" }} /></div><p>{item.rationale}</p><blockquote>{item.evidence}</blockquote></article>)}</section><section className="dashboard-grid"><article className="card panel"><div className="panel-head"><h2>Submitted answers</h2></div>{Object.entries(answers).map(([key, value]) => <div className="transcript-line" key={key}><strong>{key}</strong><p>{String(value)}</p></div>)}</article><article className="card panel"><div className="panel-head"><h2>Integrity context</h2><span className="tag">{assessment.integrityEvents.length} events</span></div>{assessment.integrityEvents.length ? assessment.integrityEvents.map((event) => <div className="activity" key={event.id}><div className="activity-dot"><AlertTriangleIcon /></div><p><strong>{event.type.replaceAll("_", " ")}</strong><br/><span className="muted">{new Date(event.occurredAt).toLocaleString()} · context for human review only</span></p></div>) : <p className="muted">No integrity context was recorded for this session.</p>}</article></section><Link className="button button-light" style={{ marginTop: 14 }} href="/workspace/assessments">Back to assessments</Link></>;
}

function AlertTriangleIcon() { return <span aria-hidden="true">!</span>; }
