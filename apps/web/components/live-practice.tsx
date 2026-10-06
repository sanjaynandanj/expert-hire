"use client";

import { ArrowRight, BrainCircuit, Code2, FileSearch, GraduationCap, LoaderCircle, MessageCircle, Presentation, Sparkles, Trophy } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { BrandMark } from "./brand-mark";

type Category = "TECHNICAL" | "COMMUNICATION" | "BEHAVIORAL";
type Attempt = { id: string; category: Category; prompt: string; response: string; score: number; feedback: { summary?: string; evidence?: Array<{ name: string; score: number; rationale: string }> }; createdAt: string };
type Dashboard = { profile: { name: string; registrationNo: string; branch: string; graduationYear: number }; readiness: number | null; attempts: Attempt[]; levels: Array<{ category: Category; score: number | null; attempts: number }> };
type StudentDrive = { id: string; title: string; description: string; applyBy: string; openings: number; locations: string[]; eligibleBranches: string[]; minCgpa: number | null; ctcMin: string | number | null; ctcMax: string | number | null; currency: string; company: { name: string }; applied: boolean; eligibility: { eligible: boolean; reasons: string[] } };

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const practiceTools = [
  [MessageCircle, "Mock interview", "Practice a structured answer", "Included", "COMMUNICATION" as Category],
  [Code2, "Technical reasoning", "Explain an engineering decision", "Included", "TECHNICAL" as Category],
  [BrainCircuit, "Work-style reflection", "Learn from a team experience", "Included", "BEHAVIORAL" as Category],
  [FileSearch, "Resume feedback", "Bring a role-specific resume", "Coming soon", null],
  [Sparkles, "Prompt lab", "Solve a practical work prompt", "Coming soon", null],
  [Presentation, "Pitch room", "Defend a product idea", "Coming soon", null]
] as const;

async function practiceRequest<T>(path: string, organizationId: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}/v1${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-Organization-Id": organizationId, ...init?.headers }
  });
  const body = await response.json().catch(() => null) as T | { error?: { message?: string } } | null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? body.error?.message : null;
    throw new Error(message ?? "Practice data could not be loaded.");
  }
  return body as T;
}

