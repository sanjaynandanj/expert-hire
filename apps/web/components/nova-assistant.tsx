"use client";

import Link from "next/link";
import { ArrowUp, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

type Job = { id: string; title: string; rounds: { id: string; title: string; sequence: number }[] };
type Assessment = { id: string; candidateId: string; candidate: { name: string }; round: { title: string; sequence: number }; evidenceCount?: number };
type Choices = { roles: Job[]; assessments: Assessment[]; nextCursor: string | null };
type Proposal = { id: string; status: string; fingerprint: string; totalCredits: number; expiresAt: string; actions: { candidateName: string; candidateEmail: string; roundTitle: string; jobTitle: string; expiresInHours: number }[]; result: { assessmentId: string; launchUrl: string | null }[] | null };
type Run = { id: string; status: string; message: string; errorCode: string | null; context: { jobId: string }; response: { message: string; summaries: { assessmentId: string; reportPath: string; observations: { text: string; evidenceIds: string[] }[] }[] } | null; proposals: Proposal[] };
type Turn = { who: "user" | "guide"; text: string } | { who: "model"; run: Run };
type Clarification = { message: string; invitation: boolean; jobs: Job[] };
type Invitation = { message: string; job: Job; choices: Choices };
const busyRun = (run: Run) => ["PENDING", "RUNNING", "RETRYABLE"].includes(run.status);
const normalize = (text: string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// Conservative title matching is navigation, not model output or authorization.
// Ambiguous matches always ask the human. Names never authorize invitation writes.
function matchJobs(message: string, jobs: Job[]) {
  const text = ` ${normalize(message)} `;
  const exact = jobs.filter((job) => text.includes(` ${normalize(job.title)} `));
  if (exact.length) return exact;
  const words = text.trim().split(/\s+/).filter((word) => word.length > 2);
  return jobs.filter((job) => normalize(job.title).split(" ").some((word) => words.includes(word) && !["role", "job", "the", "and", "for"].includes(word)));
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const org = localStorage.getItem("northstar.organizationId");
  if (!org) throw new Error("Sign in to use Nova.");
  const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/v1/nova${path}`, { ...init, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(20_000), headers: { "Content-Type": "application/json", "X-Organization-Id": org } });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? "I couldn’t complete that request. Please try again.");
  return value as T;
}

export function NovaAssistant() {
  const [ready, setReady] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [clarification, setClarification] = useState<Clarification | null>(null);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [nextRound, setNextRound] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [history, setHistory] = useState<{ id: string; status: string; message: string }[]>([]);
  const [now, setNow] = useState(Date.now());
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const historyMenu = useRef<HTMLDetailsElement>(null);
  const current = turns.findLast((turn) => turn.who === "model");
  const active = current?.who === "model" ? current.run : null;
  const busy = pending || Boolean(active && busyRun(active));
  function guide(text: string) { setTurns((previous) => [...previous, { who: "guide", text }]); }
  function replaceRun(run: Run) { setTurns((previous) => previous.map((turn) => turn.who === "model" && turn.run.id === run.id ? { who: "model", run } : turn)); }
  async function refreshHistory() { const value = await api<{ runs: typeof history }>("/runs"); setHistory(value.runs); }
  useEffect(() => {
    let alive = true;
    void Promise.all([api<{ configured: boolean; reason: string | null }>("/status"), api<Choices>("/options"), api<{ runs: typeof history }>("/runs")]).then(([status, options, saved]) => { if (alive) { setReady(status.configured); setReason(status.reason); setJobs(options.roles); setHistory(saved.runs); } }).catch((error: unknown) => { if (alive) setReason(error instanceof Error ? error.message : "Nova is unavailable."); });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [turns.length, active?.status, clarification, invitation]);
  useEffect(() => {
    if (!active || !busyRun(active)) return;
    let fetching = false, alive = true;
    const timer = setInterval(() => {
      if (fetching) return;
      fetching = true;
      void api<Run>(`/runs/${active.id}`).then((run) => { if (alive) { replaceRun(run); if (!busyRun(run)) void refreshHistory().catch(() => undefined); } }).catch((error: unknown) => { if (alive) setReason(error instanceof Error ? error.message : "Could not check the reply."); }).finally(() => { fetching = false; });
    }, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [active?.id, active?.status]);
  async function start(message: string, target: Job, assessmentIds: string[], roundId?: string) {
    const parent = active?.context.jobId === target.id && ["READY", "COMPLETED"].includes(active.status) ? active.id : null;
    const created = await api<{ id: string }>("/runs", { method: "POST", body: JSON.stringify({ message, selection: { jobId: target.id, selectedAssessmentIds: assessmentIds, ...(roundId ? { nextRoundId: roundId } : {}) }, ...(parent ? { parentRunId: parent } : {}) }) });
    const run = await api<Run>(`/runs/${created.id}`);
    setConfirmed(null);
    setTurns((previous) => [...previous.map((turn) => turn.who === "model" && turn.run.id === parent && turn.run.status === "READY" ? { ...turn, run: { ...turn.run, status: "SUPERSEDED", proposals: turn.run.proposals.map((proposal) => proposal.status === "PROPOSED" ? { ...proposal, status: "SUPERSEDED" } : proposal) } } : turn), { who: "model", run }]);
    await refreshHistory().catch(() => undefined);
  }
  async function handleJob(target: Job, request: string, invite: boolean) {
    setPending(true); setClarification(null); setJob(target);
    try {
      const choices = await api<Choices>(`/options?jobId=${encodeURIComponent(target.id)}`);
      if (invite) {
        if (!choices.assessments.length) { guide(`There are no completed assessments for ${target.title} yet. Complete an assessment first, then I can help with next-round invitations.`); return; }
        setSelected([]); setNextRound(""); setInvitation({ message: request, job: target, choices });
        guide(`Who would you like to invite for ${target.title}? Choose the people below. I won’t choose candidates or send anything on my own.`);
      } else {
        const reviewable = choices.assessments.filter((assessment) => assessment.evidenceCount !== 0).slice(0, 5);
        if (!reviewable.length) { guide(`I couldn’t find completed assessments with evidence for ${target.title} in this batch. I won’t invent a review.`); return; }
        guide(`I’m reviewing ${reviewable.length} completed assessment${reviewable.length === 1 ? "" : "s"} for ${target.title}, in record order—not ranked.${choices.assessments.length > reviewable.length || choices.nextCursor ? " This is a bounded batch of up to five; it isn’t every assessment for this job." : ""}`);
        await start(request, target, reviewable.map((item) => item.id));
      }
    } catch (error) { guide(error instanceof Error ? error.message : "I couldn’t start that review."); }
    finally { setPending(false); }
  }
  async function send(text: string) {
    const message = text.trim();
    if (!message || busy || !ready) return;
    setDraft(""); setClarification(null); setInvitation(null);
    setTurns((previous) => [...previous, { who: "user", text: message }]);
    if (/^(hi|hello|hey|help|what can you do)[!?.\s]*$/i.test(message)) { guide("Tell me which job you’d like to review—for example, ‘Review assessments for the platform engineer job.’ I can also prepare invitations for people you select. Hiring decisions stay with you."); return; }
    const invite = /\b(invite|invitations?|inviting)\b/i.test(message) && !/\b(don'?t|do not|without|no)\s+(?:send\s+|prepare\s+)?invit/i.test(message);
    const matches = matchJobs(message, jobs);
    const target = matches.length === 1 ? matches[0] : !matches.length && !/\b(for|job|role)\b/i.test(message) ? job : null;
    if (target) { await handleJob(target, message, invite); return; }
    const candidates = matches.length ? matches : jobs;
    if (!candidates.length) { guide("There are no jobs available in your workspace yet. Create a job first, then ask me to review its assessments."); return; }
    guide(matches.length ? "I found more than one matching job. Which one do you mean?" : "Which job would you like me to help with? Choose one below or type its title.");
    setClarification({ message, invitation: invite, jobs: candidates });
  }
  async function prepare() {
    if (!invitation || !selected.length || !nextRound || busy) return;
    setPending(true);
    try {
      await start(invitation.message, invitation.job, selected, nextRound);
      setInvitation(null);
    } catch (error) { guide(error instanceof Error ? error.message : "I couldn’t prepare those invitations."); }
    finally { setPending(false); }
  }
  async function approve(run: Run, proposal: Proposal) {
    setPending(true);
    try {
      await api(`/proposals/${proposal.id}/approve`, { method: "POST", body: JSON.stringify({ fingerprint: proposal.fingerprint, confirm: true }) });
      replaceRun(await api<Run>(`/runs/${run.id}`)); setConfirmed(null);
      await refreshHistory().catch(() => undefined);
    } catch (error) { guide(error instanceof Error ? error.message : "Approval failed. Reload this conversation to check any saved outcome."); }
    finally { setPending(false); }
  }
  async function openHistory(id: string) {
    if (historyMenu.current) historyMenu.current.open = false;
    setPending(true);
    try {
      const run = await api<Run>(`/runs/${id}`);
      setTurns([{ who: "user", text: run.message }, { who: "model", run }]);
      setJob(jobs.find((item) => item.id === run.context.jobId) ?? null);
      setInvitation(null); setClarification(null); setConfirmed(null);
    } catch (error) { guide(error instanceof Error ? error.message : "Could not open that conversation."); }
    finally { setPending(false); }
  }
  const highestSequence = invitation ? Math.max(0, ...invitation.choices.assessments.filter((item) => selected.includes(item.id)).map((item) => item.round.sequence)) : 0;
  return <div className="nova-conversation">
    <div className="nova-message-feed">
      <div className="nova-bubble nova-bubble-assistant"><span className="nova-speaker"><Sparkles size={14} /> Nova</span><p>What would you like to get done?</p><small>Ask me to review a job’s assessment evidence or help with next-round invitations. Just tell me in your own words.</small></div>
      {!turns.length && <div className="nova-suggestions"><button onClick={() => void send("Review completed assessments")}>Review completed assessments <span aria-hidden="true">↗</span></button><button onClick={() => void send("Prepare next-round invitations")}>Help me invite candidates <span aria-hidden="true">↗</span></button></div>}
      {reason && <div className="nova-bubble nova-bubble-assistant" role="alert">{!ready && <strong>Nova is unavailable</strong>}<p>{reason}</p></div>}
      {turns.map((turn, index) => turn.who !== "model" ? <div className={`nova-bubble nova-bubble-${turn.who === "user" ? "user" : "assistant"}`} key={index}><span className="nova-speaker">{turn.who === "user" ? "You" : "Nova · guidance"}</span><p>{turn.text}</p></div> : <div className="nova-model-turn" key={index}>
        {busyRun(turn.run) && <div className="nova-bubble nova-bubble-assistant" role="status">Reviewing evidence…</div>}
        {turn.run.response && <div className="nova-bubble nova-bubble-assistant"><span className="nova-speaker">Nova</span><p>{turn.run.response.message}</p>{turn.run.response.summaries.map((summary) => <div className="nova-evidence-card" key={summary.assessmentId}>{summary.observations.map((observation, i) => <p key={i}>{observation.text}</p>)}<Link href={summary.reportPath}>Review supporting report</Link></div>)}</div>}
        {turn.run.errorCode && <div className="nova-bubble nova-bubble-assistant" role="alert"><p>I couldn’t finish that request. No unapproved invitations were created. Please try again.</p><details><summary>Technical details</summary>{turn.run.errorCode}</details></div>}
        {turn.run.proposals.map((proposal) => <article className="nova-approval-card" key={proposal.id}><h3>{proposal.status === "EXECUTED" ? "Invitations created" : proposal.status === "PROPOSED" && turn.run.status === "READY" ? "Ready to create these invitations?" : proposal.status === "PROPOSED" && busyRun(turn.run) ? "Preparing invitation preview…" : `Invitation request · ${proposal.status.toLowerCase()}`}</h3>{proposal.actions.map((item, i) => <p key={i}><strong>{item.candidateName}</strong> → {item.roundTitle}<br /><small>{item.candidateEmail} · {item.jobTitle} · {item.expiresInHours} hour link</small></p>)}<p><strong>Total: {proposal.totalCredits} credits</strong><br /><small>Approval expires {new Date(proposal.expiresAt).toLocaleString()}</small></p>{proposal.status === "PROPOSED" && turn.run.status === "READY" && <><label className="nova-approval-check"><input type="checkbox" checked={confirmed === proposal.id} onChange={(event) => setConfirmed(event.target.checked ? proposal.id : null)} />I approve these exact invitations and the credit cost.</label><button className="button button-primary" disabled={busy || !ready || confirmed !== proposal.id || now >= new Date(proposal.expiresAt).getTime()} onClick={() => void approve(turn.run, proposal)}>Approve and create invitations</button></>}{proposal.result?.map((result) => <p key={result.assessmentId}>{result.launchUrl ? <a href={result.launchUrl} target="_blank" rel="noreferrer">Open secure candidate invitation</a> : "Invitation created"}</p>)}</article>)}
        {busyRun(turn.run) && <button className="nova-text-button" disabled={pending} onClick={() => { setPending(true); void api<Run>(`/runs/${turn.run.id}/cancel`, { method: "POST" }).then(replaceRun).catch((error: unknown) => guide(error instanceof Error ? error.message : "Could not stop the request.")).finally(() => setPending(false)); }}>Stop</button>}
      </div>)}
      {clarification && <div className="nova-choice-card"><div className="nova-suggestions">{clarification.jobs.map((item) => <button disabled={busy} key={item.id} onClick={() => void handleJob(item, clarification.message, clarification.invitation)}>{item.title}</button>)}</div></div>}
      {invitation && <div className="nova-choice-card"><h3>Who should receive an invitation?</h3><fieldset><legend>Choose up to 10 people</legend>{invitation.choices.assessments.map((item) => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} disabled={busy || item.evidenceCount === 0 || (!selected.includes(item.id) && (selected.length >= 10 || invitation.choices.assessments.some((other) => selected.includes(other.id) && other.candidateId === item.candidateId)))} onChange={() => { setNextRound(""); setSelected((previous) => previous.includes(item.id) ? previous.filter((id) => id !== item.id) : [...previous, item.id]); }} />{item.candidate.name} · {item.round.title}{item.evidenceCount === 0 ? " · no evidence yet" : ""}</label>)}</fieldset>
        {invitation.choices.nextCursor && <button className="nova-text-button" disabled={busy} onClick={() => { setPending(true); void api<Choices>(`/options?jobId=${encodeURIComponent(invitation.job.id)}&afterId=${encodeURIComponent(invitation.choices.nextCursor!)}`).then((more) => setInvitation((previous) => previous ? { ...previous, choices: { ...more, assessments: [...previous.choices.assessments, ...more.assessments] } } : null)).catch((error: unknown) => guide(error instanceof Error ? error.message : "Could not load more people.")).finally(() => setPending(false)); }}>Show more people</button>}
        {!!selected.length && <><h3>Which round should they attend?</h3><div className="nova-round-choices">{invitation.job.rounds.filter((round) => round.sequence > highestSequence).map((round) => <button key={round.id} disabled={busy} aria-pressed={nextRound === round.id} onClick={() => setNextRound(round.id)}>{round.title}</button>)}</div>{!invitation.job.rounds.some((round) => round.sequence > highestSequence) && <p>No later supported round exists. Add one to the job first.</p>}</>}
        <button className="button button-primary" disabled={busy || !selected.length || !nextRound} onClick={() => void prepare()}>Preview invitations</button><small>Nothing is sent until you review and approve the preview.</small>
      </div>}
      <div ref={end} />
    </div>
    <form className="nova-composer" onSubmit={(event: FormEvent) => { event.preventDefault(); void send(draft); }}>
      {job && <div className="nova-context-label">Talking about {job.title}<button className="nova-text-button" type="button" disabled={busy} onClick={() => { setJob(null); setClarification(null); setInvitation(null); guide("Tell me which job you’d like to work on next."); }}>Change</button></div>}
      <div className="nova-composer-input"><textarea ref={input} aria-label="Your request" placeholder="Ask Nova to help…" value={draft} onChange={(event) => setDraft(event.target.value)} rows={2} maxLength={4000} required onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !busy && ready && draft.trim()) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button type="submit" aria-label="Send message" disabled={busy || !ready || !draft.trim()}><ArrowUp size={20} /></button></div>
      <div className="nova-composer-footer"><small>{busy ? "Working on your request…" : "You stay in control. Invitations always need approval."}</small><details ref={historyMenu}><summary>History</summary><div className="nova-history-menu">{history.map((item) => <button className="nova-history-item" disabled={busy} key={item.id} onClick={() => void openHistory(item.id)}>{item.status} · {item.message.slice(0, 80)}</button>)}{!history.length && <small>No saved conversations yet.</small>}</div></details></div>
    </form>
  </div>;
}
