import { ArrowUpRight, BriefcaseBusiness, CalendarDays, CircleCheck, Clock3, FileText, Sparkles, UsersRound } from "lucide-react";
import { LiveDashboardMetrics } from "../../components/live-workspace";
import { WorkspaceShell } from "../../components/workspace-shell";

const candidates = [
  { initials: "MC", name: "Maya Chen", role: "Platform Engineer", stage: "Technical interview", score: 84 },
  { initials: "TN", name: "Theo Nwosu", role: "Product Designer", stage: "Portfolio review", score: 78 },
  { initials: "LA", name: "Lina Alvarez", role: "Data Analyst", stage: "Shortlisted", score: 91 },
  { initials: "OS", name: "Omar Saleh", role: "Solutions Architect", stage: "AI interview", score: 73 }
];

export default function DashboardPage() {
  return <WorkspaceShell>
    <div className="page-title"><div><p className="eyebrow muted" style={{ margin: "0 0 8px" }}>Monday, 5 October</p><h1>Good morning, Avery.</h1><span className="muted">The evidence is moving. Three reviews need your attention.</span></div><button className="button button-primary"><Sparkles size={16} /> Create a role</button></div>
    <LiveDashboardMetrics />
    <section className="dashboard-grid">
      <article className="card panel"><div className="panel-head"><div><h2>Hiring pipeline</h2><span className="muted" style={{ fontSize: 12 }}>All active roles · last 30 days</span></div><button className="button button-light" style={{ minHeight: 36, paddingInline: 13 }}>View pipeline <ArrowUpRight size={14} /></button></div><div className="pipeline-line"><span /><span /><span /><span /></div><div className="legend">{[["Applied", "248"], ["Screened", "143"], ["Interview", "82"], ["Offer", "19"]].map(([label, value]) => <div key={label}><strong>{value}</strong><span className="muted" style={{ fontSize: 12 }}>{label}</span></div>)}</div></article>
      <article className="card panel"><div className="panel-head"><h2>Needs a person</h2><span className="tag">3 open</span></div><div className="activity-list">
        <div className="activity"><div className="activity-dot"><FileText size={16} /></div><p><strong>Review Maya’s flagged event</strong><br /><span className="muted">One focus change in coding round</span></p><time>12m</time></div>
        <div className="activity"><div className="activity-dot"><UsersRound size={16} /></div><p><strong>Approve the Data Analyst shortlist</strong><br /><span className="muted">12 candidates above the threshold</span></p><time>1h</time></div>
        <div className="activity"><div className="activity-dot"><CalendarDays size={16} /></div><p><strong>Confirm tomorrow’s panel</strong><br /><span className="muted">Two interviewers awaiting response</span></p><time>3h</time></div>
      </div></article>
    </section>
    <section className="card panel" style={{ marginTop: 14 }}><div className="panel-head"><div><h2>Candidate momentum</h2><span className="muted" style={{ fontSize: 12 }}>Recently active across your roles</span></div><button className="button button-light" style={{ minHeight: 36 }}>All candidates</button></div><div style={{ overflowX: "auto" }}><table className="table"><thead><tr><th>Candidate</th><th>Role</th><th>Current stage</th><th>Evidence score</th><th>Updated</th></tr></thead><tbody>{candidates.map((candidate, index) => <tr key={candidate.name}><td><div className="person"><div className="avatar">{candidate.initials}</div>{candidate.name}</div></td><td>{candidate.role}</td><td><span className="tag">{candidate.stage}</span></td><td><div className="score">{candidate.score}</div></td><td className="muted">{index + 1}h ago</td></tr>)}</tbody></table></div></section>
  </WorkspaceShell>;
}