export function LivePractice() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [drives, setDrives] = useState<StudentDrive[]>([]);
  const [category, setCategory] = useState<Category>("COMMUNICATION");
  const [response, setResponse] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [applyingDrive, setApplyingDrive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);

  const refresh = useCallback(async (orgId: string) => {
    const result = await practiceRequest<Dashboard>("/student/practice", orgId);
    setDashboard(result);
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const sessionResponse = await fetch(`${apiUrl}/v1/auth/session`, { credentials: "include" });
        if (!sessionResponse.ok) {
          if (active) setDemo(true);
          return;
        }
        const session = await sessionResponse.json() as { organizations: Array<{ id: string; role: string }> };
        const studentOrg = session.organizations.find((item) => item.role === "STUDENT");
        if (!studentOrg) {
          if (active) setError("Sign in with a student account to save practice attempts.");
          return;
        }
        if (!active) return;
        window.localStorage.setItem("northstar.organizationId", studentOrg.id);
        setOrganizationId(studentOrg.id);
        const [practiceData, driveData] = await Promise.all([
          practiceRequest<Dashboard>("/student/practice", studentOrg.id),
          practiceRequest<{ data: StudentDrive[] }>("/student/drives", studentOrg.id)
        ]);
        if (active) {
          setDashboard(practiceData);
          setDrives(driveData.data);
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Practice workspace could not be loaded.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [refresh]);

  async function submitAttempt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (demo || !organizationId) {
      setNotice("This is a preview. Sign in with a student account to save your response.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await practiceRequest<{ attempt: Attempt; advisoryOnly: true }>("/student/practice/attempts", organizationId, {
        method: "POST",
        body: JSON.stringify({ category, response })
      });
      setNotice(`Practice saved. Advisory score: ${result.attempt.score}.`);
      setResponse("");
      await refresh(organizationId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Practice could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function applyToDrive(driveId: string) {
    setApplyingDrive(driveId);
    setError(null);
    setNotice(null);
    try {
      await practiceRequest("/student/applications", organizationId, { method: "POST", body: JSON.stringify({ driveId }) });
      setDrives((current) => current.map((drive) => drive.id === driveId ? { ...drive, applied: true } : drive));
      setNotice("Application submitted. You can see its status in your campus placement workspace.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Application could not be submitted.");
    } finally {
      setApplyingDrive(null);
    }
  }

  const levelScores = dashboard?.levels ?? [
    { category: "TECHNICAL" as const, score: 82, attempts: 2 },
    { category: "COMMUNICATION" as const, score: 63, attempts: 1 },
    { category: "BEHAVIORAL" as const, score: 77, attempts: 1 }
  ];
  const readiness = dashboard?.readiness ?? (demo ? 74 : null);

  return <main style={{ minHeight: "100vh", background: "var(--cream)" }}><header className="site-header"><div className="container site-header-inner"><Link href="/"><BrandMark /></Link><div style={{ display: "flex", gap: 12, alignItems: "center" }}>{demo ? <Link className="button button-light" href="/login">Sign in to save progress</Link> : <span className="tag">{loading ? "Loading profile…" : `${dashboard?.profile.branch ?? "Student"} · ${dashboard?.profile.graduationYear ?? ""}`}</span>}<div className="avatar">{dashboard?.profile.name.split(" ").map((part) => part[0]).join("").slice(0, 2) ?? "ST"}</div></div></div></header><div className="container" style={{ paddingBlock: 48 }}><div className="page-title"><div><p className="eyebrow muted" style={{ margin: "0 0 8px" }}>Your practice space {demo && <span className="tag">DEMO PREVIEW</span>}</p><h1 style={{ fontSize: 42 }}>Build the signal before it counts.</h1><span className="muted">{dashboard ? `Welcome, ${dashboard.profile.name}. Your saved readiness is based on your practice history.` : "Practice with clear feedback and keep your progress in one place."}</span></div><button className="button button-primary" onClick={() => document.getElementById("practice-response")?.scrollIntoView({ behavior: "smooth", block: "center" })}>Start a practice round <ArrowRight size={16} /></button></div>
    {error && <div className="notice form-error" role="alert">{error}</div>}{notice && <div className="notice" role="status">{notice}</div>}
    <section className="dashboard-grid"><article className="card panel" style={{ background: "var(--pine)", color: "white" }}><div className="panel-head"><div><span className="eyebrow" style={{ color: "var(--mint)" }}>Readiness score</span><div className="display" style={{ fontSize: 92, marginTop: 18 }}>{loading ? <LoaderCircle className="spin" size={46} /> : readiness ?? "—"}</div></div><Trophy size={46} color="var(--mint)" /></div><p style={{ color: "#bcd0c6", lineHeight: 1.6 }}>{readiness === null ? "Complete a practice round to establish your readiness baseline." : "Practice feedback is advisory and intended to help you decide what to work on next."}</p><span className="tag">{dashboard ? `${dashboard.attempts.length} saved attempts` : demo ? "Preview data only" : "No saved attempts yet"}</span></article><article className="card panel"><div className="panel-head"><h2>Your levels</h2><span className="tag">{dashboard ? "From saved attempts" : "Sample preview"}</span></div>{levelScores.map(({ category: level, score, attempts }) => <div key={level} style={{ marginTop: 18 }}><div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700 }}><span>{level[0] + level.slice(1).toLowerCase()}</span><span>{score ?? "—"}</span></div><div className="mini-bar" style={{ marginTop: 8 }}><span style={{ width: `${score ?? 0}%`, background: "var(--pine)" }} /></div><small className="muted">{attempts} {attempts === 1 ? "attempt" : "attempts"}</small></div>)}</article></section>
    <section className="card panel workspace-form" style={{ marginTop: 24 }}><div className="panel-head"><div><h2>Practice response</h2><span className="muted" style={{ fontSize: 12 }}>Write at least 30 characters. Your saved attempt is private to your account.</span></div><span className="tag">Advisory feedback</span></div><form onSubmit={submitAttempt}><div className="field"><label htmlFor="practice-category">Skill focus</label><select className="input" id="practice-category" value={category} onChange={(event) => setCategory(event.target.value as Category)}><option value="COMMUNICATION">Communication</option><option value="TECHNICAL">Technical reasoning</option><option value="BEHAVIORAL">Behavioral reflection</option></select></div><p className="notice">{category === "COMMUNICATION" ? "Explain a complex project to a non-specialist teammate. What did you emphasize, and how did you check for understanding?" : category === "TECHNICAL" ? "Describe a technical problem you solved. Explain the constraints, the approach you chose, and the trade-offs you considered." : "Describe a time you changed your approach after feedback. What did you learn and what did you do next?"}</p><div className="field"><label htmlFor="practice-response">Your answer</label><textarea id="practice-response" className="input form-textarea" value={response} onChange={(event) => setResponse(event.target.value)} minLength={30} maxLength={10000} required placeholder="Structure your answer: context, your action, the outcome, and what you learned." /></div><button className="button button-primary" disabled={saving || loading}>{saving ? "Saving feedback…" : "Save practice attempt"}</button></form></section>
    <h2 style={{ margin: "42px 0 18px", fontSize: 26 }}>Choose how to practice</h2><section className="feature-grid">{practiceTools.map(([Icon, title, description, cost, practiceCategory]) => { const ToolIcon = Icon as typeof Code2; const available = practiceCategory !== null; return <button className="card feature-card" key={title} style={{ minHeight: 220, textAlign: "left", cursor: available ? "pointer" : "default" }} disabled={!available} onClick={() => practiceCategory && setCategory(practiceCategory)}><div style={{ display: "flex", justifyContent: "space-between" }}><div className="feature-icon"><ToolIcon size={20} /></div><span className="tag">{cost}</span></div><div><h3>{title}</h3><p>{description}</p></div></button>; })}</section>
    <section className="card panel" style={{ marginTop: 24 }}><div className="panel-head"><div><h2>Recent practice</h2><span className="muted" style={{ fontSize: 12 }}>Saved to your account and visible only to you.</span></div></div>{dashboard?.attempts.length ? dashboard.attempts.map((attempt) => <article className="evidence-row" key={attempt.id}><div className="evidence-heading"><strong>{attempt.category[0] + attempt.category.slice(1).toLowerCase()}</strong><span>{attempt.score} · {new Date(attempt.createdAt).toLocaleDateString()}</span></div><p>{attempt.feedback.summary ?? "Feedback saved."}</p><blockquote>{attempt.prompt}</blockquote></article>) : <p className="muted">{demo ? "Sample preview progress is not saved." : "Your saved attempts will appear here."}</p>}</section>
    {!demo && <section className="card panel" style={{ marginTop: 24 }}><div className="panel-head"><div><h2>Campus placement drives</h2><span className="muted" style={{ fontSize: 12 }}>Eligibility is evaluated by the university workspace before your application is saved.</span></div><span className="tag">{drives.length} open drives</span></div>{drives.length ? drives.map((drive) => <article className="drive-row" key={drive.id}><div className="stat-icon"><GraduationCap size={18} /></div><div className="drive-main"><strong>{drive.title}</strong><span className="muted">{drive.company.name} · {drive.openings} openings · apply by {new Date(drive.applyBy).toLocaleDateString()}</span><span className="muted">{drive.locations.join(", ")}{drive.ctcMin == null ? "" : ` · ${drive.currency} ${Number(drive.ctcMin).toLocaleString()}–${Number(drive.ctcMax).toLocaleString()}`}</span>{!drive.eligibility.eligible && <span className="eligibility-reasons">{drive.eligibility.reasons.join(" · ")}</span>}</div><div className="drive-action">{drive.applied ? <span className="tag">Applied</span> : <button className="button button-primary" disabled={!drive.eligibility.eligible || applyingDrive === drive.id} onClick={() => void applyToDrive(drive.id)}>{applyingDrive === drive.id ? "Applying…" : drive.eligibility.eligible ? "Apply" : "Not eligible"}</button>}</div></article>) : <p className="muted">No published campus drives are currently open.</p>}</section>}
    <p className="muted" style={{ marginTop: 18, fontSize: 12 }}>Practice scores are generated by a local deterministic evaluator, are not validated for hiring decisions, and are not shared with employers.</p></div></main>;
}
