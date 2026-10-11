"use client";

import { AlertCircle, Check, ChevronRight, Clock3, Eye, Laptop, LoaderCircle, Mic, Save, ShieldCheck, Video } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type Stage = "LOADING" | "CHECK" | "CONSENT" | "INSTRUCTIONS" | "ACTIVE" | "COMPLETE" | "ERROR";

type AssessmentDetails = {
  id: string;
  type: string;
  status: string;
  candidateName: string;
  roundTitle: string;
  jobTitle: string;
  durationMinutes: number;
  proctoringEnabled: boolean;
  questions?: Array<{ id: string; label: string }>;
  startedAt?: string | null;
  draft?: { answers: Record<string, string>; questionIndex: number } | null;
  draftRevision?: number;
  draftSavedAt?: string | null;
};

type Evidence = { id: string; criterion: string; score: number; rationale: string; evidence: string };
type Completion = { id: string; status?: string; score: number | null; summary: string | null; evidence?: Evidence[] };

const defaultQuestions = [
  { id: "q1", label: "Architecture", prompt: "Tell us about a distributed service you made more reliable. What failed, and what did you change?", hint: "Use a concrete example. Explain your own decisions." },
  { id: "q2", label: "Trade-offs", prompt: "A queue is building faster than workers can process it. Walk through how you would diagnose and stabilize the system.", hint: "Think aloud. We care about the sequence, not a memorized answer." },
  { id: "q3", label: "Collaboration", prompt: "Describe a technical decision you changed after another person challenged it.", hint: "What evidence changed your mind?" }
];

