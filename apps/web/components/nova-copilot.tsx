"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, SlidersHorizontal, Sparkles } from "lucide-react";

type Role = { id: string; title: string; rounds: Array<{ id: string; title: string; sequence: number }> };
type Assessment = { id: string; candidateId: string; candidate: { name: string }; round: { title: string; sequence: number } };
type Options = { roles: Role[]; assessments: Assessment[]; nextCursor: string | null };
type Availability = { configured: boolean; reason: string | null; model: string | null };
type Result = { candidateId: string; assessmentId: string; launchUrl: string | null };
type Proposal = { id: string; status: string; fingerprint: string; totalCredits: number; expiresAt: string; actions: Array<{ candidateName: string; candidateEmail: string; roundTitle: string; jobTitle: string; credits: number; expiresInHours: number }>; result: Result[] | null };
type Run = { id: string; status: string; message: string; context?: { jobId: string; selectedAssessmentIds: string[]; nextRoundId?: string }; conversation?: Array<{ message: string; response: { message: string } }>; errorCode: string | null; attempts: number; modelSteps: number; response: { message: string; summaries: Array<{ assessmentId: string; reportPath: string; observations: Array<{ text: string; evidenceIds: string[] }> }> } | null; proposals: Proposal[]; calls: Array<{ id: string; name: string; status: string }> };
type History = { id: string; status: string; message: string };
const apiRoot = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
async function api<T>(path: string, init?: RequestInit) {
  const org = window.localStorage.getItem("northstar.organizationId");
  if (!org) throw new Error("Sign in to use Nova.");
  const response = await fetch(`${apiRoot}/v1/nova${path}`, { ...init, credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json", "X-Organization-Id": org, ...init?.headers }, signal: AbortSignal.timeout(20_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "Nova request failed.");
  return result as T;
}

export function NovaCopilot({ compact = false }: { compact?: boolean }) {
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [options, setOptions] = useState<Options>({ roles: [], assessments: [], nextCursor: null });
  const [jobId, setJobId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [roundId, setRoundId] = useState("");
  const [message, setMessage] = useState(compact ? "" : "Review the completed assessments for this role against their rubrics. Prepare next-round invitations only for the candidates I selected.");
  const [selectionOpen, setSelectionOpen] = useState(false);
  const feedEnd = useRef<HTMLDivElement>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [followUpId, setFollowUpId] = useState<string | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (compact) feedEnd.current?.scrollIntoView({ block: "nearest" }); }, [compact, run?.id, run?.status]);
  async function loadHistory() { const result = await api<{ runs: History[] }>("/runs"); setHistory(result.runs); }
  useEffect(() => {
    void Promise.all([api<Availability>("/status"), api<Options>("/options"), api<{ runs: History[] }>("/runs")]).then(([status, choices, previous]) => { setAvailability(status); setOptions(choices); setHistory(previous.runs); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Nova could not be loaded."));
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!jobId) return;
    let active = true;
    void api<Options>(`/options?jobId=${encodeURIComponent(jobId)}`).then((choices) => { if (active) setOptions(choices); }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Could not load assessments."); });
    return () => { active = false; };
  }, [jobId]);
  useEffect(() => {
    if (!run || !["PENDING", "RUNNING", "RETRYABLE"].includes(run.status)) return;
    let fetching = false;
    const timer = setInterval(() => {
      if (fetching) return;
      fetching = true;
      void api<Run>(`/runs/${run.id}`).then((next) => setRun(next)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Run status could not be read.")).finally(() => { fetching = false; });
    }, 1500);
    return () => clearInterval(timer);
  }, [run?.id, run?.status]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (compact && !jobId) { setSelectionOpen(true); return; }
    setPending(true); setError(null); setConfirmed(null);
    try {
      const parent = followUpId ?? (compact && run?.context?.jobId === jobId && ["READY", "COMPLETED"].includes(run.status) ? run.id : null);
      const next = await api<{ id: string }>("/runs", { method: "POST", body: JSON.stringify({ message, selection: { jobId, selectedAssessmentIds: selected, ...(roundId ? { nextRoundId: roundId } : {}) }, ...(parent ? { parentRunId: parent } : {}) }) });
      setFollowUpId(null);
      setRun(await api<Run>(`/runs/${next.id}`));
      if (compact) { setMessage(""); setSelectionOpen(false); }
      await loadHistory();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Nova could not start."); }
    finally { setPending(false); }
  }
  async function action(operation: () => Promise<unknown>, refreshRun = true) {
    setPending(true); setError(null);
    try { await operation(); if (run && refreshRun) setRun(await api<Run>(`/runs/${run.id}`)); setConfirmed(null); await loadHistory(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The action failed. Reload this run to recover any committed result."); }
    finally { setPending(false); }
  }
  const chosenRole = options.roles.find((role) => role.id === jobId);
  const selectedSequence = Math.max(0, ...options.assessments.filter((assessment) => selected.includes(assessment.id)).map((assessment) => assessment.round.sequence));
  const processing = run && ["PENDING", "RUNNING", "RETRYABLE"].includes(run.status);
  if (compact) return <div className="nova-conversation">
    <div className="nova-message-feed">
      <div className="nova-bubble nova-bubble-assistant"><span className="nova-speaker"><Sparkles size={14} /> Nova</span><p>Hi! I can help you review assessment evidence and prepare next-round invitations. What would you like to work on?</p><small>You choose the candidates. I’ll always ask before creating invitations.</small></div>
      {!run && <div className="nova-suggestions">{["Review assessment evidence", "Prepare next-round invitations"].map((prompt, index) => <button key={prompt} type="button" onClick={() => { setMessage(index ? "Review the selected assessments and prepare next-round invitations only for the candidates I selected." : "Review completed assessment evidence against the role rubric. Do not rank candidates or prepare invitations."); setSelectionOpen(true); }}>{prompt}<span aria-hidden="true">↗</span></button>)}</div>}
      {availability && !availability.configured && <div className="nova-bubble nova-bubble-assistant" role="status"><strong>Nova is unavailable</strong><p>{availability.reason}</p></div>}
      {run?.conversation?.map((turn, index) => <div key={index} className="nova-prior-turn"><div className="nova-bubble nova-bubble-user"><span className="nova-speaker">You · earlier discussion</span><p>{turn.message}</p></div><div className="nova-bubble nova-bubble-assistant"><span className="nova-speaker">Nova · historical context</span><p>{turn.response.message}</p></div></div>)}
      {run && <><div className="nova-bubble nova-bubble-user"><span className="nova-speaker">You</span><p>{run.message}</p></div>
        {processing && <div className="nova-bubble nova-bubble-assistant" role="status"><span className="nova-speaker">Nova</span><p className="nova-working">Reviewing authorized evidence<span>…</span></p></div>}
        {run.response && <div className="nova-bubble nova-bubble-assistant"><span className="nova-speaker">Nova</span><p>{run.response.message}</p>{run.response.summaries.map((summary) => <div className="nova-evidence-card" key={summary.assessmentId}>{summary.observations.map((item, index) => <div key={index}><p>{item.text}</p><small>Evidence: {item.evidenceIds.join(", ")}</small></div>)}<Link href={summary.reportPath}>Review supporting report</Link></div>)}</div>}
        {run.errorCode && <div className="nova-bubble nova-bubble-assistant" role="alert">Nova stopped: {run.errorCode}. No unapproved invitations were executed.</div>}
        {run.proposals.map((proposal) => <article className="nova-approval-card" key={proposal.id}><span className="nova-speaker">{proposal.status === "EXECUTED" ? "Invitations created" : "Your approval is required"}</span><h3>Invitation proposal · {proposal.status}</h3>{proposal.actions.map((item, index) => <p key={index}><strong>{item.candidateName}</strong> → {item.roundTitle}<br /><small>{item.candidateEmail} · {item.jobTitle} · {item.expiresInHours} hour link</small></p>)}<p><strong>Total: {proposal.totalCredits} credits</strong><br /><small>Approval expires {new Date(proposal.expiresAt).toLocaleString()}</small></p>{proposal.status === "PROPOSED" && run.status === "READY" && <><label className="nova-approval-check"><input type="checkbox" checked={confirmed === proposal.id} onChange={(event) => setConfirmed(event.target.checked ? proposal.id : null)} />I approve these exact invitations and the credit cost.</label><button className="button button-primary" disabled={pending || !availability?.configured || confirmed !== proposal.id || now >= new Date(proposal.expiresAt).getTime()} onClick={() => void action(() => api(`/proposals/${proposal.id}/approve`, { method: "POST", body: JSON.stringify({ fingerprint: proposal.fingerprint, confirm: true }) }))}>Approve and create invitations</button></>}{proposal.result?.map((result) => <p key={result.assessmentId}>{result.launchUrl ? <a href={result.launchUrl} target="_blank" rel="noreferrer">Open secure candidate invitation</a> : "Invitation created"}</p>)}</article>)}
        <details className="nova-chat-details"><summary>Run trace · {run.calls.length} tool calls · {run.modelSteps} model steps</summary>{run.calls.map((call) => <p key={call.id}>{call.name} · {call.status}</p>)}</details>
        {!["COMPLETED", "CANCELLED"].includes(run.status) && <button className="nova-text-button" disabled={pending} onClick={() => void action(() => api(`/runs/${run.id}/cancel`, { method: "POST" }))}>Cancel run and pending proposal</button>}
      </>}
      <details className="nova-chat-details"><summary>Saved conversations ({history.length})</summary><button className="nova-text-button" disabled={pending} onClick={() => void action(loadHistory)}>Refresh saved conversations</button>{history.map((item) => <button className="nova-history-item" key={item.id} disabled={pending || Boolean(processing)} onClick={() => void action(async () => { const saved = await api<Run>(`/runs/${item.id}`); setRun(saved); setJobId(saved.context?.jobId ?? ""); setSelected(saved.context?.selectedAssessmentIds ?? []); setRoundId(saved.context?.nextRoundId ?? ""); setFollowUpId(null); }, false)}>{item.status} · {item.message.slice(0, 100)}</button>)}</details>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div ref={feedEnd} />
    </div>
    <form className="nova-composer" onSubmit={submit}>
      <details className="nova-selection-card" open={selectionOpen} onToggle={(event) => setSelectionOpen(event.currentTarget.open)}><summary><SlidersHorizontal size={14} />{chosenRole ? `${chosenRole.title} · ${selected.length} selected` : "Choose role & candidates"}</summary><div className="nova-selection-fields">
        <label className="field"><span>Role</span><select className="input" value={jobId} onChange={(event) => { setJobId(event.target.value); setFollowUpId(null); setSelected([]); setRoundId(""); setOptions((current) => ({ ...current, assessments: [], nextCursor: null })); }}><option value="">Choose a role</option>{options.roles.map((role) => <option key={role.id} value={role.id}>{role.title}</option>)}</select></label>
        {jobId && <fieldset><legend>Candidates you select (maximum 10)</legend>{options.assessments.map((assessment) => <label key={assessment.id}><input type="checkbox" checked={selected.includes(assessment.id)} disabled={!selected.includes(assessment.id) && selected.length >= 10} onChange={() => { setRoundId(""); setSelected((current) => current.includes(assessment.id) ? current.filter((id) => id !== assessment.id) : [...current, assessment.id]); }} />{assessment.candidate.name} · {assessment.round.title}</label>)}{!options.assessments.length && <small>No completed assessments loaded.</small>}{options.nextCursor && <button className="nova-text-button" type="button" onClick={() => void action(async () => { const next = await api<Options>(`/options?jobId=${encodeURIComponent(jobId)}&afterId=${encodeURIComponent(options.nextCursor!)}`); setOptions((current) => ({ ...next, assessments: [...current.assessments, ...next.assessments] })); }, false)}>Load more assessments</button>}</fieldset>}
        <label className="field"><span>Next round (optional for evidence-only review)</span><select className="input" value={roundId} onChange={(event) => setRoundId(event.target.value)}><option value="">No invitation proposal</option>{chosenRole?.rounds.filter((round) => round.sequence > selectedSequence).map((round) => <option key={round.id} value={round.id}>{round.title}</option>)}</select></label>
        <button className="nova-text-button" type="button" onClick={() => setSelectionOpen(false)}>Done selecting</button>
      </div></details>
      <div className="nova-composer-input"><textarea aria-label="Your request" placeholder="Message Nova…" value={message} onChange={(event) => setMessage(event.target.value)} rows={2} maxLength={4000} required /><button type="submit" aria-label="Send message" title="Send message" disabled={pending || Boolean(processing) || !availability?.configured || !message.trim()}><ArrowUp size={20} /></button></div>
      <small>{processing ? "Working on your request…" : run && ["READY", "COMPLETED"].includes(run.status) && run.context?.jobId === jobId ? "Reply to continue this conversation. Evidence will be read again." : "Evidence-led assistance. Review sources before approving."}</small>
    </form>
  </div>;
  return <>
    {!compact && <div className="page-title"><div><p className="eyebrow muted">Recruiter copilot</p><h1>Ask Nova</h1><p className="muted">Review evidence. You choose the candidates. Every invitation needs your approval.</p></div></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {availability && !availability.configured && <div className="notice" role="status"><div><strong>Nova is unavailable</strong><p>{availability.reason}</p><span className="muted">No real AI calls or invitation execution are started from this form without a configured model.</span></div></div>}
    <form className="card panel workspace-form" onSubmit={submit}>
      <div className="panel-head"><h2>Review a role</h2><span className="tag">{availability?.model ?? "Model not configured"}</span></div>
      {run?.context && ["READY", "COMPLETED"].includes(run.status) && <button className="button button-light" type="button" disabled={pending} onClick={() => { setFollowUpId(run.id); setJobId(run.context!.jobId); setSelected(run.context!.selectedAssessmentIds); setRoundId(run.context!.nextRoundId ?? ""); setMessage(""); setConfirmed(null); }}>Use this review for follow-up</button>}
      {followUpId && <p role="status">Following up on the selected review. Earlier discussion is context only; reports are read again and any old pending proposal is closed when you submit. <button className="button button-light" type="button" onClick={() => setFollowUpId(null)}>Start a new conversation instead</button></p>}
      <label className="field"><span>Role</span><select className="input" value={jobId} onChange={(event) => { setJobId(event.target.value); setFollowUpId(null); setSelected([]); setRoundId(""); setOptions((current) => ({ ...current, assessments: [], nextCursor: null })); }} required><option value="">Choose a role</option>{options.roles.map((role) => <option key={role.id} value={role.id}>{role.title}</option>)}</select></label>
      {jobId && <fieldset style={{ border: "1px solid var(--line)", padding: 16, marginBlock: 16 }}><legend>Explicit candidate selection for invitations (maximum 10)</legend><p className="muted">Nova cannot select or rank candidates for you. Choose one completed assessment per candidate.</p>{options.assessments.map((assessment) => <label key={assessment.id} style={{ display: "flex", gap: 10, paddingBlock: 8 }}><input type="checkbox" checked={selected.includes(assessment.id)} disabled={!selected.includes(assessment.id) && selected.length >= 10} onChange={() => setSelected((current) => current.includes(assessment.id) ? current.filter((id) => id !== assessment.id) : [...current, assessment.id])} /><span>{assessment.candidate.name} · {assessment.round.title}</span></label>)}{!options.assessments.length && <p className="muted">No completed assessments loaded for this role.</p>}{options.nextCursor && <button className="button button-light" type="button" onClick={() => void action(async () => { const next = await api<Options>(`/options?jobId=${encodeURIComponent(jobId)}&afterId=${encodeURIComponent(options.nextCursor!)}`); setOptions((current) => ({ ...next, assessments: [...current.assessments, ...next.assessments] })); })}>Load more assessments</button>}</fieldset>}
      <label className="field"><span>Next round (optional for evidence-only review)</span><select className="input" value={roundId} onChange={(event) => setRoundId(event.target.value)}><option value="">No invitation proposal</option>{chosenRole?.rounds.filter((round) => round.sequence > selectedSequence).map((round) => <option key={round.id} value={round.id}>{round.title}</option>)}</select></label>
      <label className="field"><span>Your request</span><textarea className="input" value={message} onChange={(event) => setMessage(event.target.value)} rows={4} maxLength={4000} required /></label>
      <button className="button button-primary" disabled={pending || Boolean(processing) || !availability?.configured || !jobId}>{pending ? "Starting…" : compact ? "Send message" : "Ask Nova"}</button>
    </form>
    {Boolean(run?.conversation?.length) && <section className="card panel" style={{ marginTop: 24 }}><h2>Earlier discussion</h2><p className="muted">Historical context, not a current approval or evidence check.</p>{run!.conversation!.map((turn, index) => <article key={index} className="evidence-row"><p><strong>You</strong></p><p style={{ whiteSpace: "pre-wrap" }}>{turn.message}</p><p><strong>Nova</strong></p><p style={{ whiteSpace: "pre-wrap" }}>{turn.response.message}</p></article>)}</section>}
    {run && <section className="card panel" style={{ marginTop: 24 }} aria-live="polite"><div className="panel-head"><h2>Conversation</h2><span className="tag">{run.status}</span></div><p><strong>You</strong></p><p style={{ whiteSpace: "pre-wrap" }}>{run.message}</p>{run.response && <><p><strong>Nova</strong></p><p style={{ whiteSpace: "pre-wrap" }}>{run.response.message}</p>{run.response.summaries.map((summary) => <article className="evidence-row" key={summary.assessmentId}><Link href={summary.reportPath}>Review supporting report</Link>{summary.observations.map((observation, index) => <div key={index}><p>{observation.text}</p><small className="muted">Evidence: {observation.evidenceIds.join(", ")}</small></div>)}</article>)}</>}{run.errorCode && <p role="alert" className="form-error">Nova stopped: {run.errorCode}. No unapproved invitations were executed. You can start a new request after correcting the issue.</p>}<details><summary>Run trace · {run.calls.length} tool calls · {run.modelSteps} model steps</summary>{run.calls.map((call) => <p key={call.id}>{call.name} · {call.status}</p>)}</details>{!["COMPLETED", "CANCELLED"].includes(run.status) && <button className="button button-light" disabled={pending} onClick={() => void action(() => api(`/runs/${run.id}/cancel`, { method: "POST" }))}>Cancel run and pending proposal</button>}
      {run.proposals.map((proposal) => <article className="notice" key={proposal.id} style={{ marginTop: 16 }}><div style={{ width: "100%" }}><h3>Invitation proposal · {proposal.status}</h3>{proposal.actions.map((item, index) => <p key={index}>{item.candidateName} ({item.candidateEmail}) → {item.jobTitle} / {item.roundTitle} · {item.credits} credits · link valid {item.expiresInHours} hours</p>)}<p><strong>Total: {proposal.totalCredits} credits</strong> · approval expires {new Date(proposal.expiresAt).toLocaleString()}</p>{proposal.status === "PROPOSED" && run.status === "READY" && <><label style={{ display: "flex", gap: 10 }}><input type="checkbox" checked={confirmed === proposal.id} onChange={(event) => setConfirmed(event.target.checked ? proposal.id : null)} />I approve these exact invitations and the credit cost.</label><button className="button button-primary" style={{ marginTop: 12 }} disabled={pending || !availability?.configured || confirmed !== proposal.id || now >= new Date(proposal.expiresAt).getTime()} onClick={() => void action(() => api(`/proposals/${proposal.id}/approve`, { method: "POST", body: JSON.stringify({ fingerprint: proposal.fingerprint, confirm: true }) }))}>Approve and create invitations</button></>}{proposal.result?.map((result) => <p key={result.assessmentId}>{result.launchUrl ? <a href={result.launchUrl} target="_blank" rel="noreferrer">Open secure candidate invitation</a> : "Invitation created"}</p>)}</div></article>)}
    </section>}
    <section className="card panel" style={{ marginTop: 24 }}><div className="panel-head"><h2>Your saved runs</h2><button className="button button-light" onClick={() => void action(loadHistory)} disabled={pending}>Refresh</button></div>{history.map((item) => <button key={item.id} className="button button-light" style={{ display: "block", marginBottom: 8, maxWidth: "100%", textAlign: "left", whiteSpace: "normal" }} onClick={() => void action(async () => { setRun(await api<Run>(`/runs/${item.id}`)); }, false)}>{item.status} · {item.message.slice(0, 120)}</button>)}{!history.length && <p className="muted">Your requests, tool traces and approved outcomes will be saved here.</p>}</section>
  </>;
}