const demoAssessment: AssessmentDetails = {
  id: "demo_assessment_1",
  type: "AI_INTERVIEW",
  status: "PENDING",
  candidateName: "Maya Chen",
  roundTitle: "Adaptive technical",
  jobTitle: "Senior Platform Engineer",
  durationMinutes: 20,
  proctoringEnabled: false
};

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function candidateRequest<T>(token: string, path = "", init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}/candidate/assessments/${encodeURIComponent(token)}${path}`, {
    ...init,
    cache: "no-store",
    signal: init?.signal ?? AbortSignal.timeout(10_000),
    headers: { ...init?.headers, ...(init?.body ? { "Content-Type": "application/json" } : {}) }
  });
  const body = await response.json().catch(() => null) as T | { error?: { message?: string } } | null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? body.error?.message : null;
    throw new Error(message ?? "The assessment service is unavailable. Please try again.");
  }
  return body as T;
}

export function AssessmentRoom({ token }: { token: string }) {
  const storageKey = `northstar.assessment.${token}`;
  const isDemo = token.startsWith("demo-");
  const [stage, setStage] = useState<Stage>(isDemo ? "CHECK" : "LOADING");
  const [assessment, setAssessment] = useState<AssessmentDetails>(demoAssessment);
  const [checked, setChecked] = useState(false);
  const [consented, setConsented] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [focusChanges, setFocusChanges] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(demoAssessment.durationMinutes * 60);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const revision = useRef(0);
  const savedSnapshot = useRef("");
  const saveBlocked = useRef(false);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const latestSnapshot = useRef("");
  latestSnapshot.current = JSON.stringify({ answers, questionIndex });
  const questions = useMemo(() => assessment.questions?.length ? assessment.questions.map((item, index) => ({ id: item.id, label: `Question ${index + 1}`, prompt: item.label, hint: "Answer in your own words and explain your reasoning." })) : defaultQuestions, [assessment.questions]);

  function persistDraft(snapshot: string) {
    const task = saveQueue.current.catch(() => undefined).then(async () => {
      if (saveBlocked.current) throw new Error("Reload the saved draft before continuing.");
      if (savedSnapshot.current === snapshot) return;
      try {
        const result = await candidateRequest<{ revision: number; savedAt: string }>(token, "/draft", { method: "PATCH", body: JSON.stringify({ ...JSON.parse(snapshot), revision: revision.current }) });
        revision.current = result.revision;
        savedSnapshot.current = snapshot;
        if (latestSnapshot.current === snapshot) setSavedAt(new Date(result.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      } catch (reason) {
        saveBlocked.current = true;
        setSaveError(reason instanceof Error ? reason.message : "The draft could not be saved.");
        throw reason;
      }
    });
    saveQueue.current = task;
    return task;
  }

  useEffect(() => {
    if (isDemo) return;
    let active = true;
    candidateRequest<{ assessment: AssessmentDetails }>(token)
      .then(({ assessment: loaded }) => {
        if (!active) return;
        setAssessment(loaded);
        const restored = { answers: loaded.draft?.answers ?? {}, questionIndex: Math.max(0, Math.min(loaded.draft?.questionIndex ?? 0, (loaded.questions?.length || defaultQuestions.length) - 1)) };
        setAnswers(restored.answers);
        setQuestionIndex(restored.questionIndex);
        revision.current = loaded.draftRevision ?? 0;
        savedSnapshot.current = JSON.stringify(restored);
        setSavedAt(loaded.draftSavedAt ? new Date(loaded.draftSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null);
        const elapsed = loaded.startedAt ? Math.max(0, Math.floor((Date.now() - new Date(loaded.startedAt).getTime()) / 1000)) : 0;
        setSecondsLeft(Math.max(0, Math.max(1, loaded.durationMinutes) * 60 - elapsed));
        if (["PROCESSING", "COMPLETED", "PROMOTED", "REJECTED"].includes(loaded.status)) { setCompletion({ id: loaded.id, status: loaded.status, score: null, summary: null }); setStage("COMPLETE"); }
        else if (["FAILED", "CANCELLED"].includes(loaded.status)) { setError("This session is closed. Contact the hiring team."); setStage("ERROR"); }
        else setStage(loaded.status === "IN_PROGRESS" ? "ACTIVE" : loaded.status === "SCHEDULED" ? "INSTRUCTIONS" : "CHECK");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "This assessment link could not be opened.");
        setStage("ERROR");
      });
    return () => { active = false; };
  }, [isDemo, token]);

  useEffect(() => {
    if (!isDemo) return;
    const saved = window.localStorage.getItem(storageKey);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as { answers?: Record<string, string>; questionIndex?: number };
      setAnswers(parsed.answers ?? {});
      setQuestionIndex(Math.min(parsed.questionIndex ?? 0, questions.length - 1));
    } catch {
      window.localStorage.removeItem(storageKey);
    }
  }, [isDemo, storageKey]);

  useEffect(() => {
    if (stage !== "ACTIVE" || pending) return;
    const snapshot = JSON.stringify({ answers, questionIndex });
    if (!isDemo && snapshot === savedSnapshot.current) return;
    setSavedAt(null);
    const save = window.setTimeout(() => {
      if (isDemo) {
        window.localStorage.setItem(storageKey, snapshot);
        setSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      } else void persistDraft(snapshot).catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(save);
  }, [answers, questionIndex, stage, storageKey, isDemo, pending]);

  useEffect(() => {
    if (stage !== "ACTIVE") return;
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      if (!isDemo && latestSnapshot.current !== savedSnapshot.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warnUnsaved);
    return () => window.removeEventListener("beforeunload", warnUnsaved);
  }, [isDemo, stage]);

  useEffect(() => {
    if (stage !== "ACTIVE") return;
    const timer = window.setInterval(() => setSecondsLeft((value) => Math.max(0, value - 1)), 1000);
    const visibility = () => {
      if (!document.hidden) return;
      setFocusChanges((value) => value + 1);
      if (!isDemo) {
        void candidateRequest(token, "/integrity-events", {
          method: "POST",
          body: JSON.stringify({ type: "FOCUS_CHANGE", detail: { hidden: true } })
        }).catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [isDemo, stage, token]);

  const time = useMemo(() => `${String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:${String(secondsLeft % 60).padStart(2, "0")}`, [secondsLeft]);
  const question = questions[questionIndex];

  async function acceptConsent() {
    setPending(true);
    setError(null);
    try {
      if (!isDemo) await candidateRequest(token, "/consent", { method: "POST" });
      setStage("INSTRUCTIONS");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Consent could not be recorded.");
    } finally {
      setPending(false);
    }
  }

  async function startAssessment() {
    setPending(true);
    setError(null);
    try {
      if (!isDemo) await candidateRequest(token, "/start", { method: "POST" });
      setStage("ACTIVE");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The assessment could not be started.");
    } finally {
      setPending(false);
    }
  }

  async function submitAssessment() {
    setPending(true);
    setError(null);
    try {
      if (isDemo) {
        setCompletion({ id: demoAssessment.id, score: 84, summary: "Strong, reviewable evidence across the core criteria.", evidence: [] });
      } else {
        await persistDraft(JSON.stringify({ answers, questionIndex }));
        const response = await candidateRequest<{ assessment: Completion; processing?: string }>(token, "/submit", {
          method: "POST",
          body: JSON.stringify({ answers, draftRevision: revision.current, response: questions.map((item) => `${item.prompt}: ${answers[item.id] ?? ""}`).join("\n\n") })
        });
        setCompletion({
          ...response.assessment,
          ...(response.processing === "queued" ? { status: "PROCESSING" } : {})
        });
      }
      window.localStorage.removeItem(storageKey);
      setStage("COMPLETE");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Your submission could not be completed.");
    } finally {
      setPending(false);
    }
  }

  if (stage === "LOADING") return <main className="assessment-shell"><section className="assessment-center card"><LoaderCircle className="spin" size={28} /><span className="eyebrow muted">Secure candidate session</span><h1>Opening your assessment…</h1><p className="muted">We’re validating this one-time link and loading the round details.</p></section></main>;

  if (stage === "ERROR") return <main className="assessment-shell"><section className="assessment-center card"><div className="completion-mark" style={{ background: "#f8ddd5", color: "#9f2f20" }}><AlertCircle size={34} /></div><span className="eyebrow muted">Assessment unavailable</span><h1>We couldn’t open this session.</h1><p className="muted" role="alert">{error}</p><div className="notice"><ShieldCheck size={20} /><span>No response was submitted. Contact the hiring team if you believe this link should still be active.</span></div></section></main>;

  if (stage === "COMPLETE") return <main className="assessment-shell"><section className="assessment-center card"><div className="completion-mark"><Check size={36} /></div><span className="eyebrow muted">Assessment submitted</span><h1>Your evidence is on its way.</h1><p className="muted">The hiring team will review your answers, the rubric, and any integrity context together. Northstar does not make the hiring decision.</p>{completion?.score != null && <div className="notice"><ShieldCheck size={20} /><span><strong>Evidence score: {completion.score}</strong><br/><small>{completion.summary} This score is advisory and requires human review.</small></span></div>}{completion?.status === "PROCESSING" && <div className="notice"><LoaderCircle className="spin" size={20} /><span><strong>Secure evaluation is in progress.</strong><br/><small>Your submitted answers are saved. The hiring team will see the report when processing finishes.</small></span></div>}<div className="notice"><ShieldCheck size={20} /><span>Submitted answers were saved. This one-time link is now closed, and you can safely close this window.</span></div></section></main>;

  return <main className="assessment-shell"><header className="assessment-header"><div><strong>Northstar</strong><span className="tag" style={{ marginLeft: 10 }}>{assessment.roundTitle}</span></div><div style={{ display: "flex", gap: 16, alignItems: "center" }}><span className="muted"><Eye size={14} style={{ display: "inline" }} /> {focusChanges} focus changes</span>{stage === "ACTIVE" && <strong><Clock3 size={15} style={{ display: "inline" }} /> {time}</strong>}</div></header>
    {stage === "CHECK" && <section className="assessment-center card"><span className="eyebrow muted">Step 1 of 3</span><h1>Let’s make sure the room is ready.</h1><p className="muted">This browser check is local. Device permissions are requested only when the selected round needs them.</p><div className="device-grid">{[[Laptop, "Browser", "Modern browser detected"], [Mic, "Microphone", assessment.type === "AI_INTERVIEW" ? "Permission requested at start" : "Not needed for this round"], [Video, "Camera", assessment.proctoringEnabled ? "Required by this round" : "Not needed for this round"]].map(([Icon, label, sub]) => { const I = Icon as typeof Laptop; return <div className="device-card" key={label as string}><I size={22} /><div><strong>{label as string}</strong><span>{checked ? "Ready" : sub as string}</span></div>{checked && <Check size={18} color="#19724d" />}</div>; })}</div><button className="button button-primary" onClick={() => checked ? setStage("CONSENT") : setChecked(true)}>{checked ? <>Continue <ChevronRight size={16} /></> : "Run browser check"}</button></section>}
    {stage === "CONSENT" && <section className="assessment-center card"><span className="eyebrow muted">Step 2 of 3</span><h1>Know what is collected.</h1><p className="muted">This round stores draft and submitted responses, session timing, and focus-change count. Drafts are saved to this session so you can resume on another device. A reviewer sees integrity events as context, never an automatic verdict.</p><label className="consent-row"><input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} /><span>I understand the assessment notice and consent to this session being processed for human review.</span></label>{error && <p role="alert" style={{ color: "#a83224" }}>{error}</p>}<button className="button button-primary" disabled={!consented || pending} onClick={acceptConsent}>{pending ? "Recording consent…" : "Accept and continue"} <ChevronRight size={16} /></button></section>}
    {stage === "INSTRUCTIONS" && <section className="assessment-center card"><span className="eyebrow muted">Step 3 of 3</span><h1>{assessment.jobTitle}</h1><p className="muted">{questions.length} structured written questions · {assessment.durationMinutes} minutes · {isDemo ? "saved in this browser" : "drafts saved securely to your session"}</p><div className="notice"><ShieldCheck size={21} /><span>Answer in your own words. You may explain assumptions and ask for clarification in a live round.</span></div><ul className="instruction-list"><li>Keep this tab open while the round is active.</li><li>Focus changes are counted and shown to the reviewer as context.</li><li>You can revise an answer before final submission.</li></ul>{error && <p role="alert" style={{ color: "#a83224" }}>{error}</p>}<button className="button button-primary" disabled={pending} onClick={startAssessment}>{pending ? "Starting…" : "Start assessment"} <ChevronRight size={16} /></button></section>}
    {stage === "ACTIVE" && saveError && <div className="notice" role="alert"><AlertCircle size={20} /><div><p>{saveError} Your unsaved text remains on this page; copy it before reloading.</p><button className="button button-light" onClick={() => { if (window.confirm("Reload the saved draft? Unsaved changes on this page will be discarded. Copy them first if needed.")) { savedSnapshot.current = latestSnapshot.current; window.location.reload(); } }}>Reload saved draft</button></div></div>}
    {stage === "ACTIVE" && question && <section className="assessment-active"><aside className="question-rail"><span className="eyebrow muted">{assessment.roundTitle}</span><h2>{assessment.jobTitle}</h2><div className="question-steps">{questions.map((item, index) => <button key={item.id} className={index === questionIndex ? "current" : answers[item.id] ? "done" : ""} onClick={() => setQuestionIndex(index)}><span>{answers[item.id] ? <Check size={14} /> : index + 1}</span>{item.label}</button>)}</div><div className="autosave"><Save size={15} /><span>{savedAt ? `Saved ${isDemo ? "locally" : "to session"} at ${savedAt}` : saveError ? "Draft not saved" : "Unsaved changes"}</span></div></aside><article className="answer-card card"><span className="tag">Question {questionIndex + 1} of {questions.length}</span><h1>{question.prompt}</h1><p className="muted">{question.hint}</p><textarea aria-label="Your answer" placeholder="Write your response here…" value={answers[question.id] ?? ""} disabled={pending} maxLength={10_000} onChange={(event) => setAnswers((value) => ({ ...value, [question.id]: event.target.value }))} /><div className="answer-actions"><span className="muted">{(answers[question.id] ?? "").length} characters</span>{questionIndex < questions.length - 1 ? <button className="button button-primary" disabled={!(answers[question.id] ?? "").trim()} onClick={() => setQuestionIndex((value) => value + 1)}>Save and continue <ChevronRight size={16} /></button> : <button className="button button-primary" disabled={pending || !!saveError || questions.some((item) => !(answers[item.id] ?? "").trim())} onClick={submitAssessment}>{pending ? "Submitting…" : "Submit assessment"} <Check size={16} /></button>}</div>{error && <p role="alert" style={{ color: "#a83224", marginTop: 14 }}>{error}</p>}</article></section>}
  </main>;
}
